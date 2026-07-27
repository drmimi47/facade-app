/**
 * core/demoTour.ts
 *
 * The GUIDED DEMO — the script the top-right "Demo" button plays.
 *
 * It replaces the old "load a bundled example project" idea, which handed the visitor a
 * finished building and left them to reverse-engineer how it got there. A facade tool's
 * value is in the SEQUENCE (footprint → unroll → floors → system → division → framing →
 * glazing → numbers), and a finished file shows none of it. So the demo BUILDS the example
 * in front of the user, one authored step at a time, using the app's own state — nothing
 * here is a mock-up or a video.
 *
 * ── WHAT LIVES HERE vs. IN THE COMPONENT ─────────────────────────────────────────
 * This module is PURE: the example geometry, the design parameters it is built from, the
 * drawing-animation math, and the step copy. It has no React, no DOM, no setters. The
 * side effects (which setter each step calls) live in PolylineTool, keyed by
 * {@link TourStep.id}, because they are the app's own state transitions and belong with
 * them. The split is what makes the script testable.
 *
 * ── DESIGN OF THE EXAMPLE BUILDING ───────────────────────────────────────────────
 * A 4-storey mid-rise with a bowed south facade and two chamfered corners: enough shape
 * that unrolling it says something (a curved wall unrolls to its ARC length, chamfers
 * become their own narrow panels), but few enough walls that the strip stays readable.
 * The curtain wall is a 10 ft module on a 13.5 ft floor-to-floor with a 3.5 ft spandrel
 * band under each slab — an ordinary, defensible grid rather than an invented one, so the
 * statistics it produces are worth reading.
 */

import type { Perimeter, Vertex } from "./geometry";

// ---------------------------------------------------------------------------
// THE EXAMPLE PROJECT'S PARAMETERS
//
// Everything the demo builds is derived from these, so retuning the example is a
// matter of changing a number here rather than editing the step logic.
// ---------------------------------------------------------------------------

/** Name the demo's project is saved under (it needs to be saved: Solar reads a saved project). */
export const DEMO_PROJECT_NAME = "Demo — Bowfront Tower";

/**
 * The site the demo types into the Location field.
 *
 * "Manhattan, NY" rather than "Manhattan, New York": the admin-1 CODE is the strong
 * corroboration in the offline matcher (see core/gazetteer), so this lands on Manhattan,
 * New York rather than Manhattan, Kansas — and the field then rewrites itself to the
 * canonical "Manhattan, New York, US", which is the resolver visibly doing its job.
 */
export const DEMO_ADDRESS = "Manhattan, NY";

/** Wall height of every panel in the example (ft) — 4 storeys at {@link DEMO_FLOOR_TO_FLOOR_FT}. */
export const DEMO_WALL_HEIGHT_FT = 54;

/** Floor-to-floor height (ft). Drives both the floor lines and the spandrel bands. */
export const DEMO_FLOOR_TO_FLOOR_FT = 13.5;

/** Depth (ft) of the spandrel band under each slab — the opaque zone covering the slab edge. */
export const DEMO_SPANDREL_BAND_FT = 3.5;

/** Target curtain-wall module (ft). Each wall is divided into whole modules nearest this. */
export const DEMO_MODULE_FT = 10;

/** Mullion face offset (ft) the Framing step sets — 2.5 in, a typical stick-system face width. */
export const DEMO_MULLION_OFFSET_FT = 0.21;

/**
 * The example footprint, in model feet with +Y north.
 *
 * Vertex 0 → 1 is the SOUTH wall and carries the curve handles, so the sun-facing facade is
 * the bowed one — which is what makes the solar and glazing steps worth watching. The
 * outline winds counter-clockwise; `unravelPerimeter` reverses that internally to read the
 * walls clockwise, but the EDGE INDICES are preserved, so edge 0 is the south wall in both
 * the plan and the unrolled strip.
 */
export const DEMO_PERIMETER: Perimeter = {
  vertices: [
    // South-west corner; handleOut bows the south wall outward (southward, −Y).
    { x: -60, y: -38, handleOut: { x: 30, y: -16 } },
    // South-east corner; handleIn completes the same bow.
    { x: 44, y: -38, handleIn: { x: -30, y: -16 } },
    { x: 60, y: -20 }, // chamfer, SE
    { x: 60, y: 38 }, // east wall
    { x: -44, y: 38 }, // north wall
    { x: -60, y: 20 }, // chamfer, NW
  ],
  closed: true,
};

