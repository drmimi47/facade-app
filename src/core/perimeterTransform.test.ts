/**
 * perimeterTransform.test.ts — moving and scaling the whole shape as one object.
 *
 * The properties that matter to a user: moving must not deform (every distance survives),
 * scaling must keep the OPPOSITE grip pinned exactly where it was, and neither may mutate
 * the perimeter it was handed (undo/redo snapshots by reference).
 */
import { describe, it, expect } from "vitest";
import {
  perimeterBounds,
  boundsHandlePoint,
  translatePerimeter,
  scalePerimeter,
  hitPerimeterBody,
  hitBoundsHandle,
} from "./perimeterTransform";
import { perimeterLength, enclosedArea, type Perimeter, type Vertex } from "./geometry";

const rect = (w = 10, h = 20): Perimeter => ({
  vertices: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ] as Vertex[],
  closed: true,
});

const snap = (p: Perimeter) => JSON.parse(JSON.stringify(p));

describe("perimeterBounds", () => {
  it("bounds a rectangle exactly", () => {
    expect(perimeterBounds(rect())).toEqual({ x0: 0, y0: 0, x1: 10, y1: 20 });
  });

  it("is null when there is nothing to bound", () => {
    expect(perimeterBounds({ vertices: [], closed: false })).toBeNull();
  });

  it("encloses a CURVE that bulges past its anchors", () => {
    // Anchors span x 0..10, but the handles push the curve out beyond x = 10.
    const curved: Perimeter = {
      vertices: [
        { x: 0, y: 0, handleOut: { x: 8, y: 0 } },
        { x: 10, y: 0, handleIn: { x: 8, y: 0 } },
      ] as Vertex[],
      closed: false,
    };
    expect(perimeterBounds(curved)!.x1).toBeGreaterThan(10);
  });
});

describe("boundsHandlePoint", () => {
  const b = { x0: 0, y0: 0, x1: 10, y1: 20 };

  it("puts each grip on its corner or edge midpoint (+Y up)", () => {
    expect(boundsHandlePoint(b, "sw")).toEqual({ x: 0, y: 0 });
    expect(boundsHandlePoint(b, "ne")).toEqual({ x: 10, y: 20 });
    expect(boundsHandlePoint(b, "n")).toEqual({ x: 5, y: 20 });
    expect(boundsHandlePoint(b, "w")).toEqual({ x: 0, y: 10 });
  });
});

describe("translatePerimeter", () => {
  it("moves every vertex by the delta", () => {
    const moved = translatePerimeter(rect(), 5, -3);
    expect(moved.vertices[0]).toMatchObject({ x: 5, y: -3 });
    expect(moved.vertices[2]).toMatchObject({ x: 15, y: 17 });
  });

  it("does NOT deform — length and area survive exactly", () => {
    const p = rect();
    const moved = translatePerimeter(p, 123.5, -47.25);
    expect(perimeterLength(moved)).toBeCloseTo(perimeterLength(p), 9);
    expect(enclosedArea(moved)).toBeCloseTo(enclosedArea(p), 9);
  });

  it("leaves curve handles untouched (they are relative offsets)", () => {
    const curved: Perimeter = {
      vertices: [
        { x: 0, y: 0, handleOut: { x: 3, y: 4 } },
        { x: 10, y: 0, handleIn: { x: -3, y: 4 } },
      ] as Vertex[],
      closed: false,
    };
    const moved = translatePerimeter(curved, 100, 100);
    expect(moved.vertices[0].handleOut).toEqual({ x: 3, y: 4 });
    expect(moved.vertices[1].handleIn).toEqual({ x: -3, y: 4 });
  });

  it("does not mutate its input", () => {
    const p = rect();
    const before = snap(p);
    translatePerimeter(p, 5, 5);
    expect(snap(p)).toEqual(before);
  });
});

