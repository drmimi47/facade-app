/**
 * OverviewMap.tsx
 *
 * A small, always-visible NAVIGATOR overlay anchored inside the canvas stage
 * (bottom-left, above the Floor plate / Subtractive / Additive button cluster).
 * It shows a FIT-TO-BOX, centred picture of WHATEVER THE MAIN CANVAS SHOWS — the
 * WHOLE footprint perimeter in the draw/edit view, or the WHOLE unrolled PANEL STRIP
 * in the unravel/elevation view — so the user can glance the entire scope even while
 * the main canvas is zoomed in hard on one part of a very large shape/elevation.
 *
 * It reuses the proven layers — NO geometry or drawing is duplicated:
 *   - `fitViewport(perimeter, w, h, padding)` (core/viewport.ts) frames the shape
 *     into the overview's own pixel box (degenerate spans floored to an epsilon,
 *     so empty / single-point / straight-line inputs never produce a NaN scale).
 *   - the pure `render()` (core/renderer.ts) paints the perimeter with a NEUTRAL
 *     RenderState (no transient edit/unravel feedback), so the overview reads
 *     visually consistent with the main canvas and honours the same CSS tokens.
 *
 * CURRENT-VIEW INDICATOR: a rectangle marks the portion of the model currently
 * visible in the MAIN canvas. The main view's visible model rectangle is found by
 * unprojecting the main canvas corners (`toModel(mainViewport, 0,0)` →
 * `toModel(mainViewport, mainW, mainH)`); those two model points are then
 * projected through the overview's OWN fit viewport (`toScreen`) and stroked. This
 * is the feature's main payoff: at a glance the user sees WHERE they are looking
 * inside the whole shape.
 *
 * CLICK TO JUMP: the overview is a FIXED navigator — it no longer moves around the
 * stage. Instead, clicking anywhere inside it recentres the MAIN canvas on the
 * clicked spot: the click pixel is unprojected through the overview's OWN fit
 * viewport into model space, and handed to `onJumpTo`, which pans the main view
 * there at its current zoom. This turns the mini-map into a direct "look here"
 * control, matching how navigators behave in professional design tools.
 *
 * All visual values come from the `=== OVERVIEW MAP ===` token group in
 * styles.css; nothing visual is hardcoded here.
 */

import { useLayoutEffect, useRef } from "react";
import type { Perimeter } from "./core/geometry";
import { fitViewport, toModel, toScreen, type Viewport } from "./core/viewport";
import { unravelBoundsPerimeter } from "./core/unravel";
import { render, type RenderState, type UnravelDraw } from "./core/renderer";

