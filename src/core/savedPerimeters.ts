/**
 * core/savedPerimeters.ts
 *
 * Save / persistence layer for perimeters. Pure data logic — no DOM, no React.
 *
 * WHY localStorage (noted per the working agreement): the Perimeter model is a
 * plain, JSON-serializable object (vertices with numeric fields + a boolean),
 * so the simplest durable store that survives a reload with zero backend is
 * `localStorage`. No new dependency is introduced. If multi-device sync or large
 * libraries are needed later, swap this module's read/write for IndexedDB or a
 * server without touching the UI (the component only calls the helpers here).
 *
 * Each save is deep-copied on capture so subsequent edits to the LIVE perimeter
 * can never mutate a stored one (the model is shared-by-reference in React
 * state, so a shallow copy would alias the vertex objects).
 */

import type { Perimeter } from "./geometry";
import { perimeterLength, enclosedArea } from "./geometry";
import { DEFAULT_WALL_HEIGHT_FT } from "./extrude3d";
import { type SolarSettings } from "./solar";
import { type ReferenceImage, cloneReferenceImages } from "./referenceImage";

/**
 * The persistent ELEVATION / unwrapped-document state captured alongside the
 * footprint. These mirror the authored fields in the editor's DocSnapshot
 * (PolylineTool.tsx): per-edge panel heights & cell splits, the global default
 * wall height, and placed floor-plate elevations. They are OPTIONAL on the
 * interface so older localStorage entries (saved before elevation state was
 * persisted) still type-check; on every NEW save we always write them, and
 * loadSaved() defaults any missing field so old saves survive.
 */
/**
 * Inward INSET (model feet) of a unitized cell's four edges, set by the Framing tool
 * under the Unitized CW system. Each value offsets the corresponding frame face inward
 * from that edge of the cell (0 = flush with the cell edge / no frame face).
 */
export interface CellInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Curtain-wall fabrication system assignable to a panel (Stick vs Unitized). */
export type CwType = "stick" | "unitized";

/** Glazing/infill TYPE assignable to a single grid CELL via the Type tool: clear
 *  Vision glass, opaque Spandrel glass, or a fully Opaque (non-glass) infill. Each
 *  renders with its own hatch so the elevation reads as a typed facade. */
export type CellType = "vision" | "spandrel" | "opaque";

export interface SavedElevationState {
  /** Per-edge-index height overrides (model units). */
  unravelHeights: Record<number, number>;
  /** Per-edge-index cell-split counts. */
  unravelCells: Record<number, number>;
  /** Per-edge-index arrays of vertical division-line OFFSETS (model units from the
   *  panel's left edge x0), placed by the Subtractive tool. */
  panelDivisions: Record<number, number[]>;
  /** Per-edge-index arrays of HORIZONTAL divider OFFSETS (model units from the
   *  panel's baseline y0 = 0), placed by the Subtractive tool with Shift held. */
  panelDividersH: Record<number, number[]>;
  /** Per-edge-index VERTICAL mullion half-width offset (model units / feet): the
   *  distance to EACH side of every vertical grid line, set by the Mullions tool
   *  (Stick system). 0/absent = no mullion width. */
  panelMullionsV: Record<number, number>;
  /** Per-edge-index HORIZONTAL mullion half-width offset (model units / feet): the
   *  offset to each side of every horizontal grid line. 0/absent = none. */
  panelMullionsH: Record<number, number>;
  /** Per-edge-index UNITIZED cell framing: cell index (in that panel's cell grid, the
   *  same order as the editor's cellsForEdge) → the inward INSET of each of the cell's
   *  four edges (model feet). Set by the Framing tool under the Unitized CW system.
   *  Absent/empty = no per-cell framing. */
  panelCellFraming: Record<number, Record<number, CellInsets>>;
  /** Per-edge-index UNITIZED cell TYPE: cell index (in that panel's cell grid, the same
   *  order as the editor's cellsForEdge) → its glazing type (Vision / Spandrel / Opaque),
   *  assigned by the Type tool. Absent/empty = no type assigned (untyped Vision default). */
  panelCellTypes: Record<number, Record<number, CellType>>;
  /** Per-edge-index assigned curtain-wall system (Stick / Unitized). A panel carries at
   *  most one system; absent = none chosen yet. */
  panelCwType: Record<number, CwType>;
  /** Global default wall height (model units). */
  unravelHeight: number;
  /** Placed floor-plate elevations (model Y). */
  floorPlates: number[];
}

