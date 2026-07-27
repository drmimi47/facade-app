/**
 * core/cost.ts
 *
 * ORDER-OF-MAGNITUDE COST ESTIMATE for the drawn facade — the "Cost" statistics reading.
 *
 * The model is deliberately simple and fully visible, because a facade cost at sketch stage
 * is a SCALING TOOL, not a bid: it answers "does adding vision glass here move the number by
 * 2% or 20%?" and "which elevation carries the cost?". Anything more elaborate would imply a
 * precision the geometry does not have.
 *
 * Two drivers, which is what actually separates one curtain wall from another at this stage:
 *
 *   1. INFILL — priced per ft² of cell area, at a rate PER GLAZING TYPE. Vision glass is an
 *      insulated unit and costs the most; spandrel is a cheaper opacified assembly; opaque
 *      infill (metal panel, stone) cheaper still. This is why the number moves when the user
 *      paints a different type onto a run of cells.
 *   2. FRAMING — priced per LINEAR FOOT of mullion. Framing is not a rounding error in
 *      curtain wall: a finely divided panel costs far more than a coarse one of identical
 *      area, and area-only pricing would say they cost the same. Subdividing a panel with
 *      the Centerlines tool therefore RAISES the estimate, which is the true behaviour.
 *
 * KNOWN SIMPLIFICATION: infill is priced on the cell's full OPENING area, while framing is
 * priced separately per foot — so the strip of area the mullion itself occupies is counted
 * twice. It is a thin band relative to a cell, and it is well inside the accuracy these
 * placeholder rates carry, but it is a deliberate approximation rather than an oversight.
 * Pricing infill on the glass rect instead (cellGlassRect) would remove it, at the cost of
 * making the estimate depend on framing offsets the user may not have set yet.
 *
 * UNTYPED CELLS ARE NOT PRICED. Guessing a rate for a cell the user has not specified would
 * bury an assumption inside a number presented as a result. They are reported as an unpriced
 * remainder instead, and the total is flagged provisional until the facade is fully typed —
 * the same treatment WWR and VLT already give their own incomplete state.
 *
 * Everything here is PURE: geometry + rates in, a breakdown out. No React, no formatting
 * decisions beyond the currency helper at the bottom.
 */
import type { CellType } from "./displayModes";

/**
 * Installed cost assumptions, in US dollars. These are BROAD industry placeholders for a
 * conventional aluminium-framed curtain wall — supply and install, no engineering, no
 * escalation, no regional factor.
 *
 * THIS IS THE PLACE TO CHANGE THEM. Like CELL_TYPE_VLT, these are a single source of truth
 * the readout also prints on screen, so the assumption behind every line is visible rather
 * than buried here. Real numbers vary by market, system, performance spec, and year — a
 * project with a live budget should replace these with its own.
 */
export interface CostRates {
  /** $/ft² of cell area — vision glazing (insulated glass unit). */
  vision: number;
  /** $/ft² of cell area — spandrel (opacified / back-painted glass over insulation). */
  spandrel: number;
  /** $/ft² of cell area — opaque infill (metal panel, stone, louvre). */
  opaque: number;
  /** $/linear ft of framing — mullions and the panel's perimeter frame. */
  framing: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  vision: 95,
  spandrel: 70,
  opaque: 60,
  framing: 48,
};

/** One priced cell: its area (ft²) and the glazing type assigned to it, or null if untyped. */
export interface CostCell {
  area: number;
  type: CellType | null;
}

/** One wall border's contribution to the estimate. */
export interface PanelCostInput {
  /** Original edge index, so a per-panel breakdown can be traced back to the drawing. */
  edge: number;
  cells: CostCell[];
  /**
   * Linear feet of framing on this panel: its perimeter frame plus every interior grid
   * line. Computed by the caller, which owns the grid geometry.
   */
  framingLength: number;
}

/** What one glazing type contributes to the total. */
export interface CostTypeLine {
  count: number;
  area: number;
  rate: number;
  cost: number;
}

export interface CostEstimate {
  byType: Record<CellType, CostTypeLine>;
  /** Cells with no type assigned — counted and measured, but NOT priced. */
  untypedCount: number;
  untypedArea: number;
  cellCount: number;
  typedCount: number;
  /** Σ infill cost over every TYPED cell. */
  infillCost: number;
  framingLength: number;
  /** The $/ft this estimate charged for framing — carried so the readout can show it
   *  beside the line, the way each type line shows its own rate. */
  framingRate: number;
  framingCost: number;
  /** infillCost + framingCost. */
  total: number;
  /** Σ cell area over the whole facade, typed or not — the denominator below. */
  facadeArea: number;
  /**
   * total / facadeArea — the figure facade work is actually benchmarked in, and the one
   * that survives a change of building size. Zero when there is no area.
   */
  costPerSqFt: number;
  /**
   * False while any cell is untyped: the total is then a floor, not an estimate, because
   * the unpriced remainder can only ADD to it.
   */
  complete: boolean;
}

const emptyLine = (rate: number): CostTypeLine => ({ count: 0, area: 0, rate, cost: 0 });

/**
 * Price the whole facade from its panels.
 *
 * Sums infill by type and framing by length, and reports the pieces alongside the total so
 * the user can see WHERE the money is rather than being handed one opaque figure. An empty
 * input is a valid $0 estimate, not an error — a project with nothing drawn costs nothing.
 */
export function buildCostEstimate(
  panels: PanelCostInput[],
  rates: CostRates = DEFAULT_COST_RATES,
): CostEstimate {
  const byType: Record<CellType, CostTypeLine> = {
    vision: emptyLine(rates.vision),
    spandrel: emptyLine(rates.spandrel),
    opaque: emptyLine(rates.opaque),
  };
  let untypedCount = 0;
  let untypedArea = 0;
  let cellCount = 0;
  let facadeArea = 0;
  let framingLength = 0;

  for (const panel of panels) {
    framingLength += Math.max(0, panel.framingLength);
    for (const cell of panel.cells) {
      // A degenerate (fully framed away, or zero-width) cell contributes no area and no
      // cost, but it is still a cell — it is counted so coverage reads honestly.
      const area = Math.max(0, cell.area);
      cellCount++;
      facadeArea += area;
      if (cell.type === null) {
        untypedCount++;
        untypedArea += area;
        continue;
      }
      const line = byType[cell.type];
      line.count++;
      line.area += area;
      line.cost += area * line.rate;
    }
  }

  const infillCost = byType.vision.cost + byType.spandrel.cost + byType.opaque.cost;
  const framingCost = framingLength * rates.framing;
  const total = infillCost + framingCost;
  return {
    byType,
    untypedCount,
    untypedArea,
    cellCount,
    typedCount: cellCount - untypedCount,
    infillCost,
    framingLength,
    framingRate: rates.framing,
    framingCost,
    total,
    facadeArea,
    costPerSqFt: facadeArea > 0 ? total / facadeArea : 0,
    complete: untypedCount === 0,
  };
}

/**
 * Whole dollars, grouped — "$1,284,000". No cents: this estimate is not accurate to the
 * dollar, and printing decimals on it would claim otherwise.
 */
export function fmtMoney(v: number): string {
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

/** A rate, as it is printed beside the line it drives — "$95/ft²", "$48/ft". */
export function fmtRate(v: number, per: "sqft" | "ft"): string {
  return `$${Math.round(v)}/${per === "sqft" ? "ft²" : "ft"}`;
}
