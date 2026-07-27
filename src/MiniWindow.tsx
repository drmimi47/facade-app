/**
 * MiniWindow.tsx
 *
 * A draggable, collapsible overlay anchored to the TOP-RIGHT of the canvas
 * stage that shows the user's SAVED perimeters as a gallery of live thumbnails.
 *
 * It is purely a VIEW + INPUT surface over the saved-perimeter data: it owns no
 * geometry math. Each thumbnail repaints the saved shape as an EXTRUDED 3D
 * MASSING via `render3d()` (core/extrude3d.ts) — the footprint extruded up into
 * wall panels — which frames the massing into the thumbnail box itself. The pure
 * 3D logic lives in core/extrude3d.ts; this file only wires the canvas to it.
 *
 * Interactions (documented in NOTES.md too):
 *   - Click a thumbnail        -> load that perimeter into the editor.
 *   - Drag a thumbnail preview -> orbit its 3D camera (rotate the massing).
 *   - Phase change (Plan <-> Elevations) -> thumbnails animate aerial <-> 3/4 view.
 *   - Double-click the preview -> animate to a top-down (plan) view; again toggles back.
 *   - Drag a project name      -> reorder the project list.
 *   - Double-click a name      -> inline rename, Enter/blur commits.
 *   - Delete (×)               -> remove that save (undoable via Ctrl+Z / Redo).
 *   - Drag the title bar       -> reposition the window (clamped to the stage).
 *
 * All visual values come from CSS tokens in styles.css (the `MINI-WINDOW`
 * section); nothing visual is hardcoded here.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Perimeter } from "./core/geometry";
import type { SavedPerimeter, LocationInfo } from "./core/savedPerimeters";
import type { SolarSettings } from "./core/solar";
import { render3d, DEFAULT_CAMERA, PLAN_CAMERA, type Camera } from "./core/extrude3d";
import { easeInOut, shortestAngleDelta } from "./core/viewport";
import SolarStudy from "./SolarStudy";

/** Drag sensitivity (radians of camera rotation per pixel dragged). */
const ROTATE_RAD_PER_PX = 0.01;
/** Elevation clamp (radians) so the camera can't flip fully over the poles. */
const ELEVATION_LIMIT = 1.45; // ~83°
/** Pointer travel (px) past which a thumbnail press counts as a rotate, not a click. */
const ROTATE_CLICK_THRESHOLD_PX = 3;

/** Duration (ms) of the double-click camera animation between 3/4 and plan view.
 *  (PLAN_CAMERA and shortestAngleDelta are now shared — see extrude3d / viewport.) */
const PLAN_ANIM_MS = 290;

/** Margin (px) left around each thumbnail's massing inside its canvas. */
const THUMB_MARGIN_PX = 8;

