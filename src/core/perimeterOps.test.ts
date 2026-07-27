/**
 * perimeterOps.test.ts — the edit operations behind every drawing action.
 *
 * Two properties dominate here:
 *   1. IMMUTABILITY. Undo/redo stores snapshots by reference (see DocSnapshot), so an op
 *      that mutated its input in place would silently corrupt history — the previous
 *      snapshot would change underneath the stack. Every op is checked for this.
 *   2. The closed-loop rules: deleting below 3 vertices has to reopen the shape, and
 *      inserting on a segment has to land BETWEEN its endpoints, not at the end.
 */
import { describe, it, expect } from "vitest";
import {
  addVertex,
  close,
  moveVertex,
  deleteVertex,
  deleteVertices,
  popVertex,
  setHandle,
  clearVertexHandles,
  makeSegmentArc,
  makeSegmentLine,
  insertVertexOnSegment,
} from "./perimeterOps";
import { isCurved, type Perimeter, type Vertex } from "./geometry";

const square = (): Perimeter => ({
  vertices: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ] as Vertex[],
  closed: true,
});

/** Deep snapshot for the "did not mutate the input" assertions. */
const snap = (p: Perimeter) => JSON.parse(JSON.stringify(p));

describe("immutability (undo/redo depends on it)", () => {
  it("no operation mutates the perimeter it is given", () => {
    const ops: Array<[string, (p: Perimeter) => Perimeter]> = [
      ["addVertex", (p) => addVertex(p, { x: 5, y: 5 })],
      ["close", (p) => close(p)],
      ["moveVertex", (p) => moveVertex(p, 0, { x: 99, y: 99 })],
      ["deleteVertex", (p) => deleteVertex(p, 1)],
      ["deleteVertices", (p) => deleteVertices(p, [0, 2])],
      ["popVertex", (p) => popVertex(p)],
      ["setHandle", (p) => setHandle(p, 1, "out", { x: 2, y: 2 }, true)],
      ["clearVertexHandles", (p) => clearVertexHandles(p, 1)],
      ["makeSegmentArc", (p) => makeSegmentArc(p, 0)],
      ["makeSegmentLine", (p) => makeSegmentLine(p, 0)],
      ["insertVertexOnSegment", (p) => insertVertexOnSegment(p, 0, 0.5, { x: 5, y: 0 }).perimeter],
    ];
    for (const [name, op] of ops) {
      const input = square();
      const before = snap(input);
      op(input);
      expect(snap(input), `${name} mutated its input`).toEqual(before);
    }
  });
});

describe("addVertex", () => {
  it("appends to the end", () => {
    const p = addVertex({ vertices: [], closed: false }, { x: 1, y: 2 });
    expect(p.vertices).toHaveLength(1);
    expect(p.vertices[0]).toMatchObject({ x: 1, y: 2 });
  });
});

describe("close", () => {
  it("closes the loop", () => {
    const open: Perimeter = { ...square(), closed: false };
    expect(close(open).closed).toBe(true);
  });
});

