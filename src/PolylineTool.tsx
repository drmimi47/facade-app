/**
 * PolylineTool.tsx
 *
 * The interactive tool. This component owns the INPUT-HANDLING layer and the
 * React UI shell. It deliberately keeps three concerns separate:
 *
 *   - DATA MODEL   -> core/geometry.ts + core/perimeterOps.ts (Perimeter)
 *   - RENDERING    -> core/renderer.ts (paints model + viewport to canvas)
 *   - INPUT        -> this file (pointer/keyboard -> model operations)
 *
 * The canvas is treated as a pure projection of the model; React state holds
 * the model and transient interaction flags, and an effect repaints on change.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  emptyPerimeter,
  distance,
  snapPoint,
  constrainAngle,
  hitVertex,
  hitSegment,
  hitHandle,
  type Perimeter,
  type Point,
} from "./core/geometry";
import {
  addVertex,
  close as closePerimeter,
  moveVertex,
  insertVertexOnSegment,
  deleteVertex,
  eraseElements,
  popVertex,
  setHandle,
  makeSegmentArc,
  clearVertexHandles,
} from "./core/perimeterOps";
import { defaultViewport, toScreen, toModel, pixelsToModel, zoomAt, pan, fitViewport, easeOut, lerpViewport, type Viewport, type FitInsets } from "./core/viewport";
import { render, type RenderState, type UnravelDraw } from "./core/renderer";
import { unravelPerimeter, unravelBoundsPerimeter, buildEqualColumns, buildEqualRows, type UnravelSegment } from "./core/unravel";
import { buildUnrollChain, renderUnrollFrame, unrollDurationMs, type UnrollFrame } from "./core/unrollAnim";
import { DEFAULT_WALL_HEIGHT_FT } from "./core/extrude3d";
import {
  fmtLength,
  fmtLengthTick,
  toDisplayLength,
  fromDisplayLength,
  setUnitSystem,
} from "./core/units";
import {
  loadSaved,
  persistSaved,
  makeSavedPerimeter,
  duplicateSavedPerimeter,
  cloneElevationState,
  clonePerimeter,
  canSave,
  emptyLocation,
  defaultLocation,
  cloneLocation,
  cloneCellFraming,
  cloneCellTypes,
  type SavedPerimeter,
  type SavedElevationState,
  type LocationInfo,
  type CellInsets,
} from "./core/savedPerimeters";
import {
  TOUR_STEPS,
  DEMO_PERIMETER,
  DEMO_PROJECT_NAME,
  DEMO_ADDRESS,
  DEMO_WALL_HEIGHT_FT,
  DEMO_FLOOR_TO_FLOOR_FT,
  DEMO_SPANDREL_BAND_FT,
  DEMO_MODULE_FT,
  DEMO_MULLION_OFFSET_FT,
  DEMO_FOCUS_EDGE,
  DEMO_VIEW_MODE_SEQUENCE,
  DEMO_EXPORT_PANEL_COUNT,
  DEMO_MARQUEE_PAD_FT,
  demoExportWindow,
  demoCellType,
  demoColumnOffsets,
  demoDrawFrame,
  demoFloorLevels,
  demoRowOffsets,
} from "./core/demoTour";
import DemoTour from "./DemoTour";
import {
  cloneSolarSettings,
  defaultSolarSettings,
  sunPosition,
  wallIncidenceCos,
  type SolarSettings,
} from "./core/solar";
import { resolveSite, formatPlace, canonicalAddress, type Place } from "./core/gazetteer";
import {
  decodeImageFile,
  placeInView,
  cloneReferenceImages,
  hitImageBody,
  handlePoint as imageHandlePoint,
  resizeImage,
  handleCursor,
  HANDLE_KEYS,
  ACCEPTED_IMAGE_TYPES,
  type ReferenceImage,
  type HandleKey,
} from "./core/referenceImage";
import MiniWindow from "./MiniWindow";
import ExportPopup from "./ExportPopup";
import {
  AssignIcon,
  CenterlinesIcon,
  CwTypeIcon,
  ElevationsIcon,
  EraseIcon,
  FloorLinesIcon,
  FramingIcon,
  PanIcon,
  PenIcon,
  PlanIcon,
  SelectIcon,
} from "./icons";
import StatisticsPanel from "./StatisticsPanel";
import {
  perimeterBounds,
  boundsHandlePoint,
  translatePerimeter,
  scalePerimeter,
  hitPerimeterBody,
  type Bounds,
} from "./core/perimeterTransform";
import { ControlsList, ViewModesInfo, StatisticsInfo, HELP_PANEL_TITLE, type HelpPanel } from "./HelpPanels";
import { buildCostEstimate, type PanelCostInput } from "./core/cost";
import {
  CW_TYPE_LABELS,
  CELL_TYPE_LABELS,
  CELL_TYPE_VLT,
  CELL_VIEW_MODES,
  CELL_VIEW_LABELS,
  type CwType,
  type CellType,
  type CellViewMode,
  STATS_MODES,
  isPerPanelStat,
  type StatsMode,
} from "./core/displayModes";

/**
 * Which way the CENTERLINES tool should split, decided by where the cursor sits INSIDE
 * the panel. This replaces the old Shift modifier: the same pointer position that
 * already chooses the SPACING now also chooses the DIRECTION, so the whole tool is one
 * continuous gesture with nothing to hold down.
 *
 * THE RULE — the panel's two DIAGONALS cut it into four triangles, and the lines you
 * get run PARALLEL TO THE NEAREST EDGE:
 *
 *        +-----------------+
 *        | \     rows    / |     LEFT + RIGHT triangles -> VERTICAL centerlines
 *        |   \         /   |                              (equal-width COLUMNS)
 *        | cols \   / cols |     TOP + BOTTOM triangles -> HORIZONTAL centerlines
 *        |       X         |                              (equal-height ROWS)
 *        |   /         \   |
 *        | /     rows    \ |
 *        +-----------------+
 *
 * WHY this way round, and not the reverse: the COUNT is driven by the cursor's X for
 * columns and its Y for rows, so the axis the user sweeps ALONG has to be the axis that
 * gets subdivided — otherwise the drag would select a split whose spacing does not
 * respond to the movement making it. Sweeping across the middle of a wall widens and
 * narrows COLUMNS; running up its left or right end does the same for ROWS. Reversing
 * the mapping puts a horizontal sweep in the rows region, where moving sideways changes
 * nothing — the gesture goes dead.
 *
 * Normalising each offset by the panel's own half-extent makes it ASPECT-AWARE, which
 * is what lands the common case: a wall elevation is far wider than it is tall, so the
 * left/right triangles cover most of its area and a cursor almost anywhere means
 * COLUMNS — with ROWS a short move toward the top or bottom edge away. A tall narrow
 * panel inverts that and favours rows. A raw distance-to-nearest-edge test in feet would
 * instead answer "rows" nearly everywhere on a wide panel, since its top and bottom are
 * genuinely closer to most points than its ends are.
 */
function divideAxisAt(p: Point, lo: number, hi: number, panelH: number): "v" | "h" {
  const halfW = (hi - lo) / 2;
  const halfH = panelH / 2;
  // Degenerate panel: no meaningful diagonals, so keep the historical default.
  if (halfW <= 1e-9 || halfH <= 1e-9) return "v";
  const u = (p.x - (lo + halfW)) / halfW; // -1 at the left edge, +1 at the right
  const v = (p.y - halfH) / halfH; //        -1 at the baseline, +1 at the top
  // Ties (exactly on a diagonal) fall to columns — the more common split.
  return Math.abs(u) >= Math.abs(v) ? "v" : "h";
}

/** Pixel tolerance for hit-testing vertices/segments. */
const HIT_TOLERANCE_PX = 9;
/** Pixel tolerance for "click the first vertex to close". */
const CLOSE_TOLERANCE_PX = 12;
/**
 * Compact identity for a reference-image list: everything the user can CHANGE, and
 * nothing they cannot. Used by the auto-save no-op guard in place of JSON.stringify,
 * which would otherwise serialise every image's data URL on every render. `src` is
 * immutable for a given id, so omitting it loses no information.
 */
function imageSignature(list: ReferenceImage[]): string {
  return list.map((i) => `${i.id}:${i.x}:${i.y}:${i.w}:${i.h}:${i.opacity}:${i.locked}`).join("|");
}

/**
 * Pixel half-size of a reference image's resize-grip HIT area. Larger than the grip's
 * drawn half-size (--ref-image-handle-size) so the target is comfortable without
 * making the drawn square heavier — the usual "hit area bigger than the paint" rule.
 */
const IMAGE_HANDLE_HIT_PX = 7;
/** Pointer travel (px) before a press-drag counts as a handle pull rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/**
 * Cooldown (ms) between consecutive FORWARD layer drills (Elevations → Panels →
 * Assembly). Navigation is now a single click, so a habitual DOUBLE-click would
 * otherwise fire two presses and jump two layers at once; ignoring a second drill
 * within this window makes one click reliably advance exactly one layer while still
 * allowing deliberate sequential navigation (which naturally pauses to reacquire the
 * target after each zoom animation).
 */
const DRILL_COOLDOWN_MS = 300;

/**
 * The saved-project id the GUIDED DEMO always writes to. Fixed rather than generated so
 * re-running the demo overwrites its own entry instead of stacking copies in the user's
 * library, and so stepping Back across the save is a no-op rather than a duplicate.
 */
const DEMO_SAVED_ID = "oligo-demo-tour";

/**
 * sessionStorage key recording that the Demo button has been used this visit, which stops
 * its first-run pulse. Session-scoped on purpose — see `demoSeen`.
 */
const DEMO_SEEN_KEY = "oligo.demoSeen.v1";




/**
 * A stable POSITION identity for a grid cell within its panel — `edge` plus the cell's
 * four model-space bounds (rounded to defeat float jitter). Used by the cell PAINT drag
 * to dedupe cells already swept, so re-entering a cell mid-drag doesn't re-add it. This
 * is a POSITION key (one specific cell), distinct from `cellShapeColors.keyOf` which is a
 * SHAPE/Material-ID key (every same-size cell shares it).
 */
function cellPosKey(
  edge: number,
  c: { x0: number; x1: number; y0: number; y1: number },
): string {
  return `${edge}|${c.x0.toFixed(4)}|${c.y0.toFixed(4)}|${c.x1.toFixed(4)}|${c.y1.toFixed(4)}`;
}

/* (The SHORT view-mode labels were dropped with the two-column grid: the picker that
   replaced it is full width, so every mode shows its full name.) */



/** 8-point compass labels, indexed by round(bearing / 45) — N at 0°, clockwise. */
const CARDINALS_8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** The 8-point cardinal label for a true compass bearing (deg, 0 = N, CW). */
function bearingToCardinal8(bearingDeg: number): string {
  const b = ((bearingDeg % 360) + 360) % 360;
  return CARDINALS_8[Math.round(b / 45) % 8];
}

/**
 * Orientation HEAT scalar in [0,1] for a true compass bearing — drives the
 * Orientation Heatmap colour ramp (0 = cool/blue, 1 = warm/red). Anchored to the
 * brief: NORTH-facing glass is coolest (0, blue) and WEST-facing is hottest (1,
 * red), reflecting that west elevations take the harshest afternoon solar load and
 * north the least. Heat rises clockwise N→E→S→W over the first 270°, then falls
 * back W→N over the final 90° (through NW), so it is continuous around the compass.
 */
function bearingToHeatT(bearingDeg: number): number {
  const b = ((bearingDeg % 360) + 360) % 360;
  return b <= 270 ? b / 270 : 1 - (b - 270) / 90;
}

/**
 * LIVE direct-sun readout for the Orientation Heatmap — the second label line under
 * each cell's cardinal. Given a facade's true compass bearing and the active Solar
 * Study settings, reports how much of the DIRECT beam the facade catches RIGHT NOW
 * (the studied day + hour): the cosine of the sun's angle of incidence on the wall,
 * as a percentage (the industry-standard "direct exposure factor" that scales beam
 * solar gain). It is constant across a panel's cells — they share the wall plane — so
 * every cell of a facade shows the same value, and it updates live as the Solar Study
 * sun is scrubbed. Returns:
 *   "—"   when the sun is BELOW the horizon (night — no direct sun on any facade),
 *   "0%"  when the sun is up but BEHIND the wall (self-shaded — no direct beam),
 *   "NN%" otherwise (100% = sun square-on the facade, the harshest direct load).
 */
function sunHitLabel(bearingDeg: number, solar: SolarSettings): string {
  const pos = sunPosition(solar.latitude, solar.dayOfYear, solar.hour);
  if (pos.altitude <= 0) return "—"; // sun below horizon → no direct sun anywhere
  const f = wallIncidenceCos(pos, bearingDeg);
  if (f <= 0) return "0%"; // sun behind the facade → self-shaded
  return `${Math.round(f * 100)}%`;
}
/**
 * Rounding step (feet) used to BUCKET cell shapes into "same shape" groups for the
 * Material-ID view and the unique-cell count: two cells whose width AND height match
 * to this resolution share a colour. 1e-3′ ≈ 0.012″ — finer than any real tolerance,
 * so it only collapses floating-point dust, not genuinely distinct sizes.
 */
const CELL_SHAPE_EPS = 1e-3;

/** Snap increment (feet) for the Mullions tool's drag-to-set offset (0.25′). */
const MULLION_STEP = 0.25;
/** Pixel tolerance for grabbing a rectangle's TOP edge to resize its height. */
const TOP_EDGE_TOLERANCE_PX = 6;
/**
 * Pixel tolerance for the "intelligent" floor-plate increment snap: when an
 * increment has been established (the first plate above ground), the cursor's
 * elevation magnetically snaps to the nearest multiple of that increment if it
 * lands within this many screen pixels of it. Converted to model units per-frame
 * via `pixelsToModel` so the magnet feels the same at any zoom.
 */
const FLOORPLATE_SNAP_PX = 30;
/**
 * Pixel tolerance for the Eraser tool's "nearest division line" hit-test: while
 * armed, a panel's vertical division / horizontal divider within this many screen
 * pixels of the cursor is targeted for deletion (the nearest one wins). Converted
 * to model units per-frame via `pixelsToModel` so it feels the same at any zoom.
 */
const ERASE_SNAP_PX = 12;
/** Minimum per-panel height (model units) — keeps every rectangle visibly sized. */
const MIN_UNRAVEL_HEIGHT = 0.5;

/**
 * The line currently targeted for deletion by the armed Eraser tool, or null.
 * For panel division lines (`"v"` or `"h"`): `edge` is the panel's edge index
 * and `index` is the position in that axis's offset array. For floor plates
 * (`"fp"`): `edge` is unused (-1) and `index` is the position in `floorPlates`.
 */
type EraseTarget = { edge: number; axis: "v" | "h" | "fp"; index: number };

type Mode = "draw" | "edit";
/** Curve type for newly drawn segments. */
type CurveType = "line" | "arc";

/**
 * Floor on the height handed to a floating window that STACKS under another one
 * (see `useStackedBelow`). If the window above has grown tall enough to leave less
 * than this, the one below overhangs the stage rather than shrinking to a sliver:
 * a title bar and a row or two of content is the least that is still worth showing.
 */
const MIN_STACKED_WIN_HEIGHT = 160;

/** Maximum number of undo steps retained. */
const HISTORY_LIMIT = 100;
/**
 * A snapshot of the AUTHORED document for undo/redo. Holds only what the user
 * actively creates/edits — the perimeter geometry and the per-panel unravel
 * heights/cells — not transient view state (viewport, selection, mode) or the
 * saved-library list. All values are immutable (perimeter ops + the height/cell
 * maps are replaced, never mutated), so a snapshot is a cheap reference copy.
 */
interface DocSnapshot {
  perimeter: Perimeter;
  unravelHeights: Record<number, number>;
  unravelCells: Record<number, number>;
  /** Per-edge-index vertical division-line offsets (Subtractive tool). Replaced, never mutated. */
  panelDivisions: Record<number, number[]>;
  /** Per-edge-index HORIZONTAL divider offsets (Centerlines, row split). Replaced, never mutated. */
  panelDividersH: Record<number, number[]>;
  /** Per-edge vertical / horizontal mullion half-width offsets (Mullions tool). */
  panelMullionsV: Record<number, number>;
  panelMullionsH: Record<number, number>;
  /** Imported PDF/PNG/JPEG underlays placed in model space. In the snapshot so that
   *  moving, resizing, importing, and deleting one all undo like any other edit. */
  referenceImages: ReferenceImage[];
  /** Per-edge UNITIZED per-cell framing insets (Framing tool, Unitized system).
   *  panel edge → cell index → the four edge insets. Replaced, never mutated. */
  panelCellFraming: Record<number, Record<number, CellInsets>>;
  /** Per-edge UNITIZED per-cell glazing TYPE (Type tool): panel edge → cell index →
   *  Vision / Spandrel / Opaque. Replaced, never mutated. */
  panelCellTypes: Record<number, Record<number, CellType>>;
  /** Per-edge assigned curtain-wall system (Stick / Unitized). Replaced, never mutated. */
  panelCwType: Record<number, CwType>;
  unravelHeight: number;
  /** Placed floor-plate elevations (model Y). Replaced, never mutated. */
  floorPlates: number[];
}

/**
 * One row of the left panel's Display ▸ Visibility list: an eye / eye-off icon plus the
 * element's name, the whole row clickable. Shows or hides that element on the canvas
 * WITHOUT deleting it — a view preference, never document state, so it is not undoable.
 *
 * These used to be eye icons embedded in the right edge of the Floor Lines / Centerlines
 * / Framing / Glazing / Dim tool buttons, which made one control mean two things ("arm
 * this tool" AND "show this element"). Splitting them out is the layers-panel pattern
 * from Rhino / Revit: tools edit, this list controls what's drawn. `disabled` gates a row
 * whose element can't exist yet (e.g. outside the elevation views).
 */
function VisRow({
  label,
  full,
  visible,
  disabled,
  onToggle,
}: {
  /** Short label shown in the two-column grid. */
  label: string;
  /** Full name for the tooltip — the grid clips long labels, so this is where the
   *  unabbreviated name lives ("Floors" → "floor lines"). Defaults to `label`. */
  full?: string;
  visible: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const name = full ?? label;
  return (
    <button
      type="button"
      className={`panel__vis-row ${visible ? "" : "is-hidden"}`}
      onClick={onToggle}
      disabled={disabled}
      // Checked = currently SHOWN, so screen readers read the row's state the same way the
      // eye icon reads visually.
      //
      // `switch` rather than `aria-pressed`, matching the Statistics chips: the app now
      // draws one line between the two. An independent ON/OFF SETTING that takes effect
      // immediately is a switch (these rows, the reading chips); a button that ARMS a tool
      // — where "pressed" means "this owns the next click" — keeps aria-pressed (Pan,
      // Select, Delete, Pen, the cluster). These two lists are the same control in the same
      // kind of window and were announcing themselves differently.
      role="switch"
      aria-checked={visible}
      title={
        disabled
          ? `${name} — nothing to show in this view yet`
          : `${visible ? "Hide" : "Show"} ${name.toLowerCase()} on the canvas`
      }
    >
      {visible ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
      )}
      <span className="panel__vis-label">{label}</span>
    </button>
  );
}

export default function PolylineTool() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // CURSOR CROSSHAIRS (perimeter view). Two thin full-canvas lines that track the
  // pointer. Driven by a dedicated native pointermove listener writing CSS transforms
  // directly to these elements (no React state / scene redraw), so they follow the
  // cursor with minimal latency. crosshairRef = container (visibility), V/H = the lines.
  const crosshairRef = useRef<HTMLDivElement>(null);
  const crosshairVRef = useRef<HTMLDivElement>(null);
  const crosshairHRef = useRef<HTMLDivElement>(null);

  // --- DATA MODEL (source of truth) ---
  const [perimeter, setPerimeter] = useState<Perimeter>(emptyPerimeter);

  // --- VIEWPORT ---
  const [viewport, setViewport] = useState<Viewport>(() => defaultViewport(800, 600));
  // Always-current viewport, so the zoom animator can read the live start state
  // without a stale closure.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  // requestAnimationFrame id for an in-flight viewport tween (null = none).
  const animRef = useRef<number | null>(null);

  // --- UNROLL TRANSITION (3D massing unrolling into the elevations strip) ---
  // Declared up here (with the other refs) because the pointer / wheel / keyboard
  // handlers below all SKIP a running transition, and they are defined long before
  // the transition's own start/finish callbacks are.
  //
  // `unrollFrameRef` non-null == the transition owns the canvas: paint() draws the
  // animated massing instead of the 2D scene, and every input skips to the end via
  // `skipUnrollRef` (assigned once finishUnroll exists). Frame state lives in a REF,
  // not React state, so 60fps of `t` never re-renders the component tree.
  const unrollFrameRef = useRef<UnrollFrame | null>(null);
  const unrollRafRef = useRef<number | null>(null);
  const skipUnrollRef = useRef<() => void>(() => {});
  /**
   * Which way the transition is currently running: "unroll" drives t 0 -> 1 and ends in
   * the elevation views; "fold" drives t 1 -> 0 and ends on the footprint. The same
   * frame and the same tween serve both — only the direction and the finisher differ —
   * so folding back is the unrolling played in reverse, not a second animation.
   */
  const unrollDirRef = useRef<"unroll" | "fold">("unroll");
  /**
   * Published handle to the Unroll Geometry / Fold to Plan toggle, for the keyboard
   * handler defined ABOVE where that callback can be built (it needs `startUnroll`,
   * which needs the unravel layout). Same pattern as `skipUnrollRef`; assigned once
   * the callback exists.
   */
  const toggleUnrollViewRef = useRef<() => void>(() => {});

  /** Cancel any in-flight viewport animation (e.g. when the user takes over). */
  const cancelAnim = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  /**
   * Smoothly animate the viewport to `target` (ease-out, centre-anchored) so
   * double-click zoom-in, Esc zoom-out, and fit-on-load glide instead of jumping.
   * The motion is anchored to the viewport CENTRE (see lerpViewport), so the view
   * heads straight for its destination with no off-centre swing. Trivial moves snap
   * instantly; any in-flight tween is cancelled first.
   */
  const animateViewport = useCallback((target: Viewport, duration = 280) => {
    cancelAnim();
    const from = viewportRef.current;
    const { w, h } = sizeRef.current;
    if (
      Math.abs(from.scale - target.scale) < 1e-3 &&
      Math.abs(from.originX - target.originX) < 0.5 &&
      Math.abs(from.originY - target.originY) < 0.5
    ) {
      setViewport(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      if (t >= 1) {
        setViewport(target);
        animRef.current = null;
        return;
      }
      setViewport(lerpViewport(from, target, easeOut(t), w, h));
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }, [cancelAnim]);

  // Stop any running tween if the component unmounts mid-animation.
  useEffect(() => () => cancelAnim(), [cancelAnim]);


  // --- TOOL / PRECISION SETTINGS ---
  const [mode, setMode] = useState<Mode>("draw");
  const [curveType, setCurveType] = useState<CurveType>("line");
  // Snap-to-grid is permanently ON: placing/moving points always rounds to
  // `gridSpacing`. There is no toggle (it is a fixed precision guarantee), so this
  // is a constant rather than state. The grid itself is never drawn — only the
  // snapping uses `gridSpacing`.
  const snapEnabled = true;
  // Fixed 1 ft snap grid; no longer user-editable. Snapping always rounds to this.
  const gridSpacing = 1;

  // --- UNRAVEL VIEW (unwrap edges into rectangles / "spaces") ---
  const [unravelOn, setUnravelOn] = useState(false);
  // Fixed default spacing between unwrapped panels (10 ft). No longer user-editable
  // from the panel; change this constant to retune the strip layout.
  const unravelGap = 10;
  // DEFAULT height (model units, 1u = 1ft) — seeds any panel that hasn't been
  // individually resized. Default reuses DEFAULT_WALL_HEIGHT_FT so the unwrap and
  // 3D massing agree. The global "Height" input edits this value (and clears all
  // per-panel overrides, making it a "make them all uniform" action).
  const [unravelHeight, setUnravelHeight] = useState(DEFAULT_WALL_HEIGHT_FT);
  // PER-PANEL height overrides, keyed by ORIGINAL edge index (stable across gap /
  // order changes). A panel's effective height = override[index] ?? unravelHeight.
  // Stale keys for edges that no longer exist are harmless (ignored); new edges
  // fall back to the default. Set by dragging a rectangle's top edge or by typing
  // in its on-rectangle height input.
  const [unravelHeights, setUnravelHeights] = useState<Record<number, number>>({});
  // Draft text for the on-rectangle height inputs while the user is typing. Keyed
  // by edge index; an entry exists only while a field is focused/edited. Committing
  // (Enter/blur) clamps the value into unravelHeights and drops the draft so the
  // field returns to showing the live effective height. This keeps typing free
  // (clamp doesn't fight mid-edit) while the model stays the source of truth.
  const [unravelInputDraft, setUnravelInputDraft] = useState<Record<number, string>>({});
  // Which per-panel height field (by edge index) is currently focused/being
  // edited, or null if none. Drives a DISPLAY-ONLY swap: when idle the field
  // shows the value WITH the foot tick (e.g. `10.00′`, matching the canvas WIDTH
  // label); when focused it shows the PLAIN number so typing + parsing work
  // normally. This never touches the committed model value.
  const [focusedUnravelInput, setFocusedUnravelInput] = useState<number | null>(null);
  // PER-PANEL cell split count, keyed by ORIGINAL edge index (default 1 = no
  // split). Drawn as N-1 division lines inside the rectangle.
  const [unravelCells, setUnravelCells] = useState<Record<number, number>>({});
  // PER-PANEL vertical DIVISION lines placed by the Subtractive tool, keyed by
  // ORIGINAL edge index. Each value is a list of OFFSETS in model units from the
  // panel's left edge (seg.x0); offsets snap to the global 1 ft grid. Distinct from
  // unravelCells (which is N equal splits) — these are user-placed mullions; the
  // Subtractive tool writes EQUAL-COLUMN splits here, but the store itself is just
  // arbitrary offsets (so divisions can accumulate across multiple splits).
  const [panelDivisions, setPanelDivisions] = useState<Record<number, number[]>>({});
  // PER-PANEL HORIZONTAL dividers placed by the Centerlines tool when the cursor picks the
  // keyed by ORIGINAL edge index. Each value is a list of OFFSETS in model units from
  // the panel's BASELINE (y = 0). The horizontal mirror of `panelDivisions`: instead of
  // splitting a panel into equal-width columns, these split it into equal-height rows.
  const [panelDividersH, setPanelDividersH] = useState<Record<number, number[]>>({});
  // Subtractive tool armed? Enabled only with a panel selected (focusedPanel). While
  // on, hovering the selected panel recommends an equal-column split (or equal-row
  // split, chosen by cursor position); click places it. Esc / re-click / deselect disarms it.
  const [subtractiveOn, setSubtractiveOn] = useState(false);
  // Subtractive HOVER PREVIEW: the raw cursor model point inside the selected panel
  // before a press, or null. The render builder picks the split AXIS by `divideAxisAt`
  // (vertical columns from .x, horizontal rows from .y). During a drag the array
  // preview lives in `divideDraft` instead.
  const [divideHover, setDivideHover] = useState<Point | null>(null);
  // The in-progress division array being dragged (committed on pointer-up): the target
  // edge, the split AXIS ("v" = vertical columns, model-x; "h" = horizontal rows,
  // model-y), and the line positions for that axis. null when not dragging.
  const [divideDraft, setDivideDraft] = useState<{ edge: number; axis: "v" | "h"; lines: number[] } | null>(null);
  // SELECT tool armed (the Select button, first in the bar)? The OBJECT-selection tool —
  // the arrow/pointer every design app opens with. While on, a left click picks a
  // REFERENCE IMAGE (imported underlay) and its grips resize it; perimeter vertices are
  // deliberately inert here, because vertex editing belongs to Edit. Keeping the two
  // apart is what lets a click be unambiguous: Select acts on objects, Edit acts on the
  // shape. Mutually exclusive with the other armed tools.
  const [selectMode, setSelectMode] = useState(false);
  // WHOLE-SHAPE SELECTION (Select tool, Plan phase). The drawn perimeter can be picked as
  // ONE object and moved or scaled by its frame — the same gesture set as a reference
  // underlay, so the tool means one thing regardless of what it is pointed at. Distinct
  // from `selectedVertex`, which is Edit's per-point selection.
  const [perimeterSelected, setPerimeterSelected] = useState(false);
  /** Grip of the whole-shape frame under the cursor, for the hover highlight + cursor. */
  const [hoveredPerimeterHandle, setHoveredPerimeterHandle] = useState<HandleKey | null>(null);
  // PAN tool armed (the Pan button)? While on, a LEFT click-drag on the canvas moves the
  // VIEW instead of running whatever tool would otherwise own the click — the same drag
  // the middle / right mouse buttons already do, made available to a plain left drag for
  // trackpad users. Works in every view/tab and takes precedence over all other tools.
  const [panMode, setPanMode] = useState(false);
  // SPACEBAR held? The industry-standard TEMPORARY pan modifier (Rhino / Illustrator /
  // Figma): hold Space to pan with a left drag, release to fall straight back to the tool
  // that was armed before — no toggling, no state to remember.
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Pan is live when the button is armed OR Space is held. Read by the pointer handlers
  // (left-drag = pan) and by the canvas cursor (grab / grabbing).
  const panArmed = panMode || spaceHeld;
  // Eraser tool armed? The DESTRUCTIVE counterpart to Subtractive: deletes division
  // lines on the focused panel AND floor plates (global — no panel required). Enabled
  // whenever the unravel view is open. While on, hovering near any erasable line
  // highlights it; a click removes it. Mutually exclusive with Subtractive/Additive.
  const [eraserOn, setEraserOn] = useState(false);
  // Eraser HOVER HIGHLIGHT: the line currently targeted for deletion (nearest to
  // the cursor within ERASE_SNAP_PX — a panel division or a floor plate), or null.
  // The render builder turns it into a distinct deletion-highlight overlay.
  const [eraseHover, setEraseHover] = useState<EraseTarget | null>(null);
  // Eraser DRAG COLLECTED: the set of lines accumulated during an active click-drag
  // stroke, committed as one undo step on pointer-up. Empty when not dragging.
  const [eraseDragCollected, setEraseDragCollected] = useState<EraseTarget[]>([]);
  // Eraser VERTEX DRAG COLLECTED (perimeter view): the perimeter vertex INDICES the
  // cursor has swept over during an active Erase stroke, highlighted in the delete
  // colour and removed together as one undo step on pointer-up. Empty when not dragging.
  const [eraseVertexCollected, setEraseVertexCollected] = useState<number[]>([]);
  // Eraser EDGE HOVER (perimeter view): the index of the closed-perimeter EDGE the
  // cursor is over (and not over a vertex), highlighted in the delete colour; a click
  // removes that one segment and reopens the loop there (keeping both vertices). -1
  // when not targeting an edge.
  const [eraseEdge, setEraseEdge] = useState(-1);
  // Eraser EDGE DRAG COLLECTED (perimeter view): the perimeter EDGE indices the cursor
  // has swept over during an active Erase stroke, highlighted in the delete colour and
  // removed together (with any vertices, plus orphaned vertices) as one undo step on
  // pointer-up. Empty when not dragging.
  const [eraseEdgeCollected, setEraseEdgeCollected] = useState<number[]>([]);
  // CELL VIEW MODE — a purely VISUAL display mode for the elevation/Panels view
  // (the "View" button, top-center row next to Statistics). "normal" is the default look; "materialId"
  // tints every grid CELL by its geometric SHAPE (width × height) in a unique colour
  // — like Lumion's Material ID — so identical cells across the whole project read in
  // the same colour at a glance. Not a tool (it arms nothing, mutates no document
  // state) and not persisted: it is an ephemeral way of LOOKING at the model. The
  // "View" button opens a dropdown menu listing the CELL_VIEW_MODES to pick from.
  const [cellViewMode, setCellViewMode] = useState<CellViewMode>("normal");
  // CURTAIN-WALL TYPE — assigned PER PANEL (edge index → system). Each panel carries at
  // most ONE system (Stick or Unitized); the "CW Type" menu sets it for the focused
  // panel. Switching a panel's type clears that panel's framing of the OTHER system
  // (its centerlines are kept) — see selectCwType — so a panel never mixes Stick bands
  // and Unitized cell insets. Absent = no system chosen for that panel yet.
  const [panelCwType, setPanelCwType] = useState<Record<number, CwType>>({});
  // Is the CW Type two-option chooser menu open?
  const [cwMenuOpen, setCwMenuOpen] = useState(false);
  // MULLIONS tool armed? Only available once a CW Type is chosen. Mutually exclusive
  // with the rest of the bottom-left cluster.
  const [mullionsOn, setMullionsOn] = useState(false);
  // GLAZING submenu open? The "Glazing" button opens a small None / Vision / Spandrel /
  // Opaque chooser (drop-up, same rules as the CW Type menu): the button turns blue while
  // it's open and is mutually exclusive with the rest of the bottom-left cluster (arming any
  // other tool, or a canvas press, closes it). Picking an option LOADS the brush below — it
  // does not assign anything by itself. Reusing this single flag keeps the cluster
  // mutual-exclusion plumbing (disarmClusterTools / Esc / gate-loss) working unchanged.
  const [typeOn, setTypeOn] = useState(false);
  // The GLAZING BRUSH: the type the Glazing tool is currently LOADED with, or null when the
  // tool is not armed.
  //
  // Glazing works like a paint tool, not like a property editor: you pick the material FIRST
  // (from the submenu), then apply it to cells — click one, or click-drag across a run of
  // them and release to commit. That ordering is what makes a drag possible at all; with the
  // old select-then-assign order a drag could only ever build a selection, and every stroke
  // cost a round trip back to the menu. It also matches how the same job is done in the
  // tools this audience already uses (a loaded brush, applied by stroke).
  //
  // "none" is a real brush value — painting it CLEARS the type (back to untyped / no hatch),
  // so erasing an assignment is the same gesture as making one, not a separate mode.
  const [glazingBrush, setGlazingBrush] = useState<CellType | "none" | null>(null);
  // Visibility of the per-cell TYPE hatches on the canvas (Display ▸ Visibility ▸ Glazing). A
  // view preference (not model data), like the framing / centerline visibility flags. The
  // eye is gated on `hasAnyCellType` (NOT the Type button's `canType`), so it stays usable
  // for showing/hiding hatches whenever any wall border carries a type, selection or not.
  const [typeVisible, setTypeVisible] = useState(true);
  // --- EXPORT (select walls -> download CAD geometry) ---
  // When armed, a left-drag in the unravel view sweeps a MARQUEE that selects the
  // panels (walls) it intersects; releasing with a non-empty selection opens the
  // export popup. Mutually exclusive with the other armed tools. Unravel-only.
  const [exportSelectMode, setExportSelectMode] = useState(false);
  // ORIGINAL edge indices currently selected (highlighted on the canvas). Persists
  // after release so the user sees what they exported until they reselect / leave.
  const [exportSelection, setExportSelection] = useState<Set<number>>(() => new Set());
  // Live marquee rectangle in MODEL space while dragging a selection, else null.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The selection the export popup is open for (null = popup closed). Snapshotted
  // on release so editing the live selection afterwards doesn't mutate the dialog.
  const [exportPopup, setExportPopup] = useState<Set<number> | null>(null);
  // Per-edge mullion HALF-WIDTH offsets (feet), set by dragging a grid line with the
  // Mullions tool (Stick system). V = applied to every vertical grid line of a panel,
  // H = every horizontal one. Each grid line renders as a pair of faces at ±offset.
  const [panelMullionsV, setPanelMullionsV] = useState<Record<number, number>>({});
  const [panelMullionsH, setPanelMullionsH] = useState<Record<number, number>>({});
  // UNITIZED per-cell framing (Framing tool under the Unitized system): panel edge →
  // cell index (in cellsForEdge order) → the inward inset of each of the cell's four
  // edges (feet). Unlike the Stick maps above (one offset per axis for the whole
  // panel), framing here is per-cell, per-edge. Reset for a panel when its centerlines
  // change (clearPanelMullion), so new cells always start un-framed.
  const [panelCellFraming, setPanelCellFraming] = useState<Record<number, Record<number, CellInsets>>>({});
  // UNITIZED per-cell TYPE (Type tool): panel edge → cell index (in cellsForEdge order) →
  // the cell's glazing type (Vision / Spandrel / Opaque). Assigned in the Wall Border phase:
  // the user SELECTS cells (click = one, Shift+click = the whole Material-ID family) and then
  // picks a type, which applies to the selection. Drives the per-cell hatch overlay. Absent =
  // untyped (drawn with no hatch). Visibility follows `typeVisible`.
  const [panelCellTypes, setPanelCellTypes] = useState<Record<number, Record<number, CellType>>>({});
  // Mullions-tool hover: which axis's grid lines are under the cursor on the focused
  // panel ("v"/"h"), or null. Highlights the whole set (they adjust together).
  const [mullionHover, setMullionHover] = useState<"v" | "h" | null>(null);
  // Live drag preview: the offset being dragged for an axis on a panel, or null.
  const [mullionDraft, setMullionDraft] = useState<{ edge: number; axis: "v" | "h"; offset: number } | null>(null);
  // Framing-tool hover (Unitized): the cell + which of its four edges the cursor is
  // nearest on the focused panel, or null. Highlights that single cell edge so the
  // user sees the one face that a drag will move. Panels tab only.
  const [cellEdgeHover, setCellEdgeHover] = useState<{ cellIndex: number; side: "top" | "right" | "bottom" | "left" } | null>(null);
  // Live drag preview for unitized cell framing: which cell edge is being dragged on a
  // panel, the in-progress inset offset, and whether Shift is held (all four edges).
  const [cellFrameDraft, setCellFrameDraft] = useState<
    { edge: number; cellIndex: number; side: "top" | "right" | "bottom" | "left"; offset: number; all: boolean } | null
  >(null);
  // The panel (edge index) currently zoomed-to via double-click, or null. Esc
  // restores the full-strip fit and clears this.
  const [focusedPanel, setFocusedPanel] = useState<number | null>(null);
  // The ACTIVE curtain-wall type: the FOCUSED panel's assigned system, or null when no
  // panel is focused / the focused panel has no system yet. Derived from the per-panel
  // map so all the existing Framing logic (which already operates on the focused panel)
  // reads "this panel's system" with no further changes. Drives the Framing tool's
  // Stick-vs-Unitized behaviour, the menu's active mark, and button enablement.
  const cwType: CwType | null = focusedPanel !== null ? panelCwType[focusedPanel] ?? null : null;
  // The grid CELL (within focusedPanel) currently zoomed-to in the Assembly phase,
  // identified by its model-space rectangle bounds, or null. Set by the Assembly nav
  // button (defaults to the top-left-most cell) and by double-clicking a cell here.
  // Esc backs out one layer at a time (cell → panel → strip), so this is the deepest
  // navigation level. Always cleared whenever focusedPanel is cleared / view changes.
  const [focusedCell, setFocusedCell] = useState<{ edge: number; x0: number; x1: number; y0: number; y1: number } | null>(null);
  // WALL BORDER (panels) phase: the set of grid cells currently HIGHLIGHTED, each by its
  // model-space rectangle bounds + owning edge. This carries two related jobs:
  //   • with NO glazing brush loaded — a plain SELECTION (click one cell, Shift+click for the
  //     whole Material-ID family), which switches the dimension readout to the picked cells.
  //   • with a brush loaded — the LIVE PREVIEW of a paint stroke: it fills in as the drag
  //     sweeps cells, and is cleared on release once the type is actually applied.
  // Both read the same on canvas (the blue cell tint), which is the point: the highlight
  // always means "these cells are what the next action acts on".
  // Transient UI (NOT persisted): cleared on panel switch / view toggle / grid edit.
  const [selectedCells, setSelectedCells] = useState<
    Array<{ edge: number; x0: number; x1: number; y0: number; y1: number }>
  >([]);
  // PANELS phase only: when true, the focused panel is dimensioned by its OVERALL length +
  // height instead of the per-column / per-row grid. Turned on by clicking the empty canvas
  // once nothing is selected (the camera stays put — no zoom-out); reset to the grid when
  // cells are selected (effect below) or another panel is focused (zoomToPanel). Transient.
  const [panelDimsOverall, setPanelDimsOverall] = useState(false);
  // PANELS phase only: index (into cellsForEdge(focusedPanel)) of the grid cell the
  // cursor is hovering, or -1 for none. Drives a per-cell highlight so a zoomed-in,
  // subdivided panel visibly reads as a set of individually navigable cells. Stored
  // as an index (not a rectangle) so a hover over the SAME cell bails the re-render
  // (number compare), matching the other hovered-* indices. Only meaningful while a
  // split panel is focused and we are not yet in the deeper Assembly cell zoom.
  const [hoveredCell, setHoveredCell] = useState(-1);
  // ASSEMBLY phase only (a single cell zoomed-to via double-click, focusedCell set):
  // which of the focused cell's four edges the cursor is nearest (within a pixel
  // tolerance), or null for none. Drives the red edge-selection highlight so the
  // user can target an individual edge of the cell. One edge at a time; cleared
  // whenever the cursor is not near any edge or the phase changes.
  const [hoveredCellEdge, setHoveredCellEdge] = useState<"top" | "right" | "bottom" | "left" | null>(null);
  // --- FLOOR PLATES (horizontal level reference lines) ---
  // Placed floor-plate elevations stored in MODEL Y (so they pan/zoom with the
  // geometry instead of drifting in screen space — a floor level is a fixed
  // elevation). Drawn as ghosted dotted horizontal lines spanning the canvas.
  const [floorPlates, setFloorPlates] = useState<number[]>([]);
  // When armed, the "floor plate" tool shows a ghosted preview line tracking the
  // cursor's elevation; a left-click drops a plate there (click an existing plate
  // to remove it). Place as many as wanted. Esc / clicking the button disarms it.
  const [floorPlateMode, setFloorPlateMode] = useState(false);
  // VISIBILITY of the floor lines / centerlines / framing — view preferences (NOT model
  // data, so not persisted): false hides those elements from the elevation view without
  // deleting them. Each is toggled from the left panel's Display ▸ Visibility list (Floor
  // Lines / Centerlines / Framing).
  const [floorLinesVisible, setFloorLinesVisible] = useState(true);
  const [centerlinesVisible, setCenterlinesVisible] = useState(true);
  const [framingVisible, setFramingVisible] = useState(true);
  // VISIBILITY of the on-canvas DIMENSION text (panel width / per-column-row / cell
  // dimension labels AND the per-panel height input fields) across the Elevations,
  // Wall Border, and Cells tabs. Toggled ONLY by Display ▸ Visibility ▸ Dimensions (the
  // button itself has no action yet); this is the SINGLE source of truth, so no view
  // (Clean / Shadows) auto-hides dimensions. Visible by default.
  const [dimensionsVisible, setDimensionsVisible] = useState(true);

  // --- ONBOARDING HINT ---
  // A first-run hint centered on the empty canvas ("Sketch perimeter / or load project").
  // It is dismissed the instant the user interacts with ANYTHING (any pointerdown) and
  // never returns this session. Only shown while the canvas is genuinely empty (no
  // perimeter drawn yet).
  const [hintDismissed, setHintDismissed] = useState(false);
  const showHint = !hintDismissed && !unravelOn && perimeter.vertices.length === 0;
  // Dismiss on the first pointerdown anywhere (canvas, panel, nav, Projects panel…).
  useEffect(() => {
    if (!showHint) return;
    const dismiss = () => setHintDismissed(true);
    window.addEventListener("pointerdown", dismiss, { capture: true, once: true });
    return () => window.removeEventListener("pointerdown", dismiss, { capture: true });
  }, [showHint]);

  // --- HELP POPUP ---
  // The utility bar's "Help" button opens a small submenu (helpMenuOpen) that
  // picks ONE of three reference panels (helpPanel): the control list, the statistics
  // info, or the view-modes info. The submenu and a panel are mutually exclusive
  // (opening one closes the other). `helpOpen` (derived) means "any help UI is showing"
  // — it drives the button's active state and lets the global key handler defer Escape.
  // The chooser MENU still closes on an outside click (transient picker), but a chosen
  // PANEL is a STAY-OPEN reference: it survives canvas navigation and is dismissed only
  // by its × close button, the Help button, or Escape (so it can annotate on-screen items).
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [helpPanel, setHelpPanel] = useState<HelpPanel | null>(null);
  const helpOpen = helpMenuOpen || helpPanel !== null;
  const closeHelp = () => {
    setHelpMenuOpen(false);
    setHelpPanel(null);
  };

  // UNITS — the app is FEET-ONLY. Geometry has always been stored in feet; the Settings
  // popup that let the display switch to metric has been removed, so the display unit is
  // now fixed at imperial. core/units keeps its conversion helpers (fmtLength, parsing,
  // the renderer's tick labels all still route through them), which is what makes
  // re-introducing a unit switch a matter of restoring one control rather than
  // re-plumbing every readout.
  useEffect(() => {
    setUnitSystem("imperial");
  }, []);

  // --- FLOATING WINDOWS ---
  // Independent panels, each with its own title bar, laid out in two columns:
  //   LEFT   Overview -> Display
  //   RIGHT  (utility bar) -> Statistics -> Selected image
  //
  // (Collapse and drag were both removed: the title bars are plain labels now and every
  // window sits at a fixed anchor.)
  //
  // The head of each column anchors by CSS — Overview top-left, Statistics top-right
  // under the utility bar. The window BELOW gets a measured position instead, because
  // the height of the one above it is not knowable in CSS.
  const propsWinRef = useRef<HTMLDivElement>(null);
  const displayWinRef = useRef<HTMLDivElement>(null);
  const statsWinRef = useRef<HTMLDivElement>(null);
  const imageWinRef = useRef<HTMLDivElement>(null);

  /**
   * Measure `anchorRef`'s bottom edge and report the spot flush beneath it, in stage
   * coordinates — the position a window stacked under it should take, plus the height
   * that is actually LEFT below it.
   *
   * The height cap matters because the anchor can grow: Statistics now stacks as many
   * readings as are switched on. Without it a tall anchor pushes the window below off
   * the bottom of the stage, where it cannot be reached at all. Handing the window the
   * remaining space instead lets its own body scroll — it always stays on screen.
   *
   * A ResizeObserver covers the anchor changing HEIGHT (collapsing, or a section
   * appearing); it is pointed at the stage as well, so resizing the browser re-measures.
   * `deps` covers the cases a ResizeObserver cannot see: an anchor that is itself
   * positioned by an inline `top` moves without resizing, so whatever drives that has to
   * be listed.
   */
  const useStackedBelow = (
    anchorRef: React.RefObject<HTMLElement>,
    deps: React.DependencyList,
  ): React.CSSProperties | undefined => {
    const [pos, setPos] = useState<{ x: number; y: number; h: number } | null>(null);
    useLayoutEffect(() => {
      const win = anchorRef.current;
      const stage = wrapRef.current;
      if (!win || !stage) return;
      const measure = () => {
        const winRect = win.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        // Gap and margin live in the stylesheet (single source of truth), read back here
        // because the offset has to be computed in JS from a measured height.
        const css = getComputedStyle(win);
        const gap = parseFloat(css.getPropertyValue("--props-stack-gap")) || 8;
        const margin = parseFloat(css.getPropertyValue("--mini-offset")) || 12;
        const y = winRect.bottom - stageRect.top + gap;
        setPos({
          x: winRect.left - stageRect.left,
          y,
          // Floor: an anchor tall enough to leave no room still yields a usable window
          // (it simply overhangs) rather than one collapsed to its title bar.
          h: Math.max(MIN_STACKED_WIN_HEIGHT, stageRect.height - y - margin),
        });
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(win);
      ro.observe(stage);
      return () => ro.disconnect();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return pos ? { left: pos.x, top: pos.y, right: "auto", maxHeight: pos.h } : undefined;
  };

  // DISPLAY stacks under Overview in the LEFT column. Overview's height changes with the
  // sections that appear as the selection changes, which the ResizeObserver sees on its
  // own — so, like Selected image, it needs no extra dependency.
  const displayWinStyle = useStackedBelow(propsWinRef, []);
  // SELECTED IMAGE stacks under Statistics in the RIGHT column. Statistics is anchored by
  // CSS, so it only ever moves by changing its own height — which happens every time a
  // reading is toggled, and which the ResizeObserver sees on its own, leaving no extra
  // dependency to declare.
  const imageWinStyle = useStackedBelow(statsWinRef, []);

  /**
   * Which floating window was touched last, so it draws IN FRONT. Without this they all
   * share a z-index and DOM order decides which wins where two overlap — arbitrary from
   * the user's side. Overlap is real: a window that grows (Statistics, as readings are
   * switched on) can reach the one stacked beneath it, and clicking either should be
   * enough to bring it forward.
   */
  const [frontWin, setFrontWin] = useState<"props" | "display" | "stats" | "image">("props");

  // --- STATISTICS READINGS ---
  // Every reading switched ON in the Statistics window (top of the right column), as a
  // SET: the panel stacks all of them, so this is not a one-of-N pick.
  // "general" = the totals for the drawing; "irradiance" = the Irradiance (W/m²) diagram
  // (a Ladybug-style month×hour solar heatmap on the selected wall border); "insolation"
  // = its energy companion, the monthly Insolation (kWh/m²) bar chart for the same wall;
  // "wwr" = the Window-to-Wall Ratio readout for the selected wall border (Gross Opening +
  // Net Glazing methods, from the per-cell glazing types); "vlt" = the Visible Light
  // Transmittance readout for the same wall (per-type industry VLT values + the wall's
  // effective VLT). Toggled by the chips at the top of the panel — see STATS_MODES for
  // the full list and each one's phase gate.
  // Defaults to General: a statistics panel that opens showing nothing teaches nothing,
  // and General reads in both phases.
  const [statsModes, setStatsModes] = useState<StatsMode[]>(["general"]);
  // Which saved project's SOLAR STUDY popup is open (by id), or null. Owned here rather
  // than inside MiniWindow because the study is launched from TWO places: a project row's
  // ☀ button and the left panel's Display section. MiniWindow renders the popup.
  const [solarStudyId, setSolarStudyId] = useState<string | null>(null);
  /**
   * Toggle one reading on or off. The Statistics panel shows EVERY selected reading
   * stacked, so this is a set rather than a one-of-N pick — comparing General against
   * Irradiance means seeing both at once, not flipping between them.
   */
  const toggleStatsMode = useCallback((m: StatsMode) => {
    setStatsModes((prev) => (prev.includes(m) ? prev.filter((k) => k !== m) : [...prev, m]));
  }, []);

  /**
   * The readings that can actually be shown right now. The solar / glazing reads need a
   * wall orientation and assigned cell types, so they mean nothing on the footprint and
   * are filtered out in the Plan phase — but they stay in `statsModes`, so switching back
   * to Elevations restores exactly what was selected rather than making the user re-pick.
   * Kept in STATS_MODES order so the stack reads the same way every time, regardless of
   * the order the user happened to click them on.
   */
  const activeStatsModes = useMemo(
    () =>
      STATS_MODES.filter(({ key, unravelOnly }) => statsModes.includes(key) && (unravelOn || !unravelOnly)).map(
        ({ key }) => key as StatsMode,
      ),
    [statsModes, unravelOn],
  );
  // --- TRANSIENT INTERACTION STATE ---
  const [cursorModel, setCursorModel] = useState<Point | null>(null);
  // REVIT-STYLE DIMENSION ENTRY (perimeter draw). Once at least one vertex is down,
  // typing a number sets the EXACT length of the next segment: the cursor keeps
  // aiming the DIRECTION (the rubber band previews snapping to the typed length),
  // Enter commits the vertex at that distance, Esc cancels the entry, Backspace
  // edits it. null = not entering a dimension; otherwise the partial string typed
  // so far (e.g. "12" or "12.").
  const [dimInput, setDimInput] = useState<string | null>(null);
  // Latest cursor model point + dim-entry string, mirrored to refs so the global
  // keydown handler reads current values without re-subscribing on every move/keystroke.
  const cursorRef = useRef<Point | null>(null);
  cursorRef.current = cursorModel;
  const dimInputRef = useRef<string | null>(null);
  dimInputRef.current = dimInput;
  const [shiftHeld, setShiftHeld] = useState(false);
  const [selectedVertex, setSelectedVertex] = useState(-1);
  const [hoveredVertex, setHoveredVertex] = useState(-1);
  const [insertPreview, setInsertPreview] = useState<Point | null>(null);
  // Perimeter-mode hover-link: original edge index of the footprint edge under the
  // cursor in edit mode (-1 = none). Highlights the matching edge LINE (not the
  // wall panel) on the active saved thumbnail in the mini-window.
  const [hoveredEdge, setHoveredEdge] = useState(-1);
  // Unravel hover-link: original edge index of the unravel strip under the cursor
  // (-1 = none). Highlights that strip on the canvas and the matching edge on the
  // active saved thumbnail in the mini-window.
  const [hoveredUnravelEdge, setHoveredUnravelEdge] = useState(-1);
  // Unravel height-resize: original edge index whose rectangle TOP edge is under
  // the cursor (-1 = none). Drives the ns-resize cursor + the emphasised top edge,
  // and (on press) starts a height drag for that panel.
  const [hoveredUnravelTop, setHoveredUnravelTop] = useState(-1);
  // Vertex whose handles are actively being pulled during DRAW (for rendering),
  // or -1. Distinct from selection so it only fires while pulling a handle out.
  const [activeDrawHandle, setActiveDrawHandle] = useState(-1);

  // --- SAVED PERIMETERS (persisted to localStorage) ---
  // Initialised lazily from localStorage so saves survive a reload (load-on-mount
  // happens once during the initial render, not in an effect that could flash).
  const [saved, setSaved] = useState<SavedPerimeter[]>(() => loadSaved());
  // Which saved entry (if any) is currently loaded into the editor — used to
  // highlight it in the mini-window and to target the "Update" action.
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  // The name typed for a sketch that has NOT been saved yet. Once saved, the entry's own
  // `name` is the single source of truth and this is cleared — the field then edits the
  // saved project directly (renameSavedEntry), so the panel and the Projects list can
  // never disagree about what the project is called.
  const [projectNameDraft, setProjectNameDraft] = useState("");

  // --- REFERENCE IMAGES (imported PDF / PNG / JPEG underlays) ---
  // Placed in MODEL space beneath the drawing so a site plan or elevation can be traced
  // over. Part of the document (see DocSnapshot), so every placement, move, resize and
  // delete is undoable and persists with the project.
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  // Which underlay is selected — the one showing transform grips. null = none.
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  // Grip under the pointer, so it can highlight and set the resize cursor.
  const [hoveredImageHandle, setHoveredImageHandle] = useState<HandleKey | null>(null);
  // Pointer is over a movable underlay's BODY (Select tool): shows the move cursor, so
  // it is clear the image can be dragged before the drag starts.
  const [overImageBody, setOverImageBody] = useState(false);
  /** Cursor is over the drawn shape while Select is armed — drives the move cursor. */
  const [overShapeBody, setOverShapeBody] = useState(false);
  // Transient status for the import itself ("Reading…" / an error). Not persisted.
  const [importStatus, setImportStatus] = useState<string | null>(null);
  // Set when a localStorage write fails — with images in play, quota is reachable and
  // a silent failure would lose work. Surfaced in the on-canvas command bar until the next
  // successful save.
  const [saveFailed, setSaveFailed] = useState(false);
  // The hidden <input type="file"> the Import button drives.
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * DECODED bitmaps for the placed underlays, keyed by image id. Kept OUT of React
   * state: they are derived from `src`, are large, and are only ever read by the
   * renderer during paint — putting them in state would deep-compare megabytes on
   * every render for no benefit. A ref plus a repaint tick is the right shape.
   */
  const imageBitmapsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // Bumped when a bitmap finishes decoding, purely to trigger one repaint.
  const [bitmapTick, setBitmapTick] = useState(0);

  // --- LOCATION (geo-location of the sketch) ---
  // Free-text address the user types in the LOCATION panel section, plus the site
  // resolved from it (coordinates, time zone, elevation). Resolution runs against the
  // BUNDLED offline gazetteer (core/gazetteer.ts) — no API key, no network — and is
  // committed on Enter / blur rather than per keystroke, so a half-typed address never
  // yanks the solar study to the wrong city. Defaults to a PRE-RESOLVED Omaha, NE (see
  // defaultLocation) so the solar tools read a real site from the first click rather than
  // silently reading nothing. Persisted with the saved entry.
  const [location, setLocation] = useState<LocationInfo>(defaultLocation);
  // Outcome of the last resolve attempt, for the readout under the address field.
  // "missing" = the text matched nothing. Starts RESOLVED because the default location is
  // already a resolved site — the readout should show its coordinates on first paint, not
  // wait for the user to re-commit a field that is already correct.
  const [geoStatus, setGeoStatus] = useState<"idle" | "resolving" | "resolved" | "missing">("resolved");
  // Runner-up readings for an ambiguous name (the several Springfields), offered as
  // one-click corrections so a wrong guess is visible and fixable rather than silent.
  const [geoAlternatives, setGeoAlternatives] = useState<Place[]>([]);
  // Guards against an out-of-order resolve landing after a newer one (the dataset
  // import makes the first call slower than the rest).
  const geoSeqRef = useRef(0);

  /**
   * Commit the typed address: resolve it offline and write the site onto `location`.
   * Blank text clears the geolocation entirely (back to "no location"), which is the
   * documented way to remove a site.
   */
  const commitAddress = useCallback(
    async (text: string) => {
      const seq = ++geoSeqRef.current;
      if (text.trim() === "") {
        setGeoStatus("idle");
        setGeoAlternatives([]);
        setLocation((l) => ({ ...l, address: text, lat: null, lng: null, label: null, timeZone: null, elevationM: null }));
        return;
      }
      setGeoStatus("resolving");
      const site = await resolveSite(text);
      if (seq !== geoSeqRef.current) return; // a newer commit already won
      if (!site) {
        setGeoStatus("missing");
        setGeoAlternatives([]);
        // Keep the typed text but drop any stale coordinates — an unresolved address
        // must never leave the previous site silently attached to it.
        setLocation((l) => ({ ...l, address: text, lat: null, lng: null, label: null, timeZone: null, elevationM: null }));
        return;
      }
      setGeoStatus("resolved");
      setGeoAlternatives(site.alternatives);
      setLocation((l) => ({
        ...l,
        // Auto-populate the field with what was actually matched, so the text in the
        // box and the site driving the study always read as the same thing.
        address: canonicalAddress(site),
        lat: site.lat,
        lng: site.lng,
        label: site.label,
        timeZone: site.timeZone,
        elevationM: site.elevationM,
      }));
    },
    [],
  );

  /** Apply one of the offered alternatives (the user correcting an ambiguous match). */
  const pickAlternative = useCallback((p: Place) => {
    geoSeqRef.current++; // any in-flight resolve is now stale
    setGeoStatus("resolved");
    setGeoAlternatives((alts) => alts.filter((a) => a !== p));
    setLocation((l) => ({
      ...l,
      // Correcting the match rewrites the field too, for the same reason.
      address: formatPlace(p),
      lat: p.lat,
      lng: p.lng,
      label: formatPlace(p),
      timeZone: p.timeZone,
      elevationM: p.elevationM,
    }));
  }, []);

  // Drag state lives in a ref (no re-render needed mid-drag for tracking).
  //  - pan:        middle-drag the viewport
  //  - vertex:     move an anchor
  //  - handle:     drag a Bézier control knob (mirror = keep tangent smooth)
  //  - drawHandle: press-drag right after placing a vertex to pull out handles
  //  - unravelHeight: drag a rectangle's top edge to stretch THAT panel's height
  type Drag =
    | { kind: "pan"; lastX: number; lastY: number; button: number; moved: boolean }
    | { kind: "vertex"; index: number }
    | { kind: "handle"; index: number; which: "in" | "out"; mirror: boolean }
    | { kind: "drawHandle"; index: number; anchor: Point; moved: boolean }
    | { kind: "unravelHeight"; edge: number }
    | { kind: "divide"; edge: number }
    | { kind: "mullion"; edge: number; axis: "v" | "h"; ref: number }
    | {
        kind: "cellframe";
        edge: number;
        cellIndex: number;
        side: "top" | "right" | "bottom" | "left";
        cell: { x0: number; x1: number; y0: number; y1: number };
        all: boolean;
      }
    // Reference-image (underlay) transforms. `grabDX/DY` is the pointer's offset from
    // the image's origin at grab time, so a move tracks the cursor without snapping the
    // corner to it. Resize records which grip is in hand.
    | { kind: "imageMove"; id: string; grabDX: number; grabDY: number }
    | { kind: "imageResize"; id: string; handle: HandleKey }
    // Whole-shape move: the grab offset from the shape's own origin, so the drag tracks
    // the cursor without snapping the shape's corner to it.
    | { kind: "shapeMove"; grabX: number; grabY: number }
    // Whole-shape scale. `base` + `from` are the perimeter and its bounds as they were at
    // PRESS time, and every frame of the drag scales `base` — never the live perimeter.
    // The two must travel together: `from` is the frame `scalePerimeter`'s factors and
    // anchor are expressed in, so applying them to geometry that has already been scaled
    // (i.e. the live perimeter) re-applies the whole transform on top of itself. That
    // compounds per pointer-move — outward drags explode, inward ones collapse the shape
    // to a line — which is exactly the bug this pairing exists to prevent.
    | { kind: "shapeScale"; handle: HandleKey; from: Bounds; base: Perimeter }
    | { kind: "erase"; collected: EraseTarget[]; last: Point }
    | { kind: "eraseVertex"; collected: number[]; edges: number[]; last: Point }
    | { kind: "marquee"; startModel: Point }
    // cellpaint: click-drag across a focused panel's grid to sweep cells.
    // `keys` dedupes cells already swept; `painted` is the live set being built;
    // `moved` distinguishes a drag from a plain click (which toggles downCell when
    // selecting); `last` is the previous cursor model point, so a fast drag samples ALONG
    // the path (like the eraser) and never skips a cell between two pointer events.
    // `brush` is the glazing type this stroke will APPLY on release, or null when the
    // stroke is a plain selection. Captured at press rather than read from state at
    // release, so a stroke always commits the material it started with.
    | {
        kind: "cellpaint";
        edge: number;
        downCell: { x0: number; x1: number; y0: number; y1: number };
        keys: Set<string>;
        painted: Array<{ edge: number; x0: number; x1: number; y0: number; y1: number }>;
        moved: boolean;
        last: Point;
        brush: CellType | "none" | null;
      };
  const dragRef = useRef<Drag | null>(null);
  // Timestamp (performance.now) of the last forward layer drill, so a rapid second
  // click (e.g. a habitual double-click) within DRILL_COOLDOWN_MS is ignored and one
  // click advances exactly one layer. See DRILL_COOLDOWN_MS.
  const lastDrillRef = useRef(0);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });

  // --- UNDO / REDO ---
  // A history entry is either a DOCUMENT edit (restore a prior DocSnapshot) or a
  // PROJECT DELETION (re-insert / re-remove a saved entry at its original index).
  // Both share the SAME undo/redo stacks so actions unwind in true temporal order.
  type HistoryEntry =
    | { kind: "doc"; doc: DocSnapshot }
    | { kind: "delete"; entry: SavedPerimeter; index: number };
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  // Always-current document snapshot, refreshed every render, so the capture and
  // undo/redo helpers read fresh values without stale-closure bugs.
  const docRef = useRef<DocSnapshot>({ perimeter, unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCellTypes, panelCwType, unravelHeight, floorPlates, referenceImages });
  docRef.current = { perimeter, unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCellTypes, panelCwType, unravelHeight, floorPlates, referenceImages };
  // Pre-interaction snapshot for a drag / field edit, pushed on the FIRST actual
  // change (so a no-op press/focus never creates an empty undo step).
  const pendingRef = useRef<DocSnapshot | null>(null);

  /** Push any history entry and invalidate the redo branch (a fresh action). */
  const pushHistory = useCallback((entry: HistoryEntry) => {
    setUndoStack((s) => {
      const n = [...s, entry];
      return n.length > HISTORY_LIMIT ? n.slice(n.length - HISTORY_LIMIT) : n;
    });
    setRedoStack([]);
  }, []);
  const pushUndo = useCallback((snap: DocSnapshot) => pushHistory({ kind: "doc", doc: snap }), [pushHistory]);
  /** Capture the CURRENT document as a restore point (for discrete actions). */
  const recordHistory = useCallback(() => pushUndo(docRef.current), [pushUndo]);
  /** Mark the start of a drag/field edit (snapshot taken, not yet pushed). */
  const beginHistory = useCallback(() => {
    pendingRef.current = docRef.current;
  }, []);
  /** Push the pending pre-interaction snapshot once (call before the first change). */
  const flushHistory = useCallback(() => {
    if (pendingRef.current) {
      pushUndo(pendingRef.current);
      pendingRef.current = null;
    }
  }, [pushUndo]);

  /** Restore a document snapshot (used by undo/redo). Clears transient edit state. */
  const applyDoc = useCallback((d: DocSnapshot) => {
    setPerimeter(d.perimeter);
    setUnravelHeights(d.unravelHeights);
    setUnravelCells(d.unravelCells);
    setPanelDivisions(d.panelDivisions);
    setPanelDividersH(d.panelDividersH);
    setPanelMullionsV(d.panelMullionsV);
    setPanelMullionsH(d.panelMullionsH);
    setPanelCellFraming(d.panelCellFraming);
    setPanelCellTypes(d.panelCellTypes);
    setPanelCwType(d.panelCwType);
    setUnravelHeight(d.unravelHeight);
    setFloorPlates(d.floorPlates);
    setReferenceImages(d.referenceImages);
    // The restored list may not contain the selected underlay (undoing an import), so
    // drop a selection that no longer resolves rather than leaving grips on nothing.
    setSelectedImageId((id) => (id && d.referenceImages.some((i) => i.id === id) ? id : null));
    setHoveredImageHandle(null);
    setSelectedVertex(-1);
    setHoveredVertex(-1);
    setInsertPreview(null);
    setUnravelInputDraft({});
    pendingRef.current = null;
  }, []);

  // ---------------------------------------------------------------------------
  // REFERENCE IMAGES — decoding + import
  // ---------------------------------------------------------------------------

  /**
   * Keep the decoded-bitmap cache in step with the placed list: decode any underlay we
   * have not seen, and drop bitmaps whose image is gone (deleted or undone).
   *
   * Keyed by ID and `src` never changes after import, so MOVING or RESIZING an image
   * finds its bitmap already cached — a drag re-runs this effect but decodes nothing.
   */
  useEffect(() => {
    const cache = imageBitmapsRef.current;
    const live = new Set(referenceImages.map((i) => i.id));
    for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);

    let cancelled = false;
    for (const img of referenceImages) {
      if (cache.has(img.id)) continue;
      const el = new Image();
      el.onload = () => {
        if (cancelled) return;
        cache.set(img.id, el);
        setBitmapTick((t) => t + 1); // one repaint, now that there is something to draw
      };
      el.src = img.src;
    }
    return () => {
      cancelled = true;
    };
  }, [referenceImages]);

  /** The model-space rect currently visible, used to place an import into view. */
  const currentViewRect = useCallback(() => {
    const { w, h } = sizeRef.current;
    const centre = toModel(viewport, w / 2, h / 2);
    const tl = toModel(viewport, 0, 0);
    const br = toModel(viewport, w, h);
    return { cx: centre.x, cy: centre.y, w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) };
  }, [viewport]);

  /**
   * Decode the chosen files and place each centred in the current view. Decoding is
   * asynchronous (and a PDF pulls its parser on first use), so the button reports
   * progress and any failure in words rather than silently doing nothing.
   */
  const importImageFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const list = [...files];
      setImportStatus(list.length === 1 ? `Reading ${list[0].name}…` : `Reading ${list.length} files…`);

      const placed: ReferenceImage[] = [];
      const failures: string[] = [];
      let droppedPages = false;
      const view = currentViewRect();

      for (const file of list) {
        try {
          const raster = await decodeImageFile(file);
          if (raster.pages > 1) droppedPages = true;
          const id = `img-${Date.now().toString(36)}-${placed.length}-${Math.random().toString(36).slice(2, 7)}`;
          placed.push(placeInView(raster, view, id));
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }

      if (placed.length > 0) {
        // One history step for the whole import, so a single undo removes it all.
        recordHistory();
        setReferenceImages((prev) => [...prev, ...placed]);
        setSelectedImageId(placed[placed.length - 1].id);
        // Hand the user the SELECT tool with the new image already picked: placing an
        // underlay is almost always followed by positioning it, and the grips only exist
        // under Select. Without this the import would land with no visible handles.
        setSelectMode(true);
        setPanMode(false);
        setEraserOn(false);
      }

      setImportStatus(
        failures.length > 0
          ? failures[0]
          : droppedPages
            ? "Imported page 1 — multi-page PDFs place their first page only."
            : null,
      );
    },
    [currentViewRect, recordHistory],
  );

  /** Open the file browser. The <input> is hidden; this is the Import button's action. */
  const onImportClick = useCallback(() => {
    setImportStatus(null);
    // Clear the value first so re-choosing the SAME file still fires a change event.
    if (fileInputRef.current) fileInputRef.current.value = "";
    fileInputRef.current?.click();
  }, []);

  /**
   * Which resize grip (if any) is under a SCREEN point.
   *
   * Tested in screen space, not model space, because the grips are drawn at a fixed
   * pixel size — a model-space tolerance would make them unhittable when zoomed out and
   * absurdly large when zoomed in. The pad widens the drawn square into a comfortable
   * target without changing how it looks.
   */
  const hitImageHandleAt = useCallback(
    (img: ReferenceImage, sx: number, sy: number): HandleKey | null => {
      const pad = IMAGE_HANDLE_HIT_PX;
      for (const k of HANDLE_KEYS) {
        const p = toScreen(viewport, imageHandlePoint(img, k));
        if (Math.abs(sx - p.x) <= pad && Math.abs(sy - p.y) <= pad) return k;
      }
      return null;
    },
    [viewport],
  );

  /**
   * Model bounds of the drawn shape while it is selected as an object, else null. Feeds
   * both the frame the renderer draws and the grip hit-testing below. Curve-accurate:
   * measured on the flattened outline, so a bulging wall is inside its own box.
   */
  const selectedPerimeterBounds = useMemo<Bounds | null>(
    () => (perimeterSelected && !unravelOn ? perimeterBounds(perimeter) : null),
    [perimeterSelected, unravelOn, perimeter],
  );

  /**
   * Which whole-shape grip is under a SCREEN point. Hit-tested in screen space with the
   * same pad the underlay grips use, so both feel identically forgiving at any zoom.
   */
  const hitShapeHandleAt = useCallback(
    (b: Bounds, sx: number, sy: number): HandleKey | null => {
      const pad = IMAGE_HANDLE_HIT_PX;
      for (const k of HANDLE_KEYS) {
        const p = toScreen(viewport, boundsHandlePoint(b, k));
        if (Math.abs(sx - p.x) <= pad && Math.abs(sy - p.y) <= pad) return k;
      }
      return null;
    },
    [viewport],
  );

  /** The currently selected underlay, or null. */
  const selectedImage = useMemo(
    () => referenceImages.find((i) => i.id === selectedImageId) ?? null,
    [referenceImages, selectedImageId],
  );

  /** Patch the selected underlay (opacity / lock toggles, and the drag commits). */
  const updateSelectedImage = useCallback(
    (patch: Partial<ReferenceImage>, history = true) => {
      if (!selectedImageId) return;
      if (history) recordHistory();
      setReferenceImages((prev) => prev.map((i) => (i.id === selectedImageId ? { ...i, ...patch } : i)));
    },
    [selectedImageId, recordHistory],
  );

  /** Remove the selected underlay (Delete/Backspace, or the panel's Remove button). */
  const deleteSelectedImage = useCallback(() => {
    if (!selectedImageId) return;
    recordHistory();
    setReferenceImages((prev) => prev.filter((i) => i.id !== selectedImageId));
    setSelectedImageId(null);
    setHoveredImageHandle(null);
  }, [selectedImageId, recordHistory]);

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const entry = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    if (entry.kind === "doc") {
      setRedoStack([...redoStack, { kind: "doc", doc: docRef.current }]);
      applyDoc(entry.doc);
    } else {
      // Undo a deletion: re-insert the project at its original position. The redo
      // branch keeps the same descriptor so a redo simply deletes it again.
      setSaved((list) => {
        if (list.some((s) => s.id === entry.entry.id)) return list; // already present
        const next = list.slice();
        next.splice(Math.min(entry.index, next.length), 0, entry.entry);
        return next;
      });
      setRedoStack([...redoStack, entry]);
    }
  }, [undoStack, redoStack, applyDoc]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const entry = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    if (entry.kind === "doc") {
      setUndoStack([...undoStack, { kind: "doc", doc: docRef.current }]);
      applyDoc(entry.doc);
    } else {
      // Redo a deletion: remove the project again (mirroring the original delete,
      // including clearing the active id if it was the active project).
      setSaved((list) => list.filter((s) => s.id !== entry.entry.id));
      setActiveSavedId((cur) => (cur === entry.entry.id ? null : cur));
      setUndoStack([...undoStack, entry]);
    }
  }, [undoStack, redoStack, applyDoc]);

  const drawing = mode === "draw" && !perimeter.closed;

  // Cursor crosshairs are shown in the BUILDING PERIMETER view (draw or edit) once the
  // user has actually started — i.e. placed at least one vertex (so they appear the
  // moment drawing begins) — and stay active while editing the closed perimeter's
  // vertices. Never shown in the unravel/elevation views.
  const showCrosshair = !unravelOn && perimeter.vertices.length > 0;

  // Drive the crosshairs from a dedicated native pointermove listener so they track
  // the cursor with the least possible lag — direct CSS-transform writes, bypassing
  // React state and the full canvas redraw. Attached only while the crosshairs are
  // active. Visibility follows the pointer entering/leaving the canvas.
  useEffect(() => {
    if (!showCrosshair) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const cont = crosshairRef.current;
    const vLine = crosshairVRef.current;
    const hLine = crosshairHRef.current;
    if (!canvas || !wrap || !cont || !vLine || !hLine) return;
    const place = (clientX: number, clientY: number) => {
      // getBoundingClientRect here does NOT force a reflow: we only ever mutate
      // `transform`, which is composited and never dirties layout.
      const r = wrap.getBoundingClientRect();
      vLine.style.transform = `translateX(${clientX - r.left}px)`;
      hLine.style.transform = `translateY(${clientY - r.top}px)`;
    };
    const move = (e: PointerEvent) => {
      place(e.clientX, e.clientY);
      cont.style.opacity = "1";
    };
    const leave = () => {
      cont.style.opacity = "0";
    };
    canvas.addEventListener("pointermove", move, { passive: true });
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerenter", move);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerenter", move);
    };
  }, [showCrosshair]);

  // Unravel layout (only computed while the view is active). Each edge becomes a
  // horizontal baseline segment in clockwise order, preserving its true length.
  const unravelResult = useMemo(
    () => (unravelOn ? unravelPerimeter(perimeter, unravelGap) : null),
    [unravelOn, perimeter, unravelGap],
  );

  /**
   * WHICH WALL BORDER the per-panel statistics are reading — the SINGLE source of truth for
   * that question, used by both the Statistics window (which computes its numbers from it)
   * and the canvas (which draws the red anchor frame around it). -1 when no such reading is
   * on screen and there is nothing to attribute.
   *
   * The rule the readouts have always used: the FOCUSED border if one is selected, else the
   * LEFT-MOST elevation. That fallback is the reason this needs to be visible at all — a
   * user who has focused nothing still gets real numbers, for a wall they never picked, and
   * previously nothing on screen said which one.
   */
  const statsAnchorPanel = useMemo(() => {
    if (!unravelOn || !unravelResult || unravelResult.segments.length === 0) return -1;
    if (!activeStatsModes.some(isPerPanelStat)) return -1; // nothing panel-scoped is shown
    if (focusedPanel !== null && unravelResult.segments.some((s) => s.index === focusedPanel))
      return focusedPanel;
    return unravelResult.segments[0].index;
  }, [unravelOn, unravelResult, activeStatsModes, focusedPanel]);

  // Effective height for one panel: its per-edge override, else the global default.
  const effectiveHeight = useCallback(
    (edgeIndex: number) => unravelHeights[edgeIndex] ?? unravelHeight,
    [unravelHeights, unravelHeight],
  );

  // Resolve each unravel segment to its drawn (per-panel) height for the renderer
  // and the DOM input overlay. Keeps the renderer height-policy-agnostic.
  const unravelDraws = useMemo<UnravelDraw[] | null>(() => {
    if (!unravelResult) return null;
    return unravelResult.segments.map((seg) => {
      // Effective mullion offsets: the live drag draft overrides the committed value
      // for the panel/axis being dragged, so the band previews as the cursor moves.
      const mullionV =
        mullionDraft && mullionDraft.edge === seg.index && mullionDraft.axis === "v"
          ? mullionDraft.offset
          : panelMullionsV[seg.index] ?? 0;
      const mullionH =
        mullionDraft && mullionDraft.edge === seg.index && mullionDraft.axis === "h"
          ? mullionDraft.offset
          : panelMullionsH[seg.index] ?? 0;
      // Hover highlight only on the focused panel while the Mullions tool (Stick) is armed.
      const mullionHoverAxis =
        mullionsOn && cwType === "stick" && focusedPanel === seg.index ? mullionHover : null;
      return {
        seg,
        height: effectiveHeight(seg.index),
        cells: unravelCells[seg.index] ?? 1,
        divisions: panelDivisions[seg.index] ?? [],
        dividersH: panelDividersH[seg.index] ?? [],
        mullionV,
        mullionH,
        mullionHoverAxis,
      };
    });
  }, [
    unravelResult,
    effectiveHeight,
    unravelCells,
    panelDivisions,
    panelDividersH,
    panelMullionsV,
    panelMullionsH,
    mullionDraft,
    mullionsOn,
    cwType,
    focusedPanel,
    mullionHover,
  ]);

  /** Clamp + (optionally) grid-snap a candidate panel height. */
  const clampHeight = useCallback(
    (h: number) => {
      let v = Number.isFinite(h) ? h : MIN_UNRAVEL_HEIGHT;
      if (snapEnabled && gridSpacing > 0) v = Math.round(v / gridSpacing) * gridSpacing;
      return Math.max(MIN_UNRAVEL_HEIGHT, v);
    },
    [snapEnabled, gridSpacing],
  );

  /** Set one panel's per-edge height override (keyed by original edge index). */
  const setPanelHeight = useCallback((edge: number, h: number) => {
    setUnravelHeights((prev) => ({ ...prev, [edge]: h }));
  }, []);

  /** Commit an on-rectangle height input's draft (Enter/blur): clamp + drop draft. */
  const commitPanelInput = useCallback(
    (edge: number) => {
      const raw = unravelInputDraft[edge];
      if (raw !== undefined && raw.trim() !== "") {
        recordHistory();
        // The field is typed in the active display unit; convert to model feet before
        // clamping/storing so the stored geometry stays in feet regardless of unit.
        setPanelHeight(edge, clampHeight(fromDisplayLength(parseFloat(raw))));
      }
      setUnravelInputDraft((prev) => {
        const next = { ...prev };
        delete next[edge];
        return next;
      });
    },
    [unravelInputDraft, clampHeight, setPanelHeight, recordHistory],
  );

  /**
   * Resolve a raw cursor model-Y into the elevation a floor plate should land at,
   * applying the "intelligent" increment snap. Shared by BOTH placement
   * (`onPointerDown`) and the live preview (`onPointerMove`) so the ghost line and
   * the committed plate can never disagree.
   *
   * The INCREMENT is the smallest strictly-positive plate elevation. Because the
   * ground (0) plate is always present, the first plate the user places ABOVE
   * ground is that smallest positive value, so it defines the floor-to-floor
   * rhythm (matches the user's "place 10′ → snap to 10/20/30…" example). Deriving
   * it from state (not a captured "first" value) keeps it correct across
   * undo/redo and plate deletion.
   *
   * Behaviour:
   *  - No positive plate yet (ground only) OR Shift held -> NO increment snap;
   *    fall back to the existing fixed 1 ft grid snap (`gridSpacing`).
   *  - Otherwise snap to the nearest NON-NEGATIVE multiple of the increment when
   *    the cursor is within `FLOORPLATE_SNAP_PX` (in model units) of it; else fall
   *    back to the grid snap. Multiples are clamped to >= 0 (floors sit at/above
   *    the ground datum).
   */
  const snapFloorPlateY = useCallback(
    (rawY: number): number => {
      const gridSnap = snapEnabled && gridSpacing > 0 ? Math.round(rawY / gridSpacing) * gridSpacing : rawY;
      // Shift bypasses the increment magnet entirely (free / grid-only placement).
      if (shiftHeld) return gridSnap;
      // Increment = smallest strictly-positive plate elevation (the first plate
      // placed above the ground 0 datum). None yet -> no magnet.
      let increment = Infinity;
      for (const p of floorPlates) if (p > 1e-6 && p < increment) increment = p;
      if (!Number.isFinite(increment)) return gridSnap;
      // Nearest non-negative multiple of the increment.
      const multiple = Math.max(0, Math.round(rawY / increment)) * increment;
      const tolModel = pixelsToModel(viewport, FLOORPLATE_SNAP_PX);
      return Math.abs(rawY - multiple) <= tolModel ? multiple : gridSnap;
    },
    [floorPlates, shiftHeld, viewport, snapEnabled, gridSpacing],
  );

  /** Convert a raw pointer event to a model point, applying snap + constraint. */
  const eventToModel = useCallback(
    (e: { clientX: number; clientY: number; shiftKey: boolean }): Point => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      let p = toModel(viewport, sx, sy);
      if (snapEnabled) p = snapPoint(p, gridSpacing);
      // Angle constraint while drawing with Shift: lock to 15° increments
      // relative to the previous vertex. Snap-then-constrain keeps it on grid
      // directions where possible while guaranteeing the angle lock.
      if (e.shiftKey && drawing && perimeter.vertices.length > 0) {
        const last = perimeter.vertices[perimeter.vertices.length - 1];
        p = constrainAngle(last, p, 15);
      }
      return p;
    },
    [viewport, snapEnabled, gridSpacing, drawing, perimeter.vertices],
  );

  /**
   * Revit-style dimension preview: while the user is typing an exact segment length
   * (dimInput), the next vertex sits at that distance from the last vertex along the
   * CURSOR's direction (so the mouse aims, the keyboard sizes). null when not entering
   * a dimension, the typed value isn't a positive number yet, or the cursor has no
   * direction (sitting on the last vertex / off-canvas). Drives both the rubber-band
   * preview and the committed point so they always agree.
   */
  const dimPreview = useMemo<Point | null>(() => {
    if (dimInput === null) return null;
    // The user types in the active display unit; convert to model feet for geometry.
    const len = fromDisplayLength(parseFloat(dimInput));
    if (!isFinite(len) || len <= 0) return null;
    const v = perimeter.vertices;
    if (v.length === 0 || !cursorModel) return null;
    const last = v[v.length - 1];
    const dx = cursorModel.x - last.x;
    const dy = cursorModel.y - last.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    return { x: last.x + (dx / d) * len, y: last.y + (dy / d) * len };
  }, [dimInput, perimeter.vertices, cursorModel]);

  /**
   * Commit the typed dimension as the next vertex (Enter during dimension entry).
   * Reads the live perimeter/cursor/input via refs so the keydown handler need not
   * re-subscribe on every move. Places the vertex at the EXACT typed length along the
   * cursor direction (no grid snap — the typed value is authoritative). Returns true
   * when it consumed the key (an entry was active), even if the value was unusable.
   */
  const commitDimVertex = useCallback(() => {
    const raw = dimInputRef.current;
    if (raw === null) return false;
    // Typed in the active display unit; convert to model feet for the placed vertex.
    const len = fromDisplayLength(parseFloat(raw));
    const v = docRef.current.perimeter.vertices;
    const cur = cursorRef.current;
    if (!isFinite(len) || len <= 0 || v.length === 0 || !cur) {
      setDimInput(null);
      return true;
    }
    const last = v[v.length - 1];
    const dx = cur.x - last.x;
    const dy = cur.y - last.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      setDimInput(null);
      return true;
    }
    const pt = { x: last.x + (dx / d) * len, y: last.y + (dy / d) * len };
    recordHistory();
    setPerimeter((p) => addVertex(p, pt));
    setDimInput(null);
    return true;
  }, [recordHistory]);

  /**
   * Hit-test a model point against each rectangle's TOP edge in the unravel view.
   * A top edge is "hit" when the cursor's x is within [x0,x1] (± tolerance) AND its
   * model-y is within `TOP_EDGE_TOLERANCE_PX` (converted to model units) of that
   * panel's height. Returns the matching ORIGINAL edge index, or -1.
   */
  const hitUnravelTop = useCallback(
    (m: Point): number => {
      const segs = unravelResult?.segments;
      if (!segs || segs.length === 0) return -1;
      const tolModel = pixelsToModel(viewport, TOP_EDGE_TOLERANCE_PX);
      for (const s of segs) {
        const lo = Math.min(s.x0, s.x1);
        const hi = Math.max(s.x0, s.x1);
        if (m.x < lo - tolModel || m.x > hi + tolModel) continue;
        if (Math.abs(m.y - effectiveHeight(s.index)) <= tolModel) return s.index;
      }
      return -1;
    },
    [unravelResult, viewport, effectiveHeight],
  );

  /**
   * Hit-test a model point against each rectangle's BODY (x within [x0,x1] and y
   * in 0..that panel's height, each ± a small tolerance). Returns the matching
   * ORIGINAL edge index, or -1. Used for hover and double-click-to-zoom.
   */
  const hitUnravelPanel = useCallback(
    (m: Point): number => {
      const segs = unravelResult?.segments;
      if (!segs || segs.length === 0) return -1;
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      for (const s of segs) {
        const lo = Math.min(s.x0, s.x1);
        const hi = Math.max(s.x0, s.x1);
        if (m.x < lo - tolModel || m.x > hi + tolModel) continue;
        if (m.y >= -tolModel && m.y <= effectiveHeight(s.index) + tolModel) return s.index;
      }
      return -1;
    },
    [unravelResult, viewport, effectiveHeight],
  );

  /**
   * How much of the canvas is COVERED by the floating windows, measured live from the DOM.
   *
   * The canvas fills the window and the panels float on top of it, so its pixel width is
   * NOT its visible width. Every fit below frames content into the region this leaves, or
   * the content's left and right ends end up underneath a panel.
   *
   * Measured rather than read from a CSS token because the windows are not a fixed width in
   * practice: the Statistics window grows with the readings switched on, the Selected image
   * window only exists while an underlay is picked, and any of them can be restyled. A
   * hard-coded number would be right on the day it was written and quietly wrong after.
   * Each window is assigned to whichever side it sits nearer, so the two columns are
   * measured independently — the layout is not symmetric and must not be assumed to be.
   */
  const canvasInsets = useCallback((): FitInsets => {
    const wrap = wrapRef.current;
    if (!wrap) return {};
    const wr = wrap.getBoundingClientRect();
    let left = 0;
    let right = 0;
    for (const el of Array.from(wrap.querySelectorAll<HTMLElement>(".mini"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // hidden / not laid out yet
      const fromLeft = r.left - wr.left;
      const fromRight = wr.right - r.right;
      if (fromLeft <= fromRight) left = Math.max(left, r.right - wr.left);
      else right = Math.max(right, wr.right - r.left);
    }
    return { left, right };
  }, []);

  /** Zoom the viewport to fit a single panel's rectangle (double-click action). */
  const zoomToPanel = useCallback(
    (edge: number) => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      if (!seg) return;
      const { w, h } = sizeRef.current;
      const h0 = effectiveHeight(edge);
      // Fit this rectangle into the region BETWEEN the floating panels, with a margin, and
      // animate so the zoom glides instead of snapping. The scale follows the rectangle's
      // own width, so a short wall zooms in further than a long one — both end up framed
      // the same way, clear of the panels on either side.
      //
      // There is no fill-factor pull-back here any more. The old 0.8 was compensating for
      // this very bug: the fit was computed against the FULL canvas, so it framed content
      // wider than the visible region and the ends disappeared under the panels; backing
      // off 20% hid some of that but could not fix it, because the error scales with how
      // wide the panels are, not with the content. Measuring the region removes the cause,
      // and `marginPx` alone now sets the breathing room — in real pixels, predictably.
      animateViewport(
        fitViewport(unravelBoundsPerimeter([seg], () => h0), w, h, 56, undefined, 1, canvasInsets()),
      );
      setFocusedPanel(edge);
      // Selecting / re-framing a PANEL leaves any deeper Assembly cell context, so
      // clear it — never carry a stale focused cell from another panel.
      setFocusedCell(null);
      // A freshly-focused panel starts in the per-column / per-row GRID readout (the
      // overall-dimension mode is a per-panel state, not carried between borders).
      setPanelDimsOverall(false);
    },
    [unravelResult, effectiveHeight, animateViewport, canvasInsets],
  );

  /**
   * Compute the grid CELLS of one focused panel (by original edge index) as
   * model-space rectangles — the SAME grid the renderer draws, now made navigable
   * for the Assembly phase. Mirrors renderer.ts: VERTICAL boundaries come from the
   * panel borders (seg.x0/x1), the equal-cell splits (`unravelCells`, N-1 evenly
   * spaced lines), and the Subtractive vertical divisions (`panelDivisions`, offset
   * from seg.x0); HORIZONTAL boundaries come from the baseline (0), the panel height,
   * and the Subtractive horizontal dividers (`panelDividersH`, kept strictly inside).
   * Each adjacent vertical pair × adjacent horizontal pair forms one cell.
   *
   * Reads from the live unravel layout when present, else recomputes it directly from
   * the perimeter (mirroring the Panels nav button), so it works even when `unravelOn`
   * has not yet flipped on.
   */
  const cellsForEdge = useCallback(
    (edge: number): { x0: number; x1: number; y0: number; y1: number }[] => {
      const segs = unravelResult?.segments ?? unravelPerimeter(perimeter, unravelGap).segments;
      const seg = segs.find((s) => s.index === edge);
      if (!seg) return [];
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      const height = effectiveHeight(edge);
      // Vertical boundary set: borders + equal-cell splits + Subtractive divisions.
      const xs: number[] = [lo, hi];
      const nCells = Math.max(1, Math.round(unravelCells[edge] ?? 1));
      for (let k = 1; k < nCells; k++) xs.push(lo + (hi - lo) * (k / nCells));
      for (const off of panelDivisions[edge] ?? []) xs.push(seg.x0 + off);
      // Horizontal boundary set: baseline + top + interior Subtractive dividers.
      const ys: number[] = [0, height];
      for (const off of panelDividersH[edge] ?? []) if (off > 0 && off < height) ys.push(off);
      // Sort ascending + dedupe (epsilon) so coincident lines never make zero-size cells.
      const dedupe = (arr: number[]) => {
        const sorted = [...arr].sort((a, b) => a - b);
        const out: number[] = [];
        for (const v of sorted) if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1e-6) out.push(v);
        return out;
      };
      const vx = dedupe(xs);
      const vy = dedupe(ys);
      const cells: { x0: number; x1: number; y0: number; y1: number }[] = [];
      for (let i = 0; i < vx.length - 1; i++)
        for (let j = 0; j < vy.length - 1; j++)
          cells.push({ x0: vx[i], x1: vx[i + 1], y0: vy[j], y1: vy[j + 1] });
      return cells;
    },
    [unravelResult, perimeter, unravelGap, effectiveHeight, unravelCells, panelDivisions, panelDividersH],
  );

  /**
   * GLASS-INFILL rect of one grid cell: the cell rectangle MINUS its extruded frame
   * members, the SINGLE source of truth for "what is glass vs. frame" (used by both the
   * Type hatch and the WWR statistics). Frames live on INTERIOR grid lines only, and a
   * panel is either Stick (mullion bands straddling each interior line — a cell edge on an
   * interior line loses the mullion half-width `mv`/`mh`; panel-border edges keep their
   * glass) or Unitized (per-cell `panelCellFraming` insets), never both. `cellIndex` keys
   * the Unitized inset lookup (cellsForEdge order). Returns the inset rect; callers guard
   * the degenerate (fully-framed) case where x1≤x0 or y1≤y0.
   */
  const cellGlassRect = useCallback(
    (edge: number, cell: { x0: number; x1: number; y0: number; y1: number }, cellIndex: number) => {
      let gx0 = cell.x0, gx1 = cell.x1, gy0 = cell.y0, gy1 = cell.y1;
      const fr = panelCellFraming[edge]?.[cellIndex];
      if (fr) {
        gx0 += Math.max(0, fr.left);
        gx1 -= Math.max(0, fr.right);
        gy0 += Math.max(0, fr.bottom);
        gy1 -= Math.max(0, fr.top);
      } else {
        const mv = panelMullionsV[edge] ?? 0;
        const mh = panelMullionsH[edge] ?? 0;
        const seg = unravelResult?.segments.find((s) => s.index === edge);
        const lo = seg ? Math.min(seg.x0, seg.x1) : cell.x0;
        const hi = seg ? Math.max(seg.x0, seg.x1) : cell.x1;
        const ph = effectiveHeight(edge);
        if (mv > 0) {
          if (Math.abs(cell.x0 - lo) > 1e-6) gx0 += mv;
          if (Math.abs(cell.x1 - hi) > 1e-6) gx1 -= mv;
        }
        if (mh > 0) {
          if (cell.y0 > 1e-6) gy0 += mh;
          if (Math.abs(cell.y1 - ph) > 1e-6) gy1 -= mh;
        }
      }
      return { x0: gx0, x1: gx1, y0: gy0, y1: gy1 };
    },
    [panelCellFraming, panelMullionsV, panelMullionsH, unravelResult, effectiveHeight],
  );

  /**
   * WINDOW-TO-WALL RATIO for one panel, both industry methods. The WALL is the whole panel
   * rect (width × height); the WINDOW is its VISION cells (Spandrel + Opaque + untyped read
   * as wall, not window). Two ways, per the WWR stats view:
   *  • Gross Opening — frames/mullions counted as window: Σ vision cells' FULL cell area.
   *  • Net Glazing — frames/mullions excluded: Σ vision cells' GLASS-INFILL area.
   * Ratios are window/wall (0 when the panel has no area). Cells use the live grid order so
   * the Unitized framing/type lookups stay aligned with cellsForEdge.
   */
  const panelWWR = useCallback(
    (edge: number) => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      const width = seg ? Math.abs(seg.x1 - seg.x0) : 0;
      const wallArea = width * effectiveHeight(edge);
      const types = panelCellTypes[edge] ?? {};
      const cells = cellsForEdge(edge);
      let windowGross = 0;
      let windowNet = 0;
      let visionCount = 0;
      let typedCount = 0; // cells with ANY type assigned (coverage for the provisional flag)
      cells.forEach((c, i) => {
        if (types[i]) typedCount++;
        if (types[i] !== "vision") return;
        visionCount++;
        windowGross += Math.abs(c.x1 - c.x0) * Math.abs(c.y1 - c.y0);
        const g = cellGlassRect(edge, c, i);
        if (g.x1 > g.x0 && g.y1 > g.y0) windowNet += (g.x1 - g.x0) * (g.y1 - g.y0);
      });
      return {
        wallArea,
        windowGross,
        windowNet,
        wwrGross: wallArea > 0 ? windowGross / wallArea : 0,
        wwrNet: wallArea > 0 ? windowNet / wallArea : 0,
        visionCount,
        typedCount,
        cellCount: cells.length,
      };
    },
    [unravelResult, effectiveHeight, panelCellTypes, cellsForEdge, cellGlassRect],
  );

  /**
   * VISIBLE LIGHT TRANSMITTANCE for one panel. Each cell type carries an industry-standard
   * VLT (CELL_TYPE_VLT: Vision ≈ 0.70, Spandrel/Opaque = 0 — no visible transmittance). The
   * EFFECTIVE APERTURE is the glass-area-weighted VLT spread over the whole panel rect (=
   * net WWR × glazing VLT), the standard daylighting metric — light passes only through the
   * actual glass infill, so frames/mullions and non-Vision cells contribute nothing.
   */
  const panelVLT = useCallback(
    (edge: number) => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      const width = seg ? Math.abs(seg.x1 - seg.x0) : 0;
      const wallArea = width * effectiveHeight(edge);
      const types = panelCellTypes[edge] ?? {};
      const cells = cellsForEdge(edge);
      let weighted = 0; // Σ glass-area × type VLT (the light-transmitting area)
      let typedCount = 0; // cells with ANY type assigned (coverage for the provisional flag)
      cells.forEach((c, i) => {
        const t = types[i];
        if (!t) return;
        typedCount++;
        const g = cellGlassRect(edge, c, i);
        if (g.x1 <= g.x0 || g.y1 <= g.y0) return;
        weighted += (g.x1 - g.x0) * (g.y1 - g.y0) * CELL_TYPE_VLT[t];
      });
      return {
        wallArea,
        visionVLT: CELL_TYPE_VLT.vision,
        spandrelVLT: CELL_TYPE_VLT.spandrel,
        opaqueVLT: CELL_TYPE_VLT.opaque,
        effectiveAperture: wallArea > 0 ? weighted / wallArea : 0,
        typedCount,
        cellCount: cells.length,
      };
    },
    [unravelResult, effectiveHeight, panelCellTypes, cellsForEdge, cellGlassRect],
  );

  /**
   * The SOLAR settings governing the LIVE drawing: the active saved entry's stored
   * settings (edited in its Solar Study popup), or fresh defaults for a brand-new
   * unsaved shape. Only `northOffset` matters for the Orientation Heatmap — it is the
   * compass bearing (deg CW from true north) of the model's +Y axis, so it rotates
   * every facade's outward-normal bearing into TRUE compass directions. This is the
   * link that ties the heatmap to the Solar Study diagram (same source of truth).
   */
  const activeSolar = useMemo<SolarSettings>(() => {
    const entry = activeSavedId ? saved.find((s) => s.id === activeSavedId) : null;
    // cloneSolarSettings (not a raw read) so a project saved before the time-zone /
    // elevation fields existed gets them backfilled rather than reaching the radiation
    // model as undefined.
    const base = entry?.solar ? cloneSolarSettings(entry.solar) : defaultSolarSettings();
    // The LIVE Location field is the site's source of truth: an address resolved just
    // now must drive the study immediately, including on a not-yet-saved sketch.
    if (location.lat !== null && location.lng !== null) {
      base.latitude = location.lat;
      base.longitude = location.lng;
      if (location.timeZone) base.timeZone = location.timeZone;
      if (typeof location.elevationM === "number") base.elevationM = location.elevationM;
    }
    return base;
  }, [activeSavedId, saved, location]);

  /**
   * TRUE compass bearing (deg, 0 = N, CW) that each perimeter EDGE's glass faces —
   * its OUTWARD normal in plan, rotated by the Solar Study's `northOffset`. Keyed by
   * the originating edge index (== UnravelSegment.index), so each unravel panel can
   * look up which way it points. Drives the Orientation Heatmap's per-cell colour +
   * cardinal label.
   *
   * Outward normal: with model +Y up, the polygon's signed area gives its winding;
   * interior lies to the LEFT of each directed edge for a CCW loop (RIGHT for CW), so
   * the OUTWARD normal of edge a→b (direction d) is (d.y,−d.x) when CCW and (−d.y,d.x)
   * when CW — guaranteeing we use the EXTERIOR face normal, not the interior one,
   * regardless of how the user drew the loop. The bearing is atan2(nx,ny) (CW from
   * model-north = +Y) plus `northOffset` to reach true compass north.
   */
  const faceBearings = useMemo<Record<number, number>>(() => {
    const v = perimeter.vertices;
    const n = v.length;
    if (!perimeter.closed || n < 3) return {};
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const a = v[i];
      const b = v[(i + 1) % n];
      area2 += a.x * b.y - b.x * a.y;
    }
    const ccw = area2 > 0;
    const out: Record<number, number> = {};
    for (let i = 0; i < n; i++) {
      const a = v[i];
      const b = v[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const nx = ccw ? dy : -dy;
      const ny = ccw ? -dx : dx;
      let bearing = (Math.atan2(nx, ny) * 180) / Math.PI + activeSolar.northOffset;
      bearing = ((bearing % 360) + 360) % 360;
      out[i] = bearing;
    }
    return out;
  }, [perimeter, activeSolar]);

  /**
   * MATERIAL-ID cell grouping for the whole project. Walks EVERY panel's cell grid
   * (via cellsForEdge — a panel with no centerlines yields exactly one whole-panel
   * cell, so it counts as one large cell) and buckets cells by geometric SHAPE
   * (width × height, rounded to CELL_SHAPE_EPS). Each distinct shape gets a stable
   * colour INDEX (sorted by width then height so colours don't reshuffle as panels
   * change). Exposes `uniqueCount` for the Statistics readout and `indexOf(cell)` for
   * the renderer's per-cell tint. Recomputed live as the grid (cellsForEdge) changes.
   */
  const cellShapeColors = useMemo(() => {
    const keyOf = (c: { x0: number; x1: number; y0: number; y1: number }) =>
      `${Math.round((c.x1 - c.x0) / CELL_SHAPE_EPS)}x${Math.round((c.y1 - c.y0) / CELL_SHAPE_EPS)}`;
    const keys = new Set<string>();
    // Per shape key, collect EVERY cell instance across all panels so identical cells
    // can be given slightly different SHADES (a saturation taper) — matching the
    // one-button-drawing Material-ID map, where same-shape panels share a hue/number
    // but fan out in saturation. Each instance is identified by (edge, x0, y0).
    const instances = new Map<string, Array<{ edge: number; x0: number; y0: number }>>();
    for (const seg of unravelResult?.segments ?? [])
      for (const c of cellsForEdge(seg.index)) {
        const k = keyOf(c);
        keys.add(k);
        const inst = { edge: seg.index, x0: c.x0, y0: c.y0 };
        const arr = instances.get(k);
        if (arr) arr.push(inst);
        else instances.set(k, [inst]);
      }
    const sorted = [...keys].sort((a, b) => {
      const [aw, ah] = a.split("x").map(Number);
      const [bw, bh] = b.split("x").map(Number);
      return aw - bw || ah - bh;
    });
    const index = new Map(sorted.map((k, i) => [k, i] as const));
    // Deterministic RANK of each instance within its shape group (ordered by panel,
    // then position) plus the group size — together they give each cell a shade
    // fraction in [0,1] below. Sorting keeps shades stable as unrelated panels change.
    const rank = new Map<string, number>();
    const groupSize = new Map<string, number>();
    for (const [k, arr] of instances) {
      arr.sort((a, b) => a.edge - b.edge || a.y0 - b.y0 || a.x0 - b.x0);
      groupSize.set(k, arr.length);
      arr.forEach((inst, i) => rank.set(`${inst.edge}|${inst.x0}|${inst.y0}`, i));
    }
    return {
      uniqueCount: sorted.length,
      indexOf: (c: { x0: number; x1: number; y0: number; y1: number }) => index.get(keyOf(c)) ?? 0,
      // Shade FRACTION (0 → 1) of a cell instance within its shape group: 0 for the
      // first instance, 1 for the last (single-instance groups → 0). Identical cells
      // keep one hue/number but get a slightly different saturation across this range.
      shadeOf: (edge: number, c: { x0: number; x1: number; y0: number; y1: number }) => {
        const n = groupSize.get(keyOf(c)) ?? 1;
        if (n <= 1) return 0;
        return (rank.get(`${edge}|${c.x0}|${c.y0}`) ?? 0) / (n - 1);
      },
      // Material-ID KEY of a cell (its shape bucket). Two cells with the same key are
      // the "same" cell — used both for the colour index above and for mirroring a
      // Unitized framing edit across every cell of that shape (see the cellframe commit).
      keyOf,
    };
  }, [unravelResult, cellsForEdge]);

  /**
   * The base unravel draws AUGMENTED with the UNITIZED per-cell framing overlay, for
   * the 2D elevation canvas only. Computed HERE (after cellsForEdge) because resolving
   * each cell's model rect needs the panel's cell grid — and the base `unravelDraws`
   * memo is declared before cellsForEdge (it would hit the temporal-dead-zone). The
   * base draws (3D minimap + the DOM height-input overlay) stay framing-agnostic. The
   * live drag draft and the hover edge are folded in so the inset previews live.
   */
  const unravelDraws2d = useMemo<UnravelDraw[] | null>(() => {
    if (!unravelDraws) return null;
    // MATERIAL-ID MIRRORING (live preview): while a cellframe drag is in flight, the
    // inset is previewed on EVERY cell sharing the dragged cell's shape (Material ID),
    // across all panels — not just the cell under the cursor. Resolve the dragged
    // cell's shape key once so each cell below can test membership.
    const draftCell = cellFrameDraft
      ? cellsForEdge(cellFrameDraft.edge)[cellFrameDraft.cellIndex] ?? null
      : null;
    const draftKey = draftCell ? cellShapeColors.keyOf(draftCell) : null;
    return unravelDraws.map((d) => {
      const edge = d.seg.index;
      const store = panelCellFraming[edge];
      // Per-cell TYPE assignments for this panel (only drawn when the Type eye is on).
      const typeStore = typeVisible ? panelCellTypes[edge] : undefined;
      const hasTypes = !!typeStore && Object.keys(typeStore).length > 0;
      // OPAQUE cells drive the Shadows-view "flush, no cast shadow" exclusion — a property of
      // the assigned TYPE, so read from the raw type map (NOT typeStore, which the eye gates).
      const rawTypes = panelCellTypes[edge];
      const hasOpaque = !!rawTypes && Object.values(rawTypes).some((t) => t === "opaque");
      const isDraftPanel = cellFrameDraft?.edge === edge;
      // Hover highlight only on the focused panel while the Framing tool is armed under
      // the Unitized system, and only in the Panels tab (not the deeper Assembly zoom).
      const isHoverPanel =
        mullionsOn && cwType === "unitized" && focusedPanel === edge && focusedCell === null;
      // MATERIAL-ID / ORIENTATION views both tint every cell of every panel; when on we
      // always need the cell grid even if this panel has no framing/hover.
      const colorView = cellViewMode === "materialId";
      const orientView = cellViewMode === "orientation";
      // A draft can touch ANY panel (mirroring), so never early-out while one is live.
      if (!store && !hasTypes && !hasOpaque && !cellFrameDraft && !(isHoverPanel && cellEdgeHover) && !colorView && !orientView)
        return d;
      const cells = cellsForEdge(edge);
      const framing: NonNullable<UnravelDraw["cellFraming"]> = [];
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        let ins = store?.[i];
        // Live drag preview: every cell whose SHAPE matches the dragged cell (same
        // Material ID), on this or any other panel, previews the same inset — so the
        // edit visibly mirrors across the whole project as the cursor moves.
        if (cellFrameDraft && draftKey !== null && cellShapeColors.keyOf(c) === draftKey) {
          const o = cellFrameDraft.offset;
          const base = ins ?? { top: 0, right: 0, bottom: 0, left: 0 };
          ins = cellFrameDraft.all
            ? { top: o, right: o, bottom: o, left: o }
            : { ...base, [cellFrameDraft.side]: o };
        }
        if (ins && (ins.top > 0 || ins.right > 0 || ins.bottom > 0 || ins.left > 0)) {
          framing.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, ...ins });
        }
      }
      let frameHover: UnravelDraw["frameHover"] = null;
      if (isDraftPanel && cellFrameDraft) {
        const c = cells[cellFrameDraft.cellIndex];
        if (c)
          frameHover = {
            x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1,
            side: cellFrameDraft.side, offset: cellFrameDraft.offset, all: cellFrameDraft.all,
          };
      } else if (isHoverPanel && cellEdgeHover) {
        const c = cells[cellEdgeHover.cellIndex];
        if (c)
          frameHover = {
            x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1,
            side: cellEdgeHover.side, offset: 0, all: false,
          };
      }
      // MATERIAL-ID tint: one entry per cell carrying its SHAPE colour index (the
      // renderer turns the index into a hue) and its SHADE fraction (identical cells
      // share the hue but fan out in saturation). Only built while the view is active.
      const cellColors: NonNullable<UnravelDraw["cellColors"]> | undefined = colorView
        ? cells.map((c) => ({
            x0: c.x0,
            x1: c.x1,
            y0: c.y0,
            y1: c.y1,
            colorIndex: cellShapeColors.indexOf(c),
            shade: cellShapeColors.shadeOf(edge, c),
          }))
        : undefined;
      // ORIENTATION HEATMAP: tint each cell by its panel's facing direction (heat
      // scalar t) and label it with the cardinal PLUS the live direct-sun incidence
      // (`sun`). All cells of a panel share the panel's outward-normal bearing — they
      // are the same wall plane — so both the colour and the sun reading are constant
      // across the grid; the sun reading is computed once per panel here. Panels with
      // no resolvable bearing (open polyline) are left untinted.
      const bearing = faceBearings[edge];
      const sunHit = bearing !== undefined ? sunHitLabel(bearing, activeSolar) : undefined;
      const cellOrient: NonNullable<UnravelDraw["cellOrient"]> | undefined =
        orientView && bearing !== undefined
          ? cells.map((c) => ({
              x0: c.x0,
              x1: c.x1,
              y0: c.y0,
              y1: c.y1,
              t: bearingToHeatT(bearing),
              label: bearingToCardinal8(bearing),
              sun: sunHit,
            }))
          : undefined;
      // PER-CELL TYPE hatch: one entry per typed cell carrying its glazing type and the
      // GLASS-INFILL rect to hatch — the cell MINUS the extruded frame members (via the
      // shared cellGlassRect), so the hatch never paints over framing (the frame is the
      // non-Vision/Spandrel/Opaque area, drawn white in Shadows view). Drawn in every view
      // (facade spec, not a view mode) when the Type eye is on.
      const cellTypes: NonNullable<UnravelDraw["cellTypes"]> | undefined = hasTypes
        ? cells
            .map((c, i) => {
              const type = typeStore![i];
              if (!type) return null;
              const g = cellGlassRect(edge, c, i);
              // Frame consumes the whole cell → no glass to hatch.
              if (g.x1 - g.x0 <= 1e-6 || g.y1 - g.y0 <= 1e-6) return null;
              return { x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, type };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null)
        : undefined;
      // OPAQUE-cell shadow exclusion (Shadows view): the glass-infill rect of each opaque
      // cell, so the renderer can punch them out of the cast-shadow clip (opaque sits flush
      // with the frame → no shadow). Built from the raw type map so it ignores the eye toggle.
      const opaqueCells: NonNullable<UnravelDraw["opaqueCells"]> | undefined = hasOpaque
        ? cells
            .map((c, i) => {
              if (rawTypes![i] !== "opaque") return null;
              const g = cellGlassRect(edge, c, i);
              if (g.x1 - g.x0 <= 1e-6 || g.y1 - g.y0 <= 1e-6) return null;
              return { x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1 };
            })
            .filter((e): e is NonNullable<typeof e> => e !== null)
        : undefined;
      return {
        ...d,
        cellFraming: framing.length ? framing : undefined,
        frameHover,
        cellColors,
        cellOrient,
        cellTypes,
        opaqueCells,
      };
    });
  }, [
    unravelDraws,
    panelCellFraming,
    panelCellTypes,
    cellGlassRect,
    typeVisible,
    cellFrameDraft,
    cellEdgeHover,
    mullionsOn,
    cwType,
    cellViewMode,
    cellShapeColors,
    faceBearings,
    activeSolar,
    focusedPanel,
    focusedCell,
    cellsForEdge,
  ]);

  /** Zoom the viewport to fit a single grid CELL (Assembly phase). Mirrors
   *  zoomToPanel but frames the cell's full rectangle (y0..y1, not baseline→top). */
  const zoomToCell = useCallback(
    (cell: { edge: number; x0: number; x1: number; y0: number; y1: number }) => {
      const { w, h } = sizeRef.current;
      // A throwaway 4-corner open perimeter of the cell rectangle, fed to the same
      // fit-to-bounds math; a comfortable margin so the cell fills the screen.
      const bounds: Perimeter = {
        vertices: [
          { x: cell.x0, y: cell.y0 },
          { x: cell.x1, y: cell.y0 },
          { x: cell.x1, y: cell.y1 },
          { x: cell.x0, y: cell.y1 },
        ],
        closed: false,
      };
      // Frame the cell with the shared fit-to-bounds math, then deliberately back
      // off to HALF that zoom. A tight cell fill loses all spatial context — at the
      // Assembly phase the user is reasoning about how a cell sits within its panel
      // and neighbors, so we intentionally show more of the surroundings. Halving
      // the scale (not just widening the margin) makes the cell appear ~half size
      // in a way that is predictable regardless of the cell's aspect ratio.
      const insets = canvasInsets();
      const fit = fitViewport(bounds, w, h, 44, undefined, 1, insets);
      // Zoom about the centre of the VISIBLE region as a fixed screen anchor so the cell
      // stays put while shrinking — same "anchor + (origin - anchor) * applied" transform
      // used by zoomAt() in core/viewport.ts, here with applied = 0.5. It has to be the
      // visible centre, not the canvas centre: anchoring on the canvas would slide the
      // cell toward (and under) a panel as it shrank, undoing the fit just computed.
      const anchorX = (insets.left ?? 0) + (w - (insets.left ?? 0) - (insets.right ?? 0)) / 2;
      const anchorY = h / 2;
      const factor = 0.5;
      const less = {
        scale: fit.scale * factor,
        originX: anchorX + (fit.originX - anchorX) * factor,
        originY: anchorY + (fit.originY - anchorY) * factor,
      };
      animateViewport(less);
      setFocusedCell(cell);
    },
    [animateViewport, canvasInsets],
  );

  // Close EVERY drop-down / submenu (CW Type · Glazing) in
  // one call. Used whenever a tool is armed or another menu opens, so only one menu
  // surface is ever open.
  const closeAllMenus = useCallback(() => {
    setCwMenuOpen(false);
    // Arming any cluster tool (each calls this first) also disarms the Export-select
    // tool, so only one tool/mode is ever active. Re-armed last by toggleExportSelect.
    setExportSelectMode(false);
    setMarquee(null);
  }, []);

  // Disarm EVERY armed cluster tool (Floor plate · Centerlines · Eraser · Framing)
  // and drop their in-flight previews. Called when the user clicks ANY other button
  // so an armed tool never lingers (stays blue) while the user interacts elsewhere —
  // no canvas click or Esc required first.
  /**
   * Return to SELECT — the app's RESTING TOOL in both phases.
   *
   * The rule: when no other tool is armed, Select is. There is no "nothing armed" state,
   * because that state has no answer to "what will a click do?" — the bar would show
   * every button white while a click still did something. So every path that puts a tool
   * DOWN (Escape, toggling a tool off, clicking away from it, switching phase) comes back
   * here rather than to nothing.
   *
   * It only arms; it clears nothing. Callers that also need to drop a selection say so.
   */
  const armSelectDefault = useCallback(() => {
    setSelectMode(true);
  }, []);

  const disarmClusterTools = useCallback(() => {
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setEraseVertexCollected([]);
    setEraseEdgeCollected([]);
    setEraseEdge(-1);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    setGlazingBrush(null); // ...and unload the glazing brush — another tool owns the click now
    // Select can now be armed in BOTH phases (it is the default in Elevations), so it has
    // to be released here too — otherwise arming a cluster tool would leave two buttons
    // lit and the bar would stop saying what a click does.
    setSelectMode(false);
    setSelectedImageId(null);
    setHoveredImageHandle(null);
    // ...and the whole-shape frame: another tool is taking the left click.
    setPerimeterSelected(false);
    // Menu opens (which call this) also disarm the Export-select tool.
    setExportSelectMode(false);
    setMarquee(null);
  }, []);

  /**
   * Which panels does an export MARQUEE rectangle (model space) intersect? A panel
   * occupies [min(x0,x1), max(x0,x1)] on x and [0, height] on y; selection is a
   * standard AABB overlap test (touching counts). Returns the set of ORIGINAL edge
   * indices hit — empty when nothing overlaps or there's no unravel layout.
   */
  const panelsInMarquee = useCallback(
    (rect: { x0: number; y0: number; x1: number; y1: number }): Set<number> => {
      const out = new Set<number>();
      const segs = unravelResult?.segments;
      if (!segs) return out;
      const mx0 = Math.min(rect.x0, rect.x1);
      const mx1 = Math.max(rect.x0, rect.x1);
      const my0 = Math.min(rect.y0, rect.y1);
      const my1 = Math.max(rect.y0, rect.y1);
      for (const s of segs) {
        const px0 = Math.min(s.x0, s.x1);
        const px1 = Math.max(s.x0, s.x1);
        const py1 = Math.max(effectiveHeight(s.index), 0);
        // Non-overlap on either axis => not selected (panel base is y = 0).
        if (mx1 < px0 || mx0 > px1 || my1 < 0 || my0 > py1) continue;
        out.add(s.index);
      }
      return out;
    },
    [unravelResult, effectiveHeight],
  );

  /**
   * Toggle the Export selection tool. Arming it disarms every other tool / menu so
   * only one is active at a time; disarming clears any live marquee + selection.
   * (closeAllMenus / disarmClusterTools also clear exportSelectMode, so we re-arm it
   * LAST — the final write wins within React's batch.)
   */
  const toggleExportSelect = useCallback(() => {
    if (exportSelectMode) {
      setExportSelectMode(false);
      setMarquee(null);
      setExportSelection(new Set());
      return;
    }
    disarmClusterTools();
    closeAllMenus();
    setExportSelectMode(true);
  }, [exportSelectMode, disarmClusterTools, closeAllMenus]);

  // --- CW TYPE (curtain-wall system) + MULLIONS ---
  // "CW Type" opens a small two-option menu (Stick / Unitized). Picking one stores the
  // choice (relabelling the button to "CW Type: <name>") and unlocks the Mullions
  // tool. The curtain-wall system is a project-level spec, so the button is always
  // available — it is NOT gated on a selected panel.
  const onCwType = useCallback(() => {
    setCwMenuOpen((open) => !open);
    disarmClusterTools();
  }, [disarmClusterTools]);
  /**
   * Assign curtain-wall system `t` to the FOCUSED panel. Because a panel may carry only
   * one system, switching to a DIFFERENT type clears that panel's framing of the other
   * system — Stick mullion bands (panelMullionsV/H) when switching to Unitized, Unitized
   * cell insets (panelCellFraming) when switching to Stick — while KEEPING its
   * centerlines (panelDivisions / panelDividersH). No-op if the panel already has `t`.
   * One undoable step. Requires a focused panel (the button is disabled otherwise).
   */
  const selectCwType = useCallback(
    (t: CwType) => {
      setCwMenuOpen(false);
      if (focusedPanel !== null) {
        // Apply to the focused panel only.
        const edge = focusedPanel;
        // Auto-arm the Centerlines tool: choosing a CW system makes placing centerlines
        // the natural next step, so the button turns blue/armed immediately and the user
        // doesn't have to click it. (The CW menu already disarmed the other cluster tools,
        // so no mutual-exclusion conflict; restore centerline visibility like onSubtractive.)
        setCenterlinesVisible(true);
        setSubtractiveOn(true);
        if (panelCwType[edge] === t) return; // already this system — nothing else to change
        recordHistory();
        setPanelCwType((prev) => ({ ...prev, [edge]: t }));
        // Drop the now-incompatible framing for this panel (centerlines are untouched).
        if (t === "unitized") {
          setPanelMullionsV((prev) => {
            if (prev[edge] === undefined) return prev;
            const next = { ...prev }; delete next[edge]; return next;
          });
          setPanelMullionsH((prev) => {
            if (prev[edge] === undefined) return prev;
            const next = { ...prev }; delete next[edge]; return next;
          });
        } else {
          setPanelCellFraming((prev) => {
            if (prev[edge] === undefined) return prev;
            const next = { ...prev }; delete next[edge]; return next;
          });
        }
      } else {
        // No panel focused — apply to every panel in the current perimeter.
        const segs = unravelPerimeter(perimeter, unravelGap).segments;
        if (segs.length === 0) return;
        recordHistory();
        setPanelCwType((prev) => {
          const next = { ...prev };
          for (const seg of segs) next[seg.index] = t;
          return next;
        });
        if (t === "unitized") {
          setPanelMullionsV((prev) => {
            const next = { ...prev };
            for (const seg of segs) delete next[seg.index];
            return next;
          });
          setPanelMullionsH((prev) => {
            const next = { ...prev };
            for (const seg of segs) delete next[seg.index];
            return next;
          });
        } else {
          setPanelCellFraming((prev) => {
            const next = { ...prev };
            for (const seg of segs) delete next[seg.index];
            return next;
          });
        }
      }
      // Drop any in-flight framing previews so a stale draft can't re-apply the old type.
      setMullionHover(null);
      setMullionDraft(null);
      setCellEdgeHover(null);
      setCellFrameDraft(null);
    },
    [focusedPanel, panelCwType, recordHistory, perimeter],
  );

  // MULLIONS: becomes available only once a CW Type is chosen. Mutually exclusive with
  // every other tool in the cluster (arming it disarms Floor plate / Centerlines /
  // Eraser and drops their in-flight previews). The actual mullion placement is an
  // intentional TODO stub — wired so the gated button exists and has a clear home.
  const onMullions = useCallback(() => {
    if (cwType === null) return; // disabled in the UI, but guard anyway
    // Arming a tool whose drawn elements are hidden makes no sense — restore visibility
    // so the user always sees what they're editing (mirrors the Floor Lines button).
    setFramingVisible(true);
    closeAllMenus();
    setPanMode(false); // Pan owns the left drag while armed — arming a tool releases it
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setTypeOn(false);
    setMullionsOn((on) => {
      if (on) {
        // Toggling off: drop the hover highlight + any in-flight drag preview.
        setMullionHover(null);
        setMullionDraft(null);
        setCellEdgeHover(null);
        setCellFrameDraft(null);
      }
      return !on;
    });
  }, [cwType, closeAllMenus]);

  /**
   * Disarm the Select tool AND drop its object selection. The two always go together:
   * the transform grips are drawn only while Select is armed, so a selection left behind
   * would be invisible yet still take the Delete key.
   */
  const disarmSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedImageId(null);
    setHoveredImageHandle(null);
    // The whole-shape frame is Select's too — leaving it drawn after the tool is gone
    // would advertise grips that nothing would answer.
    setPerimeterSelected(false);
    setHoveredPerimeterHandle(null);
    setOverShapeBody(false);
  }, []);

  // GLAZING: the button OPENS THE CHOOSER. That is its whole job, in every state.
  //   • CHOOSER CLOSED (brush loaded or not) -> open it. Opening while a brush is already
  //     loaded is the common case — switching material is one click, not a disarm-then-
  //     rearm round trip — so a loaded brush must NOT make the button mean something else.
  //   • CHOOSER OPEN -> close it. A loaded brush SURVIVES: closing is "done picking", not
  //     "put the tool down".
  // Putting the tool DOWN is therefore Esc, arming another tool, or re-picking the material
  // already in hand (see armGlazingBrush) — never an unlabelled second click on the button,
  // which is what made re-opening the chooser cost two clicks.
  // Gated by `canType` in the UI (a wall border is focused, so there are cells to paint).
  const onType = useCallback(() => {
    if (!unravelOn || focusedPanel === null) return; // disabled in the UI, but guard anyway
    if (typeOn) {
      setTypeOn(false);
      // Closed with nothing in hand: there is no armed tool left, so fall back to Select.
      // With a brush loaded the tool IS still in hand, so leave it there.
      if (glazingBrush === null) armSelectDefault();
      return;
    }
    // Restore hatch visibility on open so the assignment the user is about to make is shown
    // (mirrors the Floor Lines / Framing buttons restoring their elements' visibility).
    setTypeVisible(true);
    closeAllMenus();
    setPanMode(false); // Pan owns the left drag while armed — arming a tool releases it
    disarmSelect(); // ...and Select owns the left CLICK, which the brush is taking over
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    // A fresh arm starts from an empty highlight: whatever was selected for DIMENSIONS is
    // not what the brush is about to paint, and leaving it lit would say otherwise.
    setSelectedCells([]);
    setTypeOn(true);
  }, [unravelOn, focusedPanel, typeOn, glazingBrush, closeAllMenus, armSelectDefault, disarmSelect]);

  /**
   * Every cell sharing `cell`'s MATERIAL ID (its geometric shape), project-wide — walking
   * each panel's grid, the way the Framing tool mirrors across the same family. This is the
   * scope of a Shift gesture on a cell: identical cells are one product, so they are
   * selected (or painted) together.
   */
  const cellsOfSameMaterial = useCallback(
    (cell: { x0: number; x1: number; y0: number; y1: number }) => {
      const key = cellShapeColors.keyOf(cell);
      const out: Array<{ edge: number; x0: number; x1: number; y0: number; y1: number }> = [];
      for (const seg of unravelResult?.segments ?? []) {
        for (const c of cellsForEdge(seg.index)) {
          if (cellShapeColors.keyOf(c) === key)
            out.push({ edge: seg.index, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
        }
      }
      return out;
    },
    [cellShapeColors, unravelResult, cellsForEdge],
  );

  /**
   * SELECT the grid cell at model rect `cell` (owned by `edge`) — the no-brush gesture,
   * which drives the per-cell dimension readout. A plain click (`sameId` false) TOGGLES
   * just that one cell: clicking an unselected cell selects only it (replacing the current
   * selection); re-clicking a cell that is already selected removes it (deselect).
   * Shift+click (`sameId` true) selects the whole Material-ID family. Wall Border (panels)
   * phase only; gated by the click handler.
   */
  const selectCellAt = useCallback(
    (edge: number, cell: { x0: number; x1: number; y0: number; y1: number }, sameId: boolean) => {
      if (sameId) {
        setSelectedCells(cellsOfSameMaterial(cell));
        return;
      }
      // Plain click: TOGGLE this single cell. Already selected → deselect it; otherwise
      // select only it (replacing whatever was selected).
      setSelectedCells((prev) => {
        const isSel = prev.some(
          (sc) =>
            sc.edge === edge &&
            Math.abs(sc.x0 - cell.x0) < 1e-6 &&
            Math.abs(sc.y0 - cell.y0) < 1e-6 &&
            Math.abs(sc.x1 - cell.x1) < 1e-6 &&
            Math.abs(sc.y1 - cell.y1) < 1e-6,
        );
        if (isSel)
          return prev.filter(
            (sc) =>
              !(
                sc.edge === edge &&
                Math.abs(sc.x0 - cell.x0) < 1e-6 &&
                Math.abs(sc.y0 - cell.y0) < 1e-6 &&
                Math.abs(sc.x1 - cell.x1) < 1e-6 &&
                Math.abs(sc.y1 - cell.y1) < 1e-6
              ),
          );
        return [{ edge, x0: cell.x0, x1: cell.x1, y0: cell.y0, y1: cell.y1 }];
      });
    },
    [cellsOfSameMaterial],
  );

  /**
   * LOAD the glazing brush with type `t` and close the chooser. This ASSIGNS NOTHING — the
   * user applies it by clicking a cell or dragging across a run of them. Splitting "pick the
   * material" from "say where it goes" is what lets a single choice cover many strokes, and
   * it is what makes a paint DRAG meaningful (a drag can only sweep cells; it cannot also
   * answer "as what?").
   *
   * Picking the material ALREADY in hand puts the tool down instead. Since the button now
   * always opens the chooser, the chooser has to carry the off switch — and "click the lit
   * option to turn it off" is the same gesture every other toggle in the bar uses.
   *
   * Any existing highlight is dropped: it was a dimension selection, not a paint target.
   */
  const armGlazingBrush = useCallback(
    (t: CellType | "none") => {
      setTypeOn(false);
      setSelectedCells([]);
      if (glazingBrush === t) {
        setGlazingBrush(null);
        armSelectDefault(); // nothing in hand — back to the resting tool
      } else {
        setGlazingBrush(t);
      }
    },
    [glazingBrush, armSelectDefault],
  );

  /**
   * APPLY glazing type `t` to `cells` — or CLEAR the type when `t` is "none" (un-assigns,
   * dropping each cell back to untyped / no hatch). One undoable step for the whole set, so
   * a drag across twenty cells undoes as the single stroke the user made, not twenty.
   *
   * Each rect is mapped back to its panel grid INDEX here rather than being stored as one,
   * because the grid can change under a stale rect; a rect that no longer matches a cell is
   * skipped silently instead of writing a type onto the wrong cell.
   *
   * Cells that ALREADY carry `t` are dropped first, and a stroke that changes nothing records
   * no history at all. Painting over what is already there is not an edit, and a brush invites
   * exactly that — overlapping strokes, a double-click that lands twice — none of which should
   * cost the user an undo press to get back through.
   */
  const applyGlazingTo = useCallback(
    (
      t: CellType | "none",
      cells: Array<{ edge: number; x0: number; x1: number; y0: number; y1: number }>,
    ) => {
      // Resolve every rect to its (edge, grid index) and keep only the cells this stroke
      // actually CHANGES.
      const targets: Array<{ edge: number; idx: number }> = [];
      for (const sc of cells) {
        const grid = cellsForEdge(sc.edge);
        const idx = grid.findIndex(
          (c) =>
            Math.abs(c.x0 - sc.x0) < 1e-6 &&
            Math.abs(c.y0 - sc.y0) < 1e-6 &&
            Math.abs(c.x1 - sc.x1) < 1e-6 &&
            Math.abs(c.y1 - sc.y1) < 1e-6,
        );
        if (idx < 0) continue; // stale rect (grid changed) — skip silently
        const current: CellType | "none" = panelCellTypes[sc.edge]?.[idx] ?? "none";
        if (current !== t) targets.push({ edge: sc.edge, idx });
      }
      if (targets.length === 0) return; // nothing to change — no history entry
      recordHistory();
      setPanelCellTypes((prev) => {
        const next = { ...prev };
        for (const { edge, idx } of targets) {
          if (t === "none") {
            // Clear: drop this cell's entry (and the whole panel map if it empties out).
            if (next[edge]) {
              const panel = { ...next[edge] };
              delete panel[idx];
              if (Object.keys(panel).length === 0) delete next[edge];
              else next[edge] = panel;
            }
          } else {
            next[edge] = { ...(next[edge] ?? {}), [idx]: t };
          }
        }
        return next;
      });
    },
    [cellsForEdge, panelCellTypes, recordHistory],
  );

  /** Interior GRID-LINE positions of a panel (the lines the Mullions tool targets):
   *  vertical = equal-cell splits + Subtractive divisions (model x); horizontal =
   *  Subtractive dividers strictly inside the panel (model y from the baseline). */
  const gridLinesForEdge = useCallback(
    (edge: number): { vx: number[]; hy: number[] } => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      if (!seg) return { vx: [], hy: [] };
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      const height = effectiveHeight(edge);
      const vx: number[] = [];
      const nCells = Math.max(1, Math.round(unravelCells[edge] ?? 1));
      for (let k = 1; k < nCells; k++) vx.push(lo + (hi - lo) * (k / nCells));
      for (const off of panelDivisions[edge] ?? []) vx.push(seg.x0 + off);
      const hy: number[] = [];
      for (const off of panelDividersH[edge] ?? []) if (off > 0 && off < height) hy.push(off);
      return { vx, hy };
    },
    [unravelResult, effectiveHeight, unravelCells, panelDivisions, panelDividersH],
  );

  /**
   * ESTIMATED COST of the whole facade — every wall border, priced from what has actually
   * been drawn and assigned. Null outside the Elevations phase, where there are no unrolled
   * walls to price.
   *
   * This is the geometry-gathering half; the money is in core/cost.ts, which is pure and
   * tested. Two things are handed to it per panel:
   *   • CELLS — each one's opening area and its assigned glazing type (null = untyped, which
   *     cost.ts deliberately leaves unpriced rather than guessing a rate for).
   *   • FRAMING LENGTH — the panel's perimeter frame plus every interior grid line, each
   *     running the full width or height it spans. Framing is charged per linear foot, so a
   *     finely subdivided panel costs more than a coarse one of the same area — which is
   *     true of real curtain wall, and is why the Centerlines tool moves this number.
   */
  const costEstimate = useMemo(() => {
    if (!unravelOn || !unravelResult) return null;
    const panels: PanelCostInput[] = unravelResult.segments.map((seg) => {
      const edge = seg.index;
      const types = panelCellTypes[edge] ?? {};
      const cells = cellsForEdge(edge).map((c, i) => ({
        area: Math.abs(c.x1 - c.x0) * Math.abs(c.y1 - c.y0),
        type: types[i] ?? null,
      }));
      const width = Math.abs(seg.x1 - seg.x0);
      const height = effectiveHeight(edge);
      const { vx, hy } = gridLinesForEdge(edge);
      const framingLength = 2 * (width + height) + vx.length * height + hy.length * width;
      return { edge, cells, framingLength };
    });
    return buildCostEstimate(panels);
  }, [unravelOn, unravelResult, panelCellTypes, cellsForEdge, effectiveHeight, gridLinesForEdge]);

  /** The interior grid line of `edge` NEAREST the model point, within hit tolerance,
   *  as which AXIS its set belongs to + the grabbed line's coordinate (x for vertical,
   *  y for horizontal). Used by the Mullions tool to start a drag. Null when none. */
  const nearestGridLine = useCallback(
    (mu: Point, edge: number): { axis: "v" | "h"; coord: number } | null => {
      const seg = unravelResult?.segments.find((s) => s.index === edge);
      if (!seg) return null;
      const tol = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      const height = effectiveHeight(edge);
      const lo = Math.min(seg.x0, seg.x1);
      const hi = Math.max(seg.x0, seg.x1);
      const { vx, hy } = gridLinesForEdge(edge);
      let best: { axis: "v" | "h"; coord: number; d: number } | null = null;
      if (mu.y >= -tol && mu.y <= height + tol) {
        for (const x of vx) {
          const d = Math.abs(mu.x - x);
          if (d <= tol && (!best || d < best.d)) best = { axis: "v", coord: x, d };
        }
      }
      if (mu.x >= lo - tol && mu.x <= hi + tol) {
        for (const y of hy) {
          const d = Math.abs(mu.y - y);
          if (d <= tol && (!best || d < best.d)) best = { axis: "h", coord: y, d };
        }
      }
      return best ? { axis: best.axis, coord: best.coord } : null;
    },
    [unravelResult, viewport, effectiveHeight, gridLinesForEdge],
  );

  /** The CELL of `edge` the cursor is over, and which of that cell's four edges is
   *  NEAREST the cursor (within hit tolerance), for the UNITIZED Framing tool. The
   *  cursor's containing cell wins (so the offset goes INTO the cell the cursor is in),
   *  and only fires when actually near one of that cell's edges (a centerline / border)
   *  so it reads as "mousing over the centerlines". Null when not near any cell edge. */
  const nearestCellEdge = useCallback(
    (
      mu: Point,
      edge: number,
    ): { cellIndex: number; side: "top" | "right" | "bottom" | "left"; cell: { x0: number; x1: number; y0: number; y1: number } } | null => {
      const cells = cellsForEdge(edge);
      if (cells.length === 0) return null;
      const tol = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      // Containing cell: prefer a STRICT hit (cursor's actual cell), then fall back to a
      // tolerant hit so a cursor parked just outside a border edge still resolves.
      let ci = cells.findIndex((c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1);
      if (ci < 0)
        ci = cells.findIndex(
          (c) => mu.x >= c.x0 - tol && mu.x <= c.x1 + tol && mu.y >= c.y0 - tol && mu.y <= c.y1 + tol,
        );
      if (ci < 0) return null;
      const c = cells[ci];
      const dists: Array<["top" | "right" | "bottom" | "left", number]> = [
        ["top", Math.abs(mu.y - c.y1)],
        ["bottom", Math.abs(mu.y - c.y0)],
        ["left", Math.abs(mu.x - c.x0)],
        ["right", Math.abs(mu.x - c.x1)],
      ];
      dists.sort((a, b) => a[1] - b[1]);
      const [side, d] = dists[0];
      if (d > tol) return null;
      return { cellIndex: ci, side, cell: c };
    },
    [cellsForEdge, viewport],
  );

  /** Inward inset (feet) of `side` of `cell` for the cursor model point, clamped to the
   *  cell's perpendicular span and snapped to the framing step (0.25′). Dragging toward
   *  the cell interior grows the inset; dragging back out clamps it to 0. */
  const cellInsetForPoint = useCallback(
    (mu: Point, cell: { x0: number; x1: number; y0: number; y1: number }, side: "top" | "right" | "bottom" | "left") => {
      let raw: number;
      let span: number;
      if (side === "top") {
        raw = cell.y1 - mu.y;
        span = cell.y1 - cell.y0;
      } else if (side === "bottom") {
        raw = mu.y - cell.y0;
        span = cell.y1 - cell.y0;
      } else if (side === "left") {
        raw = mu.x - cell.x0;
        span = cell.x1 - cell.x0;
      } else {
        raw = cell.x1 - mu.x;
        span = cell.x1 - cell.x0;
      }
      const snapped = Math.round(raw / MULLION_STEP) * MULLION_STEP;
      return Math.max(0, Math.min(span, snapped));
    },
    [],
  );

  // FLOOR PLATE: arm the elevation floor-plate placement tool. Mutually exclusive
  // with the panel tools — arming it disarms Subtractive / Eraser and drops their
  // in-flight previews so only one tool in the cluster is ever active. Re-click
  // toggles it back off (the panel tools are already off then, so the clears are
  // harmless no-ops).
  const onFloorPlate = useCallback(() => {
    closeAllMenus();
    setFloorPlateMode((on) => {
      if (!on) {
        setPanMode(false); // Pan owns the left drag while armed — arming a tool releases it
        setSubtractiveOn(false);
        setDivideHover(null);
        setDivideDraft(null);
        setEraserOn(false);
        setEraseHover(null);
        setMullionsOn(false);
        setMullionHover(null);
        setMullionDraft(null);
        setCellEdgeHover(null);
        setCellFrameDraft(null);
        setTypeOn(false);
      }
      return !on;
    });
  }, [closeAllMenus]);
  // "Floor Lines" button — arm/disarm the placement tool directly (single-function
  // button, no submenu). onFloorPlate already closes the other menus and enforces
  // cluster mutual-exclusion; we also ensure floor lines are VISIBLE (placing lines you
  // can't see makes no sense).
  const onFloorPlace = useCallback(() => {
    setFloorLinesVisible(true);
    onFloorPlate();
  }, [onFloorPlate]);
  // SUBTRACTIVE: arm the panel-division tool for the selected panel. Toggling it
  // off (or deselecting / Esc) clears any in-flight preview. The actual placement
  // happens in the pointer handlers (hover preview + click/drag commit).
  const onSubtractive = useCallback(() => {
    if (focusedPanel === null) return; // disabled in the UI, but guard anyway
    // Restore visibility on click so the centerlines are always shown while editing them
    // (mirrors the Floor Lines button).
    setCenterlinesVisible(true);
    closeAllMenus();
    setPanMode(false); // Pan owns the left drag while armed — arming a tool releases it
    // Mutually exclusive with the rest of the cluster: arming Subtractive disarms
    // the Floor plate tool and the Eraser and drops their previews (clicking
    // Subtractive while it's already on toggles it off — the others are already
    // off then, so these are harmless no-ops).
    setFloorPlateMode(false);
    setEraserOn(false);
    setEraseHover(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    if (subtractiveOn) armSelectDefault(); // toggling OFF returns to the resting tool
    setSubtractiveOn((on) => {
      if (on) {
        setDivideHover(null);
        setDivideDraft(null);
      }
      return !on;
    });
  }, [focusedPanel, closeAllMenus, subtractiveOn, armSelectDefault]);

  // ERASER: arm the line-DELETION tool for the selected panel — the destructive
  // counterpart to Subtractive. Toggling it off (or deselecting / Esc / leaving
  // the view) clears the in-flight deletion highlight. The actual removal happens
  // in the pointer handlers (hover targets the nearest line; a click deletes it).
  /**
   * PAN button — toggles the pan tool. While armed, a left click-drag on the canvas moves
   * the view (same gesture as middle-drag, which keeps working regardless).
   * Mutually exclusive with the other armed tools, exactly like Eraser / Subtractive:
   * arming Pan disarms them and drops their previews, so a drag never runs two tools.
   * Holding SPACE pans temporarily WITHOUT touching this toggle (see `spaceHeld`).
   */
  const onPan = useCallback(() => {
    closeAllMenus();
    disarmSelect();
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    if (panMode) armSelectDefault(); // toggling OFF returns to the resting tool
    setPanMode((on) => !on);
  }, [closeAllMenus, disarmSelect, panMode, armSelectDefault]);

  /**
   * SELECT button — toggles the object-selection tool. Mutually exclusive with the other
   * armed tools, the same way Pan and Eraser are.
   *
   * Disarming CLEARS the current object selection: the transform grips are only drawn
   * while Select is armed, so leaving a selection behind would mean Delete still removed
   * an image the user could no longer see was selected.
   */
  const onSelect = useCallback(() => {
    closeAllMenus();
    setPanMode(false);
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    // ...and UNLOAD the glazing brush. Closing the chooser is not putting the tool down:
    // a loaded brush keeps the click, and keeps the Glazing button blue, with no chooser
    // open to say so. Taking Select means taking the click, so the brush has to go — this
    // is what makes V (and the Select button) actually release Glazing.
    setGlazingBrush(null);
    setSelectMode((on) => {
      if (on) {
        setSelectedImageId(null);
        setHoveredImageHandle(null);
      }
      return !on;
    });
  }, [closeAllMenus]);

  const onEraser = useCallback(() => {
    // No focusedPanel guard — eraser also targets floor plates (global, no panel needed).
    closeAllMenus();
    setPanMode(false); // Pan owns the left drag while armed — arming a tool releases it
    disarmSelect(); // likewise Select, which owns the left click for objects
    // Mutually exclusive with the rest of the cluster: arming it disarms Floor plate
    // and Subtractive and drops their previews so no two tools ever fight.
    setFloorPlateMode(false);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    setGlazingBrush(null); // same as Select: taking the click means unloading the brush
    if (eraserOn) armSelectDefault(); // toggling OFF returns to the resting tool
    setEraserOn((on) => {
      // Disarming drops the unravel line highlight AND the perimeter vertex
      // hover (in Draw mode the move handler won't reset it otherwise).
      if (on) {
        setEraseHover(null);
        setHoveredVertex(-1);
        setEraseVertexCollected([]);
        setEraseEdgeCollected([]);
        setEraseEdge(-1);
      }
      return !on;
    });
  }, [closeAllMenus, disarmSelect, eraserOn, armSelectDefault]);

  /** Pick a display mode from the left panel's Display ▸ View mode list. Purely visual:
   *  it arms no tool and changes no document state, so there is nothing else to reset. */
  const selectViewMode = useCallback((m: CellViewMode) => {
    setCellViewMode(m);
  }, []);

  /**
   * Find the division line on the focused panel NEAREST the cursor, within
   * ERASE_SNAP_PX. Considers both VERTICAL divisions (panelDivisions, stored as
   * x-offsets from seg.x0) and HORIZONTAL dividers (panelDividersH, stored as
   * y-offsets from the baseline). Returns the closest target, or null if none is
   * within tolerance. Mirrors the floor-plate snap distance pattern (model-space
   * tolerance from `pixelsToModel`, so it feels the same at any zoom).
   */
  const eraseTargetsNear = useCallback(
    (m: Point): Array<{ t: EraseTarget; d: number }> => {
      const tolModel = pixelsToModel(viewport, ERASE_SNAP_PX);
      const out: Array<{ t: EraseTarget; d: number }> = [];

      // Panel division lines (vertical / horizontal) on EVERY panel — no panel needs to
      // be focused first. Each line is bounded to its own panel's rectangle, so the
      // cursor must be within that panel's body (x within [x0,x1], y within [0,height])
      // for its lines to be candidates — that keeps a horizontal divider's y from
      // matching across the whole row of panels in the Elevations strip.
      for (const seg of unravelResult?.segments ?? []) {
        const lo = Math.min(seg.x0, seg.x1);
        const hi = Math.max(seg.x0, seg.x1);
        const height = effectiveHeight(seg.index);
        const inX = m.x >= lo - tolModel && m.x <= hi + tolModel;
        const inY = m.y >= -tolModel && m.y <= height + tolModel;
        if (inY) {
          const vs = panelDivisions[seg.index] ?? [];
          for (let i = 0; i < vs.length; i++) {
            const d = Math.abs(m.x - (seg.x0 + vs[i]));
            if (d <= tolModel) out.push({ t: { edge: seg.index, axis: "v", index: i }, d });
          }
        }
        if (inX) {
          const hs = panelDividersH[seg.index] ?? [];
          for (let i = 0; i < hs.length; i++) {
            const d = Math.abs(m.y - hs[i]);
            if (d <= tolModel) out.push({ t: { edge: seg.index, axis: "h", index: i }, d });
          }
        }
      }

      // Floor plates — global, no panel selection required. The ground datum (model
      // y ≈ 0, level 0) is a PERMANENT line and is never an erase candidate.
      for (let i = 0; i < floorPlates.length; i++) {
        if (Math.abs(floorPlates[i]) <= 1e-6) continue; // ground plate: undeletable
        const d = Math.abs(m.y - floorPlates[i]);
        if (d <= tolModel) out.push({ t: { edge: -1, axis: "fp", index: i }, d });
      }

      return out;
    },
    [unravelResult, viewport, effectiveHeight, panelDivisions, panelDividersH, floorPlates],
  );

  /** The single erasable line nearest the cursor (within tolerance), for the hover
   *  highlight. Derived from {@link eraseTargetsNear}. */
  const nearestEraseLine = useCallback(
    (m: Point): EraseTarget | null => {
      let best: EraseTarget | null = null;
      let bestDist = Infinity;
      for (const { t, d } of eraseTargetsNear(m)) {
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
      return best;
    },
    [eraseTargetsNear],
  );

  /** A stable string key for an erase target (for dedupe across a drag stroke). */
  const eraseKey = (t: EraseTarget) => `${t.axis}:${t.edge}:${t.index}`;

  /** Collect EVERY erasable line the cursor sweeps over moving from `a` to `b`, so a
   *  fast drag never skips lines between two sampled pointer events. Samples the path
   *  at ~half the hit tolerance and unions all targets within tolerance of each sample
   *  into `collected` (deduped by key). Returns the (possibly unchanged) array. */
  const collectEraseAlong = useCallback(
    (a: Point, b: Point, collected: EraseTarget[]): EraseTarget[] => {
      const seen = new Set(collected.map(eraseKey));
      const result = [...collected];
      const stepModel = Math.max(pixelsToModel(viewport, ERASE_SNAP_PX / 2), 1e-6);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / stepModel));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        for (const { t } of eraseTargetsNear(p)) {
          const k = eraseKey(t);
          if (!seen.has(k)) {
            seen.add(k);
            result.push(t);
          }
        }
      }
      return result;
    },
    [viewport, eraseTargetsNear],
  );

  /** Collect EVERY perimeter VERTEX the cursor sweeps over moving from `a` to `b`, so
   *  the Erase drag never skips a vertex between two sampled pointer events. Samples the
   *  path at ~half the hit tolerance and unions any vertex within tolerance into
   *  `collected` (deduped by index). Indices stay valid through the drag because the
   *  perimeter is only mutated on the pointer-up commit. Returns the (possibly
   *  unchanged) array. */
  const collectVerticesAlong = useCallback(
    (a: Point, b: Point, collected: number[]): number[] => {
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      const seen = new Set(collected);
      const result = [...collected];
      const stepModel = Math.max(pixelsToModel(viewport, HIT_TOLERANCE_PX / 2), 1e-6);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / stepModel));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        const vi = hitVertex(perimeter, p, tolModel);
        if (vi >= 0 && !seen.has(vi)) {
          seen.add(vi);
          result.push(vi);
        }
      }
      return result;
    },
    [viewport, perimeter],
  );

  /** Collect every perimeter EDGE the cursor sweeps over moving from `a` to `b`, so a
   *  fast Erase drag never skips a segment between two sampled pointer events. Mirrors
   *  collectVerticesAlong but hit-tests segments (hitSegment). Works on both open and
   *  closed perimeters. Indices stay valid through the drag (the perimeter is mutated
   *  only on the commit). */
  const collectEdgesAlong = useCallback(
    (a: Point, b: Point, collected: number[]): number[] => {
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
      const seen = new Set(collected);
      const result = [...collected];
      const stepModel = Math.max(pixelsToModel(viewport, HIT_TOLERANCE_PX / 2), 1e-6);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / stepModel));
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
        // Vertices win over edges: don't collect an edge where a corner is the target.
        if (hitVertex(perimeter, p, tolModel) >= 0) continue;
        const seg = hitSegment(perimeter, p, tolModel);
        if (seg && !seen.has(seg.index)) {
          seen.add(seg.index);
          result.push(seg.index);
        }
      }
      return result;
    },
    [viewport, perimeter],
  );

  /** Reset a panel's framing (mullion) offset for one axis to none, so newly added
   *  centerlines never inherit an existing offset — the user re-applies framing after
   *  placing them. A no-op (same reference) when there was no offset. */
  const clearPanelMullion = useCallback((edge: number, axis: "v" | "h") => {
    const setter = axis === "v" ? setPanelMullionsV : setPanelMullionsH;
    setter((prev) => {
      if (prev[edge] === undefined) return prev;
      const next = { ...prev };
      delete next[edge];
      return next;
    });
    // The UNITIZED per-cell framing is keyed by cell INDEX, which shifts whenever the
    // panel's grid changes — so adding/removing centerlines also drops this panel's
    // cell framing. The user re-applies framing on the new cells (same as Stick).
    setPanelCellFraming((prev) => {
      if (prev[edge] === undefined) return prev;
      const next = { ...prev };
      delete next[edge];
      return next;
    });
    // Per-cell TYPE assignments are keyed by cell index too, so they go stale the same
    // way when the grid changes — drop this panel's types alongside its framing.
    setPanelCellTypes((prev) => {
      if (prev[edge] === undefined) return prev;
      const next = { ...prev };
      delete next[edge];
      return next;
    });
  }, []);

  /** Commit all lines collected during an erase drag stroke as a single undoable
   *  step. Groups targets by (edge, axis) and removes them with one filter pass
   *  per array, so indices captured during the drag remain valid (arrays are only
   *  modified AFTER the loop). */
  const commitEraseLines = useCallback(
    (targets: EraseTarget[]) => {
      if (targets.length === 0) return;
      recordHistory();
      // Group by axis so each state array is filtered in one pass.
      const vByEdge = new Map<number, Set<number>>();
      const hByEdge = new Map<number, Set<number>>();
      const fpIndices = new Set<number>();
      for (const t of targets) {
        if (t.axis === "v") {
          if (!vByEdge.has(t.edge)) vByEdge.set(t.edge, new Set());
          vByEdge.get(t.edge)!.add(t.index);
        } else if (t.axis === "h") {
          if (!hByEdge.has(t.edge)) hByEdge.set(t.edge, new Set());
          hByEdge.get(t.edge)!.add(t.index);
        } else {
          fpIndices.add(t.index);
        }
      }
      if (vByEdge.size > 0) {
        setPanelDivisions((prev) => {
          const next = { ...prev };
          for (const [edge, indices] of vByEdge) {
            next[edge] = (prev[edge] ?? []).filter((_, i) => !indices.has(i));
          }
          return next;
        });
        // Removing centerlines changes the grid, so the panel's framing no longer maps
        // to it — drop it (same invariant the add path enforces via commitDivisions), or
        // the frame bars would linger along the border with their centerlines gone.
        for (const edge of vByEdge.keys()) clearPanelMullion(edge, "v");
      }
      if (hByEdge.size > 0) {
        setPanelDividersH((prev) => {
          const next = { ...prev };
          for (const [edge, indices] of hByEdge) {
            next[edge] = (prev[edge] ?? []).filter((_, i) => !indices.has(i));
          }
          return next;
        });
        for (const edge of hByEdge.keys()) clearPanelMullion(edge, "h");
      }
      if (fpIndices.size > 0) {
        // The ground datum (model y ≈ 0, level 0) is permanent — never remove it even
        // if its index somehow got collected.
        setFloorPlates((plates) =>
          plates.filter((p, i) => !(fpIndices.has(i) && Math.abs(p) > 1e-6)),
        );
      }
    },
    [recordHistory, clearPanelMullion],
  );

  /** Commit a set of division-line MODEL-x positions onto a panel as stored OFFSETS
   *  (relative to the panel's left edge x0), merged with any existing ones,
   *  de-duplicated to the grid, and sorted. One undoable step. */
  const commitDivisions = useCallback(
    (edge: number, x0: number, xs: number[]) => {
      if (xs.length === 0) return;
      recordHistory();
      setPanelDivisions((prev) => {
        const existing = prev[edge] ?? [];
        const merged = [...existing, ...xs.map((x) => x - x0)];
        // De-dup at ~0.01 ft so a click on an existing line never stacks duplicates.
        const unique: number[] = [];
        for (const off of merged.sort((a, b) => a - b)) {
          if (unique.length === 0 || Math.abs(off - unique[unique.length - 1]) > 0.01) unique.push(off);
        }
        return { ...prev, [edge]: unique };
      });
      // Adding vertical centerlines RESETS this panel's vertical framing offset, so
      // new lines never inherit an offset — the user re-applies framing afterwards.
      clearPanelMullion(edge, "v");
    },
    [recordHistory, clearPanelMullion],
  );

  /** Commit a set of HORIZONTAL divider MODEL-y positions onto a panel as stored
   *  OFFSETS from the baseline (y = 0, so the offsets ARE the y-values), merged with
   *  any existing ones, de-duplicated to the grid, and sorted. One undoable step.
   *  The horizontal mirror of {@link commitDivisions}. */
  const commitDividersH = useCallback(
    (edge: number, ys: number[]) => {
      if (ys.length === 0) return;
      recordHistory();
      setPanelDividersH((prev) => {
        const existing = prev[edge] ?? [];
        // Baseline is y = 0, so a position's offset from the baseline IS its y-value.
        const merged = [...existing, ...ys];
        // De-dup at ~0.01 ft so a click on an existing line never stacks duplicates.
        const unique: number[] = [];
        for (const off of merged.sort((a, b) => a - b)) {
          if (unique.length === 0 || Math.abs(off - unique[unique.length - 1]) > 0.01) unique.push(off);
        }
        return { ...prev, [edge]: unique };
      });
      // Adding horizontal centerlines RESETS this panel's horizontal framing offset.
      clearPanelMullion(edge, "h");
    },
    [recordHistory, clearPanelMullion],
  );


  /**
   * Frame the unravelled rectangle strip in the viewport (fit-to-bounds, reusing
   * fitViewport). The bounds include each rectangle's OWN top (per-panel height),
   * so the TALLEST panel is framed and nothing is clipped. Defined here (before the
   * keyboard effect) so the Esc handler can call it to exit a double-click zoom.
   */
  const fitUnravel = useCallback(
    (gap: number, heights: Record<number, number>, defaultHeight: number) => {
      const res = unravelPerimeter(perimeter, gap);
      if (res.segments.length === 0) return;
      const { w, h } = sizeRef.current;
      const heightOf = (s: UnravelSegment) => heights[s.index] ?? defaultHeight;
      // Generous margin so the per-segment length labels above the strip fit.
      // Animate so exiting a double-click zoom (Esc) eases back out smoothly.
      animateViewport(
        fitViewport(unravelBoundsPerimeter(res.segments, heightOf), w, h, 48, undefined, 1, canvasInsets()),
      );
    },
    [perimeter, animateViewport, canvasInsets],
  );

  // ---------------------------------------------------------------------------
  // POINTER HANDLERS
  // ---------------------------------------------------------------------------

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current!;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // UNROLL TRANSITION: a click SKIPS it — jump to the elevation view it was
      // heading for and consume this press, so the click that skipped doesn't also
      // land as an edit in a view the user hasn't seen yet.
      if (unrollFrameRef.current) {
        skipUnrollRef.current();
        return;
      }

      // A press means the user is taking over: stop any running zoom animation
      // so it doesn't fight their input.
      cancelAnim();

      // Any press on the canvas dismisses an open CW Type / Glazing menu. (Statistics and
      // View are no longer menus — they are lists in the Display window's Display section.)
      if (cwMenuOpen) setCwMenuOpen(false);
      if (typeOn) setTypeOn(false);

      // PAN (button armed, or SPACE held): a LEFT drag moves the VIEW. Checked FIRST so
      // it takes precedence over every tool — while panning, a press must never draw a
      // vertex, drop a floor line, select a panel, or erase anything. Middle-drag still
      // pans independently below. Pointer capture keeps the drag alive if the cursor
      // leaves the canvas mid-stroke.
      if (panArmed && e.button === 0) {
        dragRef.current = { kind: "pan", lastX: sx, lastY: sy, button: 0, moved: false };
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }

      // SELECT tool: OBJECT selection. While armed it owns the left click entirely and
      // returns in every case, so perimeter vertices are inert — that total separation
      // from Edit is the point of having the tool, and it means no priority rule is
      // needed between a vertex and an underlay.
      // (`!unravelOn` IS the perimeter phase — `phase` itself is derived further down.)
      if (selectMode && !unravelOn && e.button === 0) {
        const mu = toModel(viewport, sx, sy);
        // HIT ORDER IS PAINT ORDER, TOP DOWN — whatever is drawn over the click is what
        // the click means, which is the only rule a user can predict without being told.
        // The renderer draws, bottom to top: underlays -> geometry -> the underlay's
        // frame+grips -> the shape's frame+grips (see drawBackdrop / drawTransformFrame).
        // So the tests below run in exactly the reverse of that.
        //
        // This used to test underlays FIRST, on the reasoning that they sit beneath the
        // geometry — which inverts the very rule it cites. Once underlays were forced to
        // draw behind the drawing, that made a traced footprint unselectable: every click
        // inside it landed on the underlay it was traced over, and dragging moved the
        // reference image instead of the building.

        // 1. THE SHAPE'S GRIPS — drawn last of all, so they are hit first.
        if (selectedPerimeterBounds) {
          const grip = hitShapeHandleAt(selectedPerimeterBounds, sx, sy);
          if (grip) {
            beginHistory();
            // Snapshot the perimeter alongside its bounds — the drag scales THIS, not the
            // live shape, so the factors are applied exactly once per frame. Perimeter ops
            // are immutable, so holding the reference is enough; nothing can edit it under
            // us mid-drag.
            dragRef.current = {
              kind: "shapeScale",
              handle: grip,
              from: selectedPerimeterBounds,
              base: perimeter,
            };
            return;
          }
        }
        // 2. THE UNDERLAY'S GRIPS — they sit ON the frame, outside the body, and are
        //    unambiguous; only an unlocked image has any.
        const sel = referenceImages.find((i) => i.id === selectedImageId);
        if (sel && !sel.locked) {
          const grip = hitImageHandleAt(sel, sx, sy);
          if (grip) {
            beginHistory();
            dragRef.current = { kind: "imageResize", id: sel.id, handle: grip };
            return;
          }
        }
        // 3. THE SHAPE'S BODY, as one object — it is drawn over every underlay.
        //    Tolerance in MODEL units so the outline is equally easy to grab at any zoom.
        if (
          perimeter.vertices.length > 0 &&
          hitPerimeterBody(perimeter, mu, pixelsToModel(viewport, HIT_TOLERANCE_PX))
        ) {
          setPerimeterSelected(true);
          setSelectedImageId(null); // one object at a time
          beginHistory(); // pushed on the first actual move, so a pure select is free
          dragRef.current = { kind: "shapeMove", grabX: mu.x, grabY: mu.y };
          return;
        }
        // 4. AN UNDERLAY'S BODY — the bottom of the stack, so the last thing tested.
        //    Topmost (last drawn) image wins among themselves, same rule again.
        //    LOCKED images are still SELECTABLE. Lock means "cannot be moved or resized",
        //    not "cannot be picked": its Unlock button lives in the Selected image panel,
        //    which only exists while the image is selected, so skipping locked images here
        //    made a locked underlay permanently unlockable — clicking it fell through to
        //    the deselect below and the panel vanished for good.
        const hit = [...referenceImages].reverse().find((i) => hitImageBody(i, mu));
        if (hit) {
          setSelectedImageId(hit.id);
          setPerimeterSelected(false); // one object at a time, in both directions
          // Only an UNLOCKED image begins a move drag; a locked one is selected and left
          // exactly where it is, which is the whole point of the lock.
          if (!hit.locked) {
            beginHistory(); // pushed on the first actual move, so a pure select is free
            dragRef.current = { kind: "imageMove", id: hit.id, grabDX: mu.x - hit.x, grabDY: mu.y - hit.y };
          }
          return;
        }
        setSelectedImageId(null); // empty canvas clears the selection
        setPerimeterSelected(false);
        return;
      }

      // FLOOR PLATE tool: while armed, a left-click drops a horizontal level line
      // at the cursor's elevation (or removes one already there). Takes precedence
      // over draw/edit. Other buttons (middle = pan) fall through unaffected.
      if (floorPlateMode && e.button === 0) {
        const mu = toModel(viewport, sx, sy);
        // Apply the increment magnet (or grid fallback / Shift-bypass) — the SAME
        // helper the preview uses, so the dropped plate lands exactly where the
        // ghost line showed. Removal-by-click still wins below (deletes any plate
        // within tolerance of this snapped elevation).
        const yModel = snapFloorPlateY(mu.y);
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        recordHistory(); // place/remove is one undoable step
        setFloorPlates((plates) => {
          const hit = plates.findIndex((p) => Math.abs(p - yModel) <= tolModel);
          // Click on an existing plate removes it; otherwise add a new one (kept
          // sorted bottom→top for tidy iteration). EXCEPTION: the ground plate
          // (model y ≈ 0, level 0) is a permanent datum — never remove it, so a
          // click at/near the baseline is a no-op rather than deleting the 0′ line.
          if (hit >= 0) {
            if (Math.abs(plates[hit]) <= 1e-6) return plates; // ground datum is permanent
            return plates.filter((_, i) => i !== hit);
          }
          return [...plates, yModel].sort((a, b) => a - b);
        });
        return;
      }

      // RIGHT button does NOTHING. It used to pan, from before Space+drag existed; now
      // that Space+drag is the pan gesture (plus the Pan tool, plus middle-drag), the
      // right button is deliberately left free rather than kept as a fourth way to do
      // the same thing. The context menu stays suppressed over the canvas, so a
      // right-click is simply inert — see onContextMenu on the canvas element.
      if (e.button === 2) return;
      // MIDDLE button pans — the CAD convention, and the one gesture that works with no
      // tool armed and no key held.
      if (e.button === 1) {
        dragRef.current = { kind: "pan", lastX: sx, lastY: sy, button: 1, moved: false };
        return;
      }
      if (e.button !== 0) return;
      // Unravel view: left-click does not draw/edit, but the TOP edge of a
      // rectangle can be dragged to stretch THAT panel's height.
      if (unravelOn) {
        const mu = toModel(viewport, sx, sy); // raw model point (no draw snap/constrain)
        // EXPORT tool armed: start a selection MARQUEE instead of any tool / resize /
        // navigation. The drag sweeps a box that selects the panels it intersects.
        if (exportSelectMode) {
          dragRef.current = { kind: "marquee", startModel: mu };
          setMarquee({ x0: mu.x, y0: mu.y, x1: mu.x, y1: mu.y });
          setExportSelection(new Set()); // a fresh sweep clears the prior selection
          canvasRef.current?.setPointerCapture(e.pointerId);
          return;
        }
        // SUBTRACTIVE division tool: while armed, a press on the SELECTED panel
        // commits an EQUAL-COLUMN split — the same even subdivision the hover
        // recommendation previews (N equal-width columns chosen by the cursor's
        // position). Owns the click — no height resize or deselect happens.
        if (subtractiveOn && focusedPanel !== null) {
          const clickedEdge = hitUnravelPanel(mu);
          // A press on the SELECTED panel commits the equal split.
          const seg = clickedEdge === focusedPanel ? unravelResult?.segments.find((s) => s.index === focusedPanel) : undefined;
          if (seg) {
            beginHistory(); // pushed on commit (pointer-up)
            dragRef.current = { kind: "divide", edge: focusedPanel };
            setDivideHover(null);
            // The split AXIS comes from where inside the panel the press landed (see
            // divideAxisAt) — no modifier key. It is captured on the draft HERE and never
            // recomputed during the drag, so dragging to re-pick the spacing can never
            // flip rows into columns underneath the user.
            const panelH = effectiveHeight(focusedPanel);
            const lo = Math.min(seg.x0, seg.x1);
            const hi = Math.max(seg.x0, seg.x1);
            if (divideAxisAt(mu, lo, hi, panelH) === "h") {
              // Floor plates crossing the panel act as guides the rows snap to.
              setDivideDraft({ edge: focusedPanel, axis: "h", lines: buildEqualRows(mu.y, 0, panelH, floorPlates) });
            } else {
              setDivideDraft({ edge: focusedPanel, axis: "v", lines: buildEqualColumns(mu.x, seg.x0, seg.x1) });
            }
          } else if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
            // QoL: a press on a DIFFERENT wall border reframes to it with the tool
            // STILL armed — the user can pan/zoom to another border and keep editing
            // without disarming, reselecting the border, and re-arming. Debounced like
            // the layer-nav drill so a habitual double-click jumps only once.
            const now = performance.now();
            if (now - lastDrillRef.current >= DRILL_COOLDOWN_MS) {
              lastDrillRef.current = now;
              zoomToPanel(clickedEdge);
            }
          } else if (clickedEdge < 0) {
            // A press on the empty WHITE canvas (no panel under the cursor) DISARMS the
            // Centerlines tool — its dedicated deselect gesture. Presses ON a panel keep
            // every behaviour above (commit split / reframe); only blank canvas deselects.
            setSubtractiveOn(false);
            setDivideHover(null);
            setDivideDraft(null);
          }
          return; // armed tool consumes the press regardless of where it landed
        }
        // ERASER tool: start a drag stroke that accumulates lines to delete. The
        // initial press captures whatever is under the cursor; moving over more
        // lines while the button is held adds them to the set; pointer-up commits
        // all of them as one undoable step. Owns the press — no height resize or
        // deselect happens.
        if (eraserOn) {
          // Collect EVERY line under the press (not just the nearest) so a click that
          // lands where lines overlap removes all of them.
          const initial = eraseTargetsNear(mu).map(({ t }) => t);
          dragRef.current = { kind: "erase", collected: initial, last: mu };
          setEraseDragCollected(initial);
          setEraseHover(null);
          canvasRef.current?.setPointerCapture(e.pointerId);
          return; // armed tool consumes the press regardless of where it landed
        }
        // MULLIONS tool (Stick system): grab a grid line and drag to set the mullion
        // half-width offset (to EITHER side) for that whole axis on the focused panel.
        // Snapped to 0.25′ on move; committed on pointer-up. Owns the press.
        if (mullionsOn && cwType === "stick" && focusedPanel !== null) {
          const hit = nearestGridLine(mu, focusedPanel);
          if (hit) {
            beginHistory(); // pushed on first change (pointer-up commit)
            dragRef.current = { kind: "mullion", edge: focusedPanel, axis: hit.axis, ref: hit.coord };
            const cur = (hit.axis === "v" ? panelMullionsV : panelMullionsH)[focusedPanel] ?? 0;
            setMullionDraft({ edge: focusedPanel, axis: hit.axis, offset: cur });
          } else {
            // QoL: not near a grid line of THIS panel — a press on a DIFFERENT wall
            // border reframes to it with the Framing tool STILL armed, so the user can
            // move between borders and keep editing without disarming/reselecting.
            const clickedEdge = hitUnravelPanel(mu);
            if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
              const now = performance.now();
              if (now - lastDrillRef.current >= DRILL_COOLDOWN_MS) {
                lastDrillRef.current = now;
                zoomToPanel(clickedEdge);
              }
            } else if (clickedEdge < 0) {
              // A press on the empty WHITE canvas (no panel) DISARMS the Framing tool —
              // its dedicated deselect gesture. Presses on a panel keep the behaviours
              // above; only blank canvas deselects.
              setMullionsOn(false);
              setMullionHover(null);
              setMullionDraft(null);
              setCellEdgeHover(null);
              setCellFrameDraft(null);
            }
          }
          return; // armed tool consumes the press regardless of where it landed
        }
        // FRAMING tool (Unitized system): grab the nearest edge of the cell under the
        // cursor and drag to set that edge's inward inset (into the cell) in 0.25′ steps.
        // Holding Shift offsets all four edges of the cell together. Panels tab only
        // (focusedPanel set, not the deeper Assembly cell zoom). Owns the press.
        if (mullionsOn && cwType === "unitized" && focusedPanel !== null && focusedCell === null) {
          const hit = nearestCellEdge(mu, focusedPanel);
          if (hit) {
            beginHistory(); // pushed on first change (pointer-up commit)
            const all = e.shiftKey;
            dragRef.current = {
              kind: "cellframe",
              edge: focusedPanel,
              cellIndex: hit.cellIndex,
              side: hit.side,
              cell: hit.cell,
              all,
            };
            const cur = panelCellFraming[focusedPanel]?.[hit.cellIndex];
            const startOffset = cur ? cur[hit.side] : 0;
            setCellFrameDraft({
              edge: focusedPanel,
              cellIndex: hit.cellIndex,
              side: hit.side,
              offset: startOffset,
              all,
            });
          } else {
            // QoL: not near a cell edge of THIS panel — a press on a DIFFERENT wall
            // border reframes to it with the Framing tool STILL armed, so the user can
            // move between borders and keep editing without disarming/reselecting.
            const clickedEdge = hitUnravelPanel(mu);
            if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
              const now = performance.now();
              if (now - lastDrillRef.current >= DRILL_COOLDOWN_MS) {
                lastDrillRef.current = now;
                zoomToPanel(clickedEdge);
              }
            } else if (clickedEdge < 0) {
              // A press on the empty WHITE canvas (no panel) DISARMS the Framing tool —
              // its dedicated deselect gesture. Presses on a panel keep the behaviours
              // above; only blank canvas deselects.
              setMullionsOn(false);
              setMullionHover(null);
              setMullionDraft(null);
              setCellEdgeHover(null);
              setCellFrameDraft(null);
            }
          }
          return; // armed tool consumes the press regardless of where it landed
        }
        const edge = hitUnravelTop(mu);
        if (edge >= 0) {
          beginHistory(); // capture pre-resize state; pushed on first drag move
          dragRef.current = { kind: "unravelHeight", edge };
          setHoveredUnravelTop(edge);
          return;
        }
        // LAYER NAVIGATION (single click).
        //   • click ON a panel/cell  -> drill exactly ONE layer DEEPER (zoom IN)
        //       Elevations -> Panels (zoom the clicked panel)
        //       Panels     -> Assembly (zoom the clicked cell of a SPLIT panel)
        //       Assembly   -> the cell under the cursor (keep going cell by cell)
        //     ...except when already focused on a panel (Panels/Assembly): clicking a
        //     DIFFERENT panel switches focus straight to it, no back-out click needed.
        //   • click on the empty WHITE canvas -> step BACK, deepest-first. The CAMERA never
        //       zooms out here — only the dimension READOUT changes:
        //       Assembly (single-cell zoom) -> back to its wall border.
        //       Wall Border WITH cells selected -> DESELECT them (dimensions revert from the
        //         per-cell readout to the per-column/row grid).
        //       Wall Border with NOTHING selected -> collapse the dimensions to the panel's
        //         OVERALL length + height (still zoomed in on the border; use the tabs to
        //         return to the full strip).
        // "Empty canvas" = the click landed on no panel rectangle (hit-test === -1).
        if (hitUnravelPanel(mu) === -1) {
          if (focusedCell !== null && focusedPanel !== null) {
            setFocusedCell(null);
            zoomToPanel(focusedPanel);
          } else if (focusedPanel !== null) {
            if (selectedCells.length > 0) {
              setSelectedCells([]); // first click: drop the selection → back to the grid
            } else {
              setPanelDimsOverall(true); // then: grid → overall length + height (no zoom-out)
            }
          }
          return;
        }
        // WALL BORDER (panels) phase — a press on a cell of the FOCUSED panel starts a CELL
        // STROKE instead of drilling into the Assembly cell zoom. What the stroke DOES on
        // release depends on whether the Glazing brush is loaded: with a brush it paints
        // that type onto every cell it swept; without one it selects them (which drives the
        // per-cell dimension readout). Either way the gesture is identical — click one cell,
        // or drag across a run — so there is one thing to learn, not two.
        // A press on a DIFFERENT panel falls through to the layer-switch logic below.
        if (focusedPanel !== null && focusedCell === null && hitUnravelPanel(mu) === focusedPanel) {
          const target = cellsForEdge(focusedPanel).find(
            (c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1,
          );
          if (target) {
            if (e.shiftKey) {
              // Shift = the whole Material-ID family, project-wide, in one shot (no drag):
              // painted immediately with a loaded brush, otherwise selected.
              if (glazingBrush !== null) applyGlazingTo(glazingBrush, cellsOfSameMaterial(target));
              else selectCellAt(focusedPanel, target, true);
            } else {
              // Begin the stroke: the press seeds the set with this one cell; dragging
              // across more cells of THIS panel adds each live (see onPointerMove), which
              // previews as the same blue highlight. Committed on release (onPointerUp).
              dragRef.current = {
                kind: "cellpaint",
                edge: focusedPanel,
                downCell: target,
                keys: new Set([cellPosKey(focusedPanel, target)]),
                painted: [{ edge: focusedPanel, x0: target.x0, x1: target.x1, y0: target.y0, y1: target.y1 }],
                moved: false,
                last: { x: mu.x, y: mu.y },
                brush: glazingBrush,
              };
              // With a brush loaded the pressed cell previews right away, so a plain click
              // shows its target before the release commits it.
              if (glazingBrush !== null) {
                setSelectedCells([
                  { edge: focusedPanel, x0: target.x0, x1: target.x1, y0: target.y0, y1: target.y1 },
                ]);
              }
              canvasRef.current?.setPointerCapture(e.pointerId);
            }
          }
          return; // consumed: stroke start (or a no-op press inside the panel) — keep focus
        }
        // Click landed ON a panel/cell -> drill one layer deeper, OR sideways. Debounced
        // so a habitual double-click advances only one layer (see DRILL_COOLDOWN_MS).
        // While already focused on a panel (Panels/Assembly), clicking a DIFFERENT panel
        // switches focus straight to it — no intermediate empty-canvas back-out needed.
        const now = performance.now();
        if (now - lastDrillRef.current < DRILL_COOLDOWN_MS) return;
        if (focusedCell !== null && focusedPanel !== null) {
          // ASSEMBLY: a click on a DIFFERENT panel jumps to that panel (Panels phase —
          // zoomToPanel clears the Assembly cell focus); otherwise drill into whichever
          // cell of the current panel the cursor is over.
          const clickedEdge = hitUnravelPanel(mu);
          if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
            lastDrillRef.current = now;
            zoomToPanel(clickedEdge);
          } else {
            const target = cellsForEdge(focusedPanel).find(
              (c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1,
            );
            if (target) {
              lastDrillRef.current = now;
              zoomToCell({ edge: focusedPanel, ...target });
            }
          }
        } else if (focusedPanel !== null) {
          // PANELS: a click on a DIFFERENT panel switches focus directly to it; clicking
          // the SAME panel drills deeper — a SPLIT panel's cell enters Assembly, while an
          // unsplit panel has no deeper layer (do nothing, keep the selection).
          const clickedEdge = hitUnravelPanel(mu);
          if (clickedEdge >= 0 && clickedEdge !== focusedPanel) {
            lastDrillRef.current = now;
            zoomToPanel(clickedEdge);
          }
          // NOTE: same-panel clicks are handled above as CELL SELECTION (the Wall Border
          // selection block returns before reaching here), so the click-to-zoom-into-a-cell
          // drill is disabled for now. Kept (commented) because we will re-use it later.
          // else {
          //   const cells = cellsForEdge(focusedPanel);
          //   if (cells.length > 1) {
          //     const target = cells.find(
          //       (c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1,
          //     );
          //     if (target) {
          //       lastDrillRef.current = now;
          //       zoomToCell({ edge: focusedPanel, ...target });
          //     }
          //   }
          // }
        } else {
          // ELEVATIONS: enter the Panels layer for the clicked panel.
          const edge = hitUnravelPanel(mu);
          if (edge >= 0) {
            lastDrillRef.current = now;
            zoomToPanel(edge);
          }
        }
        return;
      }

      const m = eventToModel(e);
      const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);

      // ERASE tool (perimeter view): start a drag stroke that collects every vertex AND
      // every edge the cursor sweeps over; a plain click collects just the one under the
      // press. The whole set is removed as one undo step on pointer-up — vertices spliced
      // out, edges opened, and any vertex orphaned by losing both its edges auto-dropped
      // (see eraseElements). Vertices win over edges under the cursor (corners delete the
      // vertex). Works on both open and closed perimeters, in both Draw and Edit mode.
      // Owns the press, so a click on empty canvas neither places nor selects.
      if (eraserOn) {
        // Hit-test against the RAW cursor (no grid snap) so vertices/edges catch exactly.
        const mr = toModel(viewport, sx, sy);
        const vi = hitVertex(perimeter, mr, tolModel);
        const initialV = vi >= 0 ? [vi] : [];
        // No vertex under the press but a segment is under the cursor → seed the edge set.
        const seg = vi < 0 ? hitSegment(perimeter, mr, tolModel) : null;
        const initialE = seg ? [seg.index] : [];
        dragRef.current = { kind: "eraseVertex", collected: initialV, edges: initialE, last: mr };
        setEraseVertexCollected(initialV);
        setEraseEdgeCollected(initialE);
        setEraseEdge(-1);
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
        canvasRef.current?.setPointerCapture(e.pointerId);
        return;
      }

      if (drawing) {
        // A pointer placement supersedes any in-progress typed dimension.
        setDimInput(null);
        // Click first vertex (within tolerance) to close.
        if (perimeter.vertices.length >= 3) {
          const first = perimeter.vertices[0];
          if (distance(first, toModel(viewport, sx, sy)) <= pixelsToModel(viewport, CLOSE_TOLERANCE_PX)) {
            recordHistory();
            setPerimeter((p) => closePerimeter(p));
            setMode("edit");
            return;
          }
        }
        // Place the vertex, then arm a press-drag so the user can immediately
        // pull out curve handles (pen-tool style). A plain click (no drag) is
        // resolved on pointer-up: straight in Line mode, auto-arc in Arc mode.
        // One history step covers the place + any handle pull + arc-on-up.
        const newIndex = perimeter.vertices.length;
        recordHistory();
        setPerimeter((p) => addVertex(p, m));
        dragRef.current = { kind: "drawHandle", index: newIndex, anchor: m, moved: false };
        return;
      }

      // EDIT MODE.
      // 1. Grab a handle knob of the selected vertex (handles are drawn for it).
      if (selectedVertex >= 0) {
        const which = hitHandle(perimeter, selectedVertex, m, tolModel);
        if (which) {
          beginHistory(); // pushed on first handle-drag move
          dragRef.current = { kind: "handle", index: selectedVertex, which, mirror: !e.altKey };
          return;
        }
      }
      // 2. Hit a vertex.
      const vi = hitVertex(perimeter, m, tolModel);
      // 2a. Shift-click a vertex DELETES it (a quick "remove point" gesture,
      //     perimeter/edit view only — Shift while DRAWING is the 45° angle
      //     constraint, so this never fires there). One undo step; clears the
      //     selection and any stale hover/insert transient that referenced the
      //     now-removed/shifted index. The deleteVertex op reopens a closed
      //     polygon if it would drop below 3 vertices.
      if (vi >= 0 && e.shiftKey) {
        recordHistory();
        setPerimeter((p) => deleteVertex(p, vi));
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
        return;
      }
      // 2b. Plain hit: select + drag it. Alt-drag instead pulls out fresh
      //     symmetric handles, turning a corner into a smooth curve.
      if (vi >= 0) {
        setSelectedVertex(vi);
        beginHistory(); // pushed on first move (a pure select makes no history)
        dragRef.current = e.altKey
          ? { kind: "handle", index: vi, which: "out", mirror: true }
          : { kind: "vertex", index: vi };
        return;
      }
      // 3. Hit a segment: insert a vertex (splitting curves cleanly) and drag it.
      const seg = hitSegment(perimeter, m, tolModel);
      if (seg) {
        const { perimeter: np, newIndex } = insertVertexOnSegment(perimeter, seg.index, seg.t, seg.point);
        if (newIndex >= 0) {
          recordHistory();
          setPerimeter(np);
          setSelectedVertex(newIndex);
          dragRef.current = { kind: "vertex", index: newIndex };
          setInsertPreview(null);
        }
        return;
      }
      setSelectedVertex(-1);
    },
    [
      drawing,
      perimeter,
      viewport,
      eventToModel,
      selectedVertex,
      // The Select tool reads these; without them the handler keeps a stale empty list
      // (or a stale selectMode === false) and would never hit-test an imported image.
      selectMode,
      referenceImages,
      selectedImageId,
      mode,
      hitImageHandleAt,
      unravelOn,
      hitUnravelTop,
      hitUnravelPanel,
      focusedPanel,
      cwMenuOpen,
      typeOn,
      recordHistory,
      beginHistory,
      // Subtractive division tool reads these; without them the handler would keep
      // a stale closure (subtractiveOn === false) and never start a division drag.
      subtractiveOn,
      unravelResult,
      gridSpacing,
      // Eraser tool reads these to collect the targeted line(s) on press; without them
      // the handler would keep a stale closure (eraserOn === false) and never erase.
      eraserOn,
      eraseTargetsNear,
      // Mullions tool reads these to start an offset drag on a grid line.
      mullionsOn,
      cwType,
      nearestGridLine,
      panelMullionsV,
      panelMullionsH,
      // Framing tool (Unitized) reads these to start a per-cell edge inset drag.
      // (focusedCell is already listed below for layer navigation.)
      nearestCellEdge,
      panelCellFraming,
      // The cursor position picks the split axis (rows vs columns); effectiveHeight
      // resolves the panel height for the equal-row generator. Stale closures here
      // would lock the axis / use a stale height.
      shiftHeld,
      effectiveHeight,
      // Floor plates are passed to buildEqualRows as snap guides; a stale closure
      // would align rows to an out-of-date set of plates.
      floorPlates,
      // Floor-plate branch reads these; without them the memoized handler keeps a
      // stale closure (floorPlateMode === false) and clicks fall through to
      // draw/edit until an unrelated dep change rebuilds the callback.
      floorPlateMode,
      // Pan gate (button armed OR Space held). Without it the handler keeps a stale
      // closure and a left drag would run the previous tool instead of panning.
      panArmed,
      // The floor-plate snap helper (reads floorPlates/shiftHeld/viewport). Listing
      // it here keeps placement in lock-step with the preview's snapped elevation.
      snapFloorPlateY,
      cancelAnim,
      // Single-click layer navigation: a click ON a panel/cell drills one layer deeper;
      // a click on the empty canvas steps back (Assembly → wall border; Wall Border →
      // deselect, then grid → overall dimensions, camera unchanged). These drive the
      // hit-tests, re-frame, and current layer. (focusedPanel is listed above already.)
      focusedCell,
      cellsForEdge,
      zoomToCell,
      zoomToPanel,
      // Wall Border cell STROKE: a same-panel press starts one, and whether it paints or
      // selects is decided HERE from the loaded brush — a stale closure would start the
      // stroke with the wrong (or no) material, and mis-target the Shift family.
      selectCellAt,
      glazingBrush,
      applyGlazingTo,
      cellsOfSameMaterial,
      // Empty-canvas back-out reads the selection (deselect vs. show overall dimensions);
      // a stale closure would misread whether cells are selected.
      selectedCells,
      // Export tool: a stale closure (exportSelectMode === false) would never start the
      // selection marquee after arming Export.
      exportSelectMode,
      // WHOLE-SHAPE grips. Selecting the shape changes NOTHING else this handler reads —
      // not the perimeter, not the viewport — so without these the callback kept the
      // closure from before the selection, where the bounds were still null. The grip
      // test was skipped entirely and a press on a corner fell through to the body test,
      // MOVING the building instead of resizing it. It appeared to fix itself after the
      // first drag, because that finally changed `perimeter` and rebuilt the closure.
      selectedPerimeterBounds,
      hitShapeHandleAt,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const drag = dragRef.current;

      if (drag?.kind === "pan") {
        const dx = sx - (drag.lastX ?? sx);
        const dy = sy - (drag.lastY ?? sy);
        drag.lastX = sx;
        drag.lastY = sy;
        if (dx !== 0 || dy !== 0) {
          drag.moved = true;
        }
        setViewport((vp) => pan(vp, dx, dy));
        return;
      }

      // REFERENCE IMAGE drags. Both use the RAW model point (no draw snap): an underlay
      // is positioned by eye against the drawing, and snapping it to the vertex grid
      // would fight that rather than help.
      if (drag?.kind === "imageMove") {
        const mu = toModel(viewport, sx, sy);
        flushHistory(); // first actual movement is what creates the undo step
        setReferenceImages((prev) =>
          prev.map((i) => (i.id === drag.id ? { ...i, x: mu.x - drag.grabDX, y: mu.y - drag.grabDY } : i)),
        );
        return;
      }
      // WHOLE-SHAPE MOVE. Translating by the cursor DELTA (rather than re-placing a
      // corner) keeps the grab point under the pointer wherever it was picked up.
      if (drag?.kind === "shapeMove") {
        const mu = toModel(viewport, sx, sy);
        const dx = mu.x - drag.grabX;
        const dy = mu.y - drag.grabY;
        if (dx !== 0 || dy !== 0) {
          flushHistory(); // first actual movement is what creates the undo step
          drag.grabX = mu.x;
          drag.grabY = mu.y;
          setPerimeter((p) => translatePerimeter(p, dx, dy));
        }
        return;
      }
      // WHOLE-SHAPE SCALE. Recomputed from the PRESS-TIME shape and bounds every frame, so
      // the drag is a single transform re-evaluated at the current cursor — not a chain of
      // per-frame transforms stacked on each other. Scaling the LIVE perimeter here instead
      // compounds the factor on every pointer-move, which stretches the shape away or
      // collapses it to a line within a few pixels of travel.
      if (drag?.kind === "shapeScale") {
        const mu = toModel(viewport, sx, sy);
        flushHistory();
        // Corners hold the shape's proportions by DEFAULT — a squashed building is
        // nearly always a slip — with Shift as the deliberate free-stretch override.
        // Same rule, same modifier as the underlay grips.
        setPerimeter(scalePerimeter(drag.base, drag.from, drag.handle, mu, !e.shiftKey));
        return;
      }
      if (drag?.kind === "imageResize") {
        const mu = toModel(viewport, sx, sy);
        flushHistory();
        setReferenceImages((prev) =>
          // Corner drags hold the source aspect by DEFAULT — a stretched site plan is
          // almost always an accident — with Shift as the deliberate free-stretch.
          prev.map((i) => (i.id === drag.id ? resizeImage(i, drag.handle, mu, !e.shiftKey) : i)),
        );
        return;
      }

      // Export marquee drag: grow the selection rectangle to the cursor and live-
      // update which panels it intersects. Raw model point (no draw snap/constrain).
      if (drag?.kind === "marquee") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const rect = { x0: drag.startModel.x, y0: drag.startModel.y, x1: mu.x, y1: mu.y };
        setMarquee(rect);
        setExportSelection(panelsInMarquee(rect));
        return;
      }

      // Subtractive division drag: recompute the equal split from the current cursor
      // position (dragging just re-picks the iteration / spacing) and show it as a
      // live preview, committed on pointer-up. The AXIS is fixed at press time (stored
      // on the draft) so mid-drag the user keeps splitting rows OR columns.
      if (drag?.kind === "divide") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const seg = unravelResult?.segments.find((s) => s.index === drag.edge);
        if (seg) {
          // Pinned to the axis captured at press time; the fallback only matters if a
          // draft somehow went missing mid-drag.
          const axis =
            divideDraft?.axis ??
            divideAxisAt(mu, Math.min(seg.x0, seg.x1), Math.max(seg.x0, seg.x1), effectiveHeight(drag.edge));
          if (axis === "h") {
            const panelH = effectiveHeight(drag.edge);
            // Floor plates crossing the panel act as guides the rows snap to.
            setDivideDraft({ edge: drag.edge, axis: "h", lines: buildEqualRows(mu.y, 0, panelH, floorPlates) });
          } else {
            setDivideDraft({ edge: drag.edge, axis: "v", lines: buildEqualColumns(mu.x, seg.x0, seg.x1) });
          }
        }
        return;
      }

      // Height-resize drag: set THIS panel's height to the cursor's model-y. Use
      // the raw model point (not the draw-mode snap/constrain) and clamp/snap via
      // clampHeight. Update cursor readout from the same raw point.
      if (drag?.kind === "unravelHeight") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        flushHistory(); // record the pre-resize state once, on the first move
        setPanelHeight(drag.edge, clampHeight(mu.y));
        return;
      }

      // MULLION offset drag: the half-width offset = the perpendicular distance from
      // the grabbed grid line to the cursor (raw model point), snapped to 0.25′. Lives
      // as a draft (live ± band preview) until pointer-up commits it to the panel.
      if (drag?.kind === "mullion") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const dist = drag.axis === "v" ? Math.abs(mu.x - drag.ref) : Math.abs(mu.y - drag.ref);
        const offset = Math.max(0, Math.round(dist / MULLION_STEP) * MULLION_STEP);
        setMullionDraft({ edge: drag.edge, axis: drag.axis, offset });
        return;
      }

      // CELL-FRAMING drag (Unitized): the inset = the cursor's inward distance from the
      // grabbed cell edge (raw model point), clamped to the cell span and snapped to
      // 0.25′. Previews live (one edge, or all four with Shift) until pointer-up commits.
      if (drag?.kind === "cellframe") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const offset = cellInsetForPoint(mu, drag.cell, drag.side);
        setCellFrameDraft({ edge: drag.edge, cellIndex: drag.cellIndex, side: drag.side, offset, all: drag.all });
        return;
      }

      // CELL PAINT drag (Wall Border phase): as the cursor sweeps across the focused
      // panel's grid, ADD each new cell it enters to the selection so the user can
      // "paint"-select a group. Entering a cell beyond the pressed one promotes the press
      // to a drag (moved=true) and replaces the prior selection with the fresh painted set
      // (which always includes the pressed cell). Re-entering an already-painted cell is a
      // no-op (deduped via `keys`). We SAMPLE model points along the path from the last
      // cursor position to this one (like the eraser) so a fast flick never skips a cell.
      if (drag?.kind === "cellpaint") {
        const mu = toModel(viewport, sx, sy);
        setCursorModel(mu);
        const cells = cellsForEdge(drag.edge);
        // Step count from the pixel distance travelled — ~one sample every few px keeps
        // even a fast drag inside every cell it crosses. At least 1 step (this point).
        const distPx = Math.hypot((mu.x - drag.last.x) * viewport.scale, (mu.y - drag.last.y) * viewport.scale);
        const steps = Math.max(1, Math.ceil(distPx / 6));
        let changed = false;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const px = drag.last.x + (mu.x - drag.last.x) * t;
          const py = drag.last.y + (mu.y - drag.last.y) * t;
          const cell = cells.find((c) => px >= c.x0 && px <= c.x1 && py >= c.y0 && py <= c.y1);
          if (!cell) continue;
          const key = cellPosKey(drag.edge, cell);
          if (drag.keys.has(key)) continue;
          drag.keys.add(key);
          drag.painted.push({ edge: drag.edge, x0: cell.x0, x1: cell.x1, y0: cell.y0, y1: cell.y1 });
          changed = true;
        }
        drag.last = { x: mu.x, y: mu.y };
        if (changed) {
          drag.moved = true;
          setSelectedCells(drag.painted.map((c) => ({ ...c })));
        }
        return;
      }

      const m = eventToModel(e);
      setCursorModel(m);

      if (drag?.kind === "vertex") {
        flushHistory();
        setPerimeter((p) => moveVertex(p, drag.index, m));
        return;
      }

      if (drag?.kind === "handle") {
        flushHistory();
        const anchor = perimeter.vertices[drag.index];
        const offset = { x: m.x - anchor.x, y: m.y - anchor.y };
        setPerimeter((p) => setHandle(p, drag.index, drag.which, offset, drag.mirror));
        return;
      }

      if (drag?.kind === "drawHandle") {
        // Promote a press to a drag once it travels past the threshold, then
        // pull symmetric handles on the just-placed vertex: this curves the
        // segment we just drew (via handleIn) and pre-curves the next one.
        const distPx = Math.hypot((m.x - drag.anchor.x) * viewport.scale, (m.y - drag.anchor.y) * viewport.scale);
        if (!drag.moved && distPx < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        setActiveDrawHandle(drag.index);
        const offset = { x: m.x - drag.anchor.x, y: m.y - drag.anchor.y };
        setPerimeter((p) => setHandle(p, drag.index, "out", offset, true));
        return;
      }

      // ERASE VERTEX drag (perimeter view): accumulate every vertex the cursor SWEEPS
      // over (sampling the whole path from the last point to this one) so a fast drag
      // never skips a vertex between two pointer events. Uses the RAW cursor for the
      // same precision reason as the unravel line eraser. Deleted as one undo step on up.
      if (drag?.kind === "eraseVertex") {
        const mr = toModel(viewport, sx, sy);
        const beforeV = drag.collected.length;
        const beforeE = drag.edges.length;
        drag.collected = collectVerticesAlong(drag.last, mr, drag.collected);
        drag.edges = collectEdgesAlong(drag.last, mr, drag.edges);
        drag.last = mr;
        if (drag.collected.length !== beforeV) setEraseVertexCollected([...drag.collected]);
        if (drag.edges.length !== beforeE) setEraseEdgeCollected([...drag.edges]);
        return;
      }

      // Unravel hover-link: hit-test the cursor against the edge RECTANGLES (each
      // spans x0→x1 on x and y = 0..height on y). A rectangle is "hovered" when
      // the cursor falls inside its x range and its y range (0..height), with a
      // small screen-pixel tolerance. The matched rectangle's ORIGINAL edge index
      // highlights the rectangle here and the linked edge in the mini-window.
      if (unravelOn) {
        // ERASE drag: accumulate every erasable line the cursor SWEEPS over (sampling
        // the whole path from the last point to this one) so a fast drag never skips a
        // line between two pointer events. Uses the RAW cursor (the grid-snapped `m`
        // quantises to whole feet, but centerlines sit at fractional offsets and the
        // hit tolerance shrinks as you zoom in). Highlight the current cursor target.
        // The whole set is committed as one undo step on pointer-up.
        if (drag?.kind === "erase") {
          const mr = toModel(viewport, sx, sy);
          const before = drag.collected.length;
          drag.collected = collectEraseAlong(drag.last, mr, drag.collected);
          drag.last = mr;
          if (drag.collected.length !== before) setEraseDragCollected([...drag.collected]);
          setEraseHover(nearestEraseLine(mr));
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }

        // ASSEMBLY phase (a single CELL zoomed-into via double-click): highlight the
        // ONE edge of the focused cell the cursor is nearest, within a pixel
        // tolerance, so the user can target an individual edge. Left/right test the
        // cell's vertical borders (cursor near x0/x1 AND its y inside the cell band);
        // top/bottom test the horizontal borders (cursor near y1/y0 — model +Y is UP,
        // so y1 is the TOP edge, y0 the BOTTOM — AND its x inside the band). The
        // nearest qualifying edge wins; null when not near any. Other unravel hovers
        // are cleared so they don't fight. Takes precedence over the panel-phase tools.
        if (focusedCell !== null) {
          const fc = focusedCell;
          const loX = Math.min(fc.x0, fc.x1);
          const hiX = Math.max(fc.x0, fc.x1);
          const loY = Math.min(fc.y0, fc.y1);
          const hiY = Math.max(fc.y0, fc.y1);
          // Use the RAW (un-snapped) cursor position: the grid-snapped `m` quantises
          // to whole feet, but the cell's edges sit at arbitrary fractional offsets,
          // so the snapped point could never land within tolerance of an edge.
          const rect = canvasRef.current!.getBoundingClientRect();
          const mr = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
          const tol = pixelsToModel(viewport, HIT_TOLERANCE_PX);
          let best: "top" | "right" | "bottom" | "left" | null = null;
          let bestDist = Infinity;
          // Accumulate the nearest qualifying edge: record one whose perpendicular
          // distance is within tolerance AND closer than any seen so far.
          const consider = (edge: "top" | "right" | "bottom" | "left", dist: number): void => {
            if (dist <= tol && dist < bestDist) {
              best = edge;
              bestDist = dist;
            }
          };
          // Vertical edges (left = x0, right = x1): only when the cursor's y is within
          // the cell's height band.
          if (mr.y >= loY && mr.y <= hiY) {
            consider("left", Math.abs(mr.x - loX));
            consider("right", Math.abs(mr.x - hiX));
          }
          // Horizontal edges (top = y1, bottom = y0): only when the cursor's x is
          // within the cell's width band.
          if (mr.x >= loX && mr.x <= hiX) {
            consider("top", Math.abs(mr.y - hiY));
            consider("bottom", Math.abs(mr.y - loY));
          }
          setHoveredCellEdge(best);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          return;
        }
        // MULLIONS tool armed (Stick system): highlight whichever axis's grid lines the
        // cursor is over so the user sees that dragging will move them ALL together. Uses
        // the RAW (un-snapped) cursor position — the grid-snapped `m` quantises to whole
        // feet, but the centerlines sit at fractional offsets and `nearestGridLine`'s
        // tolerance SHRINKS in model units as you zoom in; at high zoom the snapped point
        // could never land within tolerance of a centerline, so the highlight would never
        // fire. (Mirrors the cell-edge hover above and the drag-start in onPointerDown.)
        // Clears the other hovers so they don't fight.
        if (mullionsOn && cwType === "stick" && focusedPanel !== null) {
          const hit = nearestGridLine(toModel(viewport, sx, sy), focusedPanel);
          setMullionHover(hit ? hit.axis : null);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        // FRAMING tool armed (Unitized system): highlight the single nearest edge of the
        // cell under the cursor so the user sees the one face a drag will move. Uses the
        // RAW cursor (same reasoning as the Stick hover above). Panels tab only. Clears
        // the other hovers so they don't fight.
        if (mullionsOn && cwType === "unitized" && focusedPanel !== null && focusedCell === null) {
          const hit = nearestCellEdge(toModel(viewport, sx, sy), focusedPanel);
          setCellEdgeHover(hit ? { cellIndex: hit.cellIndex, side: hit.side } : null);
          setMullionHover(null);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        // SUBTRACTIVE tool armed: instead of the hover-link, recommend an equal split.
        // We store the raw cursor model point (NO grid snap) whenever it's inside the
        // selected panel; the render builder picks the AXIS by `divideAxisAt` (equal-width
        // columns from .x, or equal-height rows from .y) and turns it into the division
        // lines + the spacing dimension. Clears the rectangle hover-link so they don't fight.
        if (subtractiveOn && focusedPanel !== null) {
          const seg = unravelResult?.segments.find((s) => s.index === focusedPanel);
          setDivideHover(seg && hitUnravelPanel(m) === focusedPanel ? m : null);
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        // ERASER tool armed: highlight the nearest erasable line (division line on
        // the focused panel, or a floor plate) as the deletion candidate. Clears
        // the rectangle hover-link so they don't fight.
        if (eraserOn) {
          setEraseHover(nearestEraseLine(toModel(viewport, sx, sy)));
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
          setHoveredCellEdge(null);
          return;
        }
        const segs = unravelResult?.segments;
        if (segs && segs.length > 0) {
          // Top-edge resize hover takes PRECEDENCE near a rectangle's top so the
          // resize affordance wins over the body hover-highlight.
          const top = hitUnravelTop(m);
          setHoveredUnravelTop(top);
          // PANELS phase (a SPLIT panel zoomed-in, not yet in the deeper Assembly
          // cell zoom): highlight the individual CELL under the cursor so the
          // subdivision reads as a set of navigable cells. When a cell is hit we
          // suppress the whole-panel body hover-link so the two highlights don't
          // fight; an unsplit panel (<= 1 cell) keeps the plain panel hover-link.
          if (focusedPanel !== null && focusedCell === null) {
            const cells = cellsForEdge(focusedPanel);
            const idx =
              cells.length > 1
                ? cells.findIndex((c) => m.x >= c.x0 && m.x <= c.x1 && m.y >= c.y0 && m.y <= c.y1)
                : -1;
            setHoveredCell(idx);
            setHoveredUnravelEdge(idx >= 0 ? -1 : hitUnravelPanel(m));
          } else {
            setHoveredCell(-1);
            // Rectangle body hover (reuses the shared panel hit-test).
            setHoveredUnravelEdge(hitUnravelPanel(m));
          }
        } else {
          setHoveredUnravelEdge(-1);
          setHoveredUnravelTop(-1);
          setHoveredCell(-1);
        }
        return;
      }

      // Hover feedback (edit mode, OR while the Erase tool is armed; not in the
      // read-only unravel view). The Erase tool lights the hovered vertex (drawn red)
      // for deletion; failing a vertex it lights the hovered EDGE of a closed loop
      // (also red) — a click there removes that segment, reopening the perimeter.
      // Reference-image grip hover: highlights the grip and sets the resize cursor, so
      // the pointer states what a drag will do before it starts. Only while the SELECT
      // tool holds an unlocked underlay — the one situation where grips are drawn.
      if (selectMode && !unravelOn && selectedImage && !selectedImage.locked) {
        setHoveredImageHandle(hitImageHandleAt(selectedImage, sx, sy));
      } else if (hoveredImageHandle !== null) {
        setHoveredImageHandle(null);
      }
      // Same for the WHOLE-SHAPE frame's grips, so both selections advertise their
      // targets identically.
      if (selectMode && !unravelOn && selectedPerimeterBounds) {
        setHoveredPerimeterHandle(hitShapeHandleAt(selectedPerimeterBounds, sx, sy));
      } else if (hoveredPerimeterHandle !== null) {
        setHoveredPerimeterHandle(null);
      }
      // Over the BODY of a movable underlay, advertise the move cursor.
      if (selectMode && !unravelOn) {
        const over = referenceImages.some((i) => !i.locked && hitImageBody(i, m));
        if (over !== overImageBody) setOverImageBody(over);
        const onShape =
          perimeter.vertices.length > 0 &&
          hitPerimeterBody(perimeter, m, pixelsToModel(viewport, HIT_TOLERANCE_PX));
        if (onShape !== overShapeBody) setOverShapeBody(onShape);
      } else {
        // Both flags have to be dropped when Select is put down or the phase changes —
        // clearing only the image one left the move cursor stuck on after leaving Plan.
        if (overImageBody) setOverImageBody(false);
        if (overShapeBody) setOverShapeBody(false);
      }

      if (!unravelOn && (mode === "edit" || eraserOn)) {
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        const vi = hitVertex(perimeter, m, tolModel);
        setHoveredVertex(vi);
        if (eraserOn) {
          setInsertPreview(null);
          setHoveredEdge(-1);
          // Vertex wins over edge; when no vertex is hovered, target the nearest segment.
          setEraseEdge(vi < 0 ? (hitSegment(perimeter, m, tolModel)?.index ?? -1) : -1);
        } else if (vi < 0) {
          const seg = hitSegment(perimeter, m, tolModel);
          setInsertPreview(seg ? seg.point : null);
          // Link the hovered footprint edge to its line on the active thumbnail.
          setHoveredEdge(seg ? seg.index : -1);
        } else {
          // Over a vertex, not an edge: drop the edge hover-link.
          setInsertPreview(null);
          setHoveredEdge(-1);
        }
      }
    },
    [
      eventToModel,
      mode,
      perimeter,
      viewport,
      unravelOn,
      unravelResult,
      hitUnravelTop,
      hitUnravelPanel,
      clampHeight,
      setPanelHeight,
      flushHistory,
      // Subtractive division tool reads these for the drag array + hover preview.
      subtractiveOn,
      focusedPanel,
      gridSpacing,
      // Eraser tool reads these to highlight the nearest line on hover and to sweep up
      // every line crossed during a drag.
      eraserOn,
      nearestEraseLine,
      collectEraseAlong,
      // Erase drag (perimeter view) sweeps up every vertex AND edge crossed.
      collectVerticesAlong,
      collectEdgesAlong,
      // Shift flips the drag axis; effectiveHeight resolves the panel height for the
      // equal-row generator; divideDraft.axis pins the axis chosen at press time.
      shiftHeld,
      effectiveHeight,
      divideDraft,
      // Floor plates feed buildEqualRows as snap guides during the row drag.
      floorPlates,
      // Per-cell hover (Panels phase) reads the focused-cell state + the cell grid.
      focusedCell,
      cellsForEdge,
      // Mullions tool hover/drag reads these.
      mullionsOn,
      cwType,
      nearestGridLine,
      // Framing tool (Unitized) hover/drag reads these.
      nearestCellEdge,
      cellInsetForPoint,
      // Export marquee drag recomputes the selected panels live as the box grows.
      panelsInMarquee,
      // Underlay move/resize + grip/body hover read these.
      selectMode,
      referenceImages,
      selectedImage,
      hoveredImageHandle,
      overImageBody,
      // The whole-shape hover + drag read these; without them the handler would keep a
      // stale closure and the frame would stop responding after the first render.
      overShapeBody,
      selectedPerimeterBounds,
      hitShapeHandleAt,
      hoveredPerimeterHandle,
      hitImageHandleAt,
      flushHistory,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      canvasRef.current?.releasePointerCapture(e.pointerId);
      const drag = dragRef.current;
      // Export marquee release: finalise the selection from the drag's final corner
      // (computed fresh from the event, so no reliance on async state) and, if any
      // walls were caught, open the export popup and disarm the select tool.
      if (drag?.kind === "marquee") {
        dragRef.current = null;
        setMarquee(null);
        const canvas = canvasRef.current;
        let sel = new Set<number>();
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          const mu = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
          sel = panelsInMarquee({ x0: drag.startModel.x, y0: drag.startModel.y, x1: mu.x, y1: mu.y });
        }
        setExportSelection(sel);
        if (sel.size > 0) {
          setExportPopup(sel);
          setExportSelectMode(false); // tool's job is done; disarm like a one-shot
        }
        return;
      }
      // Cell STROKE release — where a glazing stroke actually commits.
      //   • BRUSH LOADED: assign the stroke's type to every cell it swept, as ONE undo step,
      //     then drop the highlight. The hatch that replaces it is the feedback, so keeping
      //     the blue would only obscure the result the user just made. Deliberately deferred
      //     to release rather than painted per-cell during the drag: a stroke is one edit,
      //     so it must undo as one, and mid-drag writes would flood the history stack.
      //   • NO BRUSH: a real drag already built the selection live; a press with NO drag is a
      //     plain CLICK, so apply the single-cell TOGGLE (select it, or deselect if it was
      //     already selected).
      if (drag?.kind === "cellpaint") {
        dragRef.current = null;
        if (drag.brush !== null) {
          applyGlazingTo(drag.brush, drag.painted);
          setSelectedCells([]);
          return;
        }
        if (!drag.moved) selectCellAt(drag.edge, drag.downCell, false);
        return;
      }
      // A plain click in Arc mode (no handle pulled) auto-curves the segment
      // that was just committed (between the previous vertex and the new one).
      if (drag?.kind === "drawHandle" && !drag.moved && curveType === "arc" && drag.index >= 1) {
        setPerimeter((p) => makeSegmentArc(p, drag.index - 1));
      }
      // Subtractive division drag/click: commit the previewed equal split (the N-1
      // even division lines) onto the panel. Route by the draft's AXIS: VERTICAL
      // columns go to panelDivisions as x-OFFSETS from the panel's left edge;
      // HORIZONTAL rows go to panelDividersH as y-OFFSETS from the baseline. Then
      // clear the transient preview.
      if (drag?.kind === "divide") {
        const seg = unravelResult?.segments.find((s) => s.index === drag.edge);
        if (seg && divideDraft && divideDraft.edge === drag.edge) {
          if (divideDraft.axis === "h") {
            commitDividersH(drag.edge, divideDraft.lines);
          } else {
            commitDivisions(drag.edge, seg.x0, divideDraft.lines);
          }
        }
        setDivideDraft(null);
        setDivideHover(null);
      }
      // Erase drag: commit everything collected during the stroke as one undo step.
      if (drag?.kind === "erase") {
        commitEraseLines(drag.collected);
        setEraseDragCollected([]);
        setEraseHover(null);
      }
      // Erase drag (perimeter view): remove every vertex AND edge swept during the
      // stroke in one undo step. eraseElements splices the vertices, opens the edges,
      // and auto-drops any vertex orphaned by losing both its walls (so no point is
      // left alone); a closed loop reopens when an edge is cut or it falls below 3.
      if (drag?.kind === "eraseVertex") {
        if (drag.collected.length > 0 || drag.edges.length > 0) {
          recordHistory();
          const edges = drag.edges;
          const verts = drag.collected;
          setPerimeter((p) => eraseElements(p, edges, verts));
          setSelectedVertex(-1);
          setHoveredVertex(-1);
          setInsertPreview(null);
        }
        setEraseVertexCollected([]);
        setEraseEdgeCollected([]);
        setEraseEdge(-1);
      }
      // Mullion drag: commit the dragged half-width offset onto the panel/axis (one
      // undo step via the pre-drag snapshot taken on pointer-down), then drop the draft.
      if (drag?.kind === "mullion" && mullionDraft && mullionDraft.edge === drag.edge) {
        flushHistory();
        const off = mullionDraft.offset;
        const edge = mullionDraft.edge;
        if (mullionDraft.axis === "v") setPanelMullionsV((prev) => ({ ...prev, [edge]: off }));
        else setPanelMullionsH((prev) => ({ ...prev, [edge]: off }));
        setMullionDraft(null);
      }
      // Cell-framing drag (Unitized): commit the dragged inset — one edge, or all four
      // with Shift — onto EVERY cell that shares the dragged cell's Material ID (shape),
      // across all panels, so editing one cell mirrors to all identical cells project-
      // wide. One undo step. Matching cells are found by walking each panel's grid and
      // comparing shape keys, so the framing store stays keyed by panel + cell index.
      if (drag?.kind === "cellframe" && cellFrameDraft && cellFrameDraft.edge === drag.edge) {
        flushHistory();
        const { side, offset, all } = cellFrameDraft;
        const key = cellShapeColors.keyOf(drag.cell);
        const applyInset = (cur: CellInsets): CellInsets =>
          all
            ? { top: offset, right: offset, bottom: offset, left: offset }
            : { ...cur, [side]: offset };
        setPanelCellFraming((prev) => {
          const next = { ...prev };
          for (const seg of unravelResult?.segments ?? []) {
            const cells = cellsForEdge(seg.index);
            let panel: Record<number, CellInsets> | null = null;
            for (let i = 0; i < cells.length; i++) {
              if (cellShapeColors.keyOf(cells[i]) !== key) continue;
              if (!panel) panel = { ...(next[seg.index] ?? {}) };
              panel[i] = applyInset(panel[i] ?? { top: 0, right: 0, bottom: 0, left: 0 });
            }
            if (panel) next[seg.index] = panel;
          }
          return next;
        });
        setCellFrameDraft(null);
      }
      dragRef.current = null;
      setActiveDrawHandle(-1);
    },
    [curveType, unravelResult, divideDraft, commitDivisions, commitDividersH, commitEraseLines, mullionDraft, cellFrameDraft, cellShapeColors, cellsForEdge, flushHistory, recordHistory,
      // Cell-stroke release: commits the glazing paint, or falls back to the single-cell
      // toggle on a no-drag click when no brush was loaded.
      selectCellAt,
      applyGlazingTo,
      // Export marquee release resolves the final corner via viewport and selects panels.
      viewport, panelsInMarquee],
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // Layer navigation is otherwise driven by a SINGLE click (see onPointerDown) — the
      // two underlying presses already advance one layer (debounced so they don't jump
      // two). The ONE exception is the deepest layer:
      //
      // WALL BORDER -> CELLS. A double-click on a cell drills into the single-cell view.
      // Single-click there is already spoken for by cell SELECTION (the Glazing
      // workflow), so the drill takes the double-click — the same disambiguation design
      // tools use for entering a group. This is the ONLY route into that view now that
      // the top navigation tabs are gone; the "Cells" tab used to be it.
      if (unravelOn) {
        // While the GLAZING brush is loaded it owns the click, the way every other armed
        // tool does — so a double-click paints twice rather than drilling in. Otherwise a
        // stray double-click mid-stroke would dive a layer AND silently unload the brush
        // (the deeper layer fails the tool's gate). Esc puts the brush down; then the
        // double-click navigates again.
        if (glazingBrush !== null) return;
        if (focusedPanel !== null && focusedCell === null) {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const mu = toModel(viewport, e.clientX - rect.left, e.clientY - rect.top);
          const cells = cellsForEdge(focusedPanel);
          // Only a SPLIT panel has cells to enter; an undivided one has no deeper layer.
          if (cells.length > 1) {
            const target = cells.find((c) => mu.x >= c.x0 && mu.x <= c.x1 && mu.y >= c.y0 && mu.y <= c.y1);
            if (target) zoomToCell({ edge: focusedPanel, ...target });
          }
        }
        return;
      }
      // While PAN owns the left drag, a double-click is navigation — never a
      // close-the-perimeter / make-corner edit.
      if (panArmed) return;
      if (drawing && perimeter.vertices.length >= 3) {
        recordHistory();
        setPerimeter((p) => closePerimeter(p));
        setMode("edit");
        return;
      }
      // In edit mode, double-clicking a vertex strips its handles (curve → corner).
      if (mode === "edit") {
        const m = eventToModel(e);
        const tolModel = pixelsToModel(viewport, HIT_TOLERANCE_PX);
        const vi = hitVertex(perimeter, m, tolModel);
        if (vi >= 0) {
          recordHistory();
          setPerimeter((p) => clearVertexHandles(p, vi));
          setSelectedVertex(vi);
        }
      }
    },
    [drawing, mode, perimeter, viewport, eventToModel, unravelOn, recordHistory, panArmed,
      // Wall Border -> Cells drill reads these — and is suppressed while a glazing brush
      // is loaded, so the brush has to be current here.
      glazingBrush, focusedPanel, focusedCell, cellsForEdge, zoomToCell],
  );

  // Smooth, trackpad-friendly zoom. Attached as a NON-PASSIVE native wheel
  // listener (see effect below) so preventDefault() actually fires — React's
  // synthetic onWheel is passive, which would let a trackpad PINCH (ctrl+wheel)
  // zoom the whole browser page and two-finger scroll pan the page. The native
  // listener stops both and routes the gesture into the canvas viewport.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      // A zoom gesture during the unroll transition skips it, then applies to the
      // elevation view the next event lands in (the transition owns the framing).
      if (unrollFrameRef.current) {
        skipUnrollRef.current();
        return;
      }
      cancelAnim(); // manual zoom interrupts any running animation
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      const anchorY = e.clientY - rect.top;

      // Normalize the wheel delta to PIXELS so line/page-based wheels match the
      // pixel-mode trackpad case before we apply the exponential constant.
      //   deltaMode 0 = pixel (trackpad / most mice), 1 = line, 2 = page.
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16; // ~16px per line
      else if (e.deltaMode === 2) dy *= rect.height; // a page ≈ canvas height

      // Magnitude-proportional EXPONENTIAL zoom: factor = exp(-dy * K).
      // K = ln(1.1)/100 so a typical mouse notch (|dy| ≈ 100) ≈ the old 1.1 step,
      // while small trackpad/pinch deltas yield small, smooth factors. Clamp the
      // per-event factor so one huge delta can't teleport the zoom.
      const K = 0.0009531; // ln(1.1) / 100
      const factor = Math.min(2, Math.max(0.5, Math.exp(-dy * K)));
      setViewport((vp) => zoomAt(vp, anchorX, anchorY, factor));
    },
    [cancelAnim],
  );

  // Attach the wheel handler as a non-passive native listener so preventDefault
  // works (the primary fix for page-zoom on trackpad pinch). Re-binds only if
  // onWheel changes (it is stable: depends on the stable cancelAnim).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // ---------------------------------------------------------------------------
  // SAVE / LOAD / DELETE / RENAME / UPDATE saved perimeters.
  // The live model is deep-copied on save (clonePerimeter) so later edits to the
  // editor never mutate a stored entry. Declared before the keyboard effect so
  // the Ctrl+S handler can reference saveCurrent.
  // ---------------------------------------------------------------------------

  // Whether the current editor perimeter is substantial enough to save.
  const saveable = canSave(perimeter);

  /**
   * The current authored elevation state, bundled for save/auto-save. Mirrors the
   * persistent fields of DocSnapshot (NOT transient view state). Memoised so the
   * auto-save effect below has a stable, value-equal dependency to compare.
   */
  const currentElevation: SavedElevationState = useMemo(
    () => ({ unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCellTypes, panelCwType, unravelHeight, floorPlates }),
    [unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCellTypes, panelCwType, unravelHeight, floorPlates],
  );

  /**
   * The phase the RESTING-TOOL effect last acted on. Declared HERE, rather than beside
   * that effect further down, because `newProject` writes it too — see the effect for the
   * full rationale.
   */
  const prevPhaseRef = useRef(unravelOn);

  /**
   * Start a fresh, BLANK project — the clean slate a page refresh gives, minus the
   * onboarding hint. Resets the live editor document and all view/tool/navigation state
   * to their defaults and detaches from any loaded save (activeSavedId → null), while
   * KEEPING the saved projects list intact. Clears undo/redo (there's nothing to undo
   * back into the previous project) and suppresses the first-run hint, since this is a
   * deliberate "new project" action, not a cold load.
   *
   * It also leaves the PEN in hand. This is the same rule the app already applies on
   * arrival (see the resting-tool effect): an empty Plan canvas has nothing to select and
   * exactly one thing to do, so arming Select there would mean every new project began by
   * putting a tool down before any work could start. A new project IS an arrival.
   */
  const newProject = useCallback(() => {
    cancelAnim();
    // --- Document state (mirrors the initial useState values) ---
    setPerimeter(emptyPerimeter());
    setUnravelHeights({});
    setUnravelCells({});
    setPanelDivisions({});
    setPanelDividersH({});
    setPanelMullionsV({});
    setPanelMullionsH({});
    setPanelCellFraming({});
    setPanelCellTypes({});
    setPanelCwType({});
    setUnravelHeight(DEFAULT_WALL_HEIGHT_FT);
    setFloorPlates([]);
    setLocation(defaultLocation()); // a new sketch starts at the default site, not nowhere
    setReferenceImages([]);
    setSelectedImageId(null);
    setHoveredImageHandle(null);
    setPerimeterSelected(false); // a fresh document has no selection to carry over
    setImportStatus(null);
    // The default location is already a RESOLVED site, so the readout stays on rather
    // than blanking — matching the app's own first-load state.
    setGeoStatus("resolved");
    setGeoAlternatives([]);
    setUnravelInputDraft({});
    setFocusedUnravelInput(null);
    // --- View + navigation ---
    setUnravelOn(false);
    // Coming back from Elevations would otherwise trip the phase-change branch of the
    // resting-tool effect, which arms Select — overriding the Pen this action just put in
    // hand. Marking the phase as already handled is what makes New behave the same whether
    // it is pressed from Plan or from Elevations.
    prevPhaseRef.current = false;
    setMode("draw");
    setCurveType("line");
    setFocusedPanel(null);
    setFocusedCell(null);
    setCellViewMode("normal");
    setActiveSavedId(null);
    setViewport(defaultViewport(sizeRef.current.w, sizeRef.current.h));
    // --- Tools / menus / transient selection ---
    // The Pen is not a flag but the ABSENCE of one (see its button's active condition), so
    // arming it means releasing everything that could take the click first. Pan and Select
    // were the two that survived this reset, which is why New used to land on a blank
    // canvas where clicking did nothing.
    setPanMode(false);
    disarmSelect();
    setGlazingBrush(null);
    setSubtractiveOn(false);
    setDivideHover(null);
    setDivideDraft(null);
    setEraserOn(false);
    setEraseHover(null);
    setEraseDragCollected([]);
    setMullionsOn(false);
    setMullionHover(null);
    setMullionDraft(null);
    setCellEdgeHover(null);
    setCellFrameDraft(null);
    setTypeOn(false);
    setTypeVisible(true);
    setFloorPlateMode(false);
    setFloorLinesVisible(true);
    setCwMenuOpen(false);
    setStatsModes(["general"]);
    setSelectedVertex(-1);
    setHoveredVertex(-1);
    setHoveredCell(-1);
    setHoveredCellEdge(null);
    setHoveredEdge(-1);
    setInsertPreview(null);
    setCursorModel(null);
    setDimInput(null);
    // --- History ---
    setUndoStack([]);
    setRedoStack([]);
    pendingRef.current = null;
    // The empty canvas would normally re-show the onboarding hint; this action
    // explicitly suppresses it (no load-in text/arrow for a deliberate new project).
    setHintDismissed(true);
  }, [cancelAnim, disarmSelect]);

  /** Capture the current perimeter + elevation state as a NEW saved entry. */
  const saveCurrent = useCallback(() => {
    if (!canSave(perimeter)) return; // guard empty/degenerate
    setSaved((list) => {
      const entry = makeSavedPerimeter(perimeter, currentElevation, list, location, referenceImages);
      // A name typed in the Project section wins over the generated "Option N"; blank
      // keeps the generated one so saving never blocks on naming.
      const named = projectNameDraft.trim() ? { ...entry, name: projectNameDraft.trim() } : entry;
      setActiveSavedId(named.id);
      setProjectNameDraft(""); // the saved entry now owns the name
      return [...list, named];
    });
  }, [perimeter, currentElevation, location, referenceImages, projectNameDraft]);

  /** Load a saved perimeter back into the editor (replaces the live one). */
  const loadSavedEntry = useCallback(
    (s: SavedPerimeter) => {
      recordHistory(); // loading replaces the live shape — make it undoable
      const loaded = clonePerimeter(s.perimeter); // detach from the stored copy
      setPerimeter(loaded);
      // Restore the entry's elevation/unwrapped-view document state so a loaded
      // project brings back its panel edits (defaulting any field absent on
      // older saves). Fresh containers detach from the stored snapshot.
      setUnravelHeights({ ...(s.unravelHeights ?? {}) });
      setUnravelCells({ ...(s.unravelCells ?? {}) });
      // Division arrays are nested, so copy each panel's offsets array too.
      setPanelDivisions(
        Object.fromEntries(Object.entries(s.panelDivisions ?? {}).map(([k, v]) => [k, [...v]])),
      );
      // Horizontal dividers: same nested-array copy + default-{} for older saves.
      setPanelDividersH(
        Object.fromEntries(Object.entries(s.panelDividersH ?? {}).map(([k, v]) => [k, [...v]])),
      );
      // Mullion offsets (flat number maps) — fresh containers detach from the snapshot.
      setPanelMullionsV({ ...(s.panelMullionsV ?? {}) });
      setPanelMullionsH({ ...(s.panelMullionsH ?? {}) });
      // Unitized per-cell framing is a nested map — deep-copy both object levels.
      setPanelCellFraming(cloneCellFraming(s.panelCellFraming ?? {}));
      // Unitized per-cell type is a nested map — deep-copy both object levels.
      setPanelCellTypes(cloneCellTypes(s.panelCellTypes ?? {}));
      // Per-panel curtain-wall system assignment (flat map) — fresh container.
      setPanelCwType({ ...(s.panelCwType ?? {}) });
      setUnravelHeight(s.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT);
      setFloorPlates([...(s.floorPlates ?? [])]);
      // Restore the entry's geo-location (blank for older saves with none). The
      // readout follows from the STORED site, so a loaded project shows where it is
      // without re-resolving — and older saves, which carry an address but no resolved
      // coordinates, correctly show nothing rather than a stale place.
      const loc = s.location ? cloneLocation(s.location) : emptyLocation();
      setLocation(loc);
      setGeoStatus(loc.lat !== null && loc.lng !== null ? "resolved" : "idle");
      setGeoAlternatives([]);
      // Reference underlays (absent on projects saved before the feature). The decode
      // effect picks these up and repaints once each bitmap is ready.
      setReferenceImages(s.referenceImages ? cloneReferenceImages(s.referenceImages) : []);
      setSelectedImageId(null);
      setHoveredImageHandle(null);
      setPerimeterSelected(false); // the frame belonged to the shape being replaced
      setImportStatus(null);
      setActiveSavedId(s.id);
      // Closed shapes are most useful to edit; open polylines can keep drawing.
      setMode(s.perimeter.closed ? "edit" : "draw");
      setSelectedVertex(-1);
      setHoveredVertex(-1);
      setInsertPreview(null);
      // ZOOM-TO-FIT the loaded perimeter's content — footprint when in perimeter
      // view, unravel strip when in elevation view — so saved shapes at different
      // scales each arrive framed on screen without manual zoom hunting.
      const { w, h } = sizeRef.current;
      if (unravelOn) {
        const res = unravelPerimeter(loaded, unravelGap);
        if (res.segments.length > 0) {
          const loadedHeights = { ...(s.unravelHeights ?? {}) };
          const loadedDefaultH = s.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT;
          const heightOf = (seg: UnravelSegment) => loadedHeights[seg.index] ?? loadedDefaultH;
          animateViewport(
            fitViewport(unravelBoundsPerimeter(res.segments, heightOf), w, h, 48, undefined, 1, canvasInsets()),
          );
        }
      } else {
        animateViewport(fitViewport(loaded, w, h, 64, undefined, 1, canvasInsets()));
      }
    },
    [recordHistory, animateViewport, unravelOn, unravelGap, canvasInsets],
  );

  // ===========================================================================
  // GUIDED DEMO — the "Demo" button in the utility bar.
  //
  // It BUILDS the example project in front of the user rather than loading a finished
  // one: draw the footprint, place the site, unroll the walls, then floor lines, system,
  // centerlines, framing, glazing and the numbers that fall out of them. The value of a
  // facade tool is in that sequence, and a finished file shows none of it.
  //
  // The script (geometry, parameters, copy) is pure data in core/demoTour.ts. What lives
  // here is only the part that cannot: which of THIS component's setters each step calls.
  //
  // Rules the driver keeps:
  //   · NOTHING IS FAKED. Every step writes the same state the matching tool writes, so
  //     the result is a real, editable project — not a scripted picture of one.
  //   · NOTHING IS LOST. An unsaved sketch is filed into the project list before the demo
  //     clears the canvas (see startTour), and exiting keeps whatever has been built.
  //   · IT NEVER ADVANCES ITSELF. Each step animates and then waits; only Next / Back /
  //     Exit move the tour.
  //   · IT IS INTERRUPTIBLE. Every await is followed by an `alive()` check, so exiting or
  //     stepping away abandons an in-flight animation on the next frame.
  // ===========================================================================

  /** Which step of the demo is showing, or null when the tour is not running. */
  const [tourStep, setTourStep] = useState<number | null>(null);
  /**
   * Has the Demo button been used yet THIS VISIT? Until it has, the button pulses so a
   * first-time visitor can find the one control that explains the rest of the app; once
   * they have clicked it, it goes quiet permanently and behaves like every other button.
   *
   * Kept in sessionStorage rather than localStorage: "this visit" is the tab session, so it
   * survives a reload (a refresh is not a fresh visitor) but a new tab starts over. Reads
   * and writes are guarded because storage throws outright in some privacy modes, and a
   * decorative pulse must never be able to break the app.
   */
  const [demoSeen, setDemoSeen] = useState(() => {
    try {
      return sessionStorage.getItem(DEMO_SEEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const markDemoSeen = useCallback(() => {
    setDemoSeen(true);
    try {
      sessionStorage.setItem(DEMO_SEEN_KEY, "1");
    } catch {
      /* storage unavailable — the pulse just returns next reload, which harms nothing */
    }
  }, []);
  /**
   * Bumped whenever a step starts, the user moves, or the tour exits. A running step
   * script captures the value it started with and stops the moment they differ — which is
   * what makes a multi-second animation abandonable without any per-step teardown.
   */
  const tourGenRef = useRef(0);

  /**
   * Capture the current document as the demo's saved project.
   *
   * A FIXED id (not a generated one) so re-running the demo overwrites its own entry
   * instead of piling up copies in the user's library, and so stepping Back over the save
   * is idempotent. The Solar Study reads a SAVED project, which is why the tour has to
   * save at all rather than staying live-only.
   */
  const saveDemoProject = useCallback(() => {
    const entry: SavedPerimeter = {
      ...makeSavedPerimeter(perimeter, currentElevation, saved, location, referenceImages),
      id: DEMO_SAVED_ID,
      name: DEMO_PROJECT_NAME,
    };
    setSaved((list) => {
      const i = list.findIndex((s) => s.id === DEMO_SAVED_ID);
      if (i === -1) return [...list, entry];
      const next = [...list];
      next[i] = entry;
      return next;
    });
    setActiveSavedId(DEMO_SAVED_ID);
    setProjectNameDraft(""); // the saved entry owns the name now
  }, [perimeter, currentElevation, saved, location, referenceImages]);

  /**
   * The values and callbacks a step script reads AFTER awaiting a frame — by which time
   * the closure it started in is stale. Rewritten every render (the same pattern as
   * `docRef`), so the ref always hands back the current one.
   */
  const tourLiveRef = useRef<{
    unravelOn: boolean;
    segments: UnravelSegment[];
    cellsForEdge: (edge: number) => { x0: number; x1: number; y0: number; y1: number }[];
    zoomToPanel: (edge: number) => void;
    selectCwType: (t: CwType) => void;
    saveDemoProject: () => void;
    fitUnravel: (gap: number, heights: Record<number, number>, defaultHeight: number) => void;
    panelsInMarquee: (rect: { x0: number; y0: number; x1: number; y1: number }) => Set<number>;
  }>(null!);
  tourLiveRef.current = {
    unravelOn,
    segments: unravelResult?.segments ?? [],
    cellsForEdge,
    zoomToPanel,
    selectCwType,
    saveDemoProject,
    fitUnravel,
    panelsInMarquee,
  };

  /**
   * Run one step's state changes. Held in a ref and keyed by step id, so the effect below
   * can depend on the step INDEX alone — it never needs this function's identity, which
   * changes on every render because the setters it drives do.
   *
   * `alive()` is false once the step has been superseded; every await is followed by a
   * check, and a false result returns immediately, leaving the document exactly as far as
   * it got. That is safe because each step's writes are independent and idempotent.
   */
  const runTourStepRef = useRef<(id: string, alive: () => boolean) => Promise<void>>(async () => {});
  runTourStepRef.current = async (id, alive) => {
    /** Sleep, then report whether the step is still the current one. */
    const sleep = async (ms: number) => {
      await new Promise<void>((r) => setTimeout(r, ms));
      return alive();
    };
    /** Let React commit pending state so the live ref and derived memos catch up. */
    const settle = async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      return alive();
    };
    /** Drive `onFrame(0…1)` over `ms`, stopping early if the step is superseded. */
    const animate = (ms: number, onFrame: (t: number) => void) =>
      new Promise<void>((resolve) => {
        const started = performance.now();
        const frame = (now: number) => {
          if (!alive()) return resolve();
          const t = Math.min(1, (now - started) / ms);
          onFrame(t);
          if (t >= 1) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });

    switch (id) {
      // --- 1. Draw the footprint, the way the Pen tool does -------------------
      case "footprint": {
        // Reachable by stepping BACK from a later card, which may leave the app in the
        // Elevations phase — where the footprint is not drawn at all, so the whole
        // animation would play off-screen. Fold to the plan first and let the transition
        // finish before anything is drawn.
        if (tourLiveRef.current.unravelOn) {
          toggleUnrollViewRef.current();
          if (!(await sleep(unrollDurationMs(canvasRef.current) + 120))) return;
        }
        setPerimeter(emptyPerimeter());
        setMode("draw");
        setUnravelHeight(DEMO_WALL_HEIGHT_FT);
        // Frame the FINISHED shape before a single vertex lands, so the outline grows
        // into a stable view instead of the camera chasing it.
        const { w, h } = sizeRef.current;
        setViewport(fitViewport(DEMO_PERIMETER, w, h, 96, undefined, 1, canvasInsets()));
        if (!(await sleep(260))) return;
        await animate(2100, (t) => setPerimeter(demoDrawFrame(DEMO_PERIMETER, t)));
        if (!alive()) return;
        setPerimeter(DEMO_PERIMETER); // land exactly on the authored geometry
        setMode("edit");
        return;
      }

      // --- 2. Resolve a real site, then open the Solar Study ------------------
      case "site": {
        setLocation((l) => ({ ...l, address: "" }));
        setGeoStatus("idle");
        if (!(await sleep(260))) return;
        // Typed a character at a time: the Location field is a real control, and watching
        // it fill in is what makes the resolution that follows read as the app working
        // rather than a value appearing from nowhere.
        for (let i = 1; i <= DEMO_ADDRESS.length; i++) {
          setLocation((l) => ({ ...l, address: DEMO_ADDRESS.slice(0, i) }));
          if (!(await sleep(45))) return;
        }
        await commitAddress(DEMO_ADDRESS);
        if (!(await settle())) return;
        tourLiveRef.current.saveDemoProject();
        if (!(await settle())) return;
        setSolarStudyId(DEMO_SAVED_ID);
        return;
      }

      // --- 3. Unroll into the elevation strip ---------------------------------
      case "elevations": {
        setSolarStudyId(null);
        if (!(await settle())) return;
        // Guard on the CURRENT phase: stepping Back into this card from Floor Lines must
        // re-frame the strip, not fold the building back up.
        if (!tourLiveRef.current.unravelOn) toggleUnrollViewRef.current();
        // Wait out the unroll transition so the strip is settled before the next step
        // starts measuring panels off it.
        if (!(await sleep(unrollDurationMs(canvasRef.current) + 200))) return;
        return;
      }

      // --- 4. Floor lines, one level at a time --------------------------------
      case "floors": {
        setFloorLinesVisible(true);
        // Entering Elevations arms Select (the resting tool). Release it before arming
        // Floor Lines, or two buttons in the bar would be lit and neither would be
        // telling the truth about what a click does. Nothing re-arms Select until the
        // Statistics step, so this one release covers the whole cluster walkthrough.
        disarmSelect();
        setFloorPlateMode(true);
        if (!(await sleep(240))) return;
        for (const level of demoFloorLevels(DEMO_WALL_HEIGHT_FT, DEMO_FLOOR_TO_FLOOR_FT)) {
          setFloorPlates((plates) =>
            plates.some((p) => Math.abs(p - level) <= 1e-6)
              ? plates
              : [...plates, level].sort((a, b) => a - b),
          );
          if (!(await sleep(150))) return;
        }
        return;
      }

      // --- 5. Pick the curtain-wall system for the south wall -----------------
      case "cwtype": {
        setFloorPlateMode(false);
        tourLiveRef.current.zoomToPanel(DEMO_FOCUS_EDGE);
        if (!(await sleep(620))) return;
        setCwMenuOpen(true); // show the chooser before something is picked out of it
        if (!(await sleep(820))) return;
        tourLiveRef.current.selectCwType("stick");
        if (!(await settle())) return;
        // The tool assigns the focused border; the rest of the facade gets the same
        // system so the framing and the cost estimate below cover the whole building.
        const segs = tourLiveRef.current.segments;
        setPanelCwType((prev) => {
          const next = { ...prev };
          for (const s of segs) next[s.index] = "stick";
          return next;
        });
        return;
      }

      // --- 6. Divide the wall into its curtain-wall grid ----------------------
      case "centerlines": {
        setCwMenuOpen(false);
        setCenterlinesVisible(true);
        setSubtractiveOn(true);
        if (!(await sleep(220))) return;
        const segs = tourLiveRef.current.segments;
        const focus = segs.find((s) => s.index === DEMO_FOCUS_EDGE);
        const rows = demoRowOffsets(DEMO_WALL_HEIGHT_FT, DEMO_FLOOR_TO_FLOOR_FT, DEMO_SPANDREL_BAND_FT);
        if (focus) {
          // Start from a BARE panel. Replaying this card (Back) would otherwise append a
          // second copy of every offset: the grid would look identical, because
          // cellsForEdge dedupes coincident lines, but the document would carry duplicate
          // centerlines that the Delete tool would then find two of.
          setPanelDivisions((prev) => ({ ...prev, [DEMO_FOCUS_EDGE]: [] }));
          setPanelDividersH((prev) => ({ ...prev, [DEMO_FOCUS_EDGE]: [] }));
          if (!(await sleep(120))) return;
          // Columns then rows, drawn in one at a time on the wall being looked at.
          for (const off of demoColumnOffsets(Math.abs(focus.x1 - focus.x0), DEMO_MODULE_FT)) {
            setPanelDivisions((prev) => ({ ...prev, [DEMO_FOCUS_EDGE]: [...(prev[DEMO_FOCUS_EDGE] ?? []), off] }));
            if (!(await sleep(60))) return;
          }
          if (!(await sleep(200))) return;
          for (const off of rows) {
            setPanelDividersH((prev) => ({ ...prev, [DEMO_FOCUS_EDGE]: [...(prev[DEMO_FOCUS_EDGE] ?? []), off] }));
            if (!(await sleep(60))) return;
          }
          if (!(await sleep(260))) return;
        }
        // Every other border at once — each with the module count its OWN width calls for.
        setPanelDivisions((prev) => {
          const next = { ...prev };
          for (const s of segs) next[s.index] = demoColumnOffsets(Math.abs(s.x1 - s.x0), DEMO_MODULE_FT);
          return next;
        });
        setPanelDividersH((prev) => {
          const next = { ...prev };
          for (const s of segs) next[s.index] = [...rows];
          return next;
        });
        return;
      }

      // --- 7. Grow the mullion face offset out of the centerlines -------------
      case "framing": {
        setSubtractiveOn(false);
        setFramingVisible(true);
        setMullionsOn(true);
        if (!(await sleep(240))) return;
        const FRAMES = 14;
        for (let i = 1; i <= FRAMES; i++) {
          const v = (DEMO_MULLION_OFFSET_FT * i) / FRAMES;
          setPanelMullionsV((prev) => ({ ...prev, [DEMO_FOCUS_EDGE]: v }));
          setPanelMullionsH((prev) => ({ ...prev, [DEMO_FOCUS_EDGE]: v }));
          if (!(await sleep(35))) return;
        }
        if (!(await sleep(240))) return;
        const segs = tourLiveRef.current.segments;
        const applyAll = (prev: Record<number, number>) => {
          const next = { ...prev };
          for (const s of segs) next[s.index] = DEMO_MULLION_OFFSET_FT;
          return next;
        };
        setPanelMullionsV(applyAll);
        setPanelMullionsH(applyAll);
        return;
      }

      // --- 8. Paint the glass, one material at a time -------------------------
      case "glazing": {
        setMullionsOn(false);
        setTypeVisible(true);
        setTypeOn(true); // open the chooser so the material is picked, not conjured
        if (!(await sleep(760))) return;
        setTypeOn(false);

        const segs = tourLiveRef.current.segments;
        const height = DEMO_WALL_HEIGHT_FT;
        /** Cells of `edge` whose band classification matches `want`, in grid order. */
        const cellsOfType = (edge: number, want: "vision" | "spandrel") => {
          const out: number[] = [];
          tourLiveRef.current.cellsForEdge(edge).forEach((c, i) => {
            if (demoCellType(c.y0, c.y1, height, DEMO_FLOOR_TO_FLOOR_FT, DEMO_SPANDREL_BAND_FT) === want)
              out.push(i);
          });
          return out;
        };

        // One MATERIAL at a time on the focused wall — vision first, then the brush is
        // visibly swapped and the spandrel bands go on. Each pass sweeps the panel in grid
        // order (column by column, left to right), which is how a drag across cells reads.
        // Every other wall follows in one pass once the pattern has been established.
        for (const material of ["vision", "spandrel"] as const) {
          setGlazingBrush(material);
          if (!(await sleep(320))) return;
          const indices = cellsOfType(DEMO_FOCUS_EDGE, material);
          const BATCH = Math.max(1, Math.ceil(indices.length / 12));
          for (let i = 0; i < indices.length; i += BATCH) {
            const batch = indices.slice(i, i + BATCH);
            setPanelCellTypes((prev) => {
              const panel = { ...(prev[DEMO_FOCUS_EDGE] ?? {}) };
              for (const idx of batch) panel[idx] = material;
              return { ...prev, [DEMO_FOCUS_EDGE]: panel };
            });
            if (!(await sleep(55))) return;
          }
        }
        if (!(await sleep(260))) return;
        setPanelCellTypes((prev) => {
          const next = { ...prev };
          for (const s of segs) {
            if (s.index === DEMO_FOCUS_EDGE) continue;
            const panel: Record<number, CellType> = {};
            tourLiveRef.current.cellsForEdge(s.index).forEach((c, i) => {
              panel[i] = demoCellType(c.y0, c.y1, height, DEMO_FLOOR_TO_FLOOR_FT, DEMO_SPANDREL_BAND_FT);
            });
            next[s.index] = panel;
          }
          return next;
        });
        return;
      }

      // --- 9. The same drawing, read several ways -----------------------------
      case "viewmodes": {
        // Put the brush down first: the view modes are a READ, and leaving a paint tool
        // armed under them would say a click still assigns glass.
        setGlazingBrush(null);
        setTypeOn(false);
        armSelectDefault();
        // Pull back to the whole strip — Material ID and Orientation are both comparisons
        // ACROSS walls, which one zoomed-in border cannot show.
        tourLiveRef.current.fitUnravel(unravelGap, {}, DEMO_WALL_HEIGHT_FT);
        if (!(await sleep(520))) return;
        for (const mode of DEMO_VIEW_MODE_SEQUENCE) {
          selectViewMode(mode);
          if (!(await sleep(1150))) return;
        }
        return;
      }

      // --- 10. Read the building back off the drawing -------------------------
      case "statistics": {
        setGlazingBrush(null);
        setTypeOn(false);
        armSelectDefault();
        selectViewMode("normal"); // stepping Back could have left another mode on
        setStatsModes(["general", "wwr", "cost"]);
        setFrontWin("stats");
        if (!(await settle())) return;
        // Pull back to the whole strip: the readings are about the building, and the
        // focused border stays set so the per-wall reads still name one.
        // No per-panel height overrides exist in the demo — every wall is the default.
        tourLiveRef.current.fitUnravel(unravelGap, {}, DEMO_WALL_HEIGHT_FT);
        return;
      }

      // --- 11. Select walls with the marquee and open the export dialog -------
      //
      // It OPENS the dialog and stops there. Nothing is downloaded: the three target
      // buttons are left for the user to press, because a demo that writes a file to
      // someone's disk without being asked is not a demo.
      case "export": {
        setExportPopup(null); // a replay starts from no dialog, so the sweep is visible
        closeAllMenus();
        disarmSelect();
        setExportSelectMode(true);
        if (!(await sleep(420))) return;

        const run = demoExportWindow(tourLiveRef.current.segments, DEMO_FOCUS_EDGE, DEMO_EXPORT_PANEL_COUNT);
        if (run.length === 0) return;
        const pad = DEMO_MARQUEE_PAD_FT;
        const from = run[0].x0 - pad;
        const to = run[run.length - 1].x1 + pad;
        const box = (x1: number) => ({ x0: from, y0: -pad, x1, y1: DEMO_WALL_HEIGHT_FT + pad });

        // Sweep the box across the run, updating the live selection as it goes — the same
        // thing the drag handler does on every pointer move.
        await animate(900, (t) => {
          const rect = box(from + (to - from) * t);
          setMarquee(rect);
          setExportSelection(tourLiveRef.current.panelsInMarquee(rect));
        });
        if (!alive()) return;

        // Release: the box goes, the selection stays, the dialog opens, and the tool
        // disarms — a marquee is a one-shot (mirrors the pointer-up handler).
        const selection = tourLiveRef.current.panelsInMarquee(box(to));
        setMarquee(null);
        setExportSelection(selection);
        setExportSelectMode(false);
        if (selection.size === 0) return;
        if (!(await sleep(320))) return;
        setExportPopup(selection);
        return;
      }

      // --- 12. Nothing to do but hand the project over ------------------------
      case "done": {
        // Clear the export dialog and its green highlight so the last card shows the
        // finished building rather than a leftover selection.
        setExportPopup(null);
        setExportSelection(new Set());
        armSelectDefault();
        return;
      }
    }
  };

  // Run the current step. Keyed on the INDEX alone, so Back replays a step exactly as
  // Next played it; the cleanup bumps the generation, which is what stops an in-flight
  // animation the moment the user moves or exits.
  useEffect(() => {
    if (tourStep === null) return;
    const gen = ++tourGenRef.current;
    void runTourStepRef.current(TOUR_STEPS[tourStep].id, () => tourGenRef.current === gen);
    return () => {
      tourGenRef.current++;
    };
  }, [tourStep]);

  /**
   * Start the demo. An unsaved sketch is FILED FIRST — the demo clears the canvas to draw
   * its own building, and a button labelled "Demo" must not be able to cost the user work
   * they have not saved. Anything already saved is untouched either way.
   */
  const startTour = useCallback(() => {
    if (activeSavedId === null && canSave(perimeter)) saveCurrent();
    setHelpPanel(null);
    setHelpMenuOpen(false);
    setExportPopup(null);
    setSolarStudyId(null);
    newProject();
    setTourStep(0);
  }, [activeSavedId, perimeter, saveCurrent, newProject]);

  /**
   * Leave the demo, keeping everything it has built so far. The two dialogs the tour
   * OPENS are closed with it — they were the tour talking, not something the user asked
   * for — along with the marquee state, so the canvas is handed back clean.
   */
  const exitTour = useCallback(() => {
    tourGenRef.current++; // abandon any in-flight step animation on its next frame
    setTourStep(null);
    setSolarStudyId(null);
    setExportPopup(null);
    setExportSelectMode(false);
    setMarquee(null);
    setExportSelection(new Set());
  }, []);

  const nextTourStep = useCallback(() => {
    setTourStep((s) => (s === null || s + 1 >= TOUR_STEPS.length ? null : s + 1));
  }, []);

  const backTourStep = useCallback(() => {
    setTourStep((s) => (s === null || s === 0 ? s : s - 1));
  }, []);

  const deleteSavedEntry = useCallback(
    (id: string) => {
      const index = saved.findIndex((s) => s.id === id);
      if (index === -1) return;
      // Record the deletion so Ctrl+Z / the Undo button can bring the project back
      // (and Ctrl+Y / Redo removes it again). Entries are immutable, so holding the
      // reference for re-insertion is safe.
      pushHistory({ kind: "delete", entry: saved[index], index });
      setSaved((list) => list.filter((s) => s.id !== id));
      setActiveSavedId((cur) => (cur === id ? null : cur));
    },
    [saved, pushHistory],
  );

  const renameSavedEntry = useCallback((id: string, name: string) => {
    setSaved((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const reorderSaved = useCallback((from: number, to: number) => {
    setSaved((list) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  /**
   * Duplicate an entire saved project (perimeter + all elevation/framing state, floor
   * plates, location, solar) into a new "Option N" entry appended to the list. The
   * source's stored snapshot stays current via the auto-save effect, so duplicating the
   * ACTIVE project copies its live edits too. Leaves the current selection untouched
   * (the copy is added, not loaded) so it's non-destructive to in-progress work.
   */
  const duplicateSavedEntry = useCallback((id: string) => {
    setSaved((list) => {
      const src = list.find((s) => s.id === id);
      if (!src) return list;
      return [...list, duplicateSavedPerimeter(src, list)];
    });
  }, []);

  /**
   * Update a saved entry's geo-location (edited from its Solar Study popup). When
   * the entry is the ACTIVE one, also sync the live `location` state so the left
   * LOCATION panel stays consistent and the auto-save effect doesn't overwrite the
   * change with the stale live value.
   */
  const changeSavedLocation = useCallback(
    (id: string, loc: LocationInfo) => {
      setSaved((list) => list.map((s) => (s.id === id ? { ...s, location: cloneLocation(loc) } : s)));
      if (id === activeSavedId) setLocation(cloneLocation(loc));
    },
    [activeSavedId],
  );

  // Persist a saved entry's SOLAR settings (cardinal orientation + studied date/time
  // + site), edited from its Solar Study popup. Mirrors changeSavedLocation: the
  // settings are deep-copied so the stored snapshot is detached from the popup's live
  // state. Persisting `northOffset` here is what a later step will read to derive each
  // facade's cardinal orientation from the drawn perimeter + this study set.
  const changeSavedSolar = useCallback((id: string, solar: SolarSettings) => {
    setSaved((list) => list.map((s) => (s.id === id ? { ...s, solar: cloneSolarSettings(solar) } : s)));
  }, []);

  // AUTO-SAVE the active entry. When a saved entry is loaded (activeSavedId set),
  // every authored document change — footprint geometry AND elevation-view panel
  // edits — writes back into THAT entry only, with no manual button. The user's
  // edits to a loaded project always persist to that specific pipeline.
  useEffect(() => {
    if (activeSavedId == null) return; // brand-new unsaved shape: stays live only
    setSaved((list) => {
      const idx = list.findIndex((s) => s.id === activeSavedId);
      if (idx === -1) return list; // active id no longer present: nothing to write
      const cur = list[idx];
      // NO-OP GUARD: loading an entry sets these states, which would otherwise
      // trigger an identical write-back every render (and persist churn). If the
      // stored fields already deep-equal the live document, return the SAME list
      // reference so React bails out (no re-render, no persist). A JSON compare of
      // these small maps/arrays/perimeter is cheap and readable. The maps/arrays
      // are built/replaced (never mutated) with stable key insertion order, so
      // stringify comparison is reliable here.
      const sameGeom = JSON.stringify(cur.perimeter) === JSON.stringify(perimeter);
      const sameElev =
        JSON.stringify(cur.unravelHeights ?? {}) === JSON.stringify(unravelHeights) &&
        JSON.stringify(cur.unravelCells ?? {}) === JSON.stringify(unravelCells) &&
        JSON.stringify(cur.panelDivisions ?? {}) === JSON.stringify(panelDivisions) &&
        JSON.stringify(cur.panelDividersH ?? {}) === JSON.stringify(panelDividersH) &&
        JSON.stringify(cur.panelMullionsV ?? {}) === JSON.stringify(panelMullionsV) &&
        JSON.stringify(cur.panelMullionsH ?? {}) === JSON.stringify(panelMullionsH) &&
        JSON.stringify(cur.panelCellFraming ?? {}) === JSON.stringify(panelCellFraming) &&
        JSON.stringify(cur.panelCellTypes ?? {}) === JSON.stringify(panelCellTypes) &&
        JSON.stringify(cur.panelCwType ?? {}) === JSON.stringify(panelCwType) &&
        (cur.unravelHeight ?? DEFAULT_WALL_HEIGHT_FT) === unravelHeight &&
        JSON.stringify(cur.floorPlates ?? []) === JSON.stringify(floorPlates);
      // Location is metadata, compared the same way (a blank live location matches a
      // stored entry that never had one, so loading then idling never re-writes).
      const sameLoc = JSON.stringify(cur.location ?? emptyLocation()) === JSON.stringify(location);
      // Reference images are compared by PLACEMENT SIGNATURE, never by stringifying the
      // whole list: each carries a data URL of hundreds of KB, and JSON.stringify-ing
      // those on every render would be a serious cost for no information. `src` is
      // immutable for a given id, so id + geometry + display flags fully determine
      // whether anything the user changed needs writing back.
      const sameImgs = imageSignature(cur.referenceImages ?? []) === imageSignature(referenceImages);
      if (sameGeom && sameElev && sameLoc && sameImgs) return list; // in sync — no change

      // ISOLATION: replace ONLY the active entry; every other entry keeps its
      // exact reference. Deep-copy the live document into the snapshot so later
      // edits can't mutate it.
      const elev = cloneElevationState(currentElevation);
      const next = list.slice();
      next[idx] = {
        ...cur,
        perimeter: clonePerimeter(perimeter),
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
      return next;
    });
  }, [activeSavedId, perimeter, unravelHeights, unravelCells, panelDivisions, panelDividersH, panelMullionsV, panelMullionsH, panelCellFraming, panelCellTypes, panelCwType, unravelHeight, floorPlates, currentElevation, location, referenceImages, setSaved]);

  /**
   * AUTO-CREATE the project the moment the perimeter CLOSES.
   *
   * Previously the sketch stayed unsaved until the user found "Save" in the Projects
   * popup, and everything downstream was gated behind that — so drawing a footprint and
   * reaching for the next step led to a disabled control with no explanation of why.
   * Closing the shape is the natural commit point: the footprint is complete, so the
   * project exists. The Save button still works for deliberately spinning off new options.
   *
   * Fires on the open -> closed EDGE, not merely on "is closed". That matters: deleting
   * the active project clears `activeSavedId` while the perimeter stays closed, and a
   * condition-based check would instantly recreate the project the user just deleted.
   */
  const prevClosedRef = useRef(perimeter.closed);
  useEffect(() => {
    const wasClosed = prevClosedRef.current;
    prevClosedRef.current = perimeter.closed;
    // Suppressed during the guided demo: the tour closes a perimeter of its own and then
    // saves it under a FIXED id two steps later (see saveDemoProject), so letting this
    // fire would file a stray "Option N" copy of the same building first.
    if (tourStep !== null) return;
    if (!wasClosed && perimeter.closed && activeSavedId === null && canSave(perimeter)) {
      saveCurrent();
    }
  }, [perimeter, activeSavedId, saveCurrent, tourStep]);

  // Persist whenever the saved list changes (keeps localStorage in sync). The result
  // is checked because reference images make the few-MB quota genuinely reachable, and
  // a save that silently stops working would cost the user their session.
  useEffect(() => {
    setSaveFailed(!persistSaved(saved));
  }, [saved]);

  // ---------------------------------------------------------------------------
  // KEYBOARD
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // UNROLL TRANSITION: ANY key skips it (Escape included) and is otherwise
      // swallowed — a shortcut aimed at the footprint must not fire in the elevation
      // view the transition is still on its way to. Modifiers alone are ignored so
      // holding Ctrl/Shift ahead of a shortcut doesn't cut the transition short.
      if (unrollFrameRef.current) {
        if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") {
          e.preventDefault();
          skipUnrollRef.current();
        }
        return;
      }

      if (e.key === "Shift") setShiftHeld(true);

      // While the help popup is open it owns Escape (its own effect closes it);
      // don't let Escape here also cancel a polyline / clear selection. (The
      // Statistics dropdown is sticky and does NOT consume Escape, so Escape keeps
      // its normal behaviour while stats are shown.)
      if (helpOpen && e.key === "Escape") return;

      // Ignore shortcuts while typing in a form field.
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";

      // HELP — "?" or F1 opens the reference chooser (Controls / Statistics / View modes).
      // The Help BUTTON was removed from the utility bar, so this keystroke is now the way
      // in; Escape (handled while open) closes it. Skipped while typing, where "?" is text.
      if ((e.key === "?" || e.key === "F1") && !typing) {
        e.preventDefault();
        if (helpOpen) closeHelp();
        else setHelpMenuOpen(true);
        return;
      }

      // SPACE = hold-to-PAN (Rhino / Illustrator / Figma convention). While held, a left
      // drag on the canvas moves the view; releasing returns to the tool that was armed
      // before, so it never changes the Pan button's own toggle. preventDefault stops the
      // page from scrolling AND stops Space from re-clicking whatever button has focus.
      // Skipped while typing — a space belongs to the text field.
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }

      // Ctrl/Cmd+S — save the current perimeter (prevent the browser save dialog).
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveCurrent();
        return;
      }

      // Ctrl/Cmd+Z = undo · Ctrl+Y or Ctrl/Cmd+Shift+Z = redo. Skipped while typing
      // in a field so native text undo still works there.
      if (!typing && (e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (!typing && (e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }

      // ARROW KEYS — when already zoomed into a wall border (Panels phase: a panel is
      // focused but not drilled into a cell), Left / Right jump to the PREVIOUS / NEXT
      // border along the unravel strip, wrapping around the closed loop. This is a
      // keyboard shortcut for the same gesture as clicking the neighbouring panel, so it
      // routes through zoomToPanel — identical animated zoom, focus, and cell-clear.
      if (
        !typing &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        unravelOn &&
        focusedPanel !== null &&
        focusedCell === null
      ) {
        const segs = unravelResult?.segments;
        if (segs && segs.length > 1) {
          const pos = segs.findIndex((s) => s.index === focusedPanel);
          if (pos >= 0) {
            e.preventDefault();
            const dir = e.key === "ArrowRight" ? 1 : -1;
            const next = segs[(pos + dir + segs.length) % segs.length];
            zoomToPanel(next.index);
            // Drop any stale strip-hover so the minimap's wall highlight falls back to
            // the newly FOCUSED border (lit red, as if moused over) until the pointer
            // moves and resumes driving the hover itself.
            setHoveredUnravelEdge(-1);
            return;
          }
        }
      }

      // REVIT-STYLE DIMENSION ENTRY (perimeter draw). Active once at least one vertex
      // is down: typing digits / "." builds the next segment's exact length, Enter
      // commits the vertex at that length in the cursor's direction, Backspace edits,
      // Esc cancels the entry. This intercepts those keys BEFORE the generic
      // Enter/Esc/Backspace handlers below, but only while an entry makes sense, so
      // normal drawing keys are untouched otherwise.
      if (!typing && drawing && perimeter.vertices.length > 0) {
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          setDimInput((d) => (d ?? "") + e.key);
          return;
        }
        if (e.key === ".") {
          e.preventDefault();
          // Start as "0." so it reads as a number; never allow two decimal points.
          setDimInput((d) => (d === null ? "0." : d.includes(".") ? d : d + "."));
          return;
        }
        // The remaining keys only matter once an entry is actually in progress, so
        // when no dimension is being typed they fall through to their usual handlers.
        if (dimInput !== null) {
          if (e.key === "Backspace") {
            e.preventDefault();
            setDimInput((d) => {
              if (d === null) return null;
              const next = d.slice(0, -1);
              return next.length ? next : null;
            });
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            commitDimVertex();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setDimInput(null);
            return;
          }
        }
      }

      // Curve-type shortcuts: A = arc, L = line (for segments drawn next).
      // V — arm Select, the near-universal shortcut for the pointer tool. Arms rather
      // than toggles: pressing it twice should leave you with the tool, not without it.
      // Going through onSelect (not armSelectDefault) is what makes V a real ESCAPE from
      // whatever is in hand: it puts every other tool down, including unloading the
      // Glazing brush, so the bar can never be left showing two armed tools.
      if (!typing && (e.key === "v" || e.key === "V")) {
        if (!selectMode) onSelect();
        return;
      }
      if (!typing && (e.key === "a" || e.key === "A")) {
        setCurveType("arc");
        return;
      }
      if (!typing && (e.key === "l" || e.key === "L")) {
        setCurveType("line");
        return;
      }

      if (e.key === "Enter" && !typing) {
        if (drawing && perimeter.vertices.length >= 3) {
          recordHistory();
          setPerimeter((p) => closePerimeter(p));
          setMode("edit");
        }
      } else if (e.key === "Escape") {
        // The export popup owns Esc while open (its own capture listener closes it);
        // don't let the canvas Esc actions (zoom-out, etc.) also fire underneath it.
        if (exportPopup) return;
        // Esc cancels an armed Export-select tool (and any in-progress marquee).
        if (exportSelectMode) {
          setExportSelectMode(false);
          setMarquee(null);
          setExportSelection(new Set());
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc closes the Statistics menu, the View menu, the Floor Lines menu, the
        // CW Type menu, disarms the Mullions tool, and so on.
        if (cwMenuOpen) {
          setCwMenuOpen(false);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc disarms the Pan tool first (it owns the left drag, so releasing it is the
        // most likely intent), leaving the rest of the state — selection, zoom — alone.
        if (panMode) {
          setPanMode(false);
          dragRef.current = null;
          armSelectDefault(); // put the tool down, pick Select back up
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc with something SELECTED drops the selection — but Select itself stays in
        // hand, because it is the resting tool (see armSelectDefault). Escape empties
        // your hands; it never leaves the app with no tool at all.
        // With nothing held, this branch does not consume the key: Escape falls through
        // to the rest of the ladder, where it still exits a zoom or cancels a polyline.
        if (selectMode && (selectedImageId !== null || perimeterSelected)) {
          setSelectedImageId(null);
          setHoveredImageHandle(null);
          setPerimeterSelected(false);
          setHoveredPerimeterHandle(null);
          dragRef.current = null;
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (mullionsOn) {
          setMullionsOn(false);
          armSelectDefault(); // put the tool down, pick Select back up
          setMullionHover(null);
          setMullionDraft(null);
          setCellEdgeHover(null);
          setCellFrameDraft(null);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc puts the Glazing tool down — whether the chooser is open or a brush is loaded
        // — and drops the highlight, so it never lingers as a target for the next click.
        if (typeOn || glazingBrush !== null) {
          setTypeOn(false);
          setGlazingBrush(null);
          setSelectedCells([]);
          armSelectDefault(); // put the tool down, pick Select back up
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc first disarms the Subtractive division tool (and drops its preview),
        // keeping the panel selected so a second Esc exits the zoom.
        if (subtractiveOn) {
          setSubtractiveOn(false);
          armSelectDefault(); // put the tool down, pick Select back up
          setDivideHover(null);
          setDivideDraft(null);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Esc also disarms the Eraser (drops its deletion highlight and any
        // in-progress drag collection) before exiting the zoom.
        if (eraserOn) {
          setEraserOn(false);
          armSelectDefault(); // put the tool down, pick Select back up
          setEraseHover(null);
          setEraseDragCollected([]);
          setHoveredVertex(-1); // drop the perimeter vertex delete-highlight too
          setEraseVertexCollected([]); // and any in-progress vertex sweep
          setEraseEdgeCollected([]); // and any in-progress edge sweep
          setEraseEdge(-1);
          dragRef.current = null;
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Then disarms the floor-plate tool if it's active.
        if (floorPlateMode) {
          setFloorPlateMode(false);
          armSelectDefault(); // put the tool down, pick Select back up
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // In the unravel view, Esc backs out ONE navigation layer at a time. Deepest
        // first: from the Assembly cell zoom, return to the focused panel (keep the
        // panel selected). Otherwise fall through to the panel-exit logic below.
        if (unravelOn && focusedCell !== null && focusedPanel !== null) {
          setFocusedCell(null);
          zoomToPanel(focusedPanel);
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // Next, Esc exits a panel double-click zoom (restoring the full-strip fit).
        if (unravelOn && focusedPanel !== null) {
          if (focusedPanel !== null) {
            setFocusedPanel(null);
            fitUnravel(unravelGap, unravelHeights, unravelHeight);
          }
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        // FINALLY, from the full elevation strip, Esc folds back to the footprint —
        // completing the back-out chain (cell -> panel -> strip -> plan). Without this
        // last step the strip was a dead end for the keyboard, which only mattered once
        // the top navigation tabs were removed and the toggle became the sole route.
        if (unravelOn) {
          toggleUnrollViewRef.current();
          (document.activeElement as HTMLElement)?.blur?.();
          return;
        }
        if (drawing) {
          // Cancel the in-progress polyline.
          if (perimeter.vertices.length > 0) recordHistory();
          setPerimeter(emptyPerimeter());
        }
        setSelectedVertex(-1);
        (document.activeElement as HTMLElement)?.blur?.();
      } else if ((e.key === "Backspace" || e.key === "Delete") && !typing) {
        if (drawing) {
          if (perimeter.vertices.length === 0) return;
          e.preventDefault();
          recordHistory();
          setPerimeter((p) => popVertex(p));
        } else if (selectedImageId !== null) {
          // A selected reference image takes the delete before the perimeter does —
          // it is the thing with a visible selection, so it is what the user means.
          e.preventDefault();
          deleteSelectedImage();
        } else if (mode === "edit" && selectedVertex >= 0) {
          e.preventDefault();
          recordHistory();
          setPerimeter((p) => deleteVertex(p, selectedVertex));
          setSelectedVertex(-1);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
      // Releasing Space ends the temporary pan. Also ended by a window blur (below),
      // so alt-tabbing mid-hold can't strand the canvas in pan mode.
      if (e.code === "Space") setSpaceHeld(false);
    };
    const onBlur = () => {
      setShiftHeld(false);
      setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    drawing,
    mode,
    perimeter.vertices.length,
    selectedVertex,
    saveCurrent,
    unravelOn,
    cwMenuOpen,
    mullionsOn,
    typeOn,
    glazingBrush,
    focusedPanel,
    focusedCell,
    unravelResult,
    zoomToPanel,
    fitUnravel,
    unravelGap,
    unravelHeights,
    unravelHeight,
    undo,
    redo,
    recordHistory,
    floorPlateMode,
    // Esc disarms Pan first; without this the handler would test a stale panMode.
    panMode,
    // (Esc from the full strip folds back to the plan via toggleUnrollViewRef, which
    // needs no dependency — a ref is always current.)
    // Esc deselects then disarms Select, and Delete removes the selected underlay —
    // both read these, so a stale closure would make the keys no-ops.
    selectMode,
    // Escape steps through: picked object → tool. Both reads must be current.
    perimeterSelected,
    // V arms Select through this handler; without it the key would call a stale onSelect.
    onSelect,
    selectedImageId,
    disarmSelect,
    deleteSelectedImage,
    helpOpen,
    subtractiveOn,
    eraserOn,
    dimInput,
    commitDimVertex,
    exportSelectMode,
    exportPopup,
  ]);

  // (The blanket CW-TYPE GATE that used to live here — disarming Floor Lines,
  // Centerlines, Framing, the Eraser and Type the moment `cwType` went null — has been
  // removed. It disarmed tools that never depended on a curtain-wall system, and every
  // tool now has its OWN auto-disarm effect keyed to its OWN gate; see "AUTO-DISARM ON
  // GATE LOSS" further down. Keeping this would have re-locked the very tools this
  // change ungated.)

  // A typed dimension only makes sense mid-draw; drop any leftover entry as soon as
  // drawing stops (polyline closed/cancelled, switched to edit, entered unravel).
  useEffect(() => {
    if (!drawing && dimInput !== null) setDimInput(null);
  }, [drawing, dimInput]);

  // GROUND-PLATE INVARIANT: whenever the unravel/elevation view is active, a
  // floor plate at the ground datum (model y = 0, level 0, the panels' bottom
  // baseline) MUST exist. toggleUnravel adds it on ENTRY, but several other paths
  // replace floorPlates without it — loading a saved entry (esp. older saves),
  // undo/redo restoring a pre-ground snapshot, or click-removing a near-0 plate.
  // This single guard re-asserts the datum across ALL of them: if we're in the
  // view and no ~0 plate is present, append one (kept sorted bottom→top).
  //   - NOT an undo step: like the toggleUnravel insert, this is view scaffolding,
  //     not an authored edit — no recordHistory().
  //   - No infinite loop: it only adds when missing, and returns the SAME array
  //     reference when a ~0 plate already exists, so React bails (no re-render).
  //   - Interplay with auto-save: when this fires after a load, the auto-save
  //     effect persists the added 0 into the active entry; its JSON no-op guard
  //     then sees them equal and stops, so there's no write loop.
  useEffect(() => {
    if (!unravelOn) return;
    setFloorPlates((plates) => {
      if (plates.some((p) => Math.abs(p) <= 1e-6)) return plates; // datum present
      return [...plates, 0].sort((a, b) => a - b);
    });
  }, [unravelOn, floorPlates]);

  // The Mullions tool acts on the focused panel's grid lines, so drop its hover
  // highlight + any in-flight drag draft when the selection is lost or we leave the
  // unravel view (the tool can stay armed, ready for the next focused panel).
  useEffect(() => {
    if (!unravelOn || focusedPanel === null) {
      setMullionHover(null);
      setMullionDraft(null);
    }
    // The Unitized cell-framing hover is Panels-tab only, so also drop it when we drill
    // into the Assembly cell zoom (focusedCell set) or leave the focused panel/view.
    if (!unravelOn || focusedPanel === null || focusedCell !== null) {
      setCellEdgeHover(null);
      setCellFrameDraft(null);
    }
  }, [unravelOn, focusedPanel, focusedCell]);

  // Close the help popup on Escape (a predictable, obvious dismissal alongside the
  // × close button and the "?" toggle). Bound only while it is open. NOTE: the chosen
  // reference panel intentionally has no outside-click dismissal so it stays open
  // through canvas navigation — Escape / × / "?" are the only ways to close it.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setHelpMenuOpen(false);
        setHelpPanel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen]);

  // The Statistics dropdown is intentionally "sticky": it does NOT close on Escape
  // or on any canvas click / pointer interaction, so the user can leave the live
  // stats visible while working. The ONLY way to close it is to click the
  // Statistics button again (the toggle in the JSX below).

  // ---------------------------------------------------------------------------
  // CANVAS SIZING (DPR-aware) + RENDER LOOP (render on state change).
  // ---------------------------------------------------------------------------

  useLayoutEffect(() => {
    const resize = () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Re-centre origin the first time we get a real size.
      setViewport((vp) => (vp.originX === 400 && vp.originY === 300 ? defaultViewport(w, h) : vp));
      paint();
    };
    resize();
    window.addEventListener("resize", resize);
    // Observe the canvas wrapper directly so ANY layout change that resizes it —
    // not just a window resize — re-fits the canvas. This is what makes collapsing
    // the left tool panel (which widens the stage) immediately grow the canvas to
    // fill the reclaimed space instead of leaving a stale gap.
    const ro = new ResizeObserver(() => resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", resize);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;

    // UNROLL TRANSITION: while it runs it OWNS the canvas — the scene is mid-way
    // between the footprint and the elevation strip, so neither 2D state describes
    // it. Drawn here (rather than as an overlay) so any repaint triggered by other
    // state during the run still shows the correct frame.
    const unroll = unrollFrameRef.current;
    if (unroll) {
      renderUnrollFrame(ctx, canvas, w, h, dpr, unroll);
      return;
    }

    // Subtractive equal-split preview + LIVE SPACING DIMENSION. The recommendation is
    // an even split of the selected panel into N equal bays. Lines come from the active
    // drag (priority) or the hover, both via the SAME pure generators as the commit.
    // The cursor's quadrant picks the axis: HORIZONTAL (equal-height ROWS, `buildEqualRows`,
    // with a VERTICAL measure dimension); otherwise VERTICAL (equal-width COLUMNS,
    // `buildEqualColumns`, with a HORIZONTAL measure dimension). The `dim` measures ONE
    // bay under the cursor, so the user sees the resulting column width / row height.
    let dividePreview: RenderState["dividePreview"] = null;
    if (subtractiveOn && focusedPanel !== null) {
      const draw = unravelDraws?.find((d) => d.seg.index === focusedPanel);
      if (draw) {
        const lo = Math.min(draw.seg.x0, draw.seg.x1);
        const hi = Math.max(draw.seg.x0, draw.seg.x1);
        const panelH = Math.max(draw.height, 0);
        const draftActive = divideDraft && divideDraft.edge === focusedPanel;
        // HORIZONTAL (equal rows) when an in-flight drag is on the H axis, otherwise from
        // the hovered position: the panel's diagonals decide, so the preview flips between
        // rows and columns as the cursor crosses them — no Shift. See divideAxisAt.
        const horizontal = draftActive
          ? divideDraft!.axis === "h"
          : divideHover
            ? divideAxisAt(divideHover, lo, hi, panelH) === "h"
            : false;
        if (horizontal) {
          // Hover gate: only recommend when the cursor is strictly INSIDE the panel
          // height (not on the baseline / top border), mirroring the column gate.
          const ys =
            draftActive
              ? divideDraft!.lines
              : divideHover && divideHover.y > 1e-6 && divideHover.y < panelH - 1e-6
                ? buildEqualRows(divideHover.y, 0, panelH, floorPlates)
                : null;
          if (ys && ys.length > 0) {
            // Rows may be UNEQUAL across the panel when floor-plate guides split it into
            // bands, so measure the row the cursor sits in directly from the resulting
            // lines (baseline 0 + ys + panel top) rather than assuming panelH / N.
            const bounds = [0, ...ys, panelH];
            const cy = cursorModel ? Math.max(0, Math.min(panelH, cursorModel.y)) : panelH / 2;
            let bi = 0;
            while (bi < bounds.length - 2 && cy > bounds[bi + 1]) bi++;
            const cx = cursorModel ? Math.max(lo, Math.min(hi, cursorModel.x)) : (lo + hi) / 2;
            const dim = { x1: cx, y1: bounds[bi], x2: cx, y2: bounds[bi + 1], dist: bounds[bi + 1] - bounds[bi] };
            dividePreview = { edge: focusedPanel, ys, dim };
          }
        } else {
          const xs =
            draftActive
              ? divideDraft!.lines
              : divideHover && divideHover.x > lo + 1e-6 && divideHover.x < hi - 1e-6
                ? buildEqualColumns(divideHover.x, draw.seg.x0, draw.seg.x1)
                : null;
          if (xs && xs.length > 0) {
            // N equal columns => width = panelWidth / N (N = lines + 1).
            const step = (hi - lo) / (xs.length + 1);
            // Dimension the COLUMN the cursor sits in (horizontal measure line under the cursor).
            const cx = cursorModel ? cursorModel.x : (lo + hi) / 2;
            const idx = Math.max(0, Math.min(xs.length, Math.floor((cx - lo) / step)));
            const cy = cursorModel ? Math.max(0, Math.min(panelH, cursorModel.y)) : panelH / 2;
            const dim = { x1: lo + idx * step, y1: cy, x2: lo + (idx + 1) * step, y2: cy, dist: step };
            dividePreview = { edge: focusedPanel, xs, dim };
          }
        }
      }
    }

    // Eraser deletion highlights: resolve all targeted lines (hover + any collected
    // during a drag stroke) into render coordinates. The renderer draws each line in
    // the distinct deletion colour so the user sees exactly what a release will remove.
    const eraseHighlight: Array<{ edge: number; axis: "v" | "h"; offset: number }> = [];
    const eraseFloorPlates: number[] = [];
    if (eraserOn) {
      // Union of collected-during-drag and the current cursor hover target.
      const seen = new Set<string>();
      const allTargets: EraseTarget[] = [...eraseDragCollected];
      if (eraseHover) {
        const key = `${eraseHover.axis}:${eraseHover.edge}:${eraseHover.index}`;
        if (!allTargets.some((t) => `${t.axis}:${t.edge}:${t.index}` === key)) {
          allTargets.push(eraseHover);
        }
      }
      for (const target of allTargets) {
        const key = `${target.axis}:${target.edge}:${target.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (target.axis === "fp") {
          const y = floorPlates[target.index];
          // Never flag the permanent ground datum (y ≈ 0) for deletion.
          if (y !== undefined && Math.abs(y) > 1e-6) eraseFloorPlates.push(y);
        } else {
          const arr = target.axis === "v" ? panelDivisions[target.edge] : panelDividersH[target.edge];
          const offset = arr?.[target.index];
          if (offset !== undefined) eraseHighlight.push({ edge: target.edge, axis: target.axis, offset });
        }
      }
    }

    // Erase tool (perimeter view): the edges flagged for removal (hover + drag-collected,
    // deduped) and the vertices flagged for deletion — those explicitly swept up PLUS any
    // that the targeted edges would orphan (both incident walls gone), previewed in red so
    // the auto-drop is visible before release. Both empty outside the armed perimeter view.
    let eraseEdges: number[] = [];
    let erasePreviewVertices = eraseVertexCollected;
    if (eraserOn && !unravelOn) {
      const edgeSet = new Set(eraseEdgeCollected);
      if (eraseEdge >= 0) edgeSet.add(eraseEdge);
      eraseEdges = [...edgeSet];
      const n = perimeter.vertices.length;
      if (perimeter.closed && n > 0 && edgeSet.size > 0) {
        // Vertex i sits between edge (i-1+n)%n and edge i; both gone → it is orphaned.
        const vset = new Set(eraseVertexCollected);
        for (let i = 0; i < n; i++) {
          if (edgeSet.has((i - 1 + n) % n) && edgeSet.has(i)) vset.add(i);
        }
        erasePreviewVertices = [...vset];
      }
    }

    // Cell tint highlight. In the PANELS phase it follows the HOVERED cell (resolve
    // the hovered index back to its model rect). Once a cell is clicked into (ASSEMBLY,
    // focusedCell set) the SELECTED cell stays tinted — so the zoomed-in cell still
    // reads as the selected one — rather than the highlight disappearing.
    let hoveredCellRect: RenderState["hoveredCell"] = null;
    if (unravelOn && focusedPanel !== null) {
      if (focusedCell !== null) {
        hoveredCellRect = { x0: focusedCell.x0, x1: focusedCell.x1, y0: focusedCell.y0, y1: focusedCell.y1 };
      } else if (hoveredCell >= 0) {
        hoveredCellRect = cellsForEdge(focusedPanel)[hoveredCell] ?? null;
      }
    }

    const state: RenderState = {
      perimeter,
      viewport,
      cursorModel,
      drawing,
      // Suppress the rubber-band while pulling a handle (the handle line is the
      // relevant feedback then, not a segment to the cursor).
      rubberBand: drawing && activeDrawHandle < 0,
      // REVIT-STYLE DIMENSION ENTRY: while a length is being typed, the rubber band
      // ends at the typed distance along the cursor direction (dimPreview) and shows
      // the raw typed string (dimText) verbatim, so a partial like "12." is visible.
      dimPreview,
      dimText: dimInput,
      selectedVertex,
      hoveredVertex,
      // Erase tool armed in the perimeter view → draw the hovered vertex in the
      // delete colour so it reads as "click to remove".
      eraseVertexArmed: eraserOn && !unravelOn,
      // Vertices flagged for deletion during an Erase stroke — swept up plus any the
      // collected edges would orphan — previewed in the delete colour (see above).
      eraseVertices: erasePreviewVertices,
      // Erase tool: the perimeter edges flagged for removal (hover + drag-collected),
      // each drawn in the delete colour so the user sees which segments a release removes.
      eraseEdges,
      // Show handles for the vertex being curve-edited: the selected one in edit
      // mode, or the one whose handle is being pulled while drawing.
      handleVertex: mode === "edit" ? selectedVertex : activeDrawHandle,
      insertPreview,
      gridSpacing,
      unravel: unravelDraws2d,
      hoveredUnravelEdge,
      hoveredUnravelTop,
      // Export selection highlight + live marquee — only meaningful in the unravel
      // view, so gate on it (the renderer also only reads them there).
      exportSelection: unravelOn ? exportSelection : null,
      marquee: unravelOn ? marquee : null,
      // Per-cell hover highlight (Panels phase): the model-space rectangle of the
      // grid cell under the cursor, or null. Drawn tinted so the panel reads as a
      // set of individually navigable cells.
      hoveredCell: hoveredCellRect,
      // Cells SELECTED for type assignment (Wall Border phase) — drawn with a stronger
      // fill + outline than the hover tint. Only meaningful in the unravel view.
      selectedCells: unravelOn ? selectedCells : null,
      // The double-click-focused panel doubles as the SELECTED panel (the active
      // Additive / Subtractive target). The renderer draws its width label in the
      // floor-plate grey to signal the selection.
      selectedUnravelPanel: focusedPanel ?? -1,
      // STATISTICS ANCHOR: the border the per-panel readings describe, framed in red so the
      // numbers in the Statistics window are attributable to a wall on screen. -1 whenever
      // no panel-scoped reading is on, so the frame appears only when it means something.
      statsAnchorPanel,
      // PANELS phase ONLY (one panel focused, not in the deeper Assembly cell zoom):
      // tell the renderer to dimension this panel's grid per column (top) / per row
      // (left). -1 in every other phase so the per-band labels never appear in the
      // full Elevations strip, the Assembly cell zoom, or the perimeter view.
      cellDimEdge: unravelOn && focusedPanel !== null && focusedCell === null ? focusedPanel : -1,
      // With NO cells selected, an empty-canvas click collapses the focused panel's grid to
      // just its overall length + height (camera unchanged). Ignored while cells are selected
      // (the per-cell readout wins) or in any other phase.
      cellDimOverall: panelDimsOverall,
      // ASSEMBLY phase ONLY (a single cell zoomed-into): the focused cell's model
      // rect, so the renderer annotates all four of its edges with a dimension
      // label (top/bottom = width, left/right = height). null in every other phase.
      focusedCellDims:
        unravelOn && focusedCell !== null
          ? { x0: focusedCell.x0, x1: focusedCell.x1, y0: focusedCell.y0, y1: focusedCell.y1 }
          : null,
      // ASSEMBLY phase: which of the focused cell's edges the cursor is hovering, so
      // the renderer strokes that one edge red. null when not near any edge.
      focusedCellEdge: unravelOn && focusedCell !== null ? hoveredCellEdge : null,
      // REFERENCE IMAGES (imported underlays) — perimeter view only, where tracing
      // happens; the elevation views are generated from the footprint, so a plan
      // underlay has no meaning there. Paired with their decoded bitmaps (see
      // imageBitmapsRef); `bitmapTick` is in this memo's deps so a decode that lands
      // after the placement triggers the repaint that actually shows it.
      referenceImages: unravelOn
        ? []
        : referenceImages.map((image) => ({ image, bitmap: imageBitmapsRef.current.get(image.id) ?? null })),
      // The transform frame + grips belong to the SELECT tool, so they are drawn only
      // while it is armed. The images themselves always draw — they are an underlay, not
      // a selection.
      selectedImageId: !unravelOn && selectMode ? selectedImageId : null,
      hoveredImageHandle: !unravelOn && selectMode ? hoveredImageHandle : null,
      // WHOLE-SHAPE selection frame — only while Select holds it, in the Plan phase.
      selectedPerimeterBox: !unravelOn && selectMode ? selectedPerimeterBounds : null,
      hoveredPerimeterHandle: !unravelOn && selectMode ? hoveredPerimeterHandle : null,
      floorPlates,
      // Floor Lines "Hide" — suppress drawing every floor line (and its label / eraser
      // highlight) without deleting them. A view preference from Display ▸ Visibility.
      floorPlatesHidden: !floorLinesVisible,
      // Centerlines / Framing "Hide" — same view preference, toggled from the Display ▸
      // Visibility rows; suppresses drawing those elements without deleting them.
      centerlinesHidden: !centerlinesVisible,
      framingHidden: !framingVisible,
      // Dimensions "Hide" — Display ▸ Visibility ▸ Dimensions is the single source of
      // truth for the on-canvas dimension labels; no view mode auto-hides them.
      dimensionsHidden: !dimensionsVisible,
      // Ghosted preview line follows the cursor's elevation while the tool is
      // armed, run through the SAME snap helper as placement so the ghost line
      // (and its elevation label) sits exactly where a click would drop the plate
      // — including the increment magnet and the Shift bypass.
      floorPlatePreview: floorPlateMode && cursorModel ? snapFloorPlateY(cursorModel.y) : null,
      // Subtractive division preview + live spacing dimension (computed above).
      dividePreview,
      // Eraser deletion highlights — panel division lines and floor plates (computed above).
      eraseHighlight,
      eraseFloorPlates,
      // CLEAN view: white panel fill; only the DIMENSION labels are hidden. Floor lines,
      // centerlines, and framing are NEVER auto-hidden by any view — they follow only their
      // Display ▸ Visibility rows (floorPlatesHidden / centerlinesHidden / framingHidden above).
      cellClean: cellViewMode === "clean",
      // SHADOWS view: clean white glass PLUS raised-frame hard drop shadows (2.5D).
      cellShadows: cellViewMode === "shadows",
    };
    render(ctx, canvas, w, h, dpr, state);
  }, [
    perimeter,
    viewport,
    cursorModel,
    dimPreview,
    dimInput,
    drawing,
    mode,
    activeDrawHandle,
    selectedVertex,
    hoveredVertex,
    insertPreview,
    gridSpacing,
    unravelDraws2d,
    hoveredUnravelEdge,
    hoveredUnravelTop,
    unravelOn,
    exportSelection,
    marquee,
    focusedPanel,
    // Repaint when the statistics anchor moves (or appears / disappears with the readings).
    statsAnchorPanel,
    // Per-cell hover highlight (Panels phase): repaint as the hovered cell changes.
    focusedCell,
    hoveredCell,
    // Cell selection (Wall Border phase): repaint as the selected set changes.
    selectedCells,
    // Overall-vs-grid dimension mode (Panels phase): repaint when it toggles.
    panelDimsOverall,
    // Assembly phase: repaint as the hovered cell EDGE changes (red highlight).
    hoveredCellEdge,
    cellsForEdge,
    // Reference-image underlays: repaint on placement/transform, on selection, on grip
    // hover, and on `bitmapTick` — the signal that a decode finished and there is
    // finally something to blit.
    referenceImages,
    selectedImageId,
    hoveredImageHandle,
    selectMode,
    bitmapTick,
    floorPlates,
    floorPlateMode,
    floorLinesVisible,
    centerlinesVisible,
    framingVisible,
    dimensionsVisible,
    // Preview elevation is now run through snapFloorPlateY (reads floorPlates /
    // shiftHeld / viewport), so repaint when the snap result can change.
    snapFloorPlateY,
    // Subtractive division preview repaints as it changes; the AXIS now comes from the
    // hovered position (divideAxisAt), so divideHover alone drives it.
    subtractiveOn,
    divideHover,
    divideDraft,
    shiftHeld,
    // Eraser deletion highlight repaints as the targeted line changes. The panel
    // arrays are read to resolve offsets; floorPlates for floor-plate highlights;
    // eraseDragCollected for the in-progress drag stroke.
    eraserOn,
    eraseHover,
    eraseDragCollected,
    eraseVertexCollected,
    eraseEdge,
    eraseEdgeCollected,
    panelDivisions,
    panelDividersH,
    floorPlates,
    // Clean/Shadows views repaint the panels white (floor lines, centerlines, framing,
    // and dimensions follow their per-button toggles, not the view mode).
    cellViewMode,
  ]);

  useEffect(() => {
    paint();
  }, [paint]);

  // Always-current paint, so the unroll transition's frame loop can repaint without
  // re-subscribing every time `paint` is rebuilt (mirrors viewportRef above).
  const paintRef = useRef(paint);
  paintRef.current = paint;

  // ---------------------------------------------------------------------------
  // DERIVED READOUTS
  // ---------------------------------------------------------------------------

  /** Whether the current shape has enough edges to unravel. */
  const canUnravel = perimeter.vertices.length >= 2;

  /**
   * Is the Pen currently EDITING rather than drawing? True once the footprint is a closed,
   * valid surface — at which point there is nothing left to draw and every click means
   * "adjust what's there". Drives the Pen button's tooltip and the Plan-phase cursor.
   * A closed perimeter always has >= 3 vertices (closePerimeter enforces it), so `closed`
   * alone is the whole test for "valid surface".
   */
  const penEditing = perimeter.closed;

  /**
   * Keep the Pen's actual mode in step with the shape. Every path that CLOSES the
   * perimeter already switches to edit (clicking the first vertex, double-click, Enter);
   * this handles the reverse — erasing an edge, or dropping below three vertices, reopens
   * the loop, and the Pen has to go back to DRAWING or its tooltip would advertise one
   * behaviour while the canvas did the other.
   *
   * Fires on the closed -> open EDGE only, so it never fights a deliberate mode change.
   */
  const prevPenClosedRef = useRef(perimeter.closed);
  useEffect(() => {
    const wasClosed = prevPenClosedRef.current;
    prevPenClosedRef.current = perimeter.closed;
    if (wasClosed && !perimeter.closed) setMode("draw");
  }, [perimeter.closed]);

  /**
   * Toggle the unravel view; on entry, clear transient edit state and fit the strip.
   * `skipFitOnEnter` suppresses the automatic strip-fit when entering, so a caller
   * can immediately animate to a DIFFERENT target (e.g. the Panels nav button zooming
   * straight to the first panel) without the strip-fit running afterwards and
   * cancelling it — the fit here is dispatched from inside the state updater, so it
   * would otherwise win the race against a fit queued synchronously before this call.
   */
  const toggleUnravel = useCallback((skipFitOnEnter = false) => {
    setUnravelOn((on) => {
      const next = !on;
      if (next) {
        setSelectedVertex(-1);
        setHoveredVertex(-1);
        setInsertPreview(null);
        setHoveredEdge(-1);
        // Entering the elevation view guarantees a ground-level floor plate (model
        // y = 0, the ground floor / level 0) so the user starts with the ground
        // line drawn. Add one only if no ~0 plate already exists (epsilon guards
        // against float dupes). Like the other view-state resets here, this is not
        // a separate history step. Kept sorted bottom→top to match the click handler.
        setFloorPlates((plates) => {
          if (plates.some((p) => Math.abs(p) <= 1e-6)) return plates;
          return [...plates, 0].sort((a, b) => a - b);
        });
      } else {
        // Leaving the view: drop any active hover-link highlight + resize affordance
        // and the double-click zoom focus.
        setHoveredUnravelEdge(-1);
        setHoveredUnravelTop(-1);
        setFocusedPanel(null);
        setFocusedCell(null); // leave the Assembly cell context too (phase consistency)
      }
      if (next && !skipFitOnEnter) fitUnravel(unravelGap, unravelHeights, unravelHeight);
      return next;
    });
  }, [fitUnravel, unravelGap, unravelHeights, unravelHeight]);

  // ---------------------------------------------------------------------------
  // UNROLL TRANSITION
  //
  // Entering the elevation views from the Plan phase plays the footprint
  // standing up as a 3D massing and unrolling flat (core/unrollAnim.ts) rather than
  // cutting straight to the strip — so the user SEES which wall came from where and
  // in what order, which a jump throws away.
  //
  // The transition is pure presentation: it commits no geometry and changes no
  // document state. Its last frame is drawn at exactly `to`, and finishing just sets
  // that viewport and enters the view — so skipping it early (any click, key, or
  // wheel) lands on the identical result, only sooner.
  // ---------------------------------------------------------------------------

  /**
   * End the transition NOW and enter the elevation views. Used both by the natural
   * end of the run and by every skip path. `toggleUnravel(true)` suppresses the
   * strip-fit because we already frame the strip exactly.
   */
  const finishUnroll = useCallback(() => {
    const frame = unrollFrameRef.current;
    if (!frame) return;
    if (unrollRafRef.current !== null) {
      cancelAnimationFrame(unrollRafRef.current);
      unrollRafRef.current = null;
    }
    unrollFrameRef.current = null;
    setViewport(frame.to);
    toggleUnravel(true);
  }, [toggleUnravel]);

  /**
   * End a FOLD-BACK now and settle on the footprint. The mirror of
   * {@link finishUnroll}: the fold already left the elevation view when it started, so
   * all that remains is to drop the frame and land on the plan framing (`from`, which
   * is the t = 0 end of the same tween).
   */
  const finishFold = useCallback(() => {
    const frame = unrollFrameRef.current;
    if (!frame) return;
    if (unrollRafRef.current !== null) {
      cancelAnimationFrame(unrollRafRef.current);
      unrollRafRef.current = null;
    }
    unrollFrameRef.current = null;
    setViewport(frame.from);
  }, []);

  // Publish for the input handlers defined ABOVE this point (see unrollFrameRef). The
  // skip must land on the END the run was actually heading for, so it dispatches on
  // direction — skipping a fold with finishUnroll would re-enter the view being left.
  skipUnrollRef.current = () => {
    if (unrollDirRef.current === "fold") finishFold();
    else finishUnroll();
  };

  /**
   * Play the transition, then enter the elevation views. Falls back to entering them
   * directly whenever there is nothing to animate — degenerate geometry, or a
   * `--unroll-duration-ms` of 0 (the CSS opt-out) — so the destination is never
   * gated on the animation.
   */
  const startUnroll = useCallback(() => {
    const { w, h } = sizeRef.current;
    const chain = buildUnrollChain(perimeter, unravelGap);
    const segments = unravelPerimeter(perimeter, unravelGap).segments;
    const duration = unrollDurationMs(canvasRef.current);
    // Bail out to a direct entry rather than animating something that wouldn't land
    // where it claims: degenerate geometry, a `--unroll-duration-ms` of 0 (the CSS
    // opt-out), or a chain that disagrees with the layout it hands off to (only
    // reachable from a malformed perimeter, e.g. one flagged closed with 2 vertices).
    if (!chain || segments.length === 0 || chain.panels !== segments.length || duration <= 0) {
      toggleUnravel();
      return;
    }
    // Same per-panel heights and same fit the elevation view itself uses, so the
    // final frame and the first 2D frame are the same picture.
    const heightOf = (edge: number) => unravelHeights[edge] ?? unravelHeight;
    const to = fitViewport(
      unravelBoundsPerimeter(segments, (s) => heightOf(s.index)),
      w,
      h,
      48,
      undefined,
      1,
      canvasInsets(),
    );

    cancelAnim(); // a viewport tween would fight the transition's own framing
    unrollDirRef.current = "unroll";
    unrollFrameRef.current = { chain, t: 0, heightOf, from: viewportRef.current, to };

    const started = performance.now();
    const step = (now: number) => {
      const frame = unrollFrameRef.current;
      if (!frame) return; // skipped mid-flight
      frame.t = Math.min(1, (now - started) / duration);
      if (frame.t >= 1) {
        unrollRafRef.current = null;
        finishUnroll();
        return;
      }
      paintRef.current();
      unrollRafRef.current = requestAnimationFrame(step);
    };
    unrollRafRef.current = requestAnimationFrame(step);
  }, [perimeter, unravelGap, unravelHeights, unravelHeight, cancelAnim, toggleUnravel, finishUnroll]);

  /**
   * Play the transition IN REVERSE and return to the footprint — the exact inverse of
   * {@link startUnroll}, using the same chain and the same tween with `t` driven 1 -> 0.
   * So the walls fold back up in the order they unrolled, which is what makes the round
   * trip legible rather than two unrelated moves.
   *
   * The elevation view is left at the START of the run, not the end: the frame owns the
   * canvas for the whole tween (paint returns early while it is set), so exiting first
   * costs nothing visually and means the animation's final frame IS the plan, with no
   * jump when the frame clears. Falls back to a direct exit whenever there is nothing
   * to animate, so the destination is never gated on the animation.
   */
  const startFold = useCallback(() => {
    const { w, h } = sizeRef.current;
    const planView =
      perimeter.vertices.length > 0
        ? fitViewport(perimeter, w, h, 64, undefined, 1, canvasInsets())
        : viewportRef.current;
    const chain = buildUnrollChain(perimeter, unravelGap);
    const segments = unravelPerimeter(perimeter, unravelGap).segments;
    const duration = unrollDurationMs(canvasRef.current);
    // Same bail-out conditions as the forward run — see startUnroll.
    if (!chain || segments.length === 0 || chain.panels !== segments.length || duration <= 0) {
      toggleUnravel();
      setViewport(planView);
      return;
    }

    const heightOf = (edge: number) => unravelHeights[edge] ?? unravelHeight;
    cancelAnim();
    // Leave the elevation view now; the frame hides the swap (see the note above).
    toggleUnravel();
    unrollDirRef.current = "fold";
    unrollFrameRef.current = { chain, t: 1, heightOf, from: planView, to: viewportRef.current };

    const started = performance.now();
    const step = (now: number) => {
      const frame = unrollFrameRef.current;
      if (!frame) return; // skipped mid-flight
      frame.t = Math.max(0, 1 - (now - started) / duration);
      if (frame.t <= 0) {
        unrollRafRef.current = null;
        finishFold();
        return;
      }
      paintRef.current();
      unrollRafRef.current = requestAnimationFrame(step);
    };
    unrollRafRef.current = requestAnimationFrame(step);
  }, [perimeter, unravelGap, unravelHeights, unravelHeight, cancelAnim, toggleUnravel, finishFold]);


  /**
   * The Projects popup's "Unroll Geometry / Fold to Plan" action — the single route
   * between the footprint and the elevations, and the replacement for the removed top
   * navigation tabs.
   *
   * It TOGGLES rather than only entering, because Escape steps back no further than the
   * full elevation strip: without a fold-back the user would have no way home. Entering
   * plays the unroll transition, which is the whole point — seeing which wall became
   * which panel is the information the animation carries. Folding back clears the drill
   * state (focused panel/cell) so returning later starts at the strip, not mid-zoom, and
   * re-frames the footprint the way entering the Plan phase does.
   */
  const toggleUnrollView = useCallback(() => {
    // Folding back plays the SAME transition in reverse (startFold), so the walls fold
    // up in the order they unrolled. toggleUnravel's exit branch already clears the
    // focused panel/cell, so returning later starts at the strip rather than mid-zoom.
    if (unravelOn) startFold();
    else if (canUnravel) startUnroll();
  }, [unravelOn, canUnravel, startUnroll, startFold]);
  // Publish for the keyboard handler defined ABOVE this point (see toggleUnrollViewRef).
  toggleUnrollViewRef.current = toggleUnrollView;
  // ABANDON the transition (stay put, enter nothing) when the shape it was unrolling
  // is replaced out from under it — New project, loading a save, an undo — or when the
  // component unmounts. Keyed on `perimeter` identity, which every one of those paths
  // changes; the transition itself never touches it, so a normal run is unaffected.
  useEffect(
    () => () => {
      if (unrollRafRef.current !== null) cancelAnimationFrame(unrollRafRef.current);
      unrollRafRef.current = null;
      unrollFrameRef.current = null;
    },
    [perimeter],
  );

  /* The "Selected vertex" panel section (Smooth / Corner buttons) was removed — both
     actions are already direct manipulations on the canvas: drag a vertex's handle knob
     to smooth it, double-click the vertex to make it a corner. `setHandle` /
     `clearVertexHandles` are still used by those gestures in the pointer handlers. */


  // Current workflow phase derived from view state:
  //   perimeter  — drawing / editing the building footprint (default)
  //   elevations — the unravelled panel strip (all walls laid flat)
  //   panels     — zoomed into a single panel (double-click from elevations)
  //   assembly   — zoomed into a single grid CELL of the focused panel (deepest)
  const phase = !unravelOn
    ? "perimeter"
    : focusedCell !== null
    ? "assembly"
    : focusedPanel !== null
    ? "panels"
    : "elevations";

  // Floor Lines gate: just the elevation view. Floor plates are a GLOBAL list of
  // elevations — a building datum that no curtain-wall system reads — so the old
  // `hasAnyCwType` requirement gated them behind a prerequisite they never used. It also
  // had the sequence backwards: row centerlines SNAP to floor plates, so setting levels
  // is the thing you want to do first, not third.
  const canPlaceLines = unravelOn;

  // Centerlines gate: a focused wall border, and nothing else. Divisions are plain
  // offsets along the panel — the CW system changes how FRAMING renders on those lines,
  // never where the lines go, so requiring a type first was incidental.
  const canPlaceCenterlines = focusedPanel !== null;

  // Framing gate: BOTH prerequisites are real here. Offsets are measured FROM
  // centerlines, so there must be at least one; and Stick (mullion bands straddling a
  // grid line) versus Unitized (per-cell edge insets) are different interactions, so the
  // system has to be chosen or the tool would arm with no behaviour to run. `cwType` used
  // to be implied — centerlines required it — but now that centerlines are ungated it has
  // to be stated.
  const canFrame =
    focusedPanel !== null &&
    cwType !== null &&
    ((panelDivisions[focusedPanel]?.length ?? 0) > 0 ||
      (panelDividersH[focusedPanel]?.length ?? 0) > 0);

  // Glazing gate: the tool paints a type onto the cells of the FOCUSED wall border, so all
  // it needs is that border — the Wall Border (panels) phase, which by definition means a
  // panel is focused and we have not drilled deeper into a single cell. It deliberately no
  // longer requires a selection: the selection is now made WITH the tool (by clicking or
  // dragging across cells), so requiring one first would be a chicken-and-egg gate.
  const canType = unravelOn && phase === "panels";
  // Has ANY wall border been assigned at least one cell type? This drives the Type button's
  // VISIBILITY toggle (eye) independently of `canType`: the eye shows/hides the per-cell hatches
  // and stays usable whenever there are hatches to toggle — even with no selection (Type button
  // disabled). Empty panel maps are pruned on clear, so a present entry means a real assignment.
  const hasAnyCellType = Object.values(panelCellTypes).some((m) => m && Object.keys(m).length > 0);

  // AUTO-DISARM ON GATE LOSS: a tool that is armed (blue) must un-arm the moment its
  // enablement condition goes false — e.g. losing the focused panel disables the
  // Centerlines tool, which would otherwise stay blue but unclickable. Each effect
  // mirrors clicking the tool off (drops the tool's in-flight previews too).
  useEffect(() => {
    if (!canPlaceLines && floorPlateMode) setFloorPlateMode(false);
  }, [canPlaceLines, floorPlateMode]);
  useEffect(() => {
    if (!canPlaceCenterlines && subtractiveOn) {
      setSubtractiveOn(false);
      setDivideHover(null);
      setDivideDraft(null);
    }
  }, [canPlaceCenterlines, subtractiveOn]);
  useEffect(() => {
    if (!canFrame && mullionsOn) {
      setMullionsOn(false);
      setMullionHover(null);
      setMullionDraft(null);
      setCellEdgeHover(null);
      setCellFrameDraft(null);
    }
  }, [canFrame, mullionsOn]);
  useEffect(() => {
    if (!canType) {
      setTypeOn(false);
      setGlazingBrush(null); // losing the wall border unloads the brush along with the tool
    }
  }, [canType]);
  // CLEAR THE CELL SELECTION when the user switches the focused wall border or leaves the
  // unravel view: the selection is per-border (and may include project-wide Shift picks),
  // so it must not carry over to a different panel or persist after backing out. Selecting
  // cells does NOT change focusedPanel, so this never fires mid-selection.
  useEffect(() => {
    setSelectedCells([]);
  }, [focusedPanel, unravelOn]);
  // Selecting cells exits the overall-dimension readout so it shows the per-cell dims;
  // deselecting (empty selection) then returns to the per-column/row grid, and a further
  // empty-canvas click re-enters overall. So any selection resets the overall flag.
  useEffect(() => {
    if (selectedCells.length > 0) setPanelDimsOverall(false);
  }, [selectedCells]);
  // Export is unravel-view only — un-arm it on returning to the Plan phase so it never
  // lingers while its button is disabled, and drop the export marquee / selection /
  // popup (all only make sense in the unravel view).
  useEffect(() => {
    if (!unravelOn) {
      setExportSelectMode(false);
      setExportSelection(new Set());
      setMarquee(null);
      setExportPopup(null);
    }
  }, [unravelOn]);
  // Leaving the Plan phase (entering an unravel/elevation view) clears the
  // perimeter Draw/Edit/Erase selection so none stays highlighted on another tab.
  // Draw/Edit de-highlight on their own (their active state is gated to phase ===
  // "perimeter"); Erase is not phase-gated, so disarm it explicitly here. Keyed ONLY on
  // the unravelOn transition (not eraserOn) so re-arming Erase inside the unravel view —
  // where it deletes centerlines / floor lines — is not immediately undone.
  useEffect(() => {
    if (unravelOn) setEraserOn(false);
  }, [unravelOn]);
  // Select is the RESTING tool in both phases: in Plan a click picks the drawn shape or an
  // underlay, in Elevations it picks a wall border and then a cell. Arming it explicitly
  // (rather than leaving every tool off) means the bar always states what a click will do.
  // Switching phase drops whatever was HELD, since a selection belongs to the phase that
  // owns it, but keeps the tool itself in hand.
  //
  // EXCEPT ON ARRIVAL. The app opens in Plan on an empty canvas, where there is nothing to
  // select and only one thing to do — draw the perimeter. Arming Select there meant every
  // session began by putting a tool down before any work could start, so on arrival the
  // PEN is left in hand instead. (The Pen needs no arming: it is the tool whenever nothing
  // else is held in Plan — see its button's active condition.) Nothing else changes:
  // Select is still what every other tool returns to, and every phase switch arms it.
  //
  // Gated on the phase actually CHANGING rather than on "not the first run", because
  // StrictMode mounts effects twice in development: a first-run flag would be spent on the
  // first mount and the remount would arm Select anyway, so the Pen would be in hand in
  // production and not in dev. Seeding the ref with the current phase makes both mounts a
  // no-op, so what ships is what is being looked at.
  // (`prevPhaseRef` is declared beside `newProject`, which writes it for the same reason
  // arrival does — a brand-new project IS an arrival on an empty Plan canvas.)
  useEffect(() => {
    setSelectedImageId(null);
    setHoveredImageHandle(null);
    setPerimeterSelected(false);
    setHoveredPerimeterHandle(null);
    if (prevPhaseRef.current === unravelOn) return;
    prevPhaseRef.current = unravelOn;
    armSelectDefault();
  }, [unravelOn, armSelectDefault]);


  return (
    <div className="app">
      {/* The NAVIGATION HEADER was removed. Its live controls moved to where their
          work already happens: New Project and Demo to the Projects popup footer
          (project-level actions, beside "Save" and "Unroll Geometry"), Export to
          the bottom tool bar (it arms a marquee, so it is a tool), and Settings to
          the bottom-right beside the "?" help button (both are global panels). */}

      {/* ===== RIGHT: CANVAS + STATUS BAR ===== */}
      <main className="stage">
        <div className="canvas-wrap" ref={wrapRef}>
        {/* ===== OVERVIEW WINDOW =====
            A floating window over the canvas — the same chrome as
            the Projects window on the right (identical .mini* classes, so the two are one
            visual family and any change to that look applies to both). It is deliberately
            NOT docked: the canvas is the workspace, and a permanently reserved column took
            280px from it whether or not the panel was in use.
            Order is Location first (a project-level fact you set once), then Display (the
            view controls you return to constantly). The former "Create" section — the
            Line / Arc segment switch — was removed; those stay on their A / L keyboard
            shortcuts, and Draw/Edit live in the bottom tool bar. */}
        <div
          className={`mini mini--left mini--tall ${frontWin === "props" ? "mini--front" : ""}`}
          ref={propsWinRef}
          role="region"
          aria-label="Overview"
          onPointerDownCapture={() => setFrontWin("props")}
        >
          {/* TITLE BAR — drag handle + collapse toggle (mirrors the Projects window).
              Drags THIS window only; Statistics below is a separate, independent panel. */}
          <div
            className="mini__titlebar"
          >
            <span className="mini__title">Overview</span>
          </div>

          <div className="mini__body panel-body">

          {/* ===== PROJECT =====
              First in the window because it is the first thing a user does and the last
              thing they do: name the thing, save it, or start from something else. The
              Projects window remains the LIBRARY (list, load, reorder, duplicate,
              delete); these are the actions that operate on the CURRENT sketch, so they
              belong here beside the properties they apply to.
              NAME writes straight through: once saved, typing renames the saved entry
              live (the Projects list updates as you type). Before the first save it
              holds a draft that the Save button applies. */}
          <section className="panel__section">
            <div className="panel__section-title">Project</div>
            {/* ONE row: the name field takes the space, Save and New sit to its right.
                The "Name" label is dropped — the placeholder already says what the field
                is, and at this width a label costs more than it explains. */}
            <div className="panel__row">
              <input
                className="panel__input"
                type="text"
                value={activeSavedId ? saved.find((x) => x.id === activeSavedId)?.name ?? "" : projectNameDraft}
                placeholder="Project Name"
                title="Project name — renames the saved project as you type"
                onChange={(e) => {
                  if (activeSavedId) renameSavedEntry(activeSavedId, e.target.value);
                  else setProjectNameDraft(e.target.value);
                }}
              />
              {/* Both buttons are sized to their text (no flex growth) so the field keeps
                  the remaining width — it is the control that actually needs it. */}
              <button
                className="btn btn--compact"
                onClick={saveCurrent}
                disabled={!saveable}
                title={
                  saveable
                    ? "Save the current sketch as a new project (Ctrl+S)"
                    : "Draw at least two vertices before saving"
                }
              >
                Save
              </button>
              <button
                className="btn btn--compact"
                onClick={newProject}
                title="Start a new, blank project (your saved projects are kept)"
              >
                New
              </button>
              {/* Demo moved to the top-right utility bar, beside Help and Export. */}
            </div>
            {/* THE PROJECT LIST — formerly its own floating "Projects" window. Folded in
                here because it answers the same question as the fields above it (which
                project am I in, and what else is there), and one window is cheaper than
                two. Every row action is unchanged: click to load, drag to rotate the
                preview, ✎ rename, ⧉ duplicate, × delete, drag a name to reorder. */}
            <MiniWindow
            // Embedded: the gallery renders inside this section, not as its own window.
            embedded
            saved={saved}
            activeId={activeSavedId}
            onLoad={loadSavedEntry}
            onDelete={deleteSavedEntry}
            onDuplicate={duplicateSavedEntry}
            onRename={renameSavedEntry}
            onReorder={reorderSaved}
            onLocationChange={changeSavedLocation}
            onSolarChange={changeSavedSolar}
            // Solar Study open-state is CONTROLLED from here so the left panel's Display
            // section can open the same popup a project row's ☀ opens.
            solarId={solarStudyId}
            onSolarIdChange={setSolarStudyId}
            // Phase drives each thumbnail's default camera: aerial in Plan, 3/4 in
            // Elevations (animated on the switch).
            unravelOn={unravelOn}
            stageRef={wrapRef}
            // Hover-link: in the UNRAVEL view the hovered strip lights its matching
            // wall PANEL; with nothing hovered it falls back to the FOCUSED border (the
            // one zoomed into — kept lit so arrow-key navigation between borders shows
            // the current focus on the minimap, as if moused over). In PERIMETER (edit)
            // mode the hovered footprint edge lights its matching edge LINE instead
            // (highlightAsLine below). MiniWindow applies it to the active entry only,
            // whose geometry matches the live shape.
            highlightEdge={unravelOn ? (hoveredUnravelEdge >= 0 ? hoveredUnravelEdge : focusedPanel ?? -1) : mode === "edit" ? hoveredEdge : -1}
            // Perimeter-mode highlight draws the edge as a LINE on the footprint,
            // not a filled wall panel (that panel fill is the unravel-mode behaviour).
            highlightAsLine={!unravelOn}
            // Per-panel heights of the LIVE shape -> the active (matching)
            // thumbnail's per-wall heights; the global default applies to ALL
            // thumbnails. Not gated on unravelOn: heights persist in state once
            // set, so the active preview reflects them live as they change.
            heights={unravelHeights}
            defaultHeight={unravelHeight}
            // The live editor shape — the active thumbnail renders THIS, so footprint
            // (perimeter mode) and height (unravel mode) edits track in the preview
            // immediately instead of snapping back to the stored snapshot.
            livePerimeter={perimeter}
            />
          </section>

          {/* ===== LOCATION (geo-location of the sketch) =====
              The site address, stored with the sketch and read by the solar work (sun
              path, shadows, irradiance). DEFAULTS to Omaha, NE — pre-resolved, so the
              solar tools mean something from the first click; the user only types here
              when the project is somewhere else. The on-screen blurb is deliberately
              one line: the field is self-evident and the resolved-site readout below
              already reports what was matched. */}
          <section className="panel__section">
            <div className="panel__section-title">Location</div>
            <div className="panel__row">
              <input
                className="panel__input"
                type="text"
                value={location.address}
                placeholder="Address or 41.26, -95.94"
                title="Address (or literal coordinates) used to locate the sketch — Enter to resolve, blank for no location"
                onChange={(e) => setLocation((l) => ({ ...l, address: e.target.value }))}
                // Commit on Enter or blur, never per keystroke: resolving mid-word would
                // repeatedly jump the solar study to whatever city the prefix matched.
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitAddress((e.target as HTMLInputElement).value);
                  }
                }}
                onBlur={(e) => void commitAddress(e.target.value)}
              />
              {/* SOLAR — shares the address row because it CONSUMES what that field
                  produces: the resolved latitude, longitude, and time zone are what place
                  the sun. Sized to its text (btn--compact, no flex growth) so the field
                  keeps the remaining width, exactly like Save / New on the Project row
                  above; the row's own gap gives both clusters identical spacing.
                  Labelled "Solar" rather than "Solar Study" so it fits beside the field
                  without squeezing it — the ☀ and the tooltip carry the rest.
                  Disabled until a project is saved or loaded, since the study reads a
                  saved project's massing. */}
              <button
                data-tour="solar"
                className={`btn btn--icon btn--compact ${solarStudyId !== null ? "is-active" : ""}`}
                onClick={() => setSolarStudyId((id) => (id === null ? activeSavedId : null))}
                disabled={activeSavedId === null}
                aria-pressed={solarStudyId !== null}
                title={
                  activeSavedId === null
                    ? "Save or load a project first — the study reads a saved project's massing"
                    : "Solar Study — sun path, orientation, and shadow settings for this project"
                }
              >
                <span aria-hidden="true">☀</span>
                Solar
              </button>
            </div>

            {/* ATTRIBUTION — the bundled place data is GeoNames under CC BY 4.0, which
                requires visible credit. Sits directly under the field it describes, in the
                same monospace-dim treatment as the resolved coordinates, so everything
                beneath the input reads as one block of metadata about it. */}
            <div className="geo-credit">
              Place data ©{" "}
              <a href="https://www.geonames.org/" target="_blank" rel="noreferrer noopener">
                GeoNames
              </a>
              , CC BY 4.0
            </div>

            {/* RESOLUTION READOUT — always states what the tool matched, so a wrong or
                ambiguous guess is visible rather than silently driving the solar study. */}
            {geoStatus === "resolving" && <div className="panel__hint">Resolving…</div>}

            {geoStatus === "missing" && (
              <div className="geo-readout geo-readout--missing">
                No match — the study keeps its default site. Try a nearby larger town, or
                type coordinates as "41.26, -95.94".
              </div>
            )}

            {geoStatus === "resolved" && location.lat !== null && location.lng !== null && (
              <div className="geo-readout">
                {/* The field itself now carries the matched place, so only repeat it here
                    when it says something different — e.g. the "near <city>" label that
                    typed coordinates resolve to. */}
                {location.label && location.label !== location.address && (
                  <div className="geo-readout__place">{location.label}</div>
                )}
                <div className="geo-readout__coords">
                  {location.lat.toFixed(2)}°, {location.lng.toFixed(2)}°
                  {typeof location.elevationM === "number" && <> · {location.elevationM} m</>}
                </div>
                {location.timeZone && <div className="geo-readout__coords">{location.timeZone}</div>}
              </div>
            )}

            {/* One-click corrections for an ambiguous name — the several Springfields. */}
            {geoStatus === "resolved" && geoAlternatives.length > 0 && (
              <div className="geo-alts">
                <div className="geo-alts__label">Did you mean</div>
                {geoAlternatives.map((p) => (
                  <button
                    key={`${p.name}|${p.region}|${p.country}`}
                    className="geo-alts__btn"
                    onClick={() => pickAlternative(p)}
                    title={`Use ${formatPlace(p)} (${p.lat.toFixed(2)}°, ${p.lng.toFixed(2)}°)`}
                  >
                    {formatPlace(p)}
                  </button>
                ))}
              </div>
            )}

          </section>

          {/* (SELECTED IMAGE moved OUT of this window into its own panel — see the
              Selected image window at the end of the right column, under Statistics.) */}
          </div>

        </div>

        {/* ===== DISPLAY WINDOW =====
            Second in the LEFT column, stacked under Overview. Same chrome and width as the
            others. It sits on the left because that column is about the DRAWING, leaving
            the right column to the readings taken off it — and because Statistics, which
            grows as readings are switched on, needs a column it can grow down into
            without shoving this out of reach.
            It holds the two controls that decide WHAT IS DRAWN — view mode and per-element
            visibility — which is why they left the Overview window: Overview is about the
            project (name, site, selection); this is about the picture.
            Both groups are compact GRIDS rather than stacked rows: as rows they cost ten
            full-width lines for settings that are glanced at, not read. */}
        <div
          // `mini--stacked` because this sits BENEATH Overview in the left column: it has to
          // paint over it, or Overview's drop shadow falls across this window's top edge and
          // the pair reads as one card lying on the other. See styles.css.
          className={`mini mini--left mini--stacked ${frontWin === "display" ? "mini--front" : ""}`}
          ref={displayWinRef}
          style={displayWinStyle}
          role="region"
          aria-label="Display"
          onPointerDownCapture={() => setFrontWin("display")}
        >
          <div
            className="mini__titlebar"
          >
            <span className="mini__title">Display</span>
          </div>

          <div className="mini__body panel-body">
            <section className="panel__section">
            {/* VIEW MODE — the same compact picker the Statistics panel uses: one line
                showing the current mode instead of a grid of every option. The canvas
                itself is the confirmation of what is selected, so the list has nothing to
                prove by staying open, and the height it cost is height the visibility grid
                below can use. Wheel-cycles like the Statistics one.
                Elevation views only — these are cell treatments, and the footprint has no
                cells — so it disables in the Plan phase. */}
            <div className="panel__subtitle">View mode</div>
            <div
              data-tour="viewmode"
              className="panel__select-wrap"
              // WHEEL to cycle without opening the list — the fastest way to flip between
              // treatments while looking at the canvas. stopPropagation keeps the canvas
              // from zooming under the cursor.
              onWheel={(e) => {
                if (!unravelOn) return;
                e.stopPropagation();
                const i = CELL_VIEW_MODES.indexOf(cellViewMode);
                const next =
                  e.deltaY > 0
                    ? (i + 1) % CELL_VIEW_MODES.length
                    : (i - 1 + CELL_VIEW_MODES.length) % CELL_VIEW_MODES.length;
                selectViewMode(CELL_VIEW_MODES[next]);
              }}
            >
              <select
                className="panel__select"
                value={cellViewMode}
                disabled={!unravelOn}
                aria-label="View mode"
                title={
                  unravelOn
                    ? "Pick a view mode — or scroll the wheel over this to cycle"
                    : "Available in the elevation views (switch to Elevations)"
                }
                onChange={(e) => selectViewMode(e.target.value as CellViewMode)}
              >
                {CELL_VIEW_MODES.map((m) => (
                  <option key={m} value={m}>
                    {CELL_VIEW_LABELS[m]}
                  </option>
                ))}
              </select>
              <span className="panel__select-chevron" aria-hidden="true">▾</span>
            </div>

            {/* VISIBILITY — the five eye toggles that used to be embedded in the bottom-bar
                tool buttons, collected into one layers-style list. Moving them here
                separates "arm this tool" from "show this element", which those combined
                buttons conflated. Two columns: as five rows they dominated the window for
                switches that are glanced at, not read. Labels are shortened to fit a
                column; each row's tooltip carries the full name. */}
            <div className="panel__subtitle">Visibility</div>
            <div className="panel__vis-list panel__vis-list--grid">
              <VisRow
                label="Dims"
                full="Dimensions"
                visible={dimensionsVisible}
                disabled={!unravelOn}
                onToggle={() => setDimensionsVisible((v) => !v)}
              />
              <VisRow
                label="Floors"
                full="Floor lines"
                visible={floorLinesVisible}
                disabled={!unravelOn}
                onToggle={() => setFloorLinesVisible((v) => !v)}
              />
              <VisRow
                label="Centerlines"
                visible={centerlinesVisible}
                disabled={!unravelOn}
                onToggle={() => setCenterlinesVisible((v) => !v)}
              />
              <VisRow
                label="Framing"
                visible={framingVisible}
                disabled={!unravelOn}
                onToggle={() => setFramingVisible((v) => !v)}
              />
              {/* Named for the TOOL that creates these hatches (Glazing), not for the data
                  they come from (per-cell types) — the eye and the button that fills it in
                  now say the same word. */}
              <VisRow
                label="Glazing"
                full="Glazing types"
                visible={typeVisible}
                disabled={!hasAnyCellType}
                onToggle={() => setTypeVisible((v) => !v)}
              />
            </div>

            </section>
          </div>
        </div>

        {/* STATISTICS — the panel is presentational (see StatisticsPanel.tsx): it renders
            the reading it is handed and owns no state of its own. */}
        <StatisticsPanel
          statsModes={statsModes}
          activeStatsModes={activeStatsModes}
          onToggleStatsMode={toggleStatsMode}
          unravelOn={unravelOn}
          perimeter={perimeter}
          unravelResult={unravelResult ?? null}
          effectiveHeight={effectiveHeight}
          uniqueCellCount={cellShapeColors.uniqueCount}
          // The border the per-panel readings describe — the same index the canvas frames
          // in red, so the window and the drawing can never name different walls.
          anchorPanel={statsAnchorPanel}
          faceBearings={faceBearings}
          activeSolar={activeSolar}
          panelWWR={panelWWR}
          panelVLT={panelVLT}
          // Whole-facade cost estimate (null outside Elevations) — see core/cost.ts.
          costEstimate={costEstimate}
          isFront={frontWin === "stats"}
          onBringToFront={() => setFrontWin("stats")}
          winRef={statsWinRef}
          // Statistics is anchored by CSS (see .mini) — no computed offset to apply.
          winStyle={undefined}
        />

        {/* ===== SELECTED IMAGE WINDOW =====
            Last in the right column: utility bar → Statistics → this.
            CONTEXTUAL — it only exists while an underlay is selected (or an import
            is reporting), so it costs nothing the rest of the time and the column ends at
            Statistics until you click an image.
            It is a WINDOW rather than a section of Overview because it describes a
            selection, not the project: it should appear next to the thing it edits and
            vanish with it, which a permanent section in another panel cannot do.
            Opacity and Lock live here rather than on the canvas because they are settings,
            not direct manipulation — the canvas keeps the drag/resize gestures and nothing
            else. `importStatus` shows here too: it reports on the import that produced the
            selection, so this is where the user is already looking. */}
        {!unravelOn && (importStatus || selectedImage) && (
          <div
            // Stacked beneath Statistics in the right column — same reason as Display.
            className={`mini mini--stacked ${frontWin === "image" ? "mini--front" : ""}`}
            ref={imageWinRef}
            style={imageWinStyle}
            role="region"
            aria-label="Selected image"
            onPointerDownCapture={() => setFrontWin("image")}
          >
            <div className="mini__titlebar">
              <span className="mini__title">Selected image</span>
            </div>

            <div className="mini__body panel-body">
              <section className="panel__section">
                {importStatus && <div className="panel__hint">{importStatus}</div>}
                {selectedImage && (
                  <>
                    {/* File name TRUNCATES rather than widening the panel — names are
                        arbitrary and often have no spaces to wrap at, which is what made
                        this window scroll sideways. The full name stays on hover. */}
                    <div className="panel__hint panel__hint--truncate" title={selectedImage.name}>
                      {selectedImage.name}
                    </div>
                    {/* Size on its own line so it is never the thing pushed off. */}
                    <div className="panel__hint">
                      {fmtLength(selectedImage.w, 2)} × {fmtLength(selectedImage.h, 2)}
                    </div>
                    {/* Opacity: an underlay is meant to be traced over, so fading it is the
                        control that makes the drawing on top readable. */}
                    <div className="panel__row">
                      <label className="panel__label" htmlFor="ref-image-opacity">Opacity</label>
                      <input
                        id="ref-image-opacity"
                        className="panel__slider"
                        type="range"
                        min={5}
                        max={100}
                        step={5}
                        value={Math.round(selectedImage.opacity * 100)}
                        // Live-drag without history, then one undo step on release —
                        // otherwise a single slider drag would bury the stack in steps.
                        onChange={(e) => updateSelectedImage({ opacity: Number(e.target.value) / 100 }, false)}
                        onPointerDown={() => recordHistory()}
                      />
                      <span className="panel__unit panel__unit--pct">{Math.round(selectedImage.opacity * 100)}%</span>
                    </div>
                    <div className="panel__row">
                      {/* Lock pins the underlay's PLACEMENT — no drag, no resize — so
                          tracing over it can never nudge it. It stays SELECTABLE though,
                          and the frame still shows while the grips do not: this panel is
                          where Unlock lives, so a locked image that could not be picked
                          could never be unlocked. */}
                      <button
                        className={`btn ${selectedImage.locked ? "is-active" : ""}`}
                        onClick={() => updateSelectedImage({ locked: !selectedImage.locked })}
                        aria-pressed={selectedImage.locked}
                        title={
                          selectedImage.locked
                            ? "Unlock — allow the image to be moved and resized again"
                            : "Lock — pin the image so tracing can't nudge it (still selectable, so you can unlock it)"
                        }
                      >
                        {selectedImage.locked ? "Unlock" : "Lock"}
                      </button>
                      <button
                        className="btn"
                        onClick={deleteSelectedImage}
                        title="Delete this reference image (undoable)"
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </section>
            </div>
          </div>
        )}

          <canvas
            ref={canvasRef}
            // The hovered reference-image grip contributes its own resize cursor, so the
            // pointer announces which way that corner/edge will scale before the drag.
            // Pan stays last-declared in CSS and still wins when armed.
            className={`canvas ${panArmed ? "canvas--pan" : ""} ${unravelOn && hoveredUnravelTop >= 0 ? "canvas--ns-resize" : ""} ${hoveredImageHandle ?? hoveredPerimeterHandle ? `canvas--${handleCursor((hoveredImageHandle ?? hoveredPerimeterHandle)!)}` : overImageBody || overShapeBody ? "canvas--move" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            // Suppress the browser's native right-click menu ("Save image as…",
            // "Copy image", "Inspect") over the canvas. The right button is bound to
            // NOTHING here, and "nothing" has to mean nothing: a browser menu over the
            // drawing is the one thing a stray right-click must not produce.
            onContextMenu={(e) => e.preventDefault()}
            onPointerLeave={() => {
              setCursorModel(null);
              setHoveredUnravelEdge(-1);
              setHoveredUnravelTop(-1);
              setHoveredEdge(-1);
              setHoveredCell(-1);
              // Drop the Assembly per-edge red highlight when the cursor leaves.
              setHoveredCellEdge(null);
              // Drop the Subtractive hover preview when the cursor leaves the canvas
              // (an in-progress drag keeps its draft via pointer capture).
              setDivideHover(null);
              // Drop the Eraser deletion highlight too.
              setEraseHover(null);
              setHoveredVertex(-1);
              setEraseEdge(-1);
            }}
            onDoubleClick={onDoubleClick}
          />
          {/* ===== CURSOR CROSSHAIRS =====
              Two thin full-canvas lines tracking the pointer in the Plan
              view (drawing or editing vertices). Positioned entirely via the native
              pointermove effect above (direct transform writes) for minimal lag.
              Pointer-transparent and low z-index, so it sits over the canvas drawing but
              BEHIND every floating UI panel/control. */}
          {showCrosshair && (
            <div className="crosshair" ref={crosshairRef} aria-hidden="true">
              <div className="crosshair__line crosshair__line--v" ref={crosshairVRef} />
              <div className="crosshair__line crosshair__line--h" ref={crosshairHRef} />
            </div>
          )}
          {/* ===== ONBOARDING HINT =====
              First-run prompt centered on the empty canvas, with a hand-drawn arched
              arrow pointing up toward the Projects panel (top-right). Pointer-transparent
              so it never blocks drawing; it vanishes on the first interaction anywhere
              (see the showHint / pointerdown effect above). */}
          {showHint && (
            <div className="canvas-hint" aria-hidden="true">
              {/* Text only — the hand-drawn arrow that used to point from "project" toward
                  the Projects window was removed. */}
              <div className="canvas-hint__text">
                <span>Sketch perimeter</span>
                <span>or load project</span>
              </div>
            </div>
          )}
          {/* ===== PHASE SWITCH ROW — TOP CENTER =====
              Just the Plan / Elevations switch now, centered on the top
              edge of the canvas (absolutely positioned inside .canvas-wrap, its
              positioning context) — the mirror of the bottom-center tool bar, so the two
              floating rows pair up top and bottom. Everything that used to share this row
              has moved to where its work happens: Statistics / View mode / Render to the
              Overview window's Display section, and Undo / Redo to the bottom tool bar
              beside the tools whose edits they reverse. */}
          <div className="phase-controls">
            {/* PHASE SWITCH — the app's primary state change: footprint ↔ elevations.
                It used to sit in the Projects window footer as "Unroll Geometry / Fold to
                Plan", which hid the single most consequential control in the app inside a
                window that can be collapsed or dragged away — and it gates most of the
                bottom tool bar. As a two-state segmented switch it also SHOWS which phase
                you are in, which the old one-button toggle never did.
                Reuses the shared .segmented control (same look as the Settings unit
                switch). Elevations is disabled until there is enough geometry to unroll;
                both run the same `toggleUnrollView`, which plays the unroll / fold
                transition, so clicking the phase you are already in is a no-op. */}
            <div className="segmented history-phase" role="group" aria-label="Phase">
              <button
                className={`segmented__btn${!unravelOn ? " is-active" : ""}`}
                onClick={() => { if (unravelOn) toggleUnrollView(); }}
                aria-pressed={!unravelOn}
                title="Plan — draw and edit the building footprint"
              >
                <PlanIcon />
                Plan
              </button>
              <button
                data-tour="phase-elevations"
                className={`segmented__btn${unravelOn ? " is-active" : ""}`}
                onClick={() => { if (!unravelOn) toggleUnrollView(); }}
                disabled={!unravelOn && !canUnravel}
                aria-pressed={unravelOn}
                title={
                  unravelOn
                    ? "Elevations — the unrolled wall strip"
                    : canUnravel
                      ? "Elevations — lay every wall flat as an elevation strip"
                      : "Draw a perimeter first, then switch to Elevations"
                }
              >
                <ElevationsIcon />
                Elevations
              </button>
            </div>
            {/* Statistics, View mode, and Render MOVED to the left panel's Display
                section (a docked one-of-N list beats a dropdown for showing which
                mode is active). This row is now history only: Undo + Redo. */}
          </div>
          {/* COMMAND BAR — centered directly BELOW the top-center button row.
              The per-tool coaching hint that used to live here has been removed; the "?"
              help panel is now the single place controls are explained. What remains is
              the STORAGE-QUOTA warning, which is not guidance but an alert: reference
              images can fill localStorage, and a save that has silently stopped working
              costs the user their session. It stays on-canvas, where attention already
              is, rather than in a far-away footer.
              Rendered only when there IS something to report (no empty bar taking up
              canvas), and pointer-transparent so it never intercepts a canvas drag. */}
          {saveFailed && (
            <div className="command-bar" role="status" aria-live="polite">
              <span className="command-bar__prompt" aria-hidden="true">▸</span>
              <span className="command-bar__warn">
                Not saved — browser storage is full. Remove a reference image or delete a
                project; recent changes exist only in this tab until a save succeeds.
              </span>
            </div>
          )}
          {/* BOTTOM-CENTER TOOL BAR — the single row of canvas tool buttons, centered on
              the bottom edge of the canvas. It holds two clusters, left to right:
                1. .bottomright-tools — Pan · Select · Delete · Pen (footprint tools)
                2. .tool-controls     — Floor Lines · CW Type · Centerlines · Framing · Glazing
              Both clusters keep their own class (and their own internal gap) so their
              buttons/menus are unchanged; only this wrapper decides where the row sits.
              (View mode lives in the Display window; the help reference is behind the
              utility bar's Help button.) */}
          <div className="bottom-tools">
          {/* Left to right, divider-separated:
                1. PICK    — Pan · Select. Neither modifies anything; they choose a view or
                             an object, so they lead the bar.
                2. MODIFY  — Delete · Pen.
                3. PHASE   — Elevations only: Floor Lines · CW Type · Centerlines ·
                             Framing · Glazing.
              The leading run (Pan · Select · Erase · Draw) is present in BOTH phases and
              never changes order, so those four are always in the same place under the
              cursor. Select and Draw act only in Plan — underlays and footprint vertices
              both live there — so in Elevations they render DISABLED rather than moving or
              vanishing; the position is worth more than the pixel.
              The deeper phase tools below still UNMOUNT rather than dim, because they are
              a different set per phase rather than the same set in a different state. */}
          {/* HISTORY (Undo / Redo) moved to the top-right utility bar — they act on the
              DOCUMENT rather than on a tool, so they belong with the other app-level
              actions rather than among the drawing tools. */}
          <div className="bottomright-tools">
            {/* PAN — first button in the bar. Click to arm (blue while armed): a left
                click-drag then moves the VIEW. Holding SPACE arms it temporarily without
                touching this toggle, so the button also lights up while Space is down.
                Middle-drag / right-drag pan at any time regardless. */}
            <button
              className={`tool-btn ${panArmed ? "is-active" : ""}`}
              onClick={onPan}
              aria-pressed={panArmed}
              title="Pan — click-drag the canvas to move the view (or hold Space and drag)"
            >
              <PanIcon />
              Pan
            </button>
            {/* SELECT (V) — beside Pan: both PICK rather than modify (Pan picks a view,
                Select picks an object), so they lead the bar together. Active in BOTH
                phases: in Plan it picks / moves / resizes a reference underlay, and in
                Elevations it is the neutral pick tool — the state where a click selects a
                wall border and then a cell. It is armed by default on entering Elevations. */}
            <button
              className={`tool-btn ${selectMode ? "is-active" : ""}`}
              onClick={onSelect}
              aria-pressed={selectMode}
              title={
                phase === "perimeter"
                  ? "Select (V) — click a reference image to pick it, drag to move, grips to resize"
                  : "Select (V) — click a wall border, then a cell"
              }
            >
              <SelectIcon />
              Select
            </button>
          </div>
          <span className="bottom-tools__divider" aria-hidden="true" />
          {/* EDIT TOOLS — Erase leads (it acts in BOTH phases), followed by the Plan
              phase's geometry tools. Erase sits with the tools that MODIFY the drawing
              rather than with Pan/Select, which only pick. */}
          <div className="bottomright-tools">
            <button
              className={`tool-btn ${eraserOn ? "is-active" : ""}`}
              onClick={onEraser}
              aria-pressed={eraserOn}
              title="Delete — remove perimeter vertices and edges (Plan) or centerlines / floor lines (Elevations)"
            >
              <EraseIcon />
              Delete
            </button>
            {/* PEN — ONE tool for the whole footprint lifecycle. It replaces the old
                Draw + Edit pair, which split a single job across two buttons and left one
                of them permanently dimmed: Draw died the moment the shape closed, and Edit
                was useless before it.
                The shape's own state decides which behaviour is in hand:
                  OPEN perimeter   -> DRAW: each click places the next vertex.
                  CLOSED perimeter -> EDIT: select / drag / insert / delete vertices.
                That switch already happened implicitly — closing the loop sets edit mode —
                so this only makes the button honest about it. `penEditing` drives the label
                and tooltip so the current behaviour is always readable.
                Shown in BOTH phases so the bar's leading run (Pan · Select · Erase · Pen)
                never changes order; it only ACTS in Plan, where the footprint lives. */}
            <button
              data-tour="pen"
              className={`tool-btn ${phase === "perimeter" && !eraserOn && !panArmed && !selectMode ? "is-active" : ""}`}
              onClick={() => {
                // Pick the behaviour the geometry calls for, rather than a fixed mode.
                setMode(perimeter.closed ? "edit" : "draw");
                if (eraserOn) onEraser();
                setPanMode(false); // taking a tool releases Pan's hold on the left drag
                disarmSelect(); // ...and Select's hold on the left click
              }}
              disabled={phase !== "perimeter"}
              aria-pressed={phase === "perimeter" && !eraserOn && !panArmed && !selectMode}
              title={
                phase !== "perimeter"
                  ? "Pen draws and edits the footprint, which lives in the Plan phase"
                  : penEditing
                    ? "Pen (editing — the perimeter is closed) — drag a vertex to move, a knob to curve, click a segment to insert, double-click for a corner"
                    : "Pen (drawing) — click to place vertices · double-click or Enter to close the perimeter"
              }
            >
              <PenIcon />
              Pen
            </button>
            {/* Import moved to the top-right utility bar, beside Export — the two file
                actions belong together, and neither edits the model. */}
          </div>
          {/* Separates the tools that act on the FOOTPRINT (Pan · Select · Delete · Pen)
              from the curtain-wall cluster that acts on a WALL BORDER. Rendered only with
              that cluster, so the Plan phase never ends on a dangling rule. Same
              .bottom-tools__divider as the one after Select. */}
          {unravelOn && <span className="bottom-tools__divider" aria-hidden="true" />}
          {/* ELEVATIONS phase — the curtain-wall cluster. */}
          {/* CURTAIN-WALL cluster — Floor Lines · CW Type · Centerlines · Framing · Glazing.
              Second in the bottom-center row (directly after the Dim button). A flex row
              (mirrors the top-center .phase-controls) so the buttons are spaced by a single
              small gap (--space-1) and stay a tight cluster regardless of each button's
              rendered width. */}
          {unravelOn && (
            <div className="tool-controls">
              {/* FLOOR LINES — FIRST in the cluster: it is the only tool here that needs
                  nothing selected and nothing decided, so it is where the work starts.
                  A single-function tool button (no submenu): click ARMS the placement tool —
                  while active a ghosted dotted horizontal line tracks the cursor and a click
                  drops a floor line; click an existing one to remove; Esc or re-click
                  disarms. Floor lines only RENDER in the unravel/elevation view, so the
                  button is DISABLED outside it. Stays highlighted while armed. */}
              <button
                data-tour="floorlines"
                className={`floorplate-btn ${floorPlateMode ? "is-active" : ""}`}
                onClick={onFloorPlace}
                disabled={!canPlaceLines}
                aria-pressed={floorPlateMode}
                title={
                  canPlaceLines
                    ? "Floor Lines — click to drop a level line at the cursor's elevation; click a line to remove it"
                    : "Floor Lines — floor levels are drawn on the elevation walls, so switch to Elevations"
                }
              >
                <FloorLinesIcon />
                Floor Lines
              </button>
              {/* CW TYPE — assign the curtain-wall system to the SELECTED panel. Opens a
                  two-option menu (Stick / Unitized); the chosen one relabels the button to
                  "CW Type: <name>" and unlocks the Framing tool for that panel. Per-panel,
                  so it needs a panel selected. Switching a panel's type clears its framing
                  of the other system (centerlines kept). */}
              <div className="cw-type-wrap">
                {/* Lights while its menu is OPEN, exactly as Glazing does — they are the
                    two drop-ups in this row and were behaving differently, so an open menu
                    read as "armed" on one button and as nothing on the other. */}
                <button
                  data-tour="cwtype"
                  className={`cwtype-btn ${cwMenuOpen ? "is-active" : ""}`}
                  onClick={onCwType}
                  disabled={!unravelOn}
                  aria-haspopup="true"
                  aria-expanded={cwMenuOpen}
                  title={
                    unravelOn
                      ? "CW Type — choose the curtain-wall system (Stick or Unitized) for the selected wall border"
                      : "CW Type — a curtain-wall system is assigned per wall border, so switch to Elevations"
                  }
                >
                  <CwTypeIcon />
                  {cwType ? `CW Type: ${CW_TYPE_LABELS[cwType]} ▾` : "CW Type ▾"}
                </button>
                {cwMenuOpen && (
                  <div className="cw-menu" role="menu">
                    {(Object.keys(CW_TYPE_LABELS) as CwType[]).map((t) => (
                      <button
                        key={t}
                        className={`cw-menu__btn ${cwType === t ? "is-active" : ""}`}
                        role="menuitemradio"
                        aria-checked={cwType === t}
                        onClick={() => selectCwType(t)}
                      >
                        {CW_TYPE_LABELS[t]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* CENTERLINES — operates on the panel SELECTED via click, so it is DISABLED
                  until a panel is selected (focusedPanel !== null). The armed cluster tools
                  (Floor Lines / Centerlines / Framing) are mutually exclusive — arming one
                  disarms the rest. Cluster order: Floor Lines · CW Type · Centerlines ·
                  Framing · Glazing (Delete sits earlier in the same row, with Pan · Select ·
                  Pen). */}
              <button
                data-tour="centerlines"
                className={`subtractive-btn ${subtractiveOn ? "is-active" : ""}`}
                onClick={onSubtractive}
                disabled={!canPlaceCenterlines}
                aria-pressed={subtractiveOn}
                title={
                  canPlaceCenterlines
                    ? "Centerlines — drag inside the border to divide it into columns or rows; the cursor picks both spacing and direction"
                    : "Centerlines — divide a single wall border, so click one first"
                }
              >
                <CenterlinesIcon />
                Centerlines
              </button>
              {/* FRAMING — disabled until a CW Type is selected; arms the mullion/framing
                  offset tool. Last in the cluster. Mutually exclusive cluster tool. The eye
                  ICON embedded in its right edge toggles framing visibility on the canvas. */}
              <button
                data-tour="framing"
                className={`mullions-btn ${mullionsOn ? "is-active" : ""}`}
                onClick={onMullions}
                disabled={!canFrame}
                aria-pressed={mullionsOn}
                // Framing is the only tool with THREE prerequisites, so a single "why not"
                // message would be wrong two times out of three. It names the one actually
                // missing, in the order they have to be satisfied.
                title={
                  canFrame
                    ? "Framing — drag a centerline (Stick) or a cell edge (Unitized) to set the mullion offset"
                    : focusedPanel === null
                      ? "Framing — offsets are set per wall border, so click one first"
                      : cwType === null
                        ? "Framing — assign a CW Type to this border first (Stick and Unitized frame differently)"
                        : "Framing — offsets are measured from centerlines, so add one to this border first"
                }
              >
                <FramingIcon />
                Framing
              </button>
              {/* GLAZING — to the right of Framing, and a PAINT tool: pick a material from the
                  chooser (drop-up, same rules as the CW Type menu), then apply it by clicking a
                  cell or dragging across a run of them. Enabled whenever a wall border is
                  focused; blue while the chooser is open OR a brush is loaded. The label carries
                  the loaded material, so the bar always answers "what will a click paint?".
                  Clicking it again puts the tool down. (Hatch visibility lives in the left
                  panel's Display ▸ Visibility list.) */}
              <div className="tool-vis-wrap">
                <button
                  data-tour="glazing"
                  className={`type-btn ${typeOn || glazingBrush !== null ? "is-active" : ""}`}
                  onClick={onType}
                  disabled={!canType}
                  aria-haspopup="true"
                  aria-expanded={typeOn}
                  title={
                    glazingBrush !== null
                      ? `Glazing: ${glazingBrush === "none" ? "None" : CELL_TYPE_LABELS[glazingBrush]} — click a cell, or drag across cells and release, to paint it. Click here to pick a different type; Esc puts the tool down.`
                      : "Glazing — pick a type, then click or drag across cells to paint it on"
                  }
                >
                  <AssignIcon />
                  {glazingBrush === null
                    ? "Glazing ▾"
                    : `Glazing: ${glazingBrush === "none" ? "None" : CELL_TYPE_LABELS[glazingBrush]} ▾`}
                </button>
                {typeOn && (
                  <div className="cw-menu cw-menu--type" role="menu">
                    {/* The active mark is the LOADED brush, not the selection's common type:
                        the menu's job here is to say which material is in hand. Clicking the
                        marked one again unloads it — the chooser is also the tool's off
                        switch, since the button itself always opens this menu. */}
                    {/* NONE — paints cells back to untyped (no hatch), so un-assigning is the
                        same gesture as assigning. Listed first as the neutral / reset choice. */}
                    <button
                      className={`cw-menu__btn cw-menu__btn--type type-none ${glazingBrush === "none" ? "is-active" : ""}`}
                      role="menuitemradio"
                      aria-checked={glazingBrush === "none"}
                      title={
                        glazingBrush === "none"
                          ? "None is loaded — click to put the Glazing tool down"
                          : "Paint cells back to untyped (clears the glazing type — no hatch)"
                      }
                      onClick={() => armGlazingBrush("none")}
                    >
                      <span className="type-swatch type-swatch--none" aria-hidden="true" />
                      <span className="type-name">None</span>
                      <span className="type-vlt">—</span>
                    </button>
                    {(Object.keys(CELL_TYPE_LABELS) as CellType[]).map((t) => (
                      <button
                        key={t}
                        className={`cw-menu__btn cw-menu__btn--type type-${t} ${glazingBrush === t ? "is-active" : ""}`}
                        role="menuitemradio"
                        aria-checked={glazingBrush === t}
                        title={
                          glazingBrush === t
                            ? `${CELL_TYPE_LABELS[t]} is loaded — click to put the Glazing tool down`
                            : `Load ${CELL_TYPE_LABELS[t]} — VLT ${Math.round(CELL_TYPE_VLT[t] * 100)}% — then click or drag across cells to paint it`
                        }
                        // Loads the brush; the cells it goes on are chosen afterwards, on canvas.
                        onClick={() => armGlazingBrush(t)}
                      >
                        <span className={`type-swatch type-swatch--${t}`} aria-hidden="true" />
                        <span className="type-name">{CELL_TYPE_LABELS[t]}</span>
                        {/* Industry-standard VLT for this type (CELL_TYPE_VLT) — same value the
                            VLT statistics view uses, surfaced here so the choice is informed. */}
                        <span className="type-vlt">VLT {Math.round(CELL_TYPE_VLT[t] * 100)}%</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {/* Export moved to the top-right utility bar, beside Demo and Help — it writes a
              FILE rather than editing the model, so it sits with the other app-level
              actions instead of among the drawing tools. */}
          </div>
          {/* UNRAVEL · per-panel height inputs. A DOM overlay (NOT canvas-drawn) of
              one <input> per rectangle, positioned by converting each rectangle's
              left edge at its vertical mid to screen via toScreen(viewport). Because
              `viewport` is React state and paint re-runs on it, this JSX re-renders
              on every pan/zoom/resize, so the inputs track the canvas. The container
              is pointer-transparent; only the inputs capture events, so canvas
              pan/zoom elsewhere is unaffected. Cleaned up automatically when leaving
              the view (unravelDraws becomes null). These height inputs are dimension
              fields, so they follow the DIM toggle (dimensionsVisible) — the single
              source of truth — and are no longer auto-hidden by the Clean / Shadows views. */}
          {unravelOn && unravelDraws && unravelDraws.length > 0 && dimensionsVisible && (
            <div className="unravel-overlay">
              {unravelDraws.map(({ seg, height }) => {
                // PANELS phase: the focused panel is now dimensioned per ROW with
                // height labels parked just LEFT of its border (drawn on-canvas by
                // drawUnravel). That is exactly where this rotated height <input>
                // sits, so the two would overlap. Hide ONLY the focused panel's
                // input while we are in the Panels view; every other panel (and the
                // whole Elevations strip) keeps its input. Trade-off: the panel's
                // total height can't be TYPED here in Panels view, but it can still
                // be changed by dragging the panel's top edge (existing affordance).
                if (unravelOn && focusedPanel === seg.index && focusedCell === null) return null;
                const anchor = toScreen(viewport, { x: seg.x0, y: height / 2 });
                const draft = unravelInputDraft[seg.index];
                const focused = focusedUnravelInput === seg.index;
                // Display swap (function before aesthetic): while EDITING (focused
                // or an in-progress draft) show the PLAIN number — in the active
                // display unit — so typing and numeric parsing on commit work
                // normally; while IDLE show the value WITH the active unit tick via
                // fmtLengthTick so it reads like the canvas WIDTH label (2 decimals).
                // `height` is model feet; both the plain value and the tag convert.
                const editing = focused || draft !== undefined;
                const plain = draft !== undefined ? draft : String(Number(toDisplayLength(height).toFixed(3)));
                const value = editing ? plain : fmtLengthTick(height);
                // When this panel is the double-click-SELECTED one (the Additive /
                // Subtractive target), recolour its HEIGHT field to the same faint
                // floor-plate grey the renderer uses for its WIDTH label, so BOTH
                // dimension labels of the selected panel read in the selection grey.
                const isSelected = focusedPanel === seg.index;
                return (
                  <input
                    key={seg.index}
                    className={`unravel-input ${isSelected ? "is-selected" : ""}`}
                    // type=text (not number) so the idle display can carry the `′`
                    // tick; inputMode=decimal keeps the numeric keypad on touch.
                    type="text"
                    inputMode="decimal"
                    value={value}
                    title={`Height of panel (edge #${seg.index}) — enter or blur to apply`}
                    style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
                    onChange={(e) => {
                      // Sanitize to a numeric string (digits, one dot, leading
                      // minus) so the draft stays parseable by parseFloat on
                      // commit — the `′` and any stray glyphs never enter state.
                      const cleaned = e.target.value.replace(/[^0-9.\-]/g, "");
                      setUnravelInputDraft((prev) => ({ ...prev, [seg.index]: cleaned }));
                    }}
                    onFocus={() => setFocusedUnravelInput(seg.index)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      else if (e.key === "Escape") {
                        // Cancel the edit: drop the draft, restore the live value.
                        setUnravelInputDraft((prev) => {
                          const next = { ...prev };
                          delete next[seg.index];
                          return next;
                        });
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    onBlur={() => {
                      setFocusedUnravelInput((cur) => (cur === seg.index ? null : cur));
                      commitPanelInput(seg.index);
                    }}
                  />
                );
              })}
            </div>
          )}
          {/* ===== UTILITY BAR =====
              A floating bar pinned above the Projects window at the top right, holding
              every APP-LEVEL action — the ones that act on the document or the app rather
              than on the drawing: Undo · Redo · Demo · Import · Export. Grouping them here
              keeps the bottom bar purely about drawing tools.
              Matched to the Projects window's width so the two read as one column, and a
              FIXED height so that window can offset itself below by exactly that amount in
              CSS — neither has to measure the other. Undo / Redo stay square icon buttons
              and the three labelled actions share the remaining width equally, which is
              what lets all five fit at --mini-width. (Help was removed from this bar — the
              reference now opens with ? / F1.) */}
          <div className="util-bar" role="toolbar" aria-label="Application actions">
            <button
              className="util-bar__btn util-bar__btn--icon"
              onClick={undo}
              disabled={undoStack.length === 0}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              ↶
            </button>
            <button
              className="util-bar__btn util-bar__btn--icon"
              onClick={redo}
              disabled={redoStack.length === 0}
              title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              ↷
            </button>
            {/* DEMO — plays the guided tour (core/demoTour.ts + DemoTour.tsx), which BUILDS
                an example project step by step rather than loading a finished one. It lights
                while the tour is running, and clicking it again ends the tour.
                UNTIL IT HAS BEEN USED this visit its border pulses: a first-time visitor
                faces a blank canvas and a bar of unfamiliar tools, and this is the one
                control that explains the rest. The pulse is on the BORDER only — a filled
                button here would read as "armed", which in this app means something else —
                and it stops for good on the first click (see markDemoSeen). */}
            <button
              className={`util-bar__btn ${tourStep !== null ? "is-active" : ""} ${
                !demoSeen && tourStep === null ? "util-bar__btn--attract" : ""
              }`}
              onClick={() => {
                markDemoSeen();
                if (tourStep === null) startTour();
                else exitTour();
              }}
              aria-pressed={tourStep !== null}
              title={
                tourStep === null
                  ? "Demo — a guided tour that draws an example building and walks through the whole workflow"
                  : "Demo — end the tour (everything built so far is kept)"
              }
            >
              Demo
            </button>
            {/* IMPORT · EXPORT — the two FILE actions, paired at the end of the bar and
                mirroring each other: Import brings a PDF / PNG / JPEG in as a reference
                underlay to trace over (Plan phase, where underlays live), Export writes the
                selected walls out as a DXF (Elevations, where walls are selectable). Each
                is disabled in the other's phase, so the pair reads as one in/out control
                that follows wherever you are. The <input> is hidden because a native file
                field cannot be styled to match the bar. */}
            <button
              className="util-bar__btn"
              onClick={onImportClick}
              disabled={unravelOn}
              title={
                unravelOn
                  ? "Import places a reference underlay to trace over — available in the Plan phase"
                  : "Import a PDF / PNG / JPEG as a reference underlay to trace over"
              }
            >
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="visually-hidden"
              accept={ACCEPTED_IMAGE_TYPES}
              multiple
              onChange={(e) => void importImageFiles(e.target.files)}
            />
            {/* The label stays "Export" even while the marquee is armed — at this width a
                longer word would ellipsis, and the accent fill already says it is armed. */}
            <button
              data-tour="export"
              className={`util-bar__btn ${exportSelectMode ? "is-active" : ""}`}
              onClick={toggleExportSelect}
              disabled={!unravelOn}
              aria-pressed={exportSelectMode}
              title={
                unravelOn
                  ? "Export — click-drag a box over the panels to select walls, then export to Revit / AutoCAD / Rhino (Esc cancels)"
                  : "Unroll the geometry first, then export walls"
              }
            >
              Export
            </button>
          </div>

          {/* EXPORT popup: opens on a non-empty marquee release. Portals into the
              canvas-wrap (stageRef), previews ONLY the selected walls in 3D, and
              downloads a unit-preserving DXF for Revit / AutoCAD / Rhino. */}
          {exportPopup && (
            <ExportPopup
              perimeter={perimeter}
              edges={exportPopup}
              heights={unravelHeights}
              defaultHeight={unravelHeight}
              facadeRecords={{
                cells: unravelCells,
                divisions: panelDivisions,
                dividersH: panelDividersH,
                mullionsV: panelMullionsV,
                mullionsH: panelMullionsH,
                cellFraming: panelCellFraming,
              }}
              unravelGap={unravelGap}
              stageRef={wrapRef}
              onClose={() => {
                // Closing the popup (× or Esc) drops the marquee selection too, so the
                // highlighted elevations clear rather than lingering selected on-canvas.
                setExportPopup(null);
                setExportSelection(new Set());
              }}
            />
          )}
          {/* HELP "?" button — floats at the BOTTOM-RIGHT of the canvas (anchored in
              .canvas-wrap like the floor-plate / history clusters). Clicking it opens a
              small submenu ABOVE itself to choose which reference to read; picking one
              opens a panel with the same chrome as the other floating overlays. The
              submenu and a panel never show together. */}
          {helpMenuOpen && (
            <div
              className="help-backdrop"
              onPointerDown={() => setHelpMenuOpen(false)}
              aria-hidden="true"
            />
          )}
          {helpMenuOpen && (
            <div className="help-menu" role="menu" aria-label="Help topics">
              <button
                className="help-menu__btn"
                role="menuitem"
                onClick={() => { setHelpPanel("controls"); setHelpMenuOpen(false); }}
              >
                Control List
              </button>
              <button
                className="help-menu__btn"
                role="menuitem"
                onClick={() => { setHelpPanel("stats"); setHelpMenuOpen(false); }}
              >
                Statistics Info
              </button>
              <button
                className="help-menu__btn"
                role="menuitem"
                onClick={() => { setHelpPanel("views"); setHelpMenuOpen(false); }}
              >
                View Modes Info
              </button>
            </div>
          )}
          {/* The selected reference panel. The title (top-left, UPPERCASED by CSS) names
              the topic; the body renders the matching reference list. It is a NON-MODAL,
              STAY-OPEN panel: there is deliberately NO backdrop, so the user can click
              around the canvas to navigate (pan/zoom, select walls, etc.) while the
              reference stays visible alongside the on-screen elements it explains. It is
              closed only by the × button, the Help button, or Escape (handled in an effect). */}
          {helpPanel && (
            <div
              className="help-popup"
              role="dialog"
              aria-label={HELP_PANEL_TITLE[helpPanel]}
            >
              <div className="help-popup__titlebar">
                <span className="help-popup__title">{HELP_PANEL_TITLE[helpPanel]}</span>
                <button
                  className="help-popup__close"
                  onClick={closeHelp}
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <div className="help-popup__body">
                {helpPanel === "controls" && <ControlsList />}
                {helpPanel === "stats" && <StatisticsInfo />}
                {helpPanel === "views" && <ViewModesInfo />}
              </div>
            </div>
          )}
          {/* The SETTINGS popup was removed along with its gear button. It existed only to
              switch the display unit; the app is now FEET-ONLY (see core/units). */}
        </div>
        {/* The bottom STATUS BAR (X / Y cursor readout + live zoom) was removed — the
            stage is now canvas-only, edge to edge. Its two messages moved onto the canvas
            as the .command-bar under the top-center button row (tool hint + save-failure
            warning). */}
      </main>

      {/* ===== GUIDED DEMO =====
          Rendered as a child of .app rather than inside .canvas-wrap on purpose: its card
          and ring are position:fixed and measure their targets in VIEWPORT coordinates, so
          they must not sit inside an element that could become a containing block (a
          transform or filter on an ancestor would silently re-base them). Last in the tree
          so it paints over every panel and popup, including the Solar Study's modal
          backdrop. */}
      {tourStep !== null && (
        <DemoTour
          step={TOUR_STEPS[tourStep]}
          index={tourStep}
          total={TOUR_STEPS.length}
          onNext={nextTourStep}
          onBack={tourStep > 0 ? backTourStep : null}
          onExit={exitTour}
        />
      )}
    </div>
  );
}