interface MiniWindowProps {
  /** The saved perimeters to display. */
  saved: SavedPerimeter[];
  /** Whether a saved entry is currently loaded into the editor (highlight it). */
  activeId: string | null;
  /** Load a saved perimeter into the main editor. */
  onLoad: (s: SavedPerimeter) => void;
  /** Delete a saved perimeter. */
  onDelete: (id: string) => void;
  /** Duplicate an entire saved project (perimeter + elevations + framing + everything). */
  onDuplicate: (id: string) => void;
  /** Rename a saved perimeter. */
  onRename: (id: string, name: string) => void;
  /** Reorder: move the project at `from` index to `to` index. */
  onReorder: (from: number, to: number) => void;
  /** Persist an edited geo-location onto a saved entry (from its Solar Study popup). */
  onLocationChange: (id: string, location: LocationInfo) => void;
  /** Persist edited solar settings (cardinal orientation + study set) onto a saved entry. */
  onSolarChange: (id: string, solar: SolarSettings) => void;
  /** Which saved entry's Solar Study popup is open (id), or null. Controlled by the
   *  parent so the study can also be opened from the left panel's Display section. */
  solarId: string | null;
  /** Set/clear the open Solar Study entry (null closes it). */
  onSolarIdChange: (id: string | null) => void;
  /**
   * True while the ELEVATIONS phase is open. Drives each thumbnail's default camera:
   * Plan phase shows the AERIAL (top-down) massing, matching what the canvas is
   * showing, and switching to Elevations animates every thumbnail round to the 3/4
   * view — so the preview always answers "what am I working on" in the same terms as
   * the main view. The user can still spin or double-click a thumbnail afterwards.
   */
  unravelOn: boolean;
  /**
   * EMBEDDED: render just the gallery (and the Solar Study portal), with no window
   * chrome — no title bar, no drag, no collapse, no absolute positioning. Used when the
   * project list lives INSIDE another panel's section (Overview ▸ Project) rather than
   * floating on its own. The list, thumbnails, and every row action behave identically.
   */
  embedded?: boolean;
  /** Bounds the window is dragged within (the stage size in CSS px). */
  stageRef: React.RefObject<HTMLElement>;
  /**
   * Extra class controlling which column this window is anchored in (e.g. "mini--left").
   * The window is otherwise identical wherever it sits.
   */
  positionClass?: string;
  /**
   * DEFAULT position within the stage, used until the user drags the window. Lets the
   * parent stack this beneath another floating panel whose height it cannot know —
   * see `projectsAutoPos` in PolylineTool. Once dragged, the internal position wins
   * permanently and this is ignored.
   */
  autoPos?: { x: number; y: number } | null;
  /** Called on any press inside this window, so the parent can raise it above its siblings. */
  onBringToFront?: () => void;
  /**
   * Hover-link: original edge index to highlight on the ACTIVE entry's thumbnail
   * (the one whose geometry matches the live shape being unravelled), or -1/none.
   * Only the `activeId` thumbnail receives it, since the edge index only maps
   * correctly onto a thumbnail whose geometry matches the live perimeter.
   */
  highlightEdge?: number;
  /**
   * How to render {@link highlightEdge}: when true the edge is drawn as a highlighted
   * LINE on the footprint (perimeter/edit-mode hover); when false/absent the matching
   * wall PANEL is filled (unravel-mode hover). Only affects the active thumbnail.
   */
  highlightAsLine?: boolean;
  /**
   * Per-ORIGINAL-edge-index height overrides for the LIVE editor shape (model
   * units). Like {@link highlightEdge}, these only apply to the ACTIVE entry's
   * thumbnail (the one whose geometry matches the live shape). Non-active thumbnails
   * extrude from their OWN stored per-edge heights ({@link SavedPerimeter.unravelHeights})
   * instead, so every preview shows its walls at their real saved heights.
   */
  heights?: Record<number, number>;
  /**
   * Global/default wall height (model units) — the fallback for walls without a
   * per-edge override on the ACTIVE / live shape. Non-active thumbnails fall back to
   * their OWN stored default ({@link SavedPerimeter.unravelHeight}) instead.
   */
  defaultHeight?: number;
  /**
   * The LIVE editor perimeter. The ACTIVE entry's thumbnail renders THIS instead of
   * its stored snapshot, so footprint edits (perimeter mode) and any other live
   * geometry change track in the preview immediately. When the entry stops being
   * active (the user clicks away or loads another saved preview) the thumbnail
   * FREEZES the last live massing it showed rather than snapping back to its stored
   * snapshot — see {@link frozenRef} in Thumb. Non-active thumbnails that were never
   * edited live keep rendering their own stored geometry.
   */
  livePerimeter?: Perimeter;
}

