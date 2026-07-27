/**
 * demoTour.test.ts — the guided demo's script and the geometry it builds.
 *
 * The demo is the first thing many visitors will run, and it drives the app's real state,
 * so a broken script is a broken app rather than a broken video. These tests pin the two
 * things that would fail silently: the DRAWING ANIMATION (which must land exactly on the
 * authored perimeter, never overshoot, and stay a valid perimeter at every instant) and
 * the DERIVED GRID (module counts, slab levels, spandrel bands) that the Centerlines,
 * Framing and Glazing steps write into the document.
 */
import { describe, it, expect } from "vitest";
import {
  DEMO_ADDRESS,
  DEMO_DRAW_PLACE_FRACTION,
  DEMO_EXPORT_PANEL_COUNT,
  DEMO_MARQUEE_PAD_FT,
  demoExportWindow,
  DEMO_FLOOR_TO_FLOOR_FT,
  DEMO_FOCUS_EDGE,
  DEMO_MODULE_FT,
  DEMO_PERIMETER,
  DEMO_SPANDREL_BAND_FT,
  DEMO_VIEW_MODE_SEQUENCE,
  DEMO_WALL_HEIGHT_FT,
  TOUR_STEPS,
  demoCellType,
  demoColumnCount,
  demoColumnOffsets,
  demoDrawFrame,
  demoFloorLevels,
  demoRowOffsets,
  scaleHandles,
} from "./demoTour";
import { perimeterLength, enclosedArea, isCurved } from "./geometry";
import { unravelPerimeter } from "./unravel";
import { CELL_VIEW_MODES } from "./displayModes";

describe("the example building", () => {
  it("is a closed shape with real area", () => {
    expect(DEMO_PERIMETER.closed).toBe(true);
    expect(DEMO_PERIMETER.vertices.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(enclosedArea(DEMO_PERIMETER))).toBeGreaterThan(1000);
  });

  it("has exactly one curved wall, and it is the one the demo focuses on", () => {
    // The steps after the unroll all talk about the bowed south wall, and the copy for
    // the Elevations card promises a curve that unrolls to its ARC length. If the handles
    // ever moved to another edge, both would quietly become wrong.
    const n = DEMO_PERIMETER.vertices.length;
    const curved: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = DEMO_PERIMETER.vertices[i];
      const b = DEMO_PERIMETER.vertices[(i + 1) % n];
      if (isCurved(a, b)) curved.push(i);
    }
    expect(curved).toEqual([DEMO_FOCUS_EDGE]);
  });

  it("unrolls to one panel per wall, and the focused edge is among them", () => {
    const { segments } = unravelPerimeter(DEMO_PERIMETER, 10);
    expect(segments).toHaveLength(DEMO_PERIMETER.vertices.length);
    expect(segments.some((s) => s.index === DEMO_FOCUS_EDGE)).toBe(true);
  });

  it("unrolls the curved wall to MORE than its chord — the arc length", () => {
    const { segments } = unravelPerimeter(DEMO_PERIMETER, 10);
    const seg = segments.find((s) => s.index === DEMO_FOCUS_EDGE)!;
    const a = DEMO_PERIMETER.vertices[0];
    const b = DEMO_PERIMETER.vertices[1];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    expect(seg.length).toBeGreaterThan(chord);
  });

  it("names a site that the region code disambiguates", () => {
    // "Manhattan, NY" — the admin-1 code is what separates Manhattan, New York from
    // Manhattan, Kansas in the offline matcher. Dropping it would silently relocate the
    // demo to the Midwest, taking the sun path with it.
    expect(DEMO_ADDRESS).toMatch(/,\s*NY$/);
  });
});