describe("moveVertex", () => {
  it("moves only the targeted vertex", () => {
    const p = moveVertex(square(), 2, { x: 99, y: 98 });
    expect(p.vertices[2]).toMatchObject({ x: 99, y: 98 });
    expect(p.vertices[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("ignores an out-of-range index", () => {
    expect(moveVertex(square(), 99, { x: 1, y: 1 }).vertices).toHaveLength(4);
  });
});

describe("deleteVertex / deleteVertices", () => {
  it("removes one vertex", () => {
    expect(deleteVertex(square(), 1).vertices).toHaveLength(3);
  });

  it("REOPENS the shape when it drops below 3 vertices", () => {
    // A 2-point "loop" is not a shape; leaving it closed would draw a degenerate face.
    const tri = deleteVertex(square(), 0);          // 3 left, still closed
    expect(tri.closed).toBe(true);
    const line = deleteVertex(tri, 0);              // 2 left
    expect(line.closed).toBe(false);
  });

  it("removes several at once, regardless of index order", () => {
    const p = deleteVertices(square(), [2, 0]);
    expect(p.vertices).toHaveLength(2);
    expect(p.vertices.map((v) => v.x)).toEqual([10, 0]);
  });

  it("ignores duplicate and out-of-range indices", () => {
    expect(deleteVertices(square(), [1, 1, 42]).vertices).toHaveLength(3);
  });
});

describe("popVertex", () => {
  // It is the drawing-mode "undo last point", so it deliberately refuses on a CLOSED
  // shape — there is no "last point" once the loop is joined.
  it("removes the last vertex of an OPEN path", () => {
    const open: Perimeter = { ...square(), closed: false };
    const p = popVertex(open);
    expect(p.vertices).toHaveLength(3);
    expect(p.vertices[p.vertices.length - 1]).toMatchObject({ x: 10, y: 10 });
  });

  it("refuses on a closed perimeter", () => {
    expect(popVertex(square()).vertices).toHaveLength(4);
  });

  it("is a no-op on an empty perimeter", () => {
    expect(popVertex({ vertices: [], closed: false }).vertices).toHaveLength(0);
  });
});

describe("handles", () => {
  it("setHandle makes the segment read as curved", () => {
    const p = setHandle(square(), 0, "out", { x: 3, y: 3 }, false);
    expect(isCurved(p.vertices[0], p.vertices[1])).toBe(true);
  });

  it("mirror keeps the opposite handle opposed (a smooth tangent)", () => {
    const p = setHandle(square(), 1, "out", { x: 3, y: 4 }, true);
    const v = p.vertices[1];
    expect(v.handleIn).toBeDefined();
    expect(v.handleIn!.x).toBeCloseTo(-3, 9);
    expect(v.handleIn!.y).toBeCloseTo(-4, 9);
  });

  it("clearVertexHandles turns a curve back into a corner", () => {
    const curved = setHandle(square(), 0, "out", { x: 3, y: 3 }, true);
    const cornered = clearVertexHandles(curved, 0);
    expect(isCurved(cornered.vertices[0], cornered.vertices[1])).toBe(false);
  });
});

describe("makeSegmentArc / makeSegmentLine", () => {
  it("arc curves the segment and line flattens it again", () => {
    const arced = makeSegmentArc(square(), 0);
    expect(isCurved(arced.vertices[0], arced.vertices[1])).toBe(true);
    const lined = makeSegmentLine(arced, 0);
    expect(isCurved(lined.vertices[0], lined.vertices[1])).toBe(false);
  });

  it("leaves other segments alone", () => {
    const arced = makeSegmentArc(square(), 0);
    expect(isCurved(arced.vertices[1], arced.vertices[2])).toBe(false);
  });
});

describe("insertVertexOnSegment", () => {
  // Signature: (perimeter, segmentIndex, t, fallbackPoint) -> { perimeter, newIndex }.
  // On a STRAIGHT segment `t` is unused and the fallback point is inserted verbatim (it is
  // the snapped cursor position); on a curve the segment is split at `t`.
  it("inserts BETWEEN the segment's endpoints and reports the new index", () => {
    const { perimeter, newIndex } = insertVertexOnSegment(square(), 0, 0.5, { x: 5, y: 0 });
    expect(perimeter.vertices).toHaveLength(5);
    expect(newIndex).toBe(1);
    expect(perimeter.vertices[1]).toMatchObject({ x: 5, y: 0 });
  });

  it("inserts on the CLOSING segment of a closed loop", () => {
    // Segment 3 runs from the last vertex back to the first — the wrap-around case.
    const { perimeter } = insertVertexOnSegment(square(), 3, 0.5, { x: 0, y: 5 });
    expect(perimeter.vertices).toHaveLength(5);
    expect(perimeter.vertices[perimeter.vertices.length - 1]).toMatchObject({ x: 0, y: 5 });
  });

  it("keeps the shape closed", () => {
    expect(insertVertexOnSegment(square(), 1, 0.5, { x: 10, y: 5 }).perimeter.closed).toBe(true);
  });

  it("rejects an out-of-range segment index", () => {
    const { newIndex } = insertVertexOnSegment(square(), 99, 0.5, { x: 0, y: 0 });
    expect(newIndex).toBe(-1);
  });

  it("splits a CURVED segment on the curve itself, not at the fallback", () => {
    const curved = makeSegmentArc(square(), 0);
    const { perimeter } = insertVertexOnSegment(curved, 0, 0.5, { x: -999, y: -999 });
    expect(perimeter.vertices[1].x).not.toBe(-999);
    expect(perimeter.vertices).toHaveLength(5);
  });
});
