/**
 * core/perimeterTransform.ts
 *
 * Treating the drawn perimeter as ONE OBJECT: its bounding box, and the move / scale
 * operations the Select tool performs on the whole shape at once.
 *
 * This is the geometric counterpart of core/referenceImage's transform helpers, and it
 * deliberately borrows their vocabulary — the same eight {@link HandleKey} grips, the same
 * "drag a grip, the opposite one stays pinned" rule, the same Shift-to-free-stretch
 * override on corners. A user who has moved an underlay already knows how to move a
 * building, and vice versa.
 *
 * Everything here is PURE and immutable: `perimeter` goes in, a new `Perimeter` comes out.
 * That matters because undo/redo snapshots the document by reference — an in-place edit
 * would rewrite history (see perimeterOps.test.ts, which pins the same property).
 *
 * BOUNDS ARE CURVE-ACCURATE. They come from the flattened outline, not the raw vertices,
 * so a segment that bulges past its endpoints is inside the box that is drawn around it.
 */
import { flattenPerimeter, type Perimeter, type Point, type Vertex } from "./geometry";
import { isCornerHandle, type HandleKey } from "./referenceImage";

/** A model-space axis-aligned box. `y1` is the TOP edge (model +Y is up). */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Smallest extent (model units) a scale drag may shrink the shape to. A perimeter that
 * collapsed to zero on one axis could never be grabbed again, and its scale factor would
 * be undefined on the way back out.
 */
const MIN_EXTENT = 1e-3;

/**
 * Model-space bounds of the whole shape, or null when there is nothing to bound.
 * Measured on the FLATTENED outline so curves are enclosed, not just their anchors.
 */