describe("demoDrawFrame", () => {
  it("starts from nothing and ends on the authored perimeter", () => {
    expect(demoDrawFrame(DEMO_PERIMETER, 0).vertices.length).toBeLessThanOrEqual(2);
    const end = demoDrawFrame(DEMO_PERIMETER, 1);
    expect(end.closed).toBe(true);
    expect(end.vertices).toEqual(DEMO_PERIMETER.vertices);
  });

  it("clamps outside 0…1 rather than extrapolating", () => {
    expect(demoDrawFrame(DEMO_PERIMETER, -3)).toEqual(demoDrawFrame(DEMO_PERIMETER, 0));
    expect(demoDrawFrame(DEMO_PERIMETER, 7)).toEqual(demoDrawFrame(DEMO_PERIMETER, 1));
  });

  it("stays OPEN while placing and CLOSED once the curve beat starts", () => {
    // The renderer draws an open polyline differently from a closed one, and the app's
    // Pen mode depends on it, so the flip has to happen exactly once, at the hand-off.
    for (const t of [0.1, 0.3, 0.5, 0.7]) {
      expect(demoDrawFrame(DEMO_PERIMETER, t).closed).toBe(false);
    }
    for (const t of [DEMO_DRAW_PLACE_FRACTION, 0.9, 1]) {
      expect(demoDrawFrame(DEMO_PERIMETER, t).closed).toBe(true);
    }
  });

  it("never exceeds the placed vertices plus the one moving point", () => {
    // Mid-draw the polyline is "everything committed so far, plus the pen tip" — which on
    // the closing edge is all n vertices plus the point running back to the first. Anything
    // beyond that would mean a vertex being placed twice.
    for (let t = 0; t <= 1.0001; t += 0.01) {
      expect(demoDrawFrame(DEMO_PERIMETER, t).vertices.length).toBeLessThanOrEqual(
        DEMO_PERIMETER.vertices.length + 1,
      );
    }
  });

  it("grows monotonically — the outline never shrinks back mid-draw", () => {
    let prev = -1;
    for (let t = 0; t <= DEMO_DRAW_PLACE_FRACTION - 1e-6; t += 0.005) {
      const len = perimeterLength(demoDrawFrame(DEMO_PERIMETER, t));
      expect(len).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = len;
    }
  });

  it("withholds curve handles until the loop is closed", () => {
    // Pulling a handle out of a vertex whose far end has not been placed yet would draw a
    // cubic with one control point — a curve going nowhere. The demo places, then curves.
    for (const t of [0.2, 0.5, 0.7]) {
      for (const v of demoDrawFrame(DEMO_PERIMETER, t).vertices) {
        expect(v.handleIn).toBeUndefined();
        expect(v.handleOut).toBeUndefined();
      }
    }
  });

  it("degenerates safely on a perimeter too small to draw", () => {
    expect(demoDrawFrame({ vertices: [], closed: false }, 0.5).vertices).toEqual([]);
    expect(demoDrawFrame({ vertices: [{ x: 0, y: 0 }], closed: false }, 0.5).vertices).toEqual([]);
  });
});

describe("scaleHandles", () => {
  it("straightens at 0 and restores the authored curve at 1", () => {
    const straight = scaleHandles(DEMO_PERIMETER, 0);
    // Compared by value, not identity: scaling a negative offset by 0 yields -0, which
    // `isCurved` reads as no handle exactly like +0 but which toEqual distinguishes.
    expect(straight.vertices[0].handleOut!.x).toBeCloseTo(0, 12);
    expect(straight.vertices[0].handleOut!.y).toBeCloseTo(0, 12);
    expect(isCurved(straight.vertices[0], straight.vertices[1])).toBe(false);
    expect(scaleHandles(DEMO_PERIMETER, 1).vertices).toEqual(DEMO_PERIMETER.vertices);
  });

  it("leaves the anchors and the closed flag alone", () => {
    const half = scaleHandles(DEMO_PERIMETER, 0.5);
    expect(half.closed).toBe(DEMO_PERIMETER.closed);
    half.vertices.forEach((v, i) => {
      expect(v.x).toBe(DEMO_PERIMETER.vertices[i].x);
      expect(v.y).toBe(DEMO_PERIMETER.vertices[i].y);
    });
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify(DEMO_PERIMETER);
    scaleHandles(DEMO_PERIMETER, 0.3);
    expect(JSON.stringify(DEMO_PERIMETER)).toBe(before);
  });
});

