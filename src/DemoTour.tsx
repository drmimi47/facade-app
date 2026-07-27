/**
 * DemoTour.tsx
 *
 * The GUIDED DEMO's on-screen chrome: one coach-mark card plus a ring around the control
 * the current step is about. It is a pure presentation layer — it owns no app state and
 * runs no part of the demo. PolylineTool drives the model; this only says where you are
 * and offers Back / Next / Exit.
 *
 * ── WHY A RING AND A CARD, AND NOT A DIMMED BACKDROP ─────────────────────────────
 * The usual product-tour move is to darken everything except the highlighted control. Here
 * that would hide the one thing worth watching: the drawing being built on the canvas. So
 * nothing is dimmed and nothing is blocked — the ring points, the card explains, and the
 * app stays fully visible and usable underneath. Exit is always one click away.
 *
 * ── POSITIONING ──────────────────────────────────────────────────────────────────
 * Targets are found by their `data-tour` attribute and measured every frame, because they
 * appear and move as the demo runs (the Elevations cluster does not exist until the walls
 * are unrolled, and the Solar Study opens over everything). The card takes its step's
 * preferred side of the target, flips to another side when that one does not fit, and is
 * finally clamped into the viewport — so it can never end up half off-screen or on top of
 * the drop-up menu the step is showing off.
 *
 * All visual values come from the `--tour-*` tokens in styles.css; only geometry (the
 * measured left/top of a floating element) is inline, as it is elsewhere in the app.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TourPlacement, TourStep } from "./core/demoTour";

interface DemoTourProps {
  /** The step being shown. */
  step: TourStep;
  /** Zero-based position in the script, for the "3 / 10" counter. */
  index: number;
  /** How many steps the script has. */
  total: number;
  /** Advance (the last step's Next finishes the tour). */
  onNext: () => void;
  /** Go back one step, replaying it. Absent on the first step. */
  onBack: (() => void) | null;
  /** Leave the tour, keeping whatever has been built so far. */
  onExit: () => void;
}

/** Gap (px) between the highlighted control and the card. Mirrors --tour-gap. */
const GAP = 14;
/** Minimum clear margin (px) between the card and the edge of the window. */
const MARGIN = 12;
/** Fallback card size used for the very first placement, before it has been measured. */
const FALLBACK_SIZE = { w: 340, h: 190 };

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Round to whole pixels so an unchanged target does not re-render every frame. */
function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/** Where the card sits for one candidate side, before clamping. */
function placeOn(side: TourPlacement, target: Rect, w: number, h: number) {
  switch (side) {
    case "top":
      return { left: target.left + target.width / 2 - w / 2, top: target.top - GAP - h };
    case "bottom":
      return { left: target.left + target.width / 2 - w / 2, top: target.top + target.height + GAP };
    case "left":
      return { left: target.left - GAP - w, top: target.top + target.height / 2 - h / 2 };
    case "right":
      return { left: target.left + target.width + GAP, top: target.top + target.height / 2 - h / 2 };
  }
}

/**
 * Is there room on this side?
 *
 * Only the axis the SIDE controls is tested — "is there room above the target", not "does
 * the whole card land inside the window". The other axis is slid along afterwards
 * (see the clamp below), which is what makes side placements usable for controls sitting
 * in a corner: a card to the LEFT of a button on the bottom bar is a perfectly good
 * placement, it just has to be pushed up to stay on screen.
 *
 * This matters for more than tidiness. The CW Type and Glazing buttons open drop-up menus
 * ABOVE themselves, and those menus live inside the tool bar's stacking context, so the
 * card can never be drawn behind one. Testing both axes rejected every side placement for
 * a bottom-bar button and fell through to "top" — directly on top of the very menu the
 * step exists to show.
 */
function fits(side: TourPlacement, pos: { left: number; top: number }, w: number, h: number, vw: number, vh: number): boolean {
  switch (side) {
    case "top":
      return pos.top >= MARGIN;
    case "bottom":
      return pos.top + h <= vh - MARGIN;
    case "left":
      return pos.left >= MARGIN;
    case "right":
      return pos.left + w <= vw - MARGIN;
  }
}

