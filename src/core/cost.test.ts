/**
 * cost.test.ts — the facade cost estimate behind the "Cost" statistics reading.
 *
 * The properties that make this number trustworthy rather than merely plausible:
 * the parts must sum to the total, untyped cells must never be silently priced, glazing
 * type must actually move the figure, and subdividing a panel must cost more than not
 * subdividing it (framing is priced per linear foot, which is the whole reason it is in
 * the model). A drift in any of those turns a decision tool into a misleading one.
 */
import { describe, it, expect } from "vitest";
import {
  buildCostEstimate,
  DEFAULT_COST_RATES,
  fmtMoney,
  fmtRate,
  type PanelCostInput,
} from "./cost";

/** One panel of `n` identical cells, all of `type`, with `framingLength` feet of mullion. */
const panel = (
  n: number,
  area: number,
  type: PanelCostInput["cells"][number]["type"],
  framingLength = 0,
): PanelCostInput => ({
  edge: 0,
  cells: Array.from({ length: n }, () => ({ area, type })),
  framingLength,
});

describe("buildCostEstimate", () => {
  it("prices infill by AREA at the rate for its type", () => {
    const e = buildCostEstimate([panel(2, 50, "vision")]);
    expect(e.byType.vision.area).toBe(100);
    expect(e.byType.vision.count).toBe(2);
    expect(e.byType.vision.cost).toBeCloseTo(100 * DEFAULT_COST_RATES.vision, 6);
    expect(e.total).toBeCloseTo(100 * DEFAULT_COST_RATES.vision, 6);
  });

  it("prices framing by LINEAR FOOT", () => {
    const e = buildCostEstimate([panel(0, 0, null, 200)]);
    expect(e.framingLength).toBe(200);
    expect(e.framingCost).toBeCloseTo(200 * DEFAULT_COST_RATES.framing, 6);
    expect(e.total).toBeCloseTo(e.framingCost, 6);
  });

  it("adds up — every part sums to the total", () => {
    const e = buildCostEstimate([
      panel(2, 40, "vision", 60),
      panel(3, 25, "spandrel", 40),
      panel(1, 30, "opaque", 20),
    ]);
    const infill = e.byType.vision.cost + e.byType.spandrel.cost + e.byType.opaque.cost;
    expect(e.infillCost).toBeCloseTo(infill, 6);
    expect(e.total).toBeCloseTo(e.infillCost + e.framingCost, 6);
    expect(e.framingLength).toBe(120);
  });

  it("ranks the types the way the industry does — vision > spandrel > opaque", () => {
    const at = (t: "vision" | "spandrel" | "opaque") =>
      buildCostEstimate([panel(1, 100, t)]).total;
    expect(at("vision")).toBeGreaterThan(at("spandrel"));
    expect(at("spandrel")).toBeGreaterThan(at("opaque"));
  });

  it("MOVES when a cell is repainted — the reason the reading exists", () => {
    const before = buildCostEstimate([panel(4, 50, "vision")]).total;
    const after = buildCostEstimate([
      { edge: 0, cells: [
        { area: 50, type: "vision" },
        { area: 50, type: "vision" },
        { area: 50, type: "vision" },
        { area: 50, type: "opaque" },
      ], framingLength: 0 },
    ]).total;
    expect(after).toBeLessThan(before);
  });

  describe("untyped cells", () => {
    it("are NOT priced — an unspecified cell must never carry a guessed rate", () => {
      const e = buildCostEstimate([panel(2, 50, null)]);
      expect(e.untypedCount).toBe(2);
      expect(e.untypedArea).toBe(100);
      expect(e.infillCost).toBe(0);
      expect(e.total).toBe(0);
    });

    it("still count toward coverage and facade area", () => {
      const e = buildCostEstimate([
        { edge: 0, cells: [{ area: 50, type: "vision" }, { area: 50, type: null }], framingLength: 0 },
      ]);
      expect(e.cellCount).toBe(2);
      expect(e.typedCount).toBe(1);
      expect(e.facadeArea).toBe(100);
      expect(e.complete).toBe(false);
    });

    it("mark the estimate complete once every cell is typed", () => {
      expect(buildCostEstimate([panel(3, 10, "spandrel")]).complete).toBe(true);
    });

    it("make the total a FLOOR — pricing them can only add", () => {
      const partial = buildCostEstimate([
        { edge: 0, cells: [{ area: 50, type: "vision" }, { area: 50, type: null }], framingLength: 0 },
      ]);
      const full = buildCostEstimate([panel(2, 50, "vision")]);
      expect(partial.total).toBeLessThan(full.total);
    });
  });

  it("makes a SUBDIVIDED panel cost more than an undivided one of the same area", () => {
    // The point of pricing framing per foot: two panels with identical glass area but
    // different grids are NOT the same price. Area-only pricing would say they are.
    const coarse = buildCostEstimate([panel(1, 200, "vision", 60)]);
    const fine = buildCostEstimate([panel(4, 50, "vision", 140)]);
    expect(fine.byType.vision.area).toBeCloseTo(coarse.byType.vision.area, 6);
    expect(fine.total).toBeGreaterThan(coarse.total);
  });

  it("reports cost per ft² over the WHOLE facade, untyped area included", () => {
    const e = buildCostEstimate([panel(2, 100, "vision")]);
    expect(e.facadeArea).toBe(200);
    expect(e.costPerSqFt).toBeCloseTo(e.total / 200, 6);
  });

  it("is $0 with nothing drawn, not an error", () => {
    const e = buildCostEstimate([]);
    expect(e.total).toBe(0);
    expect(e.costPerSqFt).toBe(0); // no division by zero
    expect(e.complete).toBe(true);
  });

  it("ignores negative areas and framing lengths rather than crediting them", () => {
    const e = buildCostEstimate([
      { edge: 0, cells: [{ area: -50, type: "vision" }], framingLength: -10 },
    ]);
    expect(e.total).toBe(0);
    expect(e.framingLength).toBe(0);
  });

  it("honours custom rates — the defaults are a starting point, not the model", () => {
    const e = buildCostEstimate([panel(1, 100, "vision")], {
      vision: 1,
      spandrel: 1,
      opaque: 1,
      framing: 1,
    });
    expect(e.total).toBe(100);
    expect(e.byType.vision.rate).toBe(1);
  });
});

describe("formatting", () => {
  it("prints whole grouped dollars — no false precision", () => {
    expect(fmtMoney(1284000)).toBe("$1,284,000");
    expect(fmtMoney(1284.6)).toBe("$1,285");
    expect(fmtMoney(0)).toBe("$0");
  });

  it("prints a rate with the unit it is charged in", () => {
    expect(fmtRate(95, "sqft")).toBe("$95/ft²");
    expect(fmtRate(48, "ft")).toBe("$48/ft");
  });
});