describe("the curtain-wall grid the demo builds", () => {
  it("puts a floor line on the ground, every storey, and the roof", () => {
    const levels = demoFloorLevels(DEMO_WALL_HEIGHT_FT, DEMO_FLOOR_TO_FLOOR_FT);
    expect(levels[0]).toBe(0);
    expect(levels[levels.length - 1]).toBe(DEMO_WALL_HEIGHT_FT);
    expect(levels).toEqual([0, 13.5, 27, 40.5, 54]);
  });

  it("survives degenerate heights instead of looping forever", () => {
    expect(demoFloorLevels(0, 13.5)).toEqual([0]);
    expect(demoFloorLevels(54, 0)).toEqual([0]);
  });

  it("keeps every row line strictly inside the panel", () => {
    // cellsForEdge discards anything at or outside the borders, so an offset ON the
    // border would silently produce one fewer row than the glazing pattern expects.
    for (const y of demoRowOffsets(DEMO_WALL_HEIGHT_FT, DEMO_FLOOR_TO_FLOOR_FT, DEMO_SPANDREL_BAND_FT)) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(DEMO_WALL_HEIGHT_FT);
    }
  });

  it("pairs each interior slab with the bottom of its spandrel band", () => {
    const rows = demoRowOffsets(DEMO_WALL_HEIGHT_FT, DEMO_FLOOR_TO_FLOOR_FT, DEMO_SPANDREL_BAND_FT);
    expect(rows).toEqual([10, 13.5, 23.5, 27, 37, 40.5, 50.5]);
  });

  it("divides a wall into whole modules nearest the target, never fewer than two", () => {
    expect(demoColumnCount(100, 10)).toBe(10);
    expect(demoColumnCount(104, 10)).toBe(10); // rounds to the nearest whole module
    expect(demoColumnCount(6, 10)).toBe(2); // a short chamfer still gets two bays
    expect(demoColumnCount(0, 10)).toBe(1); // degenerate, but never 0 or NaN
  });

  it("returns equal, interior, ascending column offsets", () => {
    const offsets = demoColumnOffsets(100, 10);
    expect(offsets).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets[offsets.length - 1]).toBeLessThan(100);
  });

  it("gives every wall of the example a sensible bay count", () => {
    const { segments } = unravelPerimeter(DEMO_PERIMETER, 10);
    for (const s of segments) {
      const width = Math.abs(s.x1 - s.x0);
      const n = demoColumnCount(width, DEMO_MODULE_FT);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(demoColumnOffsets(width, DEMO_MODULE_FT)).toHaveLength(n - 1);
    }
  });
});

describe("demoCellType", () => {
  const type = (y0: number, y1: number) =>
    demoCellType(y0, y1, DEMO_WALL_HEIGHT_FT, DEMO_FLOOR_TO_FLOOR_FT, DEMO_SPANDREL_BAND_FT);

  it("calls the band under a slab spandrel", () => {
    expect(type(10, 13.5)).toBe("spandrel");
    expect(type(23.5, 27)).toBe("spandrel");
  });

  it("calls the band under the ROOF spandrel too — the parapet", () => {
    expect(type(50.5, 54)).toBe("spandrel");
  });

  it("calls everything between the bands vision", () => {
    expect(type(0, 10)).toBe("vision");
    expect(type(13.5, 23.5)).toBe("vision");
    expect(type(40.5, 50.5)).toBe("vision");
  });

  it("classifies by the cell's midpoint, so subdividing a row does not change it", () => {
    // The Centerlines step may split a row further; each half must keep the row's material.
    expect(type(13.5, 18.5)).toBe("vision");
    expect(type(18.5, 23.5)).toBe("vision");
    expect(type(10, 11.75)).toBe("spandrel");
    expect(type(11.75, 13.5)).toBe("spandrel");
  });

  it("never puts a spandrel band below the ground line", () => {
    expect(type(0, 1)).toBe("vision");
  });
});

