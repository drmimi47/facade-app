/**
 * geometry.test.ts — the primitives every other module measures with.
 *
 * These assert VALUES, not just "doesn't throw": a 3-4-5 triangle really is 5 long, a
 * 10×20 rectangle really encloses 200. A silent regression here would be invisible in
 * the UI (the shape still draws) but wrong in every statistic, export, and solar figure
 * downstream, which is exactly the class of bug a test suite has to catch.
 */
import { describe, it, expect } from "vitest";
import {
  distance,
  angleDeg,
  isCurved,
  cubicAt,
  flattenPerimeter,
  perimeterLength,
  enclosedArea,
  emptyPerimeter,
  type Perimeter,
  type Vertex,
} from "./geometry";

/** A closed rectangle of straight edges — the reference shape for the area/length tests. */
function rect(w: number, h: number): Perimeter {
  const v: Vertex[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  return { vertices: v, closed: true };
}

describe("distance", () => {
  it("measures the 3-4-5 triangle", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is zero for a point against itself, and symmetric", () => {
    const a = { x: 12.5, y: -7 };
    const b = { x: -3, y: 91.25 };
    expect(distance(a, a)).toBe(0);
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 12);
  });
});

describe("angleDeg", () => {
  // Model +Y is UP, so these are standard math angles, not screen angles.
  it("reads the cardinal directions", () => {
    const o = { x: 0, y: 0 };
    expect(angleDeg(o, { x: 1, y: 0 })).toBeCloseTo(0, 10);
    expect(angleDeg(o, { x: 0, y: 1 })).toBeCloseTo(90, 10);
    expect(angleDeg(o, { x: -1, y: 0 })).toBeCloseTo(180, 10);
  });

  it("reads a 45° diagonal", () => {
    expect(angleDeg({ x: 0, y: 0 }, { x: 5, y: 5 })).toBeCloseTo(45, 10);
  });
});

describe("isCurved", () => {
  it("is false for two plain vertices", () => {
    expect(isCurved({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(false);
  });

  it("is false for a ZERO-length handle (a corner, not a curve)", () => {
    expect(isCurved({ x: 0, y: 0, handleOut: { x: 0, y: 0 } }, { x: 10, y: 0 })).toBe(false);
  });

  it("is true when either end carries a handle", () => {
    // A handle is only real if it has length — a zero offset still reads as a corner.
    const withOut: Vertex = { x: 0, y: 0, handleOut: { x: 2, y: 2 } };
    const withIn: Vertex = { x: 10, y: 0, handleIn: { x: -2, y: 2 } };
    expect(isCurved(withOut, { x: 10, y: 0 })).toBe(true);
    expect(isCurved({ x: 0, y: 0 }, withIn)).toBe(true);
  });
});

describe("cubicAt", () => {
  const p0 = { x: 0, y: 0 };
  const p1 = { x: 0, y: 10 };
  const p2 = { x: 10, y: 10 };
  const p3 = { x: 10, y: 0 };

  it("returns the endpoints at t=0 and t=1", () => {
    expect(cubicAt(p0, p1, p2, p3, 0)).toEqual(p0);
    expect(cubicAt(p0, p1, p2, p3, 1)).toEqual(p3);
  });

  it("passes through the symmetric midpoint at t=0.5", () => {
    // For this symmetric control net the midpoint is x = 5 and y = 3/4 · 10.
    const mid = cubicAt(p0, p1, p2, p3, 0.5);
    expect(mid.x).toBeCloseTo(5, 10);
    expect(mid.y).toBeCloseTo(7.5, 10);
  });
});

describe("flattenPerimeter", () => {
  it("closes the loop by repeating the first point", () => {
    const pts = flattenPerimeter(rect(10, 20));
    expect(pts[0]).toEqual(pts[pts.length - 1]);
  });

  it("emits exactly the vertices (plus the closing point) when nothing is curved", () => {
    expect(flattenPerimeter(rect(10, 20))).toHaveLength(5);
  });

  it("returns nothing for an empty perimeter", () => {
    expect(flattenPerimeter(emptyPerimeter())).toHaveLength(0);
  });
});

describe("perimeterLength", () => {
  it("sums a rectangle's four sides", () => {
    expect(perimeterLength(rect(10, 20))).toBeCloseTo(60, 10);
  });

  it("measures an OPEN path as the path, not a loop", () => {
    const open: Perimeter = { vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }], closed: false };
    expect(perimeterLength(open)).toBeCloseTo(5, 10);
  });
});

describe("enclosedArea", () => {
  it("computes a rectangle's area", () => {
    expect(enclosedArea(rect(10, 20))).toBeCloseTo(200, 10);
  });

  it("is orientation-independent (always positive)", () => {
    const cw = rect(10, 20);
    const ccw: Perimeter = { vertices: [...cw.vertices].reverse(), closed: true };
    expect(enclosedArea(ccw)).toBeCloseTo(enclosedArea(cw), 10);
    expect(enclosedArea(ccw)).toBeGreaterThan(0);
  });

  it("is zero unless the shape is closed with at least 3 vertices", () => {
    expect(enclosedArea({ ...rect(10, 20), closed: false })).toBe(0);
    expect(enclosedArea({ vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: true })).toBe(0);
  });
});