export default function MiniWindow({
  saved,
  activeId,
  onLoad,
  onDelete,
  onDuplicate,
  onRename,
  onReorder,
  onLocationChange,
  onSolarChange,
  solarId,
  onSolarIdChange,
  unravelOn,
  stageRef,
  positionClass,
  autoPos,
  embedded,
  onBringToFront,
  highlightEdge,
  highlightAsLine,
  heights,
  defaultHeight,
  livePerimeter,
}: MiniWindowProps) {
  // Which saved entry's Solar Study popup is open (by id), or null. CONTROLLED by the
  // parent: the study is launched from the Statistics window (the
  // per-row ☀ button here was removed — one launcher, in the panel that owns analysis).
  // Stored as an id (not the entry) so rename/edit/delete flow through the live list.
  const solarEntry = solarId ? saved.find((s) => s.id === solarId) ?? null : null;
  // SHARED orbit camera for the open Solar Study entry. Both the popup and that
  // entry's thumbnail are driven by it, so rotating either rotates both. Reset to
  // a clean 3/4 view each time a study opens so the two start in sync.
  const [solarCamera, setSolarCamera] = useState<Camera>(DEFAULT_CAMERA);
  // Attention flash: triggered when the user clicks outside the Solar Study popup.
  const [solarFlashing, setSolarFlashing] = useState(false);
  const solarFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSolarBackdrop = () => {
    if (solarFlashTimer.current) clearTimeout(solarFlashTimer.current);
    setSolarFlashing(true);
    solarFlashTimer.current = setTimeout(() => setSolarFlashing(false), 400);
  };
  // Windows are no longer draggable, so position comes from `autoPos` (a computed
  // stacking offset) or, failing that, the CSS anchor.
  // Drag-to-reorder: which index is being dragged, and which index is the current drop target.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const winRef = useRef<HTMLDivElement>(null);


  const placed = autoPos ?? null;
  const style: React.CSSProperties = placed
    ? { left: placed.x, top: placed.y, right: "auto" }
    : {};

  // The gallery itself — identical in both modes.
  const gallery = saved.length > 0 && (
        <div className={embedded ? "mini__body mini__body--embedded" : "mini__body"}>
          <ul className="mini__list">
              {saved.map((s, i) => (
                <Thumb
                  key={s.id}
                  saved={s}
                  active={s.id === activeId}
                  onLoad={onLoad}
                  onDelete={onDelete}
                  onDuplicate={onDuplicate}
                  onRename={onRename}
                  // While this entry's Solar Study is open, its thumbnail shares the
                  // popup's camera (controlled) so rotating one rotates the other.
                  unravelOn={unravelOn}
                  camera={s.id === solarId ? solarCamera : undefined}
                  onCameraChange={s.id === solarId ? setSolarCamera : undefined}
                  // Only the active entry's geometry matches the live unravelled
                  // shape, so only it can carry a meaningful edge highlight.
                  highlightEdge={s.id === activeId ? highlightEdge ?? -1 : -1}
                  // Perimeter-mode hover highlights the edge as a line; unravel-mode
                  // hover fills the wall panel.
                  highlightAsLine={highlightAsLine ?? false}
                  // Live per-edge heights belong to the editor shape, so only the active
                  // entry honours them; non-active thumbnails extrude from their OWN
                  // stored unravelHeights (handled inside Thumb).
                  heights={s.id === activeId ? heights : undefined}
                  defaultHeight={defaultHeight}
                  // The active entry mirrors the LIVE editor shape so footprint /
                  // height edits track in its preview immediately; others render
                  // their own stored snapshot.
                  livePerimeter={s.id === activeId ? livePerimeter : undefined}
                  // Drag-to-reorder props
                  isDragOver={overIdx === i && dragIdx !== null && dragIdx !== i}
                  onNameDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDragIdx(i);
                  }}
                  onItemDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (i !== dragIdx) setOverIdx(i);
                  }}
                  onItemDrop={() => {
                    if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                  onItemDragEnd={() => {
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                />
              ))}
          </ul>
        </div>
      );

  const solarPortal = (
    <>
      {/* ===== FOOTER: add the current sketch as a new saved preview =====
      {/* The footer's project actions (Save · New · Demo) moved to the Overview
          window's PROJECT section, which now owns naming and saving in one place. This
          window is the project LIBRARY: it lists, loads, reorders, renames, and deletes. */}

      {/* ===== SOLAR STUDY popup (opened from the Statistics window) =====
          Portalled into the STAGE (not nested in this window, which is
          position:absolute + overflow:hidden) so it is never clipped by this window.
          The popup itself is position:fixed, so it drags against the whole VIEWPORT —
          free to roam over the header/footer — clamped only to stay half on screen. */}
      {solarEntry && stageRef.current &&
        createPortal(
          <>
            <div className="modal-backdrop" onClick={handleSolarBackdrop} />
            <SolarStudy
              entry={solarEntry}
              defaultHeight={defaultHeight}
              onClose={() => onSolarIdChange(null)}
              onLocationChange={onLocationChange}
              onSolarChange={onSolarChange}
              camera={solarCamera}
              onCameraChange={setSolarCamera}
              isFlashing={solarFlashing}
            />
          </>,
          stageRef.current,
        )}
    </>
  );

  // EMBEDDED — no window chrome; the host section supplies the heading and spacing.
  if (embedded) {
    return (
      <>
        {gallery}
        {solarPortal}
      </>
    );
  }

  return (
    <div
      className={`mini ${positionClass ?? ""}`}
      ref={winRef}
      style={style}
      role="region"
      aria-label="Saved perimeters"
      onPointerDownCapture={onBringToFront}
    >
      {/* ===== TITLE BAR ===== */}
      <div className="mini__titlebar">
        <span className="mini__title">Projects ({saved.length})</span>
      </div>
      {gallery}
      {solarPortal}
    </div>
  );
}