/** Edge index the demo drills into for the per-border steps — the bowed south wall. */
export const DEMO_FOCUS_EDGE = 0;

/**
 * The view modes the "Change what you see" step cycles through, and what it lands on.
 *
 * Not the whole list in order: the point is to show that the SAME drawing reads several
 * ways, which three contrasting modes make faster than five similar ones. It ends on
 * "normal" so the Statistics card that follows is read against the technical drawing —
 * the view every number in that panel is computed from.
 */
export const DEMO_VIEW_MODE_SEQUENCE = ["materialId", "orientation", "shadows", "normal"] as const;

/**
 * How many adjacent wall borders the Export step sweeps with its marquee.
 *
 * A RUN rather than the whole strip: the point of the marquee is that you export the walls
 * you picked, and a box around everything demonstrates nothing that a single "export all"
 * button would not.
 */
export const DEMO_EXPORT_PANEL_COUNT = 3;

/**
 * Margin (ft) the demo's marquee box stands off the panels it is selecting. Kept below
 * half the inter-panel gap so the box cannot clip a neighbour it did not mean to catch.
 */
export const DEMO_MARQUEE_PAD_FT = 4;

/**
 * The contiguous run of `count` wall borders the Export step selects — centred on
 * `focusEdge` (the wall the demo has been detailing, so the export is of something the
 * user has watched being built) and clamped to the ends of the strip.
 *
 * Takes the panels in STRIP order, not perimeter order: the marquee is a box drawn on the
 * unrolled elevations, so "adjacent" means adjacent along the baseline.
 */
export function demoExportWindow<T extends { index: number; x0: number }>(
  segments: T[],
  focusEdge: number,
  count: number,
): T[] {
  if (segments.length === 0 || count <= 0) return [];
  const ordered = [...segments].sort((a, b) => a.x0 - b.x0);
  const width = Math.min(count, ordered.length);
  const focus = ordered.findIndex((s) => s.index === focusEdge);
  // Centre the window on the focused wall, then slide it back inside the strip. A window
  // wider than the strip collapses to the whole thing, which is the correct degenerate.
  const ideal = (focus < 0 ? 0 : focus) - Math.floor((width - 1) / 2);
  const start = Math.max(0, Math.min(ideal, ordered.length - width));
  return ordered.slice(start, start + width);
}

// ---------------------------------------------------------------------------
// DERIVED GEOMETRY
//
// Each of these mirrors what a user would place by hand with the matching tool, so
// the demo's result is reachable by hand rather than a special case.
// ---------------------------------------------------------------------------

/**
 * Slab levels (ft above the base) for the Floor Lines step: the ground line, every
 * floor-to-floor above it, and the roof. Always includes 0 and `height`.
 */
export function demoFloorLevels(height: number, floorToFloor: number): number[] {
  if (!(height > 0) || !(floorToFloor > 0)) return [0];
  const out: number[] = [];
  for (let y = 0; y < height - 1e-6; y += floorToFloor) out.push(round(y));
  out.push(round(height));
  return out;
}

/**
 * HORIZONTAL centerline offsets (ft above the base) for one panel — the interior grid
 * lines the Centerlines tool would place. Two per slab: the top of the spandrel band
 * (the slab line itself) and its bottom, which is what gives every floor a vision band
 * with an opaque band under the slab above it.
 *
 * Only STRICTLY interior lines are returned (0 and `height` are the panel's own borders,
 * and `cellsForEdge` discards anything outside that range anyway).
 */
export function demoRowOffsets(height: number, floorToFloor: number, band: number): number[] {
  const out: number[] = [];
  for (const level of demoFloorLevels(height, floorToFloor)) {
    for (const y of [level - band, level]) {
      if (y > 1e-6 && y < height - 1e-6) out.push(round(y));
    }
  }
  return dedupeSorted(out);
}

/**
 * How many equal columns a wall of `width` is divided into: whole modules nearest
 * {@link DEMO_MODULE_FT}, never fewer than two. A real facade is set out in whole
 * modules, so the count follows the wall rather than the wall being forced to a count —
 * which is also why a short chamfer ends up with fewer, not narrower, bays.
 */
export function demoColumnCount(width: number, module: number): number {
  if (!(width > 0) || !(module > 0)) return 1;
  return Math.max(2, Math.round(width / module));
}

/**
 * VERTICAL centerline offsets for one panel, measured from its left border (`seg.x0`) —
 * the form `panelDivisions` stores. Equal bays; the borders themselves are excluded.
 */
