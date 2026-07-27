/**
 * core/displayModes.ts
 *
 * The app's DISPLAY VOCABULARY: the curtain-wall systems, the per-cell glazing types and
 * their industry VLT values, the cell view modes, and the statistics readings.
 *
 * These are plain data with no React in them, and they are read by the editor, the
 * renderer-facing builders, and the panels alike — so they live in core/ rather than
 * inside a component. Adding an entry here is what adds it to the matching picker.
 */

export const CW_TYPE_LABELS: Record<CwType, string> = {
  stick: "Stick System",
  unitized: "Unitized System",
};

export const CELL_TYPE_LABELS: Record<CellType, string> = {
  vision: "Vision",
  spandrel: "Spandrel",
  opaque: "Opaque",
};

/**
 * Representative VISIBLE LIGHT TRANSMITTANCE (VLT / NFRC visible transmittance, 0–1) per
 * cell type — industry-typical defaults, used by the VLT statistics view. Vision = a clear /
 * low-E vision IGU (~0.70 VT, the see-through glazing that admits daylight); Spandrel
 * (back-painted / opacified glass that conceals the slab edge) and Opaque (solid infill —
 * metal panel, masonry, etc.) transmit no visible light, so 0. Adjust here to match a
 * specific product's spec sheet — these are the single source of truth for the VLT readout.
 */
export const CELL_TYPE_VLT: Record<CellType, number> = {
  vision: 0.7,
  spandrel: 0,
  opaque: 0,
};

/**
 * CELL VIEW MODES — the display modes the "View" button's dropdown menu lists. "normal"
 * is the default presentation; "materialId" colours every grid cell by its geometric
 * shape (a Lumion-style Material ID overlay). The menu lists them in this array order, so
 * adding a future mode here automatically adds a menu entry.
 */
export const CELL_VIEW_MODES = ["normal", "materialId", "orientation", "clean", "shadows"] as const;

/** Full human label for each cell-view mode — used in tooltips and the help reference. */
export const CELL_VIEW_LABELS: Record<CellViewMode, string> = {
  normal: "Technical",
  materialId: "Material ID",
  orientation: "Orientation Heatmap",
  clean: "Clean",
  shadows: "Shadows",
};

/**
 * STATISTICS READINGS — the readings the Statistics panel (top of the right column) lists
 * as toggle chips, in this order. The selection is a SET, not a one-of-N pick: every
 * reading switched on renders, stacked, and the panel grows to fit.
 * `unravelOnly` marks the reads that need a wall orientation or assigned cell types (the
 * solar diagrams, WWR, VLT): they are meaningless on the footprint, so their chips
 * disable in the Plan phase. "General" works in both views (it needs a closed perimeter
 * there, gated in the JSX).
 * `perPanel` marks the readings that describe ONE wall border rather than the whole
 * building — the solar diagrams, WWR and VLT all report a single facade. Those readings
 * need the user to know WHICH border they are about, so this flag is what drives the red
 * soft red glow the canvas draws around that border (see RenderState.statsAnchorPanel).
 * "General" totals the whole strip, so it anchors to nothing.
 * Adding a mode here adds its chip; keep the keys in sync with `StatsMode`.
 */
export const STATS_MODES = [
  { key: "general", label: "General", unravelOnly: false, perPanel: false },
  { key: "irradiance", label: "Irradiance (W/m²)", unravelOnly: true, perPanel: true },
  { key: "insolation", label: "Insolation (kWh/m²)", unravelOnly: true, perPanel: true },
  { key: "wwr", label: "WWR", unravelOnly: true, perPanel: true },
  { key: "vlt", label: "VLT", unravelOnly: true, perPanel: true },
  // Cost totals the WHOLE facade (every wall border), so it is not perPanel — a budget is
  // a project figure. It needs the unrolled walls to have cells and framing to price, so
  // it is still an Elevations-phase reading.
  { key: "cost", label: "Cost", unravelOnly: true, perPanel: false },
] as const;

/** Does this reading describe a SINGLE wall border (and so need one identified)? */
export function isPerPanelStat(m: StatsMode): boolean {
  return STATS_MODES.some((s) => s.key === m && s.perPanel);
}

/** Curtain-wall fabrication systems selectable from the "CW Type" button, with the
 *  labels shown to the user (the button relabels to "CW Type: <name>" once chosen). */
export type CwType = "stick" | "unitized";

/** Glazing/infill TYPES selectable from the "Type" button's submenu, with the labels
 *  shown to the user. Assigned per grid CELL (Cells tab) and rendered with a per-type
 *  hatch. The order here is the order the submenu lists them. */
export type CellType = "vision" | "spandrel" | "opaque";

export type CellViewMode = (typeof CELL_VIEW_MODES)[number];

/** Selectable readings, plus "none" — no longer a chip of its own (switching every chip
 *  off is how you get an empty panel), but still the EFFECTIVE state when nothing in the
 *  selection can apply in the current phase, e.g. only wall-orientation reads are on and
 *  the view is back in Plan. */
export type StatsMode = (typeof STATS_MODES)[number]["key"] | "none";
