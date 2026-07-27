/**
 * core/unrollAnim.ts
 *
 * The UNROLL TRANSITION: the animation played when the user enters the elevation
 * views from the Building Perimeter tab. Instead of cutting straight to the flat
 * strip, the footprint stands up as the 3D massing, the walls straighten out of
 * their folded plan positions onto one baseline, and the camera settles head-on —
 * at which point the frame IS the 2D elevations view and the app hands over to it.
 *
 * WHY it exists: the unravel layout is not obvious from the result alone. Seeing
 * which wall came from where, and in what order, is the whole point of unrolling a
 * facade, and a static jump throws that information away. This is a legibility
 * device, not decoration — so it is SHORT, SKIPPABLE (any click / key / wheel), and
 * its end state is exactly the state a straight jump would have produced.
 *
 * GEOMETRY — a linkage that straightens. The perimeter is flattened into a chain of
 * short links (curves included, so a curved wall unrolls to its true ARC length,
 * matching core/unravel.ts). Each link's direction angle is CONTINUOUSLY UNWRAPPED
 * along the chain — accumulating the real turning rather than wrapping at ±180° —
 * and then driven to zero. Walking the chain with those interpolated angles gives
 * the classic "unrolling" motion (the loop peels open like a carpet) while every
 * link keeps its exact length at every instant. At the end all angles are 0, so the
 * chain lies on the X axis, and per-panel gaps have opened: precisely the layout
 * `unravelPerimeter` computes.
 *
 * FRAMING — the two endpoints of the tween are real Viewports, and the projection is
 * orthographic, which makes both hand-offs exact:
 *   t=0  camera looks straight DOWN (plan) => projected (x, y) == the model's own
 *        (x, y), so the first frame sits exactly on the 2D footprint the user was
 *        just looking at, in their current pan/zoom.
 *   t=1  camera looks head-on (elevation) => projected (x, z) == the elevation
 *        view's (x, height), so the last frame sits exactly on the 2D strip at the
 *        fit-to-bounds viewport the caller then commits.
 * In between, the viewport is interpolated with the SAME `lerpViewport` the app's
 * other camera moves use, plus a slight mid-flight dolly-out so the shape never
 * clips while it is wider than either endpoint.
 *
 * All colours/widths come from CSS tokens (styles.css) — the wall paint blends from
 * the perimeter tokens, through the 3D massing tokens, to the elevation-panel tokens,
 * so neither hand-off pops. Only motion CHOREOGRAPHY (the timeline splits below)
 * lives here as code; the tunable duration/dolly are CSS tokens too.
 */

import type { Perimeter, Point } from "./geometry";
import { flattenPerimeter } from "./geometry";
import {
  DEFAULT_CAMERA,
  PLAN_CAMERA,
  buildEdgeMap,
  mixColor,
  parseColor,
  project,
  type Camera,
  type Face,
  type Projected,
  type RGBA,
  type Vec3,
} from "./extrude3d";
import { isCounterClockwise } from "./unravel";
import { easeInOut, lerpViewport, toScreen, zoomAt, type Viewport } from "./viewport";

// ---------------------------------------------------------------------------
// TIMELINE (choreography, in normalized time 0 → 1)
//
// The transition tells a three-beat story: the plan STANDS UP, the walls UNROLL,
// the strip FACES the viewer. These constants are where those beats overlap; they
// deliberately cross-fade rather than run end-to-end so nothing ever sits still.
// ---------------------------------------------------------------------------

/** When the camera has finished tilting up out of plan into the 3/4 massing view. */
const T_PIVOT = 0.32;
/** Window over which the walls straighten onto the baseline. */
const T_UNROLL_IN = 0.28;
const T_UNROLL_OUT = 0.92;
/** Window over which the per-panel gaps open (late: the chain is near-straight by then). */
const T_GAP_IN = 0.62;
const T_GAP_OUT = 1;
/** Window over which the paint crosses from the 2D perimeter look to the 3D massing look. */
const T_PAINT_3D = 0.3;
/** Window over which the paint crosses from the 3D massing look to the elevation-panel look. */
const T_PAINT_FLAT_IN = 0.78;
/** Window over which the footprint's floor fill fades away (before any unrolling starts). */
const T_GROUND_OUT = 0.22;

/** Fallback duration (ms) when `--unroll-duration-ms` is absent. */
const DEFAULT_DURATION_MS = 1150;
/** Fallback mid-flight dolly-out (fraction of scale) when `--unroll-dolly` is absent. */
const DEFAULT_DOLLY = 0.12;

/** Map raw time onto a sub-window [`a`,`b`], eased, clamped to 0…1 outside it. */
function segment(t: number, a: number, b: number): number {
  if (b <= a) return t >= b ? 1 : 0;
  return easeInOut(Math.max(0, Math.min(1, (t - a) / (b - a))));
}

