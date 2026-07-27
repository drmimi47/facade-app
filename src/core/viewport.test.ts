/**
 * viewport.test.ts — the model↔screen mapping every click, drag, and label depends on.
 *
 * The tests are mostly ROUND TRIPS (model → screen → model) and INVARIANTS (the point
 * under the cursor stays under the cursor while zooming), because those are the
 * properties users actually feel. A scale factor that is subtly wrong still draws a
 * picture; a broken round trip means clicks land somewhere other than where you clicked.
 */
import { describe, it, expect } from "vitest";
import {
  defaultViewport,
  toScreen,
  toModel,
  pixelsToModel,
  zoomAt,
  pan,
  easeInOut,
  easeOut,
  shortestAngleDelta,
  fitViewport,
} from "./viewport";
import type { Perimeter } from "./geometry";

const vp = () => defaultViewport(800, 600);

describe("toScreen / toModel", () => {
  it("round-trips an arbitrary model point", () => {
    const v = vp();
    for (const p of [{ x: 0, y: 0 }, { x: 12.5, y: -40 }, { x: -333, y: 91.25 }]) {
      const back = toModel(v, toScreen(v, p).x, toScreen(v, p).y);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it("flips the Y axis — model +Y is UP, screen +Y is DOWN", () => {
    const v = vp();
    const low = toScreen(v, { x: 0, y: 0 });
    const high = toScreen(v, { x: 0, y: 100 });
    expect(high.y).toBeLessThan(low.y);
  });

  it("does not flip X", () => {
    const v = vp();
    expect(toScreen(v, { x: 100, y: 0 }).x).toBeGreaterThan(toScreen(v, { x: 0, y: 0 }).x);
  });
});

describe("pixelsToModel", () => {
  it("converts by the current scale", () => {
    const v = { ...vp(), scale: 4 };
    expect(pixelsToModel(v, 8)).toBeCloseTo(2, 12);
  });

  it("shrinks as you zoom in", () => {
    const out = pixelsToModel({ ...vp(), scale: 1 }, 10);
    const inn = pixelsToModel({ ...vp(), scale: 10 }, 10);
    expect(inn).toBeLessThan(out);
  });
});

describe("zoomAt", () => {
  it("keeps the anchor point pinned under the cursor", () => {
    // The defining property of cursor-anchored zoom: whatever model point sits under the
    // pointer must still sit there afterwards, at any factor.
    const v = vp();
    const [ax, ay] = [321, 187];
    const before = toModel(v, ax, ay);
    for (const factor of [1.25, 0.5, 3]) {
      const after = toModel(zoomAt(v, ax, ay, factor), ax, ay);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
    }
  });

  it("scales by the factor", () => {
    const v = vp();
    expect(zoomAt(v, 400, 300, 2).scale).toBeCloseTo(v.scale * 2, 9);
  });

  it("does not mutate the input", () => {
    const v = vp();
    const snapshot = { ...v };
    zoomAt(v, 100, 100, 2);
    expect(v).toEqual(snapshot);
  });
});

describe("pan", () => {
  it("moves the view by exactly the screen delta", () => {
    const v = vp();
    const moved = pan(v, 25, -10);
    const a = toScreen(v, { x: 0, y: 0 });
    const b = toScreen(moved, { x: 0, y: 0 });
    expect(b.x - a.x).toBeCloseTo(25, 9);
    expect(b.y - a.y).toBeCloseTo(-10, 9);
  });

  it("leaves the scale alone", () => {
    const v = vp();
    expect(pan(v, 100, 100).scale).toBe(v.scale);
  });
});

describe("easing", () => {
  it("pins both ends", () => {
    expect(easeInOut(0)).toBeCloseTo(0, 12);
    expect(easeInOut(1)).toBeCloseTo(1, 12);
    expect(easeOut(0)).toBeCloseTo(0, 12);
    expect(easeOut(1)).toBeCloseTo(1, 12);
  });

  it("is monotonic across the interval", () => {
    let prevIn = -Infinity;
    let prevOut = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const a = easeInOut(t);
      const b = easeOut(t);
      expect(a).toBeGreaterThanOrEqual(prevIn - 1e-12);
      expect(b).toBeGreaterThanOrEqual(prevOut - 1e-12);
      prevIn = a;
      prevOut = b;
    }
  });

  it("easeOut leads easeInOut in the first half (it starts fast)", () => {
    expect(easeOut(0.25)).toBeGreaterThan(easeInOut(0.25));
  });
});

describe("shortestAngleDelta", () => {
  const TAU = Math.PI * 2;

  it("takes the short way round rather than the long way", () => {
    // 350° → 10° is +20°, not −340°.
    const d = shortestAngleDelta(350 * (Math.PI / 180), 10 * (Math.PI / 180));
    expect(d).toBeCloseTo(20 * (Math.PI / 180), 9);
  });

  it("always lands in [-π, π]", () => {
    for (let a = -8; a <= 8; a += 0.37) {
      for (let b = -8; b <= 8; b += 0.53) {
        const d = shortestAngleDelta(a, b);
        expect(d).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
        expect(d).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });

  it("actually reaches the target angle (mod 2π)", () => {
    const from = 5.9;
    const to = 0.2;
    const landed = from + shortestAngleDelta(from, to);
    expect(((landed - to) % TAU + TAU) % TAU).toBeCloseTo(0, 9);
  });
});

describe("fitViewport", () => {
  // It takes a PERIMETER (not a bounds rect) and frames its flattened outline.
  const box = (minX: number, maxX: number, minY: number, maxY: number): Perimeter => ({
    vertices: [
      { x: minX, y: minY },
      { x: minX, y: maxY },
      { x: maxX, y: maxY },
      { x: maxX, y: minY },
    ],
    closed: true,
  });

  it("frames the shape inside the canvas", () => {
    const v = fitViewport(box(0, 100, 0, 50), 800, 600, 20);
    for (const p of [toScreen(v, { x: 0, y: 0 }), toScreen(v, { x: 100, y: 50 })]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it("respects the margin — the shape never touches the canvas edge", () => {
    const margin = 20;
    const v = fitViewport(box(0, 100, 0, 50), 800, 600, margin);
    const a = toScreen(v, { x: 0, y: 0 });
    const b = toScreen(v, { x: 100, y: 50 });
    expect(Math.min(a.x, b.x)).toBeGreaterThanOrEqual(margin - 1e-6);
    expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(800 - margin + 1e-6);
  });

  it("centres the shape", () => {
    const v = fitViewport(box(-30, 70, 10, 60), 800, 600, 20);
    const mid = toScreen(v, { x: 20, y: 35 }); // centre of those bounds
    expect(mid.x).toBeCloseTo(400, 6);
    expect(mid.y).toBeCloseTo(300, 6);
  });

  it("uses one uniform scale for both axes (no distortion)", () => {
    const v = fitViewport(box(0, 200, 0, 10), 800, 600, 20);
    const dx = toScreen(v, { x: 10, y: 0 }).x - toScreen(v, { x: 0, y: 0 }).x;
    const dy = toScreen(v, { x: 0, y: 0 }).y - toScreen(v, { x: 0, y: 10 }).y;
    expect(dx).toBeCloseTo(dy, 9);
  });

  it("falls back to a centred default for an empty perimeter", () => {
    const v = fitViewport({ vertices: [], closed: false }, 800, 600, 20);
    expect(v.originX).toBe(400);
    expect(v.originY).toBe(300);
  });

  // The canvas fills the window and the floating panels are drawn ON TOP of it, so its
  // pixel width is not its VISIBLE width. Fitting to the full width frames content whose
  // left and right ends then sit underneath those panels — right by the arithmetic, wrong
  // on screen. These pin the fix.
  describe("insets (the region the panels leave visible)", () => {
    const shape = () => box(0, 100, 0, 50);
    // A deliberately ASYMMETRIC layout: a wide window one side, a narrow one the other.
    // A symmetric case would pass even if the centring still used the canvas centre.
    const insets = { left: 260, right: 140 };

    it("keeps the shape clear of BOTH panels", () => {
      const v = fitViewport(shape(), 800, 600, 20, undefined, 1, insets);
      const a = toScreen(v, { x: 0, y: 0 });
      const b = toScreen(v, { x: 100, y: 50 });
      expect(Math.min(a.x, b.x)).toBeGreaterThanOrEqual(insets.left + 20 - 1e-6);
      expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(800 - insets.right - 20 + 1e-6);
    });

    it("centres on the VISIBLE region, not the canvas", () => {
      const v = fitViewport(shape(), 800, 600, 20, undefined, 1, insets);
      const mid = toScreen(v, { x: 50, y: 25 });
      expect(mid.x).toBeCloseTo(260 + (800 - 260 - 140) / 2, 6); // 460, not 400
    });

    it("zooms OUT relative to the full-canvas fit — less room means a smaller scale", () => {
      const full = fitViewport(shape(), 800, 600, 20);
      const inset = fitViewport(shape(), 800, 600, 20, undefined, 1, insets);
      expect(inset.scale).toBeLessThan(full.scale);
    });

    it("scales with the CONTENT — a shorter wall still frames to the same region", () => {
      // Two walls of different length must each end up spanning the same visible width,
      // which is what makes the framing feel consistent from one border to the next.
      const wide = fitViewport(box(0, 200, 0, 50), 800, 600, 20, undefined, 1, insets);
      const narrow = fitViewport(box(0, 50, 0, 50), 800, 600, 20, undefined, 1, insets);
      const widthOf = (v: ReturnType<typeof fitViewport>, span: number) =>
        toScreen(v, { x: span, y: 0 }).x - toScreen(v, { x: 0, y: 0 }).x;
      expect(widthOf(narrow, 50)).toBeCloseTo(widthOf(wide, 200), 6);
      expect(narrow.scale).toBeGreaterThan(wide.scale); // the short wall zooms in further
    });

    it("handles top / bottom insets the same way", () => {
      const v = fitViewport(shape(), 800, 600, 0, undefined, 1, { top: 100, bottom: 40 });
      const mid = toScreen(v, { x: 50, y: 25 });
      expect(mid.y).toBeCloseTo(100 + (600 - 100 - 40) / 2, 6);
    });

    it("is unchanged from the old behaviour when no insets are given", () => {
      const before = fitViewport(shape(), 800, 600, 20);
      const after = fitViewport(shape(), 800, 600, 20, undefined, 1, {});
      expect(after).toEqual(before);
    });

    it("survives panels wider than the canvas rather than producing NaN", () => {
      const v = fitViewport(shape(), 400, 600, 20, undefined, 1, { left: 300, right: 300 });
      expect(Number.isFinite(v.scale)).toBe(true);
      expect(Number.isFinite(v.originX)).toBe(true);
      expect(v.scale).toBeGreaterThan(0);
    });
  });
});