export default function DemoTour({ step, index, total, onNext, onBack, onExit }: DemoTourProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // The highlighted control's box in VIEWPORT coordinates (the card is position:fixed, so
  // the two share a coordinate space). null = no target, or it is not on screen yet.
  const [target, setTarget] = useState<Rect | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);

  // MEASURE the target every frame. The demo mounts and unmounts controls as it runs (the
  // curtain-wall cluster only exists in Elevations) and floating windows move, so a
  // one-shot measurement on mount would leave the ring pointing at nothing. State is only
  // written when the box actually changes, so a still target costs one rect read per frame.
  useEffect(() => {
    if (!step.target) {
      setTarget(null);
      return;
    }
    let raf = 0;
    const selector = `[data-tour="${step.target}"]`;
    const tick = () => {
      const el = document.querySelector(selector);
      // Copied field by field, NOT spread: a DOMRect's values live on the prototype as
      // accessors, so `{ ...rect }` yields an empty object.
      const r = el?.getBoundingClientRect();
      const next: Rect | null = r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
      setTarget((cur) => (sameRect(cur, next) ? cur : next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step.target]);

  // MEASURE the card itself — its height depends on how long the step's copy is, and the
  // placement arithmetic needs the real number rather than an estimate.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize((cur) =>
        Math.round(cur.w) === Math.round(r.width) && Math.round(cur.h) === Math.round(r.height)
          ? cur
          : { w: r.width, h: r.height },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [step.id]);

  // KEYBOARD — Enter / → advance, Escape leaves. Bound in the CAPTURE phase and stopped
  // there so the app's own global Escape (which cancels tools and steps back out of the
  // zoom) never fires underneath the tour: while the tour is up, Escape means "exit the
  // tour" and nothing else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Leave typing and slider keys alone. The demo opens the Solar Study, which is full
      // of fields and range sliders — swallowing Enter and the arrow keys there would make
      // the popup the tour is showing off unusable while it is on screen.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onExit();
      } else if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        onNext();
      } else if (e.key === "ArrowLeft" && onBack) {
        e.preventDefault();
        e.stopPropagation();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onNext, onBack, onExit]);

  // The window size is part of the placement arithmetic, so it has to be state: on the
  // last step there is no target to re-measure, and without this the card would keep a
  // position computed for the old window after a resize.
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const vw = view.w;
  const vh = view.h;

  // --- PLACEMENT -----------------------------------------------------------------
  // No target (or it is not on screen): centre the card. Otherwise try the step's
  // preferred side, then the rest, then clamp whatever we ended up with.
  let side: TourPlacement = step.prefer;
  let left: number;
  let top: number;
  if (target) {
    const order: TourPlacement[] = [step.prefer, "bottom", "top", "right", "left"];
    let chosen = placeOn(step.prefer, target, size.w, size.h);
    for (const candidate of order) {
      const pos = placeOn(candidate, target, size.w, size.h);
      if (fits(candidate, pos, size.w, size.h, vw, vh)) {
        chosen = pos;
        side = candidate;
        break;
      }
    }
    left = Math.max(MARGIN, Math.min(chosen.left, vw - size.w - MARGIN));
    top = Math.max(MARGIN, Math.min(chosen.top, vh - size.h - MARGIN));
  } else {
    left = Math.max(MARGIN, vw / 2 - size.w / 2);
    top = Math.max(MARGIN, vh / 2 - size.h / 2);
  }

  // The pointer sits on the card edge facing the target, lined up with the target's
  // centre and kept clear of the card's own rounded corners.
  const CORNER = 18;
  let arrow: { left: number; top: number } | null = null;
  if (target) {
    if (side === "top" || side === "bottom") {
      const x = target.left + target.width / 2 - left;
      arrow = { left: Math.max(CORNER, Math.min(x, size.w - CORNER)), top: side === "top" ? size.h : 0 };
    } else {
      const y = target.top + target.height / 2 - top;
      arrow = { left: side === "left" ? size.w : 0, top: Math.max(CORNER, Math.min(y, size.h - CORNER)) };
    }
  }

  const last = index === total - 1;
  // Stop presses inside the card from reaching the canvas underneath — a click on Next
  // must never also place a vertex or repaint a cell.
  const swallow = useCallback((e: React.PointerEvent) => e.stopPropagation(), []);

  return (
    <>
      {target && (
        <div
          className="tour-ring"
          aria-hidden="true"
          style={{
            left: `${target.left}px`,
            top: `${target.top}px`,
            width: `${target.width}px`,
            height: `${target.height}px`,
          }}
        />
      )}
      <div
        className="tour-card"
        ref={cardRef}
        role="dialog"
        aria-live="polite"
        aria-label={`Demo step ${index + 1} of ${total}: ${step.title}`}
        style={{ left: `${left}px`, top: `${top}px` }}
        onPointerDown={swallow}
      >
        {arrow && (
          <span
            className={`tour-card__arrow tour-card__arrow--${side}`}
            aria-hidden="true"
            style={{ left: `${arrow.left}px`, top: `${arrow.top}px` }}
          />
        )}
        <div className="tour-card__head">
          {/* PROGRESS is a count, not a bar: ten steps is few enough to read as a number,
              and a number also says how much is left without any pixel arithmetic. */}
          <span className="tour-card__count">
            {index + 1} / {total}
          </span>
          <span className="tour-card__title">{step.title}</span>
          <button className="tour-card__close" onClick={onExit} title="Exit the demo (Esc)" aria-label="Exit the demo">
            ×
          </button>
        </div>
        <p className="tour-card__body">{step.body}</p>
        <div className="tour-card__actions">
          <button className="tour-card__btn" onClick={onExit} title="Leave the demo — everything built so far is kept">
            Exit
          </button>
          <span className="tour-card__spacer" />
          {onBack && (
            <button className="tour-card__btn" onClick={onBack} title="Previous step (←)">
              Back
            </button>
          )}
          <button
            className="tour-card__btn tour-card__btn--primary"
            onClick={onNext}
            title={last ? "Finish the demo (Enter)" : "Next step (Enter or →)"}
          >
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}