describe("scalePerimeter", () => {
  const bounds = { x0: 0, y0: 0, x1: 10, y1: 20 };

  it("pins the OPPOSITE corner while a corner grip is dragged", () => {
    // Drag "ne" outward; "sw" (0,0) must not move.
    const scaled = scalePerimeter(rect(), bounds, "ne", { x: 20, y: 40 }, false);
    const b = perimeterBounds(scaled)!;
    expect(b.x0).toBeCloseTo(0, 9);
    expect(b.y0).toBeCloseTo(0, 9);
    expect(b.x1).toBeCloseTo(20, 9);
    expect(b.y1).toBeCloseTo(40, 9);
  });

  it("pins the opposite corner for an INWARD drag too", () => {
    const scaled = scalePerimeter(rect(), bounds, "sw", { x: 5, y: 10 }, false);
    const b = perimeterBounds(scaled)!;
    expect(b.x1).toBeCloseTo(10, 9); // "ne" corner stays put
    expect(b.y1).toBeCloseTo(20, 9);
    expect(b.x0).toBeCloseTo(5, 9);
    expect(b.y0).toBeCloseTo(10, 9);
  });

  it("scales ONE axis for an edge grip", () => {
    const scaled = scalePerimeter(rect(), bounds, "e", { x: 30, y: 999 }, false);
    const b = perimeterBounds(scaled)!;
    expect(b.x1).toBeCloseTo(30, 9);
    expect(b.y0).toBeCloseTo(0, 9); // untouched
    expect(b.y1).toBeCloseTo(20, 9);
  });

  it("preserves aspect on a corner when asked", () => {
    const p = rect(10, 20); // aspect 1:2
    const scaled = scalePerimeter(p, bounds, "ne", { x: 20, y: 22 }, true);
    const b = perimeterBounds(scaled)!;
    expect((b.x1 - b.x0) / (b.y1 - b.y0)).toBeCloseTo(10 / 20, 9);
  });

  it("keeps the shape's proportions under a uniform scale", () => {
    const p = rect();
    const scaled = scalePerimeter(p, bounds, "ne", { x: 20, y: 40 }, false);
    // Doubling both axes doubles length and quadruples area.
    expect(perimeterLength(scaled)).toBeCloseTo(perimeterLength(p) * 2, 6);
    expect(enclosedArea(scaled)).toBeCloseTo(enclosedArea(p) * 4, 6);
  });

  it("scales curve handles with the shape, so curvature stays proportional", () => {
    const curved: Perimeter = {
      vertices: [
        { x: 0, y: 0, handleOut: { x: 2, y: 3 } },
        { x: 10, y: 0 },
        { x: 10, y: 20 },
        { x: 0, y: 20 },
      ] as Vertex[],
      closed: true,
    };
    const scaled = scalePerimeter(curved, bounds, "ne", { x: 20, y: 40 }, false);
    expect(scaled.vertices[0].handleOut).toEqual({ x: 4, y: 6 });
  });

  it("refuses to collapse the shape to zero", () => {
    const scaled = scalePerimeter(rect(), bounds, "e", { x: -100, y: 0 }, false);
    const b = perimeterBounds(scaled)!;
    expect(b.x1 - b.x0).toBeGreaterThan(0);
  });

  it("does not mutate its input", () => {
    const p = rect();
    const before = snap(p);
    scalePerimeter(p, bounds, "ne", { x: 40, y: 40 }, true);
    expect(snap(p)).toEqual(before);
  });

  // A drag is MANY calls — one per pointer-move — and the result must depend only on where
  // the cursor ENDED, never on how many frames it took to get there. That holds precisely
  // because `from` describes the bounds of the perimeter passed in: feed both from the
  // press-time snapshot and the transform is re-evaluated, not re-applied.
  it("is FRAME-INDEPENDENT when every frame scales the press-time shape", () => {
    const base = rect();
    const from = perimeterBounds(base)!;
    const end = { x: 25, y: 50 };

    let live = base;
    for (const to of [{ x: 11, y: 22 }, { x: 14, y: 28 }, { x: 19, y: 38 }, end]) {
      live = scalePerimeter(base, from, "ne", to, false); // always from the BASE
    }
    expect(perimeterBounds(live)).toEqual(perimeterBounds(scalePerimeter(base, from, "ne", end, false)));
  });

  // The failure mode that motivated the pairing: feeding the LIVE (already-scaled) shape
  // while still describing the ORIGINAL bounds re-applies the whole transform each frame,
  // so the factor compounds. Pinned here so the call site's base/from pairing is understood
  // as load-bearing rather than incidental — a few pointer-moves of an outward drag blow the
  // shape far past the cursor, and an inward one collapses it toward a line.
  it("COMPOUNDS if fed its own output against the original bounds (why the base is kept)", () => {
    const base = rect(10, 20);
    const from = perimeterBounds(base)!;
    const to = { x: 20, y: 40 }; // a steady 2x, held still

    let wrong = base;
    for (let frame = 0; frame < 4; frame++) wrong = scalePerimeter(wrong, from, "ne", to, false);
    // Four frames of a 2x drag that never moved: 16x instead of 2x.
    const b = perimeterBounds(wrong)!;
    expect(b.x1 - b.x0).toBeCloseTo(160, 6);
    expect(b.x1 - b.x0).toBeGreaterThan(perimeterBounds(scalePerimeter(base, from, "ne", to, false))!.x1 * 7);
  });
});

describe("hitPerimeterBody", () => {
  it("hits anywhere INSIDE a closed shape", () => {
    expect(hitPerimeterBody(rect(), { x: 5, y: 10 }, 0.1)).toBe(true);
  });

  it("misses well outside it", () => {
    expect(hitPerimeterBody(rect(), { x: 50, y: 50 }, 0.1)).toBe(false);
  });

  it("hits NEAR the outline within tolerance", () => {
    expect(hitPerimeterBody(rect(), { x: -0.05, y: 10 }, 0.1)).toBe(true);
    expect(hitPerimeterBody(rect(), { x: -5, y: 10 }, 0.1)).toBe(false);
  });

  it("hits an OPEN path only near its line, since it has no inside", () => {
    const open: Perimeter = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }] as Vertex[], closed: false };
    expect(hitPerimeterBody(open, { x: 5, y: 0.05 }, 0.1)).toBe(true);
    expect(hitPerimeterBody(open, { x: 5, y: 5 }, 0.1)).toBe(false);
  });

  it("misses an empty perimeter", () => {
    expect(hitPerimeterBody({ vertices: [], closed: false }, { x: 0, y: 0 }, 1)).toBe(false);
  });
});

describe("hitBoundsHandle", () => {
  const b = { x0: 0, y0: 0, x1: 10, y1: 20 };

  it("finds the grip under the point", () => {
    expect(hitBoundsHandle(b, { x: 0.05, y: 19.95 }, 0.2)).toBe("nw");
    expect(hitBoundsHandle(b, { x: 5, y: 20 }, 0.2)).toBe("n");
  });

  it("returns null away from every grip", () => {
    expect(hitBoundsHandle(b, { x: 5, y: 10 }, 0.2)).toBeNull();
  });

  it("prefers a CORNER when a corner and an edge grip overlap", () => {
    // On a box shorter than the tolerance every left-side grip coincides. WHICH corner
    // wins is arbitrary; that a corner beats the edge grip is the contract — corners
    // scale both axes, so they are the more capable pick when the two are ambiguous.
    const tiny = { x0: 0, y0: 0, x1: 10, y1: 0.1 };
    expect(["nw", "sw"]).toContain(hitBoundsHandle(tiny, { x: 0, y: 0 }, 0.2));
  });
});