export function demoColumnOffsets(width: number, module: number): number[] {
  const n = demoColumnCount(width, module);
  const out: number[] = [];
  for (let k = 1; k < n; k++) out.push(round((width * k) / n));
  return out;
}

/**
 * The glazing type for a cell whose vertical span is `y0`…`y1`.
 *
 * SPANDREL where the cell sits inside a band under a slab (the opaque zone concealing the
 * slab edge and the floor build-up), VISION everywhere else. Decided from the cell's
 * MIDPOINT so it is independent of how the rows were subdivided.
 */
export function demoCellType(
  y0: number,
  y1: number,
  height: number,
  floorToFloor: number,
  band: number,
): "vision" | "spandrel" {
  const mid = (y0 + y1) / 2;
  for (const level of demoFloorLevels(height, floorToFloor)) {
    if (level <= 1e-6) continue; // no band below the ground line
    if (mid > level - band - 1e-6 && mid < level + 1e-6) return "spandrel";
  }
  return "vision";
}

// ---------------------------------------------------------------------------
// THE DRAWING ANIMATION
//
// The first step draws the footprint the way a user does: vertices placed one after
// another with a rubber band running to the cursor, the loop closing, and only THEN the
// curve handles pulled out of the south wall. Splitting the curve into its own beat is
// deliberate — it is a separate gesture in the Pen tool, and collapsing the two would
// show a curve appearing from nowhere.
// ---------------------------------------------------------------------------

/** Fraction of the draw animation spent placing vertices; the rest pulls the curve out. */
export const DEMO_DRAW_PLACE_FRACTION = 0.78;

/**
 * The perimeter as it looks `t` of the way (0 → 1) through the drawing animation.
 *
 * While placing, the result is an OPEN polyline of the vertices committed so far plus one
 * moving point running along the edge being drawn — exactly the state the Pen tool is in
 * mid-draw, so the renderer needs no special case. Handles are withheld until the loop
 * closes, then scaled in over the final beat.
 */
export function demoDrawFrame(p: Perimeter, t: number): Perimeter {
  const n = p.vertices.length;
  if (n < 2) return { vertices: [], closed: false };
  const clamped = Math.max(0, Math.min(1, t));

  if (clamped >= DEMO_DRAW_PLACE_FRACTION) {
    const u = (clamped - DEMO_DRAW_PLACE_FRACTION) / (1 - DEMO_DRAW_PLACE_FRACTION);
    return scaleHandles(p, Math.max(0, Math.min(1, u)));
  }

  // n edges around a closed loop (the last one runs from the final vertex back to the
  // first), so the placing beat is divided into n equal spans.
  const progress = (clamped / DEMO_DRAW_PLACE_FRACTION) * n;
  const placed = Math.min(n - 1, Math.floor(progress));
  const frac = Math.max(0, Math.min(1, progress - placed));

  const vertices: Vertex[] = [];
  for (let i = 0; i <= placed; i++) vertices.push({ x: p.vertices[i].x, y: p.vertices[i].y });

  // The moving point: along the edge leaving the last placed vertex, toward the next one
  // (or back to the first on the closing edge).
  const from = p.vertices[placed];
  const to = p.vertices[(placed + 1) % n];
  vertices.push({ x: lerp(from.x, to.x, frac), y: lerp(from.y, to.y, frac) });

  return { vertices, closed: false };
}

/**
 * `p` with every curve handle scaled by `u` (0 = straight corners, 1 = the authored
 * curve). Used for the "pull the handles out" beat, and useful on its own for any
 * straighten/curve transition.
 */
