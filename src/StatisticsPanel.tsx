/**
 * StatisticsPanel.tsx
 *
 * The Statistics window: a set of toggle chips, and every live reading they turn on.
 *
 * Readings are a SET, not a one-of-N pick — General and Irradiance can be read at the
 * same time, which is how they are actually used (a number is checked against a
 * diagram). Every selected reading renders, stacked, and the window grows downward.
 *
 * Split out of PolylineTool because it is PRESENTATIONAL — it owns no state, computes
 * nothing the rest of the app needs, and simply renders numbers it is handed. It was the
 * single largest JSX block in that file, and every readout edit meant a diff against the
 * same file as the pointer handlers and the render loop.
 *
 * The readouts render HERE rather than on the canvas (where they used to float, anchored
 * to a wall border) so that zooming in to work on something does not push the numbers
 * off-screen — which is exactly when they are wanted.
 */
import type { RefObject, CSSProperties } from "react";
import RadiationDiagram from "./RadiationDiagram";
import InsolationChart from "./InsolationChart";
import { STATS_MODES, CELL_TYPE_LABELS, type StatsMode, type CellType } from "./core/displayModes";
import { fmtMoney, fmtRate, type CostEstimate } from "./core/cost";
import { buildRadiationMatrix } from "./core/radiation";
import { flattenPerimeter, perimeterLength, enclosedArea, type Perimeter } from "./core/geometry";
import { fmtLength, fmtArea } from "./core/units";
import type { SolarSettings } from "./core/solar";
import type { UnravelResult } from "./core/unravel";

/** The WWR figures for one wall border, as computed by the editor. */
export interface PanelWWR {
  wallArea: number;
  visionCount: number;
  cellCount: number;
  typedCount: number;
  wwrGross: number;
  wwrNet: number;
}

/** The VLT figures for one wall border, as computed by the editor. */
export interface PanelVLT {
  visionVLT: number;
  spandrelVLT: number;
  opaqueVLT: number;
  effectiveAperture: number;
  cellCount: number;
  typedCount: number;
}

interface StatisticsPanelProps {
  /** Every reading the user has SELECTED, including ones that cannot apply in this phase. */
  statsModes: StatsMode[];
  /** The subset actually SHOWN here, in STATS_MODES order. */
  activeStatsModes: StatsMode[];
  /** Turn one reading on or off — the selection is a set, not a one-of-N pick. */
  onToggleStatsMode: (m: StatsMode) => void;
  /** True in the Elevations phase; gates the wall-orientation readings. */
  unravelOn: boolean;
  perimeter: Perimeter;
  unravelResult: UnravelResult | null;
  /** Resolved height of one wall border (model feet). */
  effectiveHeight: (edge: number) => number;
  /** Distinct cell-shape count, for the General readout. */
  uniqueCellCount: number;
  /**
   * The wall border the PER-PANEL readings (Irradiance / Insolation / WWR / VLT) describe:
   * the focused border if one is selected, else the left-most elevation. -1 when no such
   * reading is on screen. Resolved by the editor rather than here, so the numbers below and
   * the RED ANCHOR FRAME the canvas draws can never disagree about which wall is meant.
   */
  anchorPanel: number;
  /** True compass bearing per wall border, for the solar readings. */
  faceBearings: Record<number, number>;
  activeSolar: SolarSettings;
  panelWWR: (edge: number) => PanelWWR;
  panelVLT: (edge: number) => PanelVLT;
  /**
   * Whole-facade cost estimate, or null outside the Elevations phase (nothing to price).
   * Unlike the readings above this is a PROJECT total, not a per-panel one — a budget is a
   * project figure — so it ignores the anchor entirely.
   */
  costEstimate: CostEstimate | null;
  /** Window stacking — clicking the panel brings it to the front. */
  isFront: boolean;
  onBringToFront: () => void;
  winRef: RefObject<HTMLDivElement>;
  winStyle: CSSProperties | undefined;
}