interface ThumbProps {
  saved: SavedPerimeter;
  active: boolean;
  onLoad: (s: SavedPerimeter) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Open this entry's Solar Study popup (by id). */
  /**
   * Optional CONTROLLED orbit camera: when provided (this entry's Solar Study is
   * open) the thumbnail renders and rotates this shared camera instead of its own
   * local one, so the thumbnail and the popup stay in sync. Omitted = uncontrolled
   * (the thumbnail keeps its own local camera, the normal case).
   */
  camera?: Camera;
  onCameraChange?: (camera: Camera) => void;
  /** Phase (see MiniWindowProps.unravelOn) — picks this thumbnail's default camera. */
  unravelOn: boolean;
  /** Edge index to highlight on this thumbnail, or -1 for none. */
  highlightEdge: number;
  /** Draw the highlighted edge as a footprint LINE (true) vs a filled wall PANEL (false). */
  highlightAsLine: boolean;
  /** Per-edge height overrides to extrude this thumbnail with, or undefined for none. */
  heights?: Record<number, number>;
  /** Default/global wall height (model units), or undefined for the built-in default. */
  defaultHeight?: number;
  /** Live editor geometry to render INSTEAD of the stored snapshot (active entry only). */
  livePerimeter?: Perimeter;
  /** True when this item is the current drag-over drop target. */
  isDragOver: boolean;
  onNameDragStart: (e: React.DragEvent) => void;
  onItemDragOver: (e: React.DragEvent) => void;
  onItemDrop: () => void;
  onItemDragEnd: () => void;
}