/**
 * Optional GEO-LOCATION captured for a sketch via the LOCATION panel section.
 *
 * `address` is the free text the user types. Committing it runs the OFFLINE
 * gazetteer (core/gazetteer.ts), which fills the resolved fields below — no API key
 * and no network request. A wholly BLANK location (empty address, null coordinates)
 * means "no geolocation", the default, so a blank canvas needs no location at all.
 *
 * The resolved fields are what the Solar Study reads for site latitude, the
 * solar↔clock time correction, and the radiation model's site elevation. They stay
 * null when the address matched nothing, so an unresolved address never silently
 * pretends to be a located site — the UI says so and the study keeps its default.
 */
export interface LocationInfo {
  address: string;
  lat: number | null;
  lng: number | null;
  /**
   * Human-readable resolved place ("Omaha, Nebraska, US"), or null when the address
   * did not resolve / coordinates were typed directly. Shown next to the field so the
   * user can always see WHAT the tool matched and correct a wrong guess.
   */
  label?: string | null;
  /** IANA zone of the resolved site, for the clock-time readout. Null when unresolved. */
  timeZone?: string | null;
  /** Resolved site elevation in METRES (feeds Hottel transmittance). Null when unresolved. */
  elevationM?: number | null;
}

/** A fresh, blank location — no geolocation at all. Used when a saved entry predates
 *  the location feature, or when a location is explicitly cleared. */
export function emptyLocation(): LocationInfo {
  return { address: "", lat: null, lng: null, label: null, timeZone: null, elevationM: null };
}

/**
 * The DEFAULT location a new sketch starts with: Omaha, Nebraska. Pre-resolved rather
 * than left blank so the solar study, sun path, and shadow work are meaningful from the
 * first click instead of silently reading nothing — the user re-types an address only
 * when the project is somewhere else. Values are the resolved gazetteer entry (the same
 * ones the offline lookup returns for "Omaha, NE"), so no resolution round trip is
 * needed at startup.
 */
export function defaultLocation(): LocationInfo {
  return {
    // Byte-for-byte what `resolveSite("Omaha, Nebraska, US")` returns, so the default
    // site is indistinguishable from one the user resolved themselves — same canonical
    // address in the field, same rounded coordinates, same elevation and zone. Anything
    // hand-written here would silently disagree with the gazetteer the moment the user
    // re-committed the field, and the readout would jump.
    address: "Omaha, Nebraska, US",
    lat: 41.26,
    lng: -95.94,
    label: "Omaha, Nebraska, US",
    timeZone: "America/Chicago",
    elevationM: 320,
  };
}

/** Deep-copy a location so a stored snapshot is detached from live state. */
export function cloneLocation(l: LocationInfo): LocationInfo {
  return {
    address: l.address,
    lat: l.lat,
    lng: l.lng,
    // Backfilled with null for entries saved before these fields existed.
    label: l.label ?? null,
    timeZone: l.timeZone ?? null,
    elevationM: typeof l.elevationM === "number" ? l.elevationM : null,
  };
}

/** True when a location carries no geolocation info at all (the default). */
export function isBlankLocation(l: LocationInfo | undefined | null): boolean {
  return !l || (l.address.trim() === "" && l.lat === null && l.lng === null);
}