export function perimeterBounds(p: Perimeter): Bounds | null {
  const pts = flattenPerimeter(p);
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of pts) {
    if (q.x < x0) x0 = q.x;
    if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

/** A grip's anchor point on a bounds box (+Y up, so "n" is the top edge). */
export function boundsHandlePoint(b: Bounds, k: HandleKey): Point {
  const midX = (b.x0 + b.x1) / 2;
  const midY = (b.y0 + b.y1) / 2;
  switch (k) {
    case "nw": return { x: b.x0, y: b.y1 };
    case "n": return { x: midX, y: b.y1 };
    case "ne": return { x: b.x1, y: b.y1 };
    case "e": return { x: b.x1, y: midY };
    case "se": return { x: b.x1, y: b.y0 };
    case "s": return { x: midX, y: b.y0 };
    case "sw": return { x: b.x0, y: b.y0 };
    case "w": return { x: b.x0, y: midY };
  }
}

/**
 * MOVE the whole shape by a model-space delta.
 *
 * Handles are stored as offsets RELATIVE to their vertex, so a translation leaves them
 * untouched — the curves travel with the shape unchanged, which is the whole point of
 * storing them that way.
 */
export function translatePerimeter(p: Perimeter, dx: number, dy: number): Perimeter {
  if (dx === 0 && dy === 0) return p;
  return {
    ...p,
    vertices: p.vertices.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
  };
}

/**
 * SCALE the whole shape so that grip `k` lands on model point `to`, holding the opposite
 * corner / edge pinned.
 *
 * `from` is the bounds the drag STARTED from, not the live ones: scaling off the live box
 * would compound each frame's rounding into visible drift over a long drag.
 *
 * `preserveAspect` governs CORNER drags — on by default, since a building squashed on one
 * axis is nearly always a slip rather than an intent, with Shift as the deliberate
 * override. Edge grips always scale their single axis; that IS their purpose.
 *
 * Handle offsets scale by the same factors as the positions, so a curved wall keeps its
 * curvature proportionally instead of flattening out as the shape grows.
 */
export function scalePerimeter(
  p: Perimeter,
  from: Bounds,
  k: HandleKey,
  to: Point,
  preserveAspect: boolean,
): Perimeter {
  const w = from.x1 - from.x0;
  const h = from.y1 - from.y0;
  if (w <= 0 || h <= 0) return p;

  // Which edges this grip moves — and therefore which stay pinned.
  const movesLeft = k === "nw" || k === "w" || k === "sw";
  const movesRight = k === "ne" || k === "e" || k === "se";
  const movesTop = k === "nw" || k === "n" || k === "ne";
  const movesBottom = k === "sw" || k === "s" || k === "se";

  let nx0 = from.x0;
  let nx1 = from.x1;
  let ny0 = from.y0;
  let ny1 = from.y1;

  if (movesLeft) nx0 = Math.min(to.x, from.x1 - MIN_EXTENT);
  else if (movesRight) nx1 = Math.max(to.x, from.x0 + MIN_EXTENT);

  if (movesBottom) ny0 = Math.min(to.y, from.y1 - MIN_EXTENT);
  else if (movesTop) ny1 = Math.max(to.y, from.y0 + MIN_EXTENT);

  let sx = (nx1 - nx0) / w;
  let sy = (ny1 - ny0) / h;

  if (preserveAspect && isCornerHandle(k)) {
    // Drive both axes from whichever the pointer moved PROPORTIONALLY further, so the
    // shape tracks the cursor diagonally rather than snapping to one axis.
    const s = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
    sx = s;
    sy = s;
    if (movesLeft) nx0 = from.x1 - w * sx;
    else nx1 = from.x0 + w * sx;
    if (movesBottom) ny0 = from.y1 - h * sy;
    else ny1 = from.y0 + h * sy;
  }

  // The pinned corner: whichever edges this grip does NOT move.
  const ax = movesLeft ? from.x1 : from.x0;
  const ay = movesBottom ? from.y1 : from.y0;
  const nax = movesLeft ? nx1 : nx0;
  const nay = movesBottom ? ny1 : ny0;

  const scalePoint = (q: Point): Point => ({
    x: nax + (q.x - ax) * sx,
    y: nay + (q.y - ay) * sy,
  });
  // Offsets are deltas, so they take the scale but NOT the anchor translation.
  const scaleOffset = (o: Point | undefined): Point | undefined =>
    o ? { x: o.x * sx, y: o.y * sy } : undefined;

  const vertices: Vertex[] = p.vertices.map((v) => {
    const moved = scalePoint(v);
    const next: Vertex = { ...v, x: moved.x, y: moved.y };
    const hIn = scaleOffset(v.handleIn);
    const hOut = scaleOffset(v.handleOut);
    if (hIn) next.handleIn = hIn;
    if (hOut) next.handleOut = hOut;
    return next;
  });
  return { ...p, vertices };
}

/**
 * Is a model point ON the shape as an object? True inside a CLOSED outline (so the whole
 * footprint is grabbable, the way a filled object is), or within `tolerance` of any
 * segment otherwise — an open path has no inside to click.
 *
 * Uses the flattened outline, so it agrees with what is drawn, curves included.
 */
export function hitPerimeterBody(p: Perimeter, point: Point, tolerance: number): boolean {
  const pts = flattenPerimeter(p);
  if (pts.length < 2) return false;

  if (p.closed && pts.length >= 4) {
    // Ray casting: count crossings of a ray heading +X from the point. `pts` ends with a
    // repeat of the first point, so iterate the unique ones.
    const n = pts.length - 1;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = pts[i];
      const b = pts[j];
      const straddles = a.y > point.y !== b.y > point.y;
      if (straddles && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    if (inside) return true;
  }

  // Near the outline itself — the only way to grab an open path, and a forgiving edge
  // for a closed one.
  for (let i = 0; i < pts.length - 1; i++) {
    if (distanceToSegment(point, pts[i], pts[i + 1]) <= tolerance) return true;
  }
  return false;
}

/** Shortest distance from `p` to the segment a→b. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Which grip (if any) a model point is within `tolerance` of. Corners win over edges. */
export function hitBoundsHandle(b: Bounds, point: Point, tolerance: number): HandleKey | null {
  const order: HandleKey[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];
  for (const k of order) {
    const h = boundsHandlePoint(b, k);
    if (Math.abs(point.x - h.x) <= tolerance && Math.abs(point.y - h.y) <= tolerance) return k;
  }
  return null;
}