export default function StatisticsPanel({
  statsModes,
  activeStatsModes,
  onToggleStatsMode,
  unravelOn,
  perimeter,
  unravelResult,
  effectiveHeight,
  uniqueCellCount,
  anchorPanel,
  faceBearings,
  activeSolar,
  panelWWR,
  panelVLT,
  costEstimate,
  isFront,
  onBringToFront,
  winRef,
  winStyle,
}: StatisticsPanelProps) {
  /** Is this reading currently on screen? */
  const shown = (m: StatsMode) => activeStatsModes.includes(m);
  /** Selected but filtered out by the phase — drives the one explanatory line below. */
  const hiddenByPhase = statsModes.filter((m) => !activeStatsModes.includes(m));
  /** Label a reading when several are stacked, so each block says what it is. */
  const heading = (m: StatsMode) =>
    activeStatsModes.length > 1 ? (
      <div className="stats-readout__title">{STATS_MODES.find((s) => s.key === m)?.label ?? m}</div>
    ) : null;
  /**
   * The segment the per-panel readings are about, resolved from the shared anchor index.
   * The same border the canvas glows red — which is now the ONLY statement of which wall
   * these numbers belong to, the in-panel caption that used to repeat it having been
   * dropped as redundant with the glow.
   */
  const anchorSeg =
    anchorPanel >= 0
      ? (unravelResult?.segments.find((s) => s.index === anchorPanel) ?? null)
      : null;

  return (
    <>
    {/* ===== STATISTICS WINDOW =====
        Top of the RIGHT column, under the utility bar. Kept separate from Display
        because it answers a different question: Display changes how the drawing
        LOOKS, while this chooses which measurements to READ off it.
        `mini--tall` because several readings stack here — it needs the taller cap
        before its body starts scrolling. */}
    <div
      // Anchor for the guided demo's final step (see core/demoTour.ts) — the tour rings
      // whichever element carries the matching data-tour value.
      data-tour="stats"
      className={`mini mini--tall ${isFront ? "mini--front" : ""}`}
      ref={winRef}
      style={winStyle}
      role="region"
      aria-label="Statistics"
      onPointerDownCapture={onBringToFront}
    >
      <div className="mini__titlebar">
        <span className="mini__title">Statistics</span>
      </div>

      <div className="mini__body panel-body">
        <section className="panel__section">
          {/* MODE PICKER — TOGGLE CHIPS, not a dropdown. Each reading turns on or off
              independently and every one that is on renders below, so General and
              Irradiance can be read side by side instead of flipped between. A dropdown
              cannot express that: its whole grammar is one-of-N.
              Chips wrap onto as many lines as they need and the panel grows to fit. */}
          <div className="stats-chips" role="group" aria-label="Statistics readings">
            {STATS_MODES.map(({ key, label, unravelOnly }) => {
              const gated = unravelOnly && !unravelOn;
              const on = statsModes.includes(key);
              return (
                <button
                  key={key}
                  className={`stats-chip ${on ? "is-active" : ""}`}
                  role="switch"
                  aria-checked={on}
                  disabled={gated}
                  onClick={() => onToggleStatsMode(key)}
                  title={
                    gated
                      ? `${label} — needs a wall orientation, so it reads in the Elevations phase`
                      : on
                        ? `Hide ${label}`
                        : `Show ${label}`
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          {/* Nothing selected renders NOTHING: the chips are directly above, unfilled, and
              already say what to do. A line of prose repeating it only takes height off the
              canvas and re-explains a control the user just switched off on purpose.
              (Contrast the phase notice below, which reports something NOT visible — a
              reading that is on but cannot apply here.) */}
          {/* Selections that cannot apply here are KEPT, not dropped — they return with the
              Elevations phase — so account for them instead of leaving a silent gap. */}
          {hiddenByPhase.length > 0 && (
            <div className="panel__hint">
              {hiddenByPhase.length} reading{hiddenByPhase.length === 1 ? "" : "s"} need a wall
              orientation — switch to <b>Elevations</b> to see {hiddenByPhase.length === 1 ? "it" : "them"}.
            </div>
          )}
          {/* THE READOUTS THEMSELVES. They used to float on the CANVAS, anchored to a
              wall border's left edge, which meant they slid off-screen (or behind the
              zoomed geometry) exactly when the user zoomed in to work on something.
              Here they stay put and legible at any zoom, next to the mode that
              selected them. Each block keeps its original computation — only the
              wrapper changed from an absolutely-positioned overlay to a panel
              readout. */}
          {/* GENERAL — elevations: totals for the WHOLE unrolled strip. */}


          {shown("general") && unravelOn && unravelResult && unravelResult.segments.length > 0 && (() => {
            return (
              <div
                className="stats-readout"
                role="region"
                aria-label="Live statistics"
              >
                {heading("general")}
                <div className="readout">
                  <span className="readout__key">Segments</span>
                  <span className="readout__val">{unravelResult.segments.length}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Unwrapped length</span>
                  <span className="readout__val">{fmtLength(unravelResult.totalLength, 3)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Total area</span>
                  <span className="readout__val">
                    {fmtArea(
                      unravelResult.segments.reduce((sum, s) => sum + s.length * effectiveHeight(s.index), 0),
                      3,
                    )}
                  </span>
                </div>
                <div className="readout">
                  <span className="readout__key">Unique cells</span>
                  <span className="readout__val">{uniqueCellCount}</span>
                </div>
              </div>
            );
          })()}
          {/* SOLAR RADIATION DIAGRAMS — the Irradiance (W/m²) month×hour heatmap and its
              energy companion, the Insolation (kWh/m²) monthly bar chart, for ONE wall
              border. Both anchor exactly like the General overlay: the SELECTED wall
              border if one is focused, else the LEFT-MOST elevation. The matrix is built
              from the live Solar Study settings (activeSolar: latitude, north offset) and
              that wall's TRUE compass orientation (faceBearings) — same source of truth as
              the Orientation Heatmap, so the diagrams are real per-facade data. They share
              one matrix (the chart reads its monthlyTotals, the heatmap its cell grid).
              Both read the SELECTED wall border, else the left-most elevation. */}
          {(shown("irradiance") || shown("insolation")) &&
            unravelOn &&
            anchorSeg &&
            (() => {
              const bearing = faceBearings[anchorSeg.index];
              if (bearing === undefined) return null; // no resolvable orientation (open loop)
              // ONE matrix serves both diagrams (the heatmap reads its cell grid, the
              // chart its monthlyTotals), so building it once covers either or BOTH being
              // on — which multi-select now makes possible.
              const matrix = buildRadiationMatrix(activeSolar, bearing);
              return (
                <>
                  {shown("irradiance") && (
                    <div className="stats-readout" role="region" aria-label="Irradiance diagram">
                      {heading("irradiance")}
                      <RadiationDiagram matrix={matrix} />
                    </div>
                  )}
                  {shown("insolation") && (
                    <div className="stats-readout" role="region" aria-label="Insolation chart">
                      {heading("insolation")}
                      <InsolationChart matrix={matrix} />
                    </div>
                  )}
                </>
              );
            })()}
          {/* WWR — the Window-to-Wall Ratio for ONE wall border, anchored exactly like the
              General / solar readings (the SELECTED border if focused, else the LEFT-MOST
              elevation). Window = the panel's VISION cells; wall = the whole panel rect.
              Shown both standard ways: Gross Opening (frames/mullions counted as window)
              and Net Glazing (frames excluded). */}
          {shown("wwr") && unravelOn && anchorSeg && (() => {
            const w = panelWWR(anchorSeg.index);
            const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
            // PROVISIONAL: the WWR is only a FINAL figure once every cell is typed. Until then
            // untyped cells are counted as opaque wall, so flag the result as in-progress (a
            // "Typed N / M" coverage line + a "*" on the ratios + a footnote) rather than
            // presenting an incomplete number as authoritative.
            const untyped = w.cellCount - w.typedCount;
            const incomplete = untyped > 0;
            const star = incomplete ? " *" : "";
            return (
              <div
                className="stats-readout"
                role="region"
                aria-label="Window-to-wall ratio"
              >
                {heading("wwr")}
                <div className="readout">
                  <span className="readout__key">Wall area</span>
                  <span className="readout__val">{fmtArea(w.wallArea, 2)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Vision cells</span>
                  <span className="readout__val">{w.visionCount} / {w.cellCount}</span>
                </div>
                <div className={`readout ${incomplete ? "readout--provisional" : ""}`}>
                  <span className="readout__key">WWR · Gross Opening</span>
                  <span className="readout__val">{pct(w.wwrGross)}{star}</span>
                </div>
                <div className={`readout ${incomplete ? "readout--provisional" : ""}`}>
                  <span className="readout__key">WWR · Net Glazing</span>
                  <span className="readout__val">{pct(w.wwrNet)}{star}</span>
                </div>
                {/* Coverage + provisional warning sit LAST, after all the WWR figures. */}
                <div className={`readout ${incomplete ? "readout--warn" : ""}`}>
                  <span className="readout__key">Assigned cells</span>
                  <span className="readout__val">{w.typedCount} / {w.cellCount}{incomplete ? " ⚠" : ""}</span>
                </div>
                {incomplete && (
                  <div className="stats-dropdown__note">
                    * provisional — {untyped} cell{untyped === 1 ? "" : "s"} unassigned
                  </div>
                )}
              </div>
            );
          })()}
          {/* VLT — the Visible Light Transmittance of ONE wall border, anchored exactly like
              the General / WWR / solar readings (the SELECTED border if focused, else the
              LEFT-MOST elevation). Lists the industry-standard VLT assigned to each cell type
              (Vision admits light; Spandrel / Opaque are 0) and the wall's EFFECTIVE VLT —
              the glass-area-weighted transmittance over the whole panel (the daylighting
              effective aperture). */}
          {shown("vlt") && unravelOn && anchorSeg && (() => {
            const v = panelVLT(anchorSeg.index);
            const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
            // PROVISIONAL: like WWR, the effective aperture is only FINAL once every cell is
            // typed (untyped cells admit no light here, biasing the figure low). Flag coverage
            // + mark the computed aperture with "*" until the wall border is fully typed.
            const untyped = v.cellCount - v.typedCount;
            const incomplete = untyped > 0;
            return (
              <div
                className="stats-readout"
                role="region"
                aria-label="Visible light transmittance"
              >
                {heading("vlt")}
                <div className="readout">
                  <span className="readout__key">Vision</span>
                  <span className="readout__val">{pct(v.visionVLT)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Spandrel</span>
                  <span className="readout__val">{pct(v.spandrelVLT)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Opaque</span>
                  <span className="readout__val">{pct(v.opaqueVLT)}</span>
                </div>
                <div className={`readout ${incomplete ? "readout--provisional" : ""}`}>
                  <span className="readout__key">Effective aperture</span>
                  <span className="readout__val">{pct(v.effectiveAperture)}{incomplete ? " *" : ""}</span>
                </div>
                {/* Coverage + provisional warning sit LAST, after all the VLT figures. */}
                <div className={`readout ${incomplete ? "readout--warn" : ""}`}>
                  <span className="readout__key">Assigned cells</span>
                  <span className="readout__val">{v.typedCount} / {v.cellCount}{incomplete ? " ⚠" : ""}</span>
                </div>
                {incomplete && (
                  <div className="stats-dropdown__note">
                    * provisional — {untyped} cell{untyped === 1 ? "" : "s"} unassigned
                  </div>
                )}
              </div>
            );
          })()}
          {/* COST — an order-of-magnitude estimate for the WHOLE facade, not one border, so
              it draws no anchor and ignores the focused panel. Structured as a bill: what
              each glazing type contributes, then framing, then the total — because the
              useful question at sketch stage is never "what is the number" alone, it is
              "which part of the number would my next decision move".
              The per-line RATES are printed rather than hidden, so the assumptions behind
              the total are on screen; they live in core/cost.ts (DEFAULT_COST_RATES) and
              are the single place to change them. */}
          {shown("cost") && unravelOn && costEstimate && costEstimate.cellCount > 0 && (() => {
            const c = costEstimate;
            const star = c.complete ? "" : " *";
            return (
              <div className="stats-readout" role="region" aria-label="Estimated cost">
                {heading("cost")}
                {/* One line per glazing type actually USED. Types with no cells are omitted
                    rather than listed as $0 — an empty line is noise, not information. */}
                {(Object.keys(CELL_TYPE_LABELS) as CellType[]).map((t) => {
                  const line = c.byType[t];
                  if (line.count === 0) return null;
                  return (
                    <div className="readout" key={t}>
                      <span className="readout__key">
                        {CELL_TYPE_LABELS[t]}
                        <span className="readout__note"> {fmtArea(line.area, 0)} @ {fmtRate(line.rate, "sqft")}</span>
                      </span>
                      <span className="readout__val">{fmtMoney(line.cost)}</span>
                    </div>
                  );
                })}
                {/* Framing is its own line because it is its own decision: subdividing a
                    panel adds cost here without changing a single glazing assignment. */}
                <div className="readout">
                  <span className="readout__key">
                    Framing
                    <span className="readout__note"> {fmtLength(c.framingLength, 0)} @ {fmtRate(c.framingRate, "ft")}</span>
                  </span>
                  <span className="readout__val">{fmtMoney(c.framingCost)}</span>
                </div>
                {/* UNPRICED remainder — untyped cells are measured but never given a
                    guessed rate, so they are shown as what they are: work not yet specified. */}
                {!c.complete && (
                  <div className="readout readout--warn">
                    <span className="readout__key">
                      Unpriced
                      <span className="readout__note"> {c.untypedCount} cell{c.untypedCount === 1 ? "" : "s"}, {fmtArea(c.untypedArea, 0)}</span>
                    </span>
                    <span className="readout__val">⚠</span>
                  </div>
                )}
                <div className={`readout ${c.complete ? "" : "readout--provisional"}`}>
                  <span className="readout__key">Estimated total</span>
                  <span className="readout__val">{fmtMoney(c.total)}{star}</span>
                </div>
                {/* The benchmark figure — what facade work is actually compared in, and the
                    one that survives a change of building size. */}
                <div className={`readout ${c.complete ? "" : "readout--provisional"}`}>
                  <span className="readout__key">Cost / area</span>
                  <span className="readout__val">{fmtRate(c.costPerSqFt, "sqft")}{star}</span>
                </div>
                <div className={`readout ${c.complete ? "" : "readout--warn"}`}>
                  <span className="readout__key">Assigned cells</span>
                  <span className="readout__val">{c.typedCount} / {c.cellCount}{c.complete ? "" : " ⚠"}</span>
                </div>
                {/* Two different kinds of footnote, so they take two different treatments:
                    the incomplete case is a CAUTION about the number's validity, the complete
                    case is a neutral statement of what the number covers. */}
                {c.complete ? (
                  <div className="stats-readout__basis">
                    Order-of-magnitude only — supply + install at the rates shown; no engineering,
                    escalation, or regional factor.
                  </div>
                ) : (
                  <div className="stats-dropdown__note">
                    * provisional — {c.untypedCount} cell{c.untypedCount === 1 ? "" : "s"} unassigned
                    and unpriced, so the total is a FLOOR: assigning them can only add to it.
                  </div>
                )}
              </div>
            );
          })()}
          {/* PLAN-PHASE GENERAL — footprint totals, shown from the FIRST FRAME rather
              than waiting on a closed perimeter. An empty canvas reads
              "Walls 0 · Perimeter 0 · Footprint area 0 · Extents 0 × 0" and every figure
              climbs as vertices go down, so the panel teaches what it measures before
              there is anything to measure — and never swaps its content for a
              "close the perimeter first" notice.
              Extents are curve-accurate (a bulging curve is respected, not just its
              vertices). */}
          {shown("general") && !unravelOn && (() => {
            const outline = flattenPerimeter(perimeter);
            // Bounds default to a zero box so an empty canvas reports 0 × 0 instead of
            // the ±Infinity a bare reduce would leave behind.
            let minX = 0;
            let maxX = 0;
            let minY = 0;
            let maxY = 0;
            if (outline.length > 0) {
              minX = Infinity;
              maxX = -Infinity;
              minY = Infinity;
              maxY = -Infinity;
              for (const q of outline) {
                if (q.x < minX) minX = q.x;
                if (q.x > maxX) maxX = q.x;
                if (q.y < minY) minY = q.y;
                if (q.y > maxY) maxY = q.y;
              }
            }
            // A CLOSED loop has one wall per vertex (the last edge joins back to the
            // first); an OPEN polyline has one per SEGMENT, so n-1.
            const wallCount = perimeter.closed
              ? perimeter.vertices.length
              : Math.max(0, perimeter.vertices.length - 1);
            // Enclosed area is only defined once the loop closes — an open chain
            // bounds nothing, so it reads 0 rather than a misleading part-figure.
            const area = perimeter.closed ? enclosedArea(perimeter) : 0;
            return (
              <div
                className="stats-readout"
                role="region"
                aria-label="Live statistics"
              >
                {heading("general")}
                <div className="readout">
                  <span className="readout__key">Walls</span>
                  <span className="readout__val">{wallCount}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Perimeter</span>
                  <span className="readout__val">{fmtLength(perimeterLength(perimeter), 3)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Footprint area</span>
                  <span className="readout__val">{fmtArea(area, 3)}</span>
                </div>
                <div className="readout">
                  <span className="readout__key">Extents</span>
                  <span className="readout__val">
                    {fmtLength(maxX - minX, 2)} × {fmtLength(maxY - minY, 2)}
                  </span>
                </div>
              </div>
            );
          })()}
        </section>
      </div>

    </div>
    </>
  );
}