export function scaleHandles(p: Perimeter, u: number): Perimeter {
  const k = Math.max(0, Math.min(1, u));
  return {
    closed: p.closed,
    vertices: p.vertices.map((v) => {
      const out: Vertex = { x: v.x, y: v.y };
      if (v.handleIn) out.handleIn = { x: v.handleIn.x * k, y: v.handleIn.y * k };
      if (v.handleOut) out.handleOut = { x: v.handleOut.x * k, y: v.handleOut.y * k };
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------
// THE SCRIPT
// ---------------------------------------------------------------------------

/** Which side of its target a step's card prefers. It flips when there is no room. */
export type TourPlacement = "top" | "bottom" | "left" | "right";

/** One card of the guided demo. The matching side effects live in PolylineTool. */
export interface TourStep {
  /** Stable key — PolylineTool switches on this to run the step's state changes. */
  id: string;
  /** Short heading. Names the move, not the button. */
  title: string;
  /** One or two sentences: what just happened on screen, and why a designer cares. */
  body: string;
  /**
   * `data-tour` value of the control this step is about — highlighted with a ring and
   * used to place the card. `null` centres the card and highlights nothing.
   */
  target: string | null;
  /** Preferred side of the target for the card. */
  prefer: TourPlacement;
}

/**
 * The demo, in order. Eleven cards, each kept to about two sentences: what is happening,
 * and — where the gesture is not guessable from the button — HOW to do it yourself. A tour
 * that only narrates leaves the user knowing a feature exists and not how to reach it, so
 * the interaction is named wherever it is a drag, a modifier, or a two-part sequence.
 *
 * Each card waits for Next; the animation plays behind it, but the tour never advances on
 * its own.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "footprint",
    title: "Draw the footprint",
    body:
      "Click to place each vertex — and drag as you place one to pull out a curve handle, which is what bows the south wall. Everything downstream derives from this outline.",
    target: "pen",
    prefer: "top",
  },
  {
    id: "site",
    title: "Put it on a real site",
    body:
      "Type an address and press Enter: it resolves offline to a latitude, time zone and elevation. Drag the dome to set the building's true north — the sun path is Manhattan's.",
    target: "solar",
    prefer: "bottom",
  },
  {
    id: "elevations",
    title: "Unroll the walls",
    body:
      "Every wall laid flat in plan order, each keeping its true length — the curved one unrolls to its arc length. This strip is where the facade gets designed.",
    target: "phase-elevations",
    prefer: "bottom",
  },
  {
    id: "floors",
    title: "Set the levels",
    body:
      "Click to drop a level line at the cursor's height; click an existing one to remove it. These are the datum the grid and the spandrel bands are set out from.",
    target: "floorlines",
    prefer: "top",
  },
  {
    id: "cwtype",
    title: "Choose the system",
    body:
      "Click a wall border first, then pick Stick or Unitized — they are framed and priced differently, and the choice changes what the Framing tool does.",
    target: "cwtype",
    // LEFT, not above: this button's chooser drops UP, and the menu is left-aligned to the
    // button — so a card placed to its left is guaranteed to clear the menu by the gap,
    // where a card above it would sit right on top of the thing being demonstrated.
    prefer: "left",
  },
  {
    id: "centerlines",
    title: "Divide the wall",
    body:
      "Drag inside the border — where the cursor sits picks both the spacing and the direction: across the middle for columns, toward an edge for rows. Whole 10 ft modules here.",
    target: "centerlines",
    prefer: "top",
  },
  {
    id: "framing",
    title: "Give it framing",
    body:
      "Drag a centerline sideways to set the mullion face offset, and every parallel line follows — 2.5 in here. Glass is then measured from the framed opening, not the grid line.",
    target: "framing",
    prefer: "top",
  },
  {
    id: "glazing",
    title: "Paint the glass",
    body:
      "Pick a material first, then click a cell — or drag across a run of them and release. Vision between floors, spandrel under each slab.",
    target: "glazing",
    prefer: "left", // same reason as CW Type — the material chooser drops up from here
  },
  {
    id: "viewmodes",
    title: "Change what you see",
    body:
      "Technical, Material ID, Orientation, Clean, Shadows — pick one, or scroll the wheel over the list to cycle. Only the reading changes; the drawing underneath is untouched.",
    target: "viewmode",
    prefer: "right",
  },
  {
    id: "statistics",
    title: "Read the building",
    body:
      "Areas, window-to-wall ratio and cost, all live off the drawing. Click a chip to add or drop a reading; the red glow marks which wall the per-wall figures are about.",
    target: "stats",
    prefer: "left",
  },
  {
    id: "export",
    title: "Hand the walls off",
    body:
      "Drag a box over the walls you want and release — they highlight green and this dialog opens. Drag to orbit; the three buttons write a DXF at true size.",
    target: "export",
    // LEFT: the dialog it is describing is centred in the stage, so anything on that side
    // would cover the very thing the card is pointing at.
    prefer: "left",
  },
  {
    id: "done",
    title: "That is the loop",
    body:
      "Draw, unroll, detail, measure — then change your mind and watch it follow. This is saved to your projects; press ? any time for the full control list.",
    target: null,
    prefer: "bottom",
  },
];

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Round to 1/1000 ft so derived offsets stay clean in the saved document. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function dedupeSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1e-6) out.push(v);
  return out;
}