/** A persisted perimeter plus its metadata. */
export interface SavedPerimeter {
  /** Stable unique id (used as React key and for load/delete/update). */
  id: string;
  /** User-facing name; auto-generated ("Option 1") but renameable. */
  name: string;
  /** Epoch millis when first saved (for ordering / display). */
  createdAt: number;
  /** Deep-copied perimeter geometry (model units). */
  perimeter: Perimeter;
  /**
   * Elevation/unwrapped-view document state. OPTIONAL so entries written before
   * this field existed still load; new saves always populate it. See
   * {@link SavedElevationState}.
   */
  unravelHeights?: Record<number, number>;
  unravelCells?: Record<number, number>;
  panelDivisions?: Record<number, number[]>;
  panelDividersH?: Record<number, number[]>;
  unravelHeight?: number;
  floorPlates?: number[];
  /**
   * Optional geo-location for the sketch (LOCATION panel). OPTIONAL so entries
   * written before this field existed still load; absent/blank = no geolocation.
   */
  location?: LocationInfo;
  /** Per-edge mullion half-width offsets (Mullions tool). OPTIONAL so older entries
   *  still load (defaulted to {} on load). See {@link SavedElevationState}. */
  panelMullionsV?: Record<number, number>;
  panelMullionsH?: Record<number, number>;
  /** Per-edge UNITIZED per-cell framing insets (Framing tool, Unitized system).
   *  OPTIONAL so older entries still load (defaulted to {} on load). */
  panelCellFraming?: Record<number, Record<number, CellInsets>>;
  /** Per-edge UNITIZED per-cell glazing TYPE (Vision / Spandrel / Opaque, Type tool).
   *  OPTIONAL so older entries still load (defaulted to {} on load). */
  panelCellTypes?: Record<number, Record<number, CellType>>;
  /** Per-edge curtain-wall system assignment (Stick / Unitized). OPTIONAL so older
   *  entries still load (defaulted to {} on load). */
  panelCwType?: Record<number, CwType>;
  /**
   * Optional REFERENCE IMAGES (imported PDF/PNG/JPEG underlays) placed in model space
   * beneath the drawing. OPTIONAL so older entries still load (defaulted to [] on load).
   *
   * Each carries its raster inline as a data URL, so a project is self-contained: it
   * survives a reload and travels with a duplicate without depending on the original
   * file still being on disk. That is also why imports are downscaled on the way in —
   * see MAX_RASTER_PX in core/referenceImage.ts — since this all has to fit in the
   * localStorage budget shared by every saved project.
   */
  referenceImages?: ReferenceImage[];
  /**
   * Optional SOLAR-STUDY settings (the Solar Study popup): the sketch's cardinal
   * orientation (`northOffset`), site latitude/longitude, and the studied day +
   * solar time. OPTIONAL so older entries still load (the Solar Study defaults them
   * when absent and writes them on first edit). Persisting this is what lets a later
   * step encode each FACADE's cardinal orientation from the stored north + study set.
   */
  solar?: SolarSettings;
}

/** localStorage key under which the saved-perimeter list lives. */
const STORAGE_KEY = "facade-app.savedPerimeters.v1";

/**
 * Deep-copy a perimeter. The model is plain JSON (no functions/dates/cycles),
 * so structuredClone (or a JSON round-trip fallback) is correct and detaches
 * every nested vertex/handle object from the live state.
 */
export function clonePerimeter(p: Perimeter): Perimeter {
  if (typeof structuredClone === "function") return structuredClone(p);
  return JSON.parse(JSON.stringify(p)) as Perimeter;
}

/**
 * Deep-copy the nested per-cell framing map (panel index → cell index → insets) so a
 * stored snapshot is fully detached from live state. Two object levels plus a flat
 * insets object, all primitive values.
 */
