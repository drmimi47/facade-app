/**
 * unravel.test.ts — the transform the whole elevation half of the app is built on:
 * a closed footprint becomes a flat strip of wall panels.
 *
 * The invariant that matters most is LENGTH PRESERVATION — every panel must be exactly as
 * wide as its wall was long, or every downstream area, WWR, and DXF export is wrong while
 * still looking correct on screen. The equal-column / equal-row builders are tested for
 * exact division because they drive both the live preview and the commit; if those two
 * ever disagreed, a placed split would land somewhere other than where it was shown.
 */
import { describe, it, expect } from "vitest";
import { unravelPerimeter, isCounterClockwise, buildEqualColumns, buildEqualRows } from "./unravel";
import type { Perimeter, Vertex } from "./geometry";

/** Closed rectangle wound CLOCKWISE in model space (+Y up). */
function rectCW(w: number, h: number): Perimeter {
  const vertices: Vertex[] = [
    { x: 0, y: 0 },
    { x: 0, y: h },
    { x: w, y: h },
    { x: w, y: 0 },
  ];
  return { vertices, closed: true };
}

const rectCCW = (w: number, h: number): Perimeter => ({
  vertices: [...rectCW(w, h).vertices].reverse(),
  closed: true,
});

describe("isCounterClockwise", () => {
  it("tells the two windings apart", () => {
    expect(isCounterClockwise(rectCW(10, 20))).toBe(false);
    expect(isCounterClockwise(rectCCW(10, 20))).toBe(true);
  });
});

describe("unravelPerimeter", () => {
  it("produces one segment per wall of a closed shape", () => {
    expect(unravelPerimeter(rectCW(10, 20), 5).segments).toHaveLength(4);
  });

  it("produces n-1 segments for an OPEN path", () => {
    const open: Perimeter = { vertices: rectCW(10, 20).vertices, closed: false };
    expect(unravelPerimeter(open, 5).segments).toHaveLength(3);
  });

  it("PRESERVES each wall's length as its panel width", () => {
    // 10×20 rectangle → walls of 20, 10, 20, 10 in some rotation.
    const { segments } = unravelPerimeter(rectCW(10, 20), 5);
    const widths = segments.map((s) => s.x1 - s.x0).sort((a, b) => a - b);
    expect(widths).toEqual([10, 10, 20, 20]);
  });

  it("reports totalLength as the true perimeter", () => {
    expect(unravelPerimeter(rectCW(10, 20), 5).totalLength).toBeCloseTo(60, 10);
  });

  it("spaces panels by exactly the gap", () => {
    const gap = 7;
    const { segments } = unravelPerimeter(rectCW(10, 20), gap);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].x0 - segments[i - 1].x1).toBeCloseTo(gap, 10);
    }
  });

  it("counts the gaps in totalWidth but not a trailing one", () => {
    const gap = 5;
    const { totalWidth, totalLength, segments } = unravelPerimeter(rectCW(10, 20), gap);
    expect(totalWidth).toBeCloseTo(totalLength + gap * (segments.length - 1), 10);
  });

  it("centres the strip on the origin", () => {
    const { segments, totalWidth } = unravelPerimeter(rectCW(10, 20), 5);
    const left = segments[0].x0;
    const right = segments[segments.length - 1].x1;
    expect(left).toBeCloseTo(-totalWidth / 2, 10);
    expect(right).toBeCloseTo(totalWidth / 2, 10);
    expect(left + right).toBeCloseTo(0, 10);
  });

  it("normalises a CCW shape to the same clockwise travel as a CW one", () => {
    // Winding is an authoring accident, so both are reported clockwise and both unroll
    // the same set of walls. The STARTING wall still differs — reversing a vertex list
    // also changes which edge is edge 0 — so the sequence is a rotation, not a match.
    const cw = unravelPerimeter(rectCW(10, 20), 5);
    const ccw = unravelPerimeter(rectCCW(10, 20), 5);
    expect(cw.clockwise).toBe(true);
    expect(ccw.clockwise).toBe(true);
    const widths = (r: typeof cw) => r.segments.map((s) => s.x1 - s.x0).sort((a, b) => a - b);
    expect(widths(ccw)).toEqual(widths(cw));
    expect(ccw.totalLength).toBeCloseTo(cw.totalLength, 10);
  });

  it("keeps each segment's originating edge index", () => {
    const { segments } = unravelPerimeter(rectCW(10, 20), 5);
    expect([...segments.map((s) => s.index)].sort()).toEqual([0, 1, 2, 3]);
  });

  it("returns an empty result for a degenerate perimeter", () => {
    const empty = unravelPerimeter({ vertices: [], closed: false }, 5);
    expect(empty.segments).toHaveLength(0);
    expect(empty.totalLength).toBe(0);
    expect(empty.totalWidth).toBe(0);
  });

  it("treats a negative gap as zero rather than overlapping panels", () => {
    const { segments } = unravelPerimeter(rectCW(10, 20), -50);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].x0).toBeCloseTo(segments[i - 1].x1, 10);
    }
  });
});

describe("buildEqualColumns", () => {
  it("splits into exactly equal columns", () => {
    // Panel 0..100; cursor at 25 asks for ~25-wide columns → 4 columns, 3 lines.
    const lines = buildEqualColumns(25, 0, 100);
    expect(lines).toEqual([25, 50, 75]);
  });

  it("returns lines strictly inside the panel, ascending", () => {
    const lines = buildEqualColumns(17, 0, 100);
    expect(lines[0]).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toBeLessThan(100);
    for (let i = 1; i < lines.length; i++) expect(lines[i]).toBeGreaterThan(lines[i - 1]);
  });

  it("recommends nothing at or left of the left border", () => {
    expect(buildEqualColumns(0, 0, 100)).toEqual([]);
    expect(buildEqualColumns(-10, 0, 100)).toEqual([]);
  });

  it("is independent of which end is passed first", () => {
    expect(buildEqualColumns(25, 100, 0)).toEqual(buildEqualColumns(25, 0, 100));
  });

  it("always produces N-1 evenly spaced lines", () => {
    for (const cursor of [10, 33, 60, 90]) {
      const lines = buildEqualColumns(cursor, 0, 120);
      if (lines.length < 2) continue;
      const step = lines[1] - lines[0];
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i] - lines[i - 1]).toBeCloseTo(step, 9);
      }
    }
  });
});

describe("buildEqualRows", () => {
  it("splits a panel height into equal rows", () => {
    // 0..40 tall, cursor at 10 → 4 rows, 3 lines.
    expect(buildEqualRows(10, 0, 40, [])).toEqual([10, 20, 30]);
  });

  it("returns lines strictly inside the panel", () => {
    const lines = buildEqualRows(7, 0, 40, []);
    expect(lines[0]).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toBeLessThan(40);
  });

  it("recommends nothing at or below the baseline", () => {
    expect(buildEqualRows(0, 0, 40, [])).toEqual([]);
  });

  it("lands a line on every floor plate that crosses the panel", () => {
    // With plates present the rows snap to them: each plate must be among the lines.
    const plates = [0, 13, 26];
    const lines = buildEqualRows(6.5, 0, 39, plates);
    for (const plate of plates.filter((p) => p > 0 && p < 39)) {
      expect(lines.some((l) => Math.abs(l - plate) < 1e-6)).toBe(true);
    }
  });
});