/** Scalar lerp. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A parsed colour back to a CSS string (the no-blend counterpart to mixColor). */
function toCss(c: RGBA): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`;
}

// ---------------------------------------------------------------------------
// CHAIN: the perimeter as a straightenable linkage.
// ---------------------------------------------------------------------------

/** One flattened link of the outline — a straight piece of wall that keeps its length. */
interface UnrollLink {
  /** Originating perimeter edge (== `UnravelSegment.index`) — resolves height + gap. */
  edge: number;
  /** Preserved length of this link (model units). */
  length: number;
  /** UNWRAPPED direction angle (radians) in the folded state; driven to 0 when unrolled. */
  angle: number;
  /** How many panel gaps precede this link's edge in the unravel order (0 for the first). */
  gapOrdinal: number;
}

/** A perimeter prepared for the unroll transition. Pure data — build once per run. */
export interface UnrollChain {
  links: UnrollLink[];
  /**
   * How many panels the chain unrolls into. MUST equal the elevation layout's
   * segment count — the transition hands off to that layout, so a caller should
   * verify the two agree and fall back to entering the view directly if they ever
   * diverge (see the guard in PolylineTool's startUnroll).
   */
  panels: number;
  /** Model position the chain starts from while FOLDED (a point on the footprint). */
  start: Point;
  /** Model position the chain starts from once UNROLLED (the strip's left end, y = 0). */
  target: Point;
  /** Gap between panels (model units) — matches the gap the unravel layout uses. */
  gap: number;
  /** Whether the source outline is a closed loop (drives the floor-fill flourish). */
  closed: boolean;
}

/**
 * Prepare `p` for unrolling with the same `gap` the elevation layout uses.
 *
 * The outline is flattened, then read in the SAME direction `unravelPerimeter`
 * reads its edges (clockwise — reversed when the sketch winds counter-clockwise),
 * so link k of this chain belongs to panel k of the resulting strip. Returns null
 * for anything too small to unroll (< 2 links).
 */
export function buildUnrollChain(p: Perimeter, gap: number): UnrollChain | null {
  const pts = flattenPerimeter(p);
  if (pts.length < 2) return null;
  const edgeOf = buildEdgeMap(p, pts.length);

  // Read the outline in unravel order. Reversing the point list reverses BOTH the
  // edge order and each edge's own sub-links, which is exactly the edge reversal
  // `unravelPerimeter` applies for a counter-clockwise sketch.
  const reversed = p.closed && p.vertices.length >= 3 && isCounterClockwise(p);
  const n = pts.length - 1; // link count
  const ordered: { edge: number; length: number; raw: number }[] = [];
  for (let k = 0; k < n; k++) {
    const i = reversed ? n - 1 - k : k;
    const a = reversed ? pts[i + 1] : pts[i];
    const b = reversed ? pts[i] : pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    ordered.push({ edge: edgeOf[i], length: Math.hypot(dx, dy), raw: Math.atan2(dy, dx) });
  }

  // Unwrap the direction angles along the chain so the turning ACCUMULATES (a closed
  // loop winds through a full ±360°). Without this the angles wrap at ±180° and the
  // straightening would snap instead of peeling open.
  const links: UnrollLink[] = [];
  let angle = ordered[0].raw;
  let gapOrdinal = -1;
  let lastEdge = -1;
  for (let k = 0; k < ordered.length; k++) {
    const o = ordered[k];
    if (k > 0) {
      let d = (o.raw - angle) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      angle += d;
    }
    if (o.edge !== lastEdge) {
      gapOrdinal++;
      lastEdge = o.edge;
    }
    links.push({ edge: o.edge, length: o.length, angle, gapOrdinal });
  }

  // Where the unrolled strip starts: `unravelPerimeter` centres the whole run
  // (walls + gaps) on the origin, so the first panel's left border sits at
  // -totalWidth / 2 on the baseline.
  const totalLength = links.reduce((s, l) => s + l.length, 0);
  const g = Math.max(0, gap);
  const totalWidth = totalLength + g * gapOrdinal;
  const start = reversed ? pts[pts.length - 1] : pts[0];

  return {
    links,
    panels: gapOrdinal + 1,
    start: { x: start.x, y: start.y },
    target: { x: -totalWidth / 2, y: 0 },
    gap: g,
    closed: !!p.closed,
  };
}

/** The massing at one instant of the unroll: wall quads plus the footprint floor ring. */
interface UnrollGeometry {
  faces: Face[];
  /** The chain's ground polyline (z = 0) — filled early as the footprint's floor. */
  ground: Vec3[];
}

/**
 * Walk the chain with its angles driven `u` of the way to zero, emitting one wall
 * quad per link. `gapT` slides each panel along +X by its share of the gap, so the
 * strip separates into panels; at `u = gapT = 1` the result is the exact elevation
 * layout. Heights come from `heightOf(edge)` — the same per-panel heights the
 * elevation view draws.
 */
function unrollGeometry(
  chain: UnrollChain,
  u: number,
  gapT: number,
  heightOf: (edge: number) => number,
): UnrollGeometry {
  const faces: Face[] = [];
  const ground: Vec3[] = [];
  let x = lerp(chain.start.x, chain.target.x, u);
  let y = lerp(chain.start.y, chain.target.y, u);
  ground.push({ x, y, z: 0 });

  for (const link of chain.links) {
    const a = link.angle * (1 - u);
    const nx = x + Math.cos(a) * link.length;
    const ny = y + Math.sin(a) * link.length;
    // Panel separation: every link of an edge shares the offset, so an edge (curve
    // included) stays whole while neighbouring panels part.
    const off = chain.gap * link.gapOrdinal * gapT;
    const z = Math.max(heightOf(link.edge), 0);
    faces.push({
      edge: link.edge,
      pts: [
        { x: x + off, y, z: 0 },
        { x: nx + off, y: ny, z: 0 },
        { x: nx + off, y: ny, z },
        { x: x + off, y, z },
      ],
    });
    ground.push({ x: nx, y: ny, z: 0 });
    x = nx;
    y = ny;
  }
  return { faces, ground };
}

/**
 * The camera at time `t`: straight down (plan, matching the 2D footprint view), up
 * and around into the 3/4 massing view, then round to head-on (matching the 2D
 * elevation view). Both ends are exact, which is what makes the hand-offs seamless.
 */
function unrollCamera(t: number): Camera {
  if (t <= T_PIVOT) {
    const s = segment(t, 0, T_PIVOT);
    return {
      azimuth: lerp(PLAN_CAMERA.azimuth, DEFAULT_CAMERA.azimuth, s),
      elevation: lerp(PLAN_CAMERA.elevation, DEFAULT_CAMERA.elevation, s),
    };
  }
  const s = segment(t, T_PIVOT, 1);
  return {
    azimuth: lerp(DEFAULT_CAMERA.azimuth, 0, s),
    elevation: lerp(DEFAULT_CAMERA.elevation, 0, s),
  };
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

/** Read a CSS custom property from an element, with a fallback. (Mirror renderer.ts.) */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

function cssNum(el: HTMLElement, name: string, fallback: number): number {
  const value = parseFloat(cssVar(el, name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

/** How long the transition runs (ms), from `--unroll-duration-ms`. */
export function unrollDurationMs(canvas: HTMLCanvasElement | null): number {
  if (!canvas) return DEFAULT_DURATION_MS;
  return Math.max(0, cssNum(canvas, "--unroll-duration-ms", DEFAULT_DURATION_MS));
}

/** Everything one frame of the transition needs. Held by the caller across the run. */
export interface UnrollFrame {
  chain: UnrollChain;
  /** Raw normalized time, 0 → 1. */
  t: number;
  /** Per-panel wall height (model units) for an originating edge index. */
  heightOf: (edge: number) => number;
  /** Viewport at t = 0 — the user's live footprint view. */
  from: Viewport;
  /** Viewport at t = 1 — the fit-to-bounds framing of the finished strip. */
  to: Viewport;
}

/**
 * The viewport the transition frames with at time `t`: the straight tween between
 * the caller's two endpoints, pulled back slightly at mid-flight (the shape is
 * momentarily wider than either end while it peels open, and clipping it would hide
 * the very thing the animation is explaining). Exact at both ends.
 */
function frameViewport(f: UnrollFrame, width: number, height: number, dolly: number): Viewport {
  const base = lerpViewport(f.from, f.to, easeInOut(f.t), width, height);
  const pull = 1 - dolly * Math.sin(Math.PI * f.t);
  if (pull >= 1) return base;
  return zoomAt(base, width / 2, height / 2, pull);
}

/**
 * Paint one frame of the unroll transition, replacing the normal 2D scene for the
 * duration of the run. Same contract as `render`/`render3d`: clears in device
 * pixels, resolves colours from CSS tokens on the canvas, then paints.
 *
 * Faces are depth-sorted back-to-front (painter's algorithm) exactly as the massing
 * thumbnails are, so walls occlude correctly while the model turns. Fog and the
 * floor fill both fade out on their own schedule, leaving a clean flat strip.
 */
export function renderUnrollFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  frame: UnrollFrame,
): void {
  const tk = {
    bg: cssVar(canvas, "--canvas-bg", "#ffffff"),
    // Start-of-transition paint: the closed footprint as the perimeter view drew it.
    planFill: cssVar(canvas, "--polygon-fill", "rgba(31,157,107,0.10)"),
    planStroke: cssVar(canvas, "--segment-closed-color", "#1f9d6b"),
    planW: cssNum(canvas, "--segment-width", 1.5),
    // Mid-transition paint: the 3D massing (shared with the mini-window thumbnails).
    wallFill: cssVar(canvas, "--m3d-wall-fill", "#cfd8e0"),
    wallStroke: cssVar(canvas, "--m3d-wall-stroke", "#7e8a96"),
    wallW: cssNum(canvas, "--m3d-edge-width", 1),
    fogColor: cssVar(canvas, "--m3d-fog-color", "#ffffff"),
    fogStrength: cssNum(canvas, "--m3d-fog-strength", 0.35),
    // End-of-transition paint: the elevation panels the 2D view takes over with.
    panelFill: cssVar(canvas, "--unravel-rect-fill", "rgba(31,111,235,0.10)"),
    panelStroke: cssVar(canvas, "--unravel-line-color", "#1f6feb"),
    dolly: cssNum(canvas, "--unroll-dolly", DEFAULT_DOLLY),
  };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = tk.bg;
  ctx.fillRect(0, 0, width, height);

  const t = Math.max(0, Math.min(1, frame.t));
  const cam = unrollCamera(t);
  const vp = frameViewport(frame, width, height, tk.dolly);
  const { faces, ground } = unrollGeometry(
    frame.chain,
    segment(t, T_UNROLL_IN, T_UNROLL_OUT),
    segment(t, T_GAP_IN, T_GAP_OUT),
    frame.heightOf,
  );
  if (faces.length === 0) return;

  /** Model 3D -> canvas px. Orthographic projection then the plain viewport mapping,
   *  so the frame lines up with the 2D views at both ends of the run. */
  const toPx = (q: Projected) => toScreen(vp, { x: q.x, y: q.y });

  // Wall paint crossfades 2D-perimeter -> 3D-massing -> 2D-panel so neither hand-off
  // pops. Parsed once per frame; the per-face loop below only does arithmetic.
  const paint3d = segment(t, 0, T_PAINT_3D);
  const paintFlat = segment(t, T_PAINT_FLAT_IN, 1);
  const blend = (a: RGBA, b: RGBA, c: RGBA): RGBA =>
    parseColor(mixColor(parseColor(mixColor(a, b, paint3d)), c, paintFlat));
  const fillRGBA = blend(parseColor(tk.planFill), parseColor(tk.wallFill), parseColor(tk.panelFill));
  const strokeRGBA = blend(parseColor(tk.planStroke), parseColor(tk.wallStroke), parseColor(tk.panelStroke));
  const fogRGBA = parseColor(tk.fogColor);
  const lineWidth = lerp(lerp(tk.planW, tk.wallW, paint3d), tk.planW, paintFlat);

  // FOOTPRINT FLOOR: the plan's filled polygon, held for the first beat so the shape
  // the user was looking at is still there as the walls stand up, then faded out
  // before any unrolling could distort it.
  const groundAlpha = 1 - segment(t, 0, T_GROUND_OUT);
  if (frame.chain.closed && groundAlpha > 0.001) {
    ctx.beginPath();
    ground.forEach((v, i) => {
      const c = toPx(project(v, cam));
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.globalAlpha = groundAlpha;
    ctx.fillStyle = tk.planFill;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Painter's algorithm: farthest faces first, so nearer walls paint over them.
  const ordered = faces
    .map((face) => {
      const proj = face.pts.map((p) => project(p, cam));
      return { proj, meanDepth: proj.reduce((s, q) => s + q.depth, 0) / proj.length };
    })
    .sort((a, b) => b.meanDepth - a.meanDepth);

  // Atmospheric fog (same depth cue as the thumbnails). It self-cancels at the end of
  // the run: head-on, every panel is the same distance away, so there is no depth span
  // left to fog and the strip lands perfectly flat.
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const pf of ordered) {
    if (pf.meanDepth < minDepth) minDepth = pf.meanDepth;
    if (pf.meanDepth > maxDepth) maxDepth = pf.meanDepth;
  }
  const depthSpan = maxDepth - minDepth;
  const canFog = tk.fogStrength > 0 && depthSpan > 1e-6;

  const flatFill = toCss(fillRGBA);
  const flatStroke = toCss(strokeRGBA);
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  for (const pf of ordered) {
    let fillStyle = flatFill;
    let strokeStyle = flatStroke;
    if (canFog) {
      const mix = ((pf.meanDepth - minDepth) / depthSpan) * tk.fogStrength;
      fillStyle = mixColor(fillRGBA, fogRGBA, mix);
      // Blend the stroke a touch less than the fill so the silhouette stays legible.
      strokeStyle = mixColor(strokeRGBA, fogRGBA, mix * 0.85);
    }
    ctx.beginPath();
    pf.proj.forEach((q, i) => {
      const c = toPx(q);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
  }
}