/** Read a CSS custom property off an element, with a fallback (mirrors renderer). */
function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}
function cssNum(el: HTMLElement, name: string, fallback: number): number {
  const v = parseFloat(cssVar(el, name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

interface OverviewMapProps {
  /** The LIVE editor perimeter — the overview reflects edits immediately. */
  perimeter: Perimeter;
  /** The MAIN canvas viewport, used to compute the current-view indicator rect. */
  viewport: Viewport;
  /** The MAIN canvas pixel size (CSS px) — its visible model rect is derived from this. */
  mainSize: { w: number; h: number };
  /** Snap grid spacing — passed through to the neutral RenderState (drives no drawing). */
  gridSpacing: number;
  /**
   * Whether the main canvas is in the UNRAVEL / elevation view. When true the
   * overview frames the unrolled PANEL STRIP (from {@link unravelDraws}) instead of
   * the footprint, mirroring whatever the main canvas shows — so the same view
   * model space is used and the current-view indicator stays meaningful in BOTH views.
   */
  unravelOn: boolean;
  /**
   * The resolved unravel panels (segment + height + cells + divisions) to draw in
   * the overview while {@link unravelOn}. Null/empty falls back to the footprint.
   */
  unravelDraws: UnravelDraw[] | null;
  /**
   * Recentre the MAIN canvas on a model-space point. Called with the point the user
   * clicked inside the overview (already unprojected through the overview's own fit
   * viewport), so the main view can pan there at its current zoom.
   */
  onJumpTo: (model: { x: number; y: number }) => void;
}

export default function OverviewMap({
  perimeter,
  viewport,
  mainSize,
  gridSpacing,
  unravelOn,
  unravelDraws,
  onJumpTo,
}: OverviewMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The fit viewport used to draw the CURRENT frame, stashed so the click handler
  // can unproject a clicked pixel into the SAME model space that was rendered.
  const fitRef = useRef<Viewport | null>(null);

  // Repaint whenever the perimeter, the main viewport, the main size, or the
  // indicator toggle changes. We FIT the whole shape into the overview's pixel box
  // and render it with a neutral state, then overlay the current-view rectangle.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    // Choose what to frame: in the UNRAVEL view, the unrolled panel strip (same
    // model space the main canvas uses there); otherwise the footprint perimeter.
    // This keeps the overview a faithful mini-map of whatever the main view shows.
    const useUnravel = unravelOn && unravelDraws != null && unravelDraws.length > 0;
    const pad = cssNum(canvas, "--overview-padding", 8);

    // Frame the chosen scene into this box. fitViewport floors degenerate spans to
    // an epsilon, so empty / single-point / straight-line inputs stay finite.
    //
    // OVERVIEW_MIN_SCALE: the navigator box is tiny (≈200×150 px) but the model it
    // frames can be huge — especially a WIDE many-panel unravel strip (the sum of
    // every wall length). The main canvas's 0.25 px/unit zoom-OUT floor would clamp
    // the fit and let the strip OVERFLOW the box (only its centre showing), so the
    // overview passes a near-zero floor: it must always frame the FULL extent.
    const OVERVIEW_MIN_SCALE = 1e-6;
    let fit: Viewport;
    if (useUnravel) {
      // Bounds = each panel rectangle (baseline → its own height), reusing the same
      // helper the main view's fit uses, so the strip frames identically. Built from
      // ALL unravelDraws (every panel), so the FULL width and the TALLEST height frame.
      const segments = unravelDraws!.map((d) => d.seg);
      const heightById = new Map(unravelDraws!.map((d) => [d.seg.index, d.height]));
      const bounds = unravelBoundsPerimeter(segments, (seg) => heightById.get(seg.index) ?? 0);
      fit = fitViewport(bounds, w, h, pad, OVERVIEW_MIN_SCALE);
    } else {
      fit = fitViewport(perimeter, w, h, pad, OVERVIEW_MIN_SCALE);
    }
    // Stash the fit so onClick unprojects into the exact model space just drawn.
    fitRef.current = fit;

    // Neutral RenderState framed by the fit viewport, with NO transient edit
    // feedback. In unravel mode we pass the resolved panels so render()'s unravel
    // branch draws the strip — but as BOUNDARIES ONLY (outlineOnly /
    // unravelBoundariesOnly below): just the panel rectangles, no dimension labels,
    // cells, divisions or floor plates. In perimeter mode it draws the footprint
    // OUTLINE only (no vertex dots). Either way it stays a clean, glanceable mini-map.
    const state: RenderState = {
      perimeter,
      viewport: fit,
      cursorModel: null,
      drawing: false,
      rubberBand: false,
      selectedVertex: -1,
      hoveredVertex: -1,
      handleVertex: -1,
      insertPreview: null,
      gridSpacing,
      unravel: useUnravel ? unravelDraws : null,
      hoveredUnravelEdge: -1,
      hoveredUnravelTop: -1,
      selectedUnravelPanel: -1,
      highlightEdge: -1,
      floorPlates: null,
      floorPlatePreview: null,
      dividePreview: null,
      // OVERVIEW opt-ins: show JUST the shape (no vertex dots / edit overlays) in
      // the perimeter view, and JUST the panel rectangle boundaries (no dimension
      // labels / cells / divisions / floor plates / emphasis) in the unravel view.
      outlineOnly: true,
      unravelBoundariesOnly: true,
    };
    render(ctx, canvas, w, h, dpr, state);

    // CURRENT-VIEW INDICATOR. render() leaves the transform at (dpr,0,0,dpr,0,0),
    // so we keep drawing in CSS px. Unproject the MAIN canvas corners to model
    // space (screen +Y down flips to model +Y up, so top-left screen → max-Y model
    // and bottom-right screen → min-Y model), then project those model points
    // through the overview's OWN fit viewport to get the rect in overview pixels.
    // Meaningful in BOTH views now: the overview and the main canvas share the same
    // model space in each mode (footprint ↔ footprint, strip ↔ strip).
    if (mainSize.w > 0 && mainSize.h > 0) {
      const mTL = toModel(viewport, 0, 0);
      const mBR = toModel(viewport, mainSize.w, mainSize.h);
      const s1 = toScreen(fit, mTL);
      const s2 = toScreen(fit, mBR);
      const x = Math.min(s1.x, s2.x);
      const y = Math.min(s1.y, s2.y);
      const rw = Math.abs(s2.x - s1.x);
      const rh = Math.abs(s2.y - s1.y);
      ctx.strokeStyle = cssVar(canvas, "--overview-indicator-color", "#c2700a");
      ctx.lineWidth = cssNum(canvas, "--overview-indicator-width", 1.5);
      ctx.strokeRect(x, y, rw, rh);
    }
  }, [perimeter, viewport, mainSize.w, mainSize.h, gridSpacing, unravelOn, unravelDraws]);

  // CLICK TO JUMP: unproject the clicked pixel (relative to the canvas box, which is
  // exactly the fit's pixel space) into model coords and hand it to the parent to
  // recentre the main view. The canvas CSS size equals the w/h used to build `fit`,
  // so the clientRect offset maps 1:1 into the fit viewport.
  const onClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const fit = fitRef.current;
    if (!canvas || !fit) return;
    const rect = canvas.getBoundingClientRect();
    const model = toModel(fit, e.clientX - rect.left, e.clientY - rect.top);
    onJumpTo(model);
  };

  return (
    <div
      className="overview"
      role="button"
      tabIndex={0}
      aria-label="Overview map — click to jump the main view there"
      title="Click to jump the main view there"
      onClick={onClick}
    >
      {/* ===== FIT-TO-VIEW SCENE + CURRENT-VIEW RECT ===== */}
      <div className="overview__body">
        <canvas ref={canvasRef} className="overview__canvas" />
      </div>
    </div>
  );
}