export function cloneCellFraming(
  m: Record<number, Record<number, CellInsets>>,
): Record<number, Record<number, CellInsets>> {
  return Object.fromEntries(
    Object.entries(m).map(([k, cells]) => [
      k,
      Object.fromEntries(Object.entries(cells).map(([ci, ins]) => [ci, { ...ins }])),
    ]),
  );
}

/**
 * Deep-copy the nested per-cell TYPE map (panel index → cell index → cell type) so a
 * stored snapshot is fully detached from live state. Two object levels of primitive
 * (string) values — mirrors {@link cloneCellFraming}.
 */
export function cloneCellTypes(
  m: Record<number, Record<number, CellType>>,
): Record<number, Record<number, CellType>> {
  return Object.fromEntries(
    Object.entries(m).map(([k, cells]) => [k, { ...cells }]),
  );
}

/** Minimum vertices required to save (guards empty/degenerate perimeters). */
export const MIN_SAVE_VERTICES = 2;

/** Is this perimeter substantial enough to save? */
export function canSave(p: Perimeter): boolean {
  return p.vertices.length >= MIN_SAVE_VERTICES;
}

/** Generate a reasonably unique id without pulling in a uuid dependency. */
function makeId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Deep-copy an elevation-state object so the stored snapshot is fully detached
 * from live React state. The maps' values and the floor-plate elevations are all
 * primitives, so a fresh container (`{ ...map }` / `[...arr]`) is a sufficient
 * deep copy.
 */
export function cloneElevationState(e: SavedElevationState): SavedElevationState {
  return {
    unravelHeights: { ...e.unravelHeights },
    unravelCells: { ...e.unravelCells },
    // Per-panel division arrays must be copied element-wise (nested arrays).
    panelDivisions: Object.fromEntries(
      Object.entries(e.panelDivisions).map(([k, v]) => [k, [...v]]),
    ),
    // Horizontal dividers: same element-wise nested-array copy as panelDivisions.
    panelDividersH: Object.fromEntries(
      Object.entries(e.panelDividersH).map(([k, v]) => [k, [...v]]),
    ),
    // Mullion offsets are flat number maps — a fresh container is a sufficient copy.
    panelMullionsV: { ...e.panelMullionsV },
    panelMullionsH: { ...e.panelMullionsH },
    // Unitized per-cell framing is a nested map — deep-copy both object levels.
    panelCellFraming: cloneCellFraming(e.panelCellFraming),
    // Unitized per-cell TYPE is a nested map — deep-copy both object levels.
    panelCellTypes: cloneCellTypes(e.panelCellTypes),
    // Per-panel system assignment is a flat map — a fresh container is a sufficient copy.
    panelCwType: { ...e.panelCwType },
    unravelHeight: e.unravelHeight,
    floorPlates: [...e.floorPlates],
  };
}

/**
 * Pick the next auto name ("Option N") so names stay sequential: one past the
 * highest "Option N" already present, so deleting and re-saving doesn't reuse a
 * confusingly low number mid-session.
 */