/** One saved-perimeter row: a live thumbnail + name + actions. */
function Thumb({ saved, active, onLoad, onDelete, onDuplicate, onRename, unravelOn, camera: controlledCamera, onCameraChange, highlightEdge, highlightAsLine, heights, defaultHeight, livePerimeter, isDragOver, onNameDragStart, onItemDragOver, onItemDrop, onItemDragEnd }: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved.name);

  // Per-thumbnail 3D camera the user can spin by dragging on the preview. When a
  // controlled camera is supplied (this entry's Solar Study is open) it takes over
  // so the thumbnail mirrors the popup; otherwise the local one is used. All the
  // existing `camera`/`setCamera` call sites below work unchanged against these.
  // Seeded from the PHASE: aerial in Plan, 3/4 in Elevations (see the effect below,
  // which animates between them whenever the phase changes).
  const [localCamera, setLocalCamera] = useState<Camera>(unravelOn ? DEFAULT_CAMERA : PLAN_CAMERA);
  const camera = controlledCamera ?? localCamera;
  const setCamera = onCameraChange ?? setLocalCamera;
  // Gesture tracking: rotRef holds the drag start (pointer + camera); movedRef
  // tells the click handler whether this was a rotate-drag (don't load) or a tap.
  const rotRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);
  const movedRef = useRef(false);
  // Plan-view toggle state: tracks INTENT (not float equality of the camera) so a
  // double-click reliably toggles between the angled 3/4 massing and the top-down
  // plan, even mid-animation or after the user has spun the thumb.
  const [planView, setPlanView] = useState(!unravelOn);
  // In-flight double-click camera animation (rAF id), so we can cancel it the
  // moment a new animation or a manual drag starts, and on unmount.
  const animRef = useRef<number | null>(null);
  // Set true by the double-click handler so the click that accompanies a
  // double-click does NOT also load the perimeter; cleared once consumed.
  const suppressClickRef = useRef(false);

  // FROZEN MASSING: the exact shape + per-edge heights this thumbnail last
  // displayed WHILE it was the active entry (mirroring the live editor). Once it
  // stops being active — the user clicks away or loads a different saved preview —
  // we keep rendering this frozen snapshot instead of snapping the massing back to
  // the stored shape/uniform heights. The preview stays exactly as it was shown.
  // (The camera/perspective already persists as local Thumb state across the
  // active→inactive transition, so only geometry needs explicit freezing.)
  const frozenRef = useRef<{ geom: Perimeter; heights?: Record<number, number>; defaultHeight?: number } | null>(null);
  // Tracks the stored snapshot identity so we can drop the frozen massing if the
  // save itself is overwritten (e.g. auto-save writes a new perimeter snapshot)
  // and let the fresh snapshot show.
  const prevSavedRef = useRef(saved.perimeter);

  const cancelAnim = () => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  };

  // Smoothly animate the camera to `target` over PLAN_ANIM_MS using the shared
  // easeInOut. Azimuth follows the SHORTEST angular path (delta normalized into
  // [-π, π]) so it never spins the long way; elevation interpolates linearly with
  // the eased t. Any prior animation is cancelled first so a new toggle wins.
  const animateCameraTo = (target: Camera) => {
    cancelAnim();
    const startAz = camera.azimuth;
    const startEl = camera.elevation;
    const dAz = shortestAngleDelta(startAz, target.azimuth);
    const dEl = target.elevation - startEl;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / PLAN_ANIM_MS);
      const e = easeInOut(t);
      setCamera({ azimuth: startAz + dAz * e, elevation: startEl + dEl * e });
      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        animRef.current = null;
      }
    };
    animRef.current = requestAnimationFrame(step);
  };

  // Double-click the preview -> toggle between the top-down plan view and the
  // default 3/4 massing. Suppress the load that the accompanying click would fire.
  const onThumbDoubleClick = () => {
    suppressClickRef.current = true;
    const next = !planView;
    setPlanView(next);
    animateCameraTo(next ? PLAN_CAMERA : DEFAULT_CAMERA);
  };

  // PHASE-DRIVEN CAMERA. Switching Plan ↔ Elevations re-aims every thumbnail so the
  // preview reads in the same terms as the main view: aerial (top-down) while drawing the
  // footprint, 3/4 massing once the walls are unrolled. Animated with the same easing as
  // the double-click toggle, and only ON A CHANGE — the initial state is already correct
  // (see the seeds above), and re-running on mount would fight a restored camera.
  // A manual drag or double-click afterwards still wins until the next phase change.
  const prevUnravelRef = useRef(unravelOn);
  useEffect(() => {
    if (prevUnravelRef.current === unravelOn) return;
    prevUnravelRef.current = unravelOn;
    // The Solar Study owns the camera while it is open for this entry; don't fight it.
    if (controlledCamera) return;
    setPlanView(!unravelOn);
    animateCameraTo(unravelOn ? DEFAULT_CAMERA : PLAN_CAMERA);
    // animateCameraTo reads the CURRENT camera from this render's closure, which is what
    // we want as the animation's start point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unravelOn]);

  // Cancel any in-flight animation on unmount (avoid setState-after-unmount).
  useEffect(() => cancelAnim, []);

  const onThumbPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Manual rotation always wins: kill any running plan animation so the drag
    // takes control immediately (function before aesthetic).
    cancelAnim();
    rotRef.current = { x: e.clientX, y: e.clientY, az: camera.azimuth, el: camera.elevation };
    movedRef.current = false;
  };

  const onThumbPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = rotRef.current;
    if (!r) return;
    const dx = e.clientX - r.x;
    const dy = e.clientY - r.y;
    if (Math.abs(dx) + Math.abs(dy) > ROTATE_CLICK_THRESHOLD_PX) movedRef.current = true;
    // The gesture is identical in both modes (click-and-drag); only the camera
    // constraint differs. Horizontal drag always spins the model (azimuth).
    const az = r.az + dx * ROTATE_RAD_PER_PX;
    if (planView) {
      // PLAN (top-down) view locks elevation: a drag must only SPIN the plan
      // around the vertical axis and stay looking straight down, so we ignore
      // the captured `el`/`dy` and pin elevation to the plan's PI/2. The view
      // only leaves top-down via double-click (onThumbDoubleClick), never a drag.
      setCamera({ azimuth: az, elevation: PLAN_CAMERA.elevation });
    } else {
      // 3D view: horizontal drag spins (azimuth), vertical drag tilts the view
      // (elevation), clamped to ±ELEVATION_LIMIT so it can't flip over the poles.
      const el = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, r.el - dy * ROTATE_RAD_PER_PX));
      setCamera({ azimuth: az, elevation: el });
    }
  };

  const onThumbPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    rotRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  // Load only on a genuine click: not at the end of a rotate-drag, and not the
  // click that fires alongside a double-click (which toggles the plan view).
  const onThumbClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (movedRef.current) return;
    onLoad(saved);
  };

  // Paint the thumbnail whenever the geometry changes. We size the canvas to its
  // CSS box (DPR-aware) and render the perimeter as an EXTRUDED 3D MASSING (the
  // footprint walls extruded up). The 3D renderer frames the whole massing
  // (footprint + height) into the thumbnail box itself, so no 2D viewport is
  // needed. The hovered-unravel edge highlights the matching wall panel in 3D.
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

    // If the stored snapshot itself changed (e.g. auto-save wrote a new perimeter
    // for this entry), forget any frozen live massing so the fresh snapshot shows.
    if (prevSavedRef.current !== saved.perimeter) {
      prevSavedRef.current = saved.perimeter;
      frozenRef.current = null;
    }

    // While ACTIVE this thumbnail mirrors the LIVE editor shape; record that exact
    // massing (footprint + per-edge heights + the global default in effect) so it
    // persists, frozen, once the entry goes inactive instead of snapping back to the
    // stored snapshot.
    if (livePerimeter) {
      frozenRef.current = { geom: livePerimeter, heights, defaultHeight };
    }

    // Render priority: live shape (active) -> last frozen live massing (was active,
    // now clicked away) -> stored snapshot (never edited live). For each source pick
    // the MATCHING per-edge heights AND global default so every wall is extruded to its
    // real height, not a uniform fallback:
    //   - live   : the live editor's per-edge heights + global default
    //   - frozen : the heights + default captured while it was active
    //   - stored : the ENTRY'S OWN saved heights + default. This fixes the visual bug
    //     where an inactive preview showed every wall at the uniform default height and
    //     only "corrected" to the real saved heights once the entry was clicked into.
    const frozen = livePerimeter ? null : frozenRef.current;
    const geom = livePerimeter ?? frozen?.geom ?? saved.perimeter;
    let renderHeights: Record<number, number> | undefined;
    let renderDefaultHeight: number | undefined;
    if (livePerimeter) {
      renderHeights = heights;
      renderDefaultHeight = defaultHeight;
    } else if (frozen) {
      renderHeights = frozen.heights;
      renderDefaultHeight = frozen.defaultHeight;
    } else {
      renderHeights = saved.unravelHeights;
      renderDefaultHeight = saved.unravelHeight ?? defaultHeight;
    }

    render3d(ctx, canvas, w, h, dpr, geom, {
      marginPx: THUMB_MARGIN_PX,
      camera,
      // Global default height for walls without a per-edge override.
      height: renderDefaultHeight,
      // Per-edge heights matched to the rendered geometry (live / frozen / stored).
      heights: renderHeights,
      // Hover-link: the matching edge — as a footprint LINE (perimeter-mode hover)
      // or a filled wall PANEL (unravel-mode hover).
      highlightEdge,
      highlightAsLine,
    });
  }, [saved.perimeter, saved.unravelHeights, saved.unravelHeight, livePerimeter, highlightEdge, highlightAsLine, heights, defaultHeight, camera]);

  const commitRename = () => {
    const name = draft.trim();
    if (name && name !== saved.name) onRename(saved.id, name);
    else setDraft(saved.name);
    setEditing(false);
  };

  return (
    <li
      className={`mini__item ${active ? "is-active" : ""} ${isDragOver ? "is-drag-over" : ""}`}
      onDragOver={onItemDragOver}
      onDrop={onItemDrop}
      onDragEnd={onItemDragEnd}
    >
      <button
        className="mini__thumb"
        onClick={onThumbClick}
        title="Click to load — drag to rotate the 3D preview — double-click to toggle a top-down (plan) view"
      >
        <canvas
          ref={canvasRef}
          className={`mini__canvas ${planView ? "is-plan" : ""}`}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onDoubleClick={onThumbDoubleClick}
        />
      </button>

      <div className="mini__meta">
        {editing ? (
          <input
            className="mini__nameinput"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(saved.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="mini__name"
            draggable
            onClick={() => onLoad(saved)}
            // Double-click renames in place. The pencil button was removed from the row;
            // this keeps renaming available for projects that are NOT the loaded one
            // (Overview ▸ Project ▸ Name only edits the loaded project).
            onDoubleClick={() => {
              setDraft(saved.name);
              setEditing(true);
            }}
            onDragStart={onNameDragStart}
            title="Click to load · double-click to rename · drag to re-order"
          >
            {saved.name}
          </button>
        )}
        {/* No length / area line here. Those figures are the Statistics window's General
            reading, and duplicating them on every thumbnail meant two places to read the
            same number — and two places to keep correct. The row is an IDENTITY (name +
            preview), not a readout. */}
      </div>

      <div className="mini__actions">
        <button
          className="mini__iconbtn"
          onClick={() => onDuplicate(saved.id)}
          title="Duplicate project"
          aria-label="Duplicate"
        >
          ⧉
        </button>
        <button
          className="mini__iconbtn mini__iconbtn--danger"
          onClick={() => onDelete(saved.id)}
          title="Delete project"
          aria-label="Delete project"
        >
          ×
        </button>
      </div>
    </li>
  );
}