describe("the script", () => {
  it("has unique step ids", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the pipeline in order, and ends on a card with no target", () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      "footprint",
      "site",
      "elevations",
      "floors",
      "cwtype",
      "centerlines",
      "framing",
      "glazing",
      "viewmodes",
      "statistics",
      "export",
      "done",
    ]);
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].target).toBeNull();
  });

  it("gives every step something to say", () => {
    for (const s of TOUR_STEPS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps every card to about two sentences", () => {
    // The card sits over the drawing it is describing, and a paragraph there stops being
    // read. Two sentences is the budget; this catches copy that has crept past it.
    for (const s of TOUR_STEPS) {
      expect(s.body.length, s.id).toBeLessThanOrEqual(190);
      // The terminator has to FOLLOW a word: the copy names the "?" help key, and a bare
      // "?" between spaces is a keystroke, not the end of a sentence.
      expect(s.body.split(/(?<=\w)[.!?](?:\s|$)/).filter((p) => p.trim().length > 0).length, s.id)
        .toBeLessThanOrEqual(2);
    }
  });

  it("names the gesture for every tool driven by a DRAG", () => {
    // A card that only narrates leaves the user knowing a feature exists and not how to
    // reach it. Clicking is guessable from a button; dragging is not, so these three have
    // to say so outright.
    for (const id of ["footprint", "centerlines", "framing", "export"]) {
      expect(TOUR_STEPS.find((s) => s.id === id)!.body, id).toMatch(/drag/i);
    }
  });

  it("never promises to download anything", () => {
    // The Export step opens the dialog and stops. If the copy ever says the demo exports
    // or downloads a file, either the copy is lying or the driver has started writing to
    // someone's disk uninvited — both are bugs.
    for (const s of TOUR_STEPS) {
      expect(s.body, s.id).not.toMatch(/\b(download(s|ed|ing)?|saves? a file)\b/i);
    }
  });

  it("cycles view modes that contrast, and lands back on the technical drawing", () => {
    // The Statistics card follows this one and every figure in it is computed from the
    // technical view, so ending on a colour overlay would misattribute the numbers.
    expect(new Set(DEMO_VIEW_MODE_SEQUENCE).size).toBe(DEMO_VIEW_MODE_SEQUENCE.length);
    expect(DEMO_VIEW_MODE_SEQUENCE[DEMO_VIEW_MODE_SEQUENCE.length - 1]).toBe("normal");
    for (const m of DEMO_VIEW_MODE_SEQUENCE) expect(CELL_VIEW_MODES).toContain(m);
  });

  it("stays short enough not to outstay its welcome", () => {
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(12);
  });
});

describe("demoExportWindow", () => {
  const strip = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ index: i, x0: i * 100, x1: i * 100 + 80 }));

  it("returns a CONTIGUOUS run in strip order", () => {
    const run = demoExportWindow(strip(6), 3, 3);
    expect(run.map((s) => s.index)).toEqual([2, 3, 4]);
  });

  it("centres the run on the focused wall", () => {
    expect(demoExportWindow(strip(9), 4, 3).map((s) => s.index)).toEqual([3, 4, 5]);
  });

  it("slides back inside the strip at either end rather than running off it", () => {
    expect(demoExportWindow(strip(6), 0, 3).map((s) => s.index)).toEqual([0, 1, 2]);
    expect(demoExportWindow(strip(6), 5, 3).map((s) => s.index)).toEqual([3, 4, 5]);
  });

  it("orders by POSITION on the baseline, not by perimeter edge index", () => {
    // Wall borders are laid out clockwise from an arbitrary start, so the edge indices
    // along the strip are not sorted. "Adjacent" has to mean adjacent on screen — a
    // marquee is a box, and it cannot catch a non-contiguous set.
    const shuffled = [
      { index: 5, x0: 0, x1: 80 },
      { index: 0, x0: 100, x1: 180 },
      { index: 3, x0: 200, x1: 280 },
      { index: 1, x0: 300, x1: 380 },
    ];
    expect(demoExportWindow(shuffled, 0, 3).map((s) => s.index)).toEqual([5, 0, 3]);
  });

  it("takes the whole strip when it is shorter than the window", () => {
    expect(demoExportWindow(strip(2), 0, 3)).toHaveLength(2);
  });

  it("degenerates safely", () => {
    expect(demoExportWindow([], 0, 3)).toEqual([]);
    expect(demoExportWindow(strip(4), 0, 0)).toEqual([]);
    // An edge that is not in the strip falls back to the start rather than throwing.
    expect(demoExportWindow(strip(4), 99, 2).map((s) => s.index)).toEqual([0, 1]);
  });

  it("keeps the marquee's padding inside the gap between panels", () => {
    // The box is drawn a little outside the run it is selecting. Any padding at or beyond
    // half the inter-panel gap would reach into the neighbour and select a wall the user
    // was never shown being caught.
    expect(DEMO_MARQUEE_PAD_FT * 2).toBeLessThan(10); // 10 ft = the unravel layout's gap
  });

  it("selects a run of the example building without swallowing the whole strip", () => {
    const { segments } = unravelPerimeter(DEMO_PERIMETER, 10);
    const run = demoExportWindow(segments, DEMO_FOCUS_EDGE, DEMO_EXPORT_PANEL_COUNT);
    expect(run).toHaveLength(DEMO_EXPORT_PANEL_COUNT);
    expect(run.length).toBeLessThan(segments.length);
    expect(run.some((s) => s.index === DEMO_FOCUS_EDGE)).toBe(true);
  });
});