function nextOptionName(existing: SavedPerimeter[]): string {
  let maxN = 0;
  for (const s of existing) {
    const m = /^Option (\d+)$/.exec(s.name);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `Option ${Math.max(existing.length, maxN) + 1}`;
}

/**
 * Build a new SavedPerimeter from the live perimeter + elevation state. `existing`
 * is used only to pick the next auto name ("Option N") so names stay sequential.
 * The perimeter and elevation state are deep-copied so later edits to the live
 * document can never mutate this stored snapshot.
 */
export function makeSavedPerimeter(
  p: Perimeter,
  elevation: SavedElevationState,
  existing: SavedPerimeter[],
  location: LocationInfo = emptyLocation(),
  referenceImages: ReferenceImage[] = [],
): SavedPerimeter {
  const elev = cloneElevationState(elevation);
  return {
    id: makeId(),
    name: nextOptionName(existing),
    createdAt: Date.now(),
    perimeter: clonePerimeter(p),
    unravelHeights: elev.unravelHeights,
    unravelCells: elev.unravelCells,
    panelDivisions: elev.panelDivisions,
    panelDividersH: elev.panelDividersH,
    panelMullionsV: elev.panelMullionsV,
    panelMullionsH: elev.panelMullionsH,
    panelCellFraming: elev.panelCellFraming,
    panelCellTypes: elev.panelCellTypes,
    panelCwType: elev.panelCwType,
    unravelHeight: elev.unravelHeight,
    floorPlates: elev.floorPlates,
    location: cloneLocation(location),
    referenceImages: cloneReferenceImages(referenceImages),
  };
}

/**
 * Duplicate an ENTIRE saved project — perimeter, all elevation/panel state (heights,
 * divisions, mullions, Unitized cell framing, CW types), floor plates, geo-location, and
 * solar settings — into a brand-new entry with a fresh id, a fresh `createdAt`, and the
 * next sequential "Option N" name. The whole entry is plain JSON-serialisable data, so a
 * structured/JSON deep clone fully detaches the copy from the source (and from live state).
 */
export function duplicateSavedPerimeter(src: SavedPerimeter, existing: SavedPerimeter[]): SavedPerimeter {
  const copy: SavedPerimeter =
    typeof structuredClone === "function"
      ? structuredClone(src)
      : (JSON.parse(JSON.stringify(src)) as SavedPerimeter);
  copy.id = makeId();
  copy.name = nextOptionName(existing);
  copy.createdAt = Date.now();
  return copy;
}

/** Convenience readouts for a saved perimeter (curve-accurate). */
export function savedStats(s: SavedPerimeter): { length: number; area: number; vertices: number } {
  return {
    length: perimeterLength(s.perimeter),
    area: enclosedArea(s.perimeter),
    vertices: s.perimeter.vertices.length,
  };
}

// ---------------------------------------------------------------------------
// PERSISTENCE (localStorage)
// ---------------------------------------------------------------------------

/**
 * Load the saved list from localStorage. Defensive: returns [] on any problem
 * (missing key, malformed JSON, wrong shape, no localStorage in the runtime) so
 * a corrupt store never crashes the app on mount.
 */
export function loadSaved(): SavedPerimeter[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep only entries with the expected shape, then DEFAULT any missing
    // elevation fields so saves written before elevation state was persisted
    // (which only carry {id,name,createdAt,perimeter}) still load cleanly. We
    // do NOT bump STORAGE_KEY or drop these old entries — we backfill instead.
    return parsed
      .filter(
        (s): s is SavedPerimeter =>
          s &&
          typeof s.id === "string" &&
          typeof s.name === "string" &&
          s.perimeter &&
          Array.isArray(s.perimeter.vertices),
      )
      .map((s) => ({
        ...s,
        unravelHeights: s.unravelHeights ?? {},
        unravelCells: s.unravelCells ?? {},
        panelDivisions: s.panelDivisions ?? {},
        panelDividersH: s.panelDividersH ?? {},
        panelMullionsV: s.panelMullionsV ?? {},
        panelMullionsH: s.panelMullionsH ?? {},
        panelCellFraming: s.panelCellFraming ?? {},
        panelCellTypes: s.panelCellTypes ?? {},
        panelCwType: s.panelCwType ?? {},
        unravelHeight: s.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT,
        floorPlates: s.floorPlates ?? [],
      }));
  } catch {
    return [];
  }
}

/**
 * Persist the saved list. Returns TRUE on success, FALSE when the write failed —
 * almost always localStorage's few-MB quota, or a private-mode block.
 *
 * The result is reported rather than swallowed because REFERENCE IMAGES made silent
 * failure dangerous: geometry is small enough that quota was effectively unreachable,
 * but one imported scan can approach the whole budget. A user whose save is failing
 * needs to know before they close the tab, so the caller surfaces a warning.
 */
export function persistSaved(list: SavedPerimeter[]): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
