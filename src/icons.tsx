/**
 * icons.tsx
 *
 * The app's line-icon set: one small component per glyph, no state and no props.
 *
 * Split out of PolylineTool so the tool bar's markup reads as markup rather than as a
 * wall of SVG path data — and so a glyph can be found by name instead of by scrolling.
 * Every icon here follows the same house convention, which is what lets them sit in a
 * row and read as one family; see the section comment below.
 */

/* === BOTTOM-CENTER TOOL-BAR GLYPHS ===
   Small leading line-icons for the bottom-center bar — Pan · Select · Delete · Pen
   (footprint tools) and Floor Lines · CW Type · Centerlines · Framing · Glazing
   (curtain-wall cluster). All follow the house SVG convention (24×24 viewBox,
   stroke=currentColor, round caps/joins) so each glyph inherits the button's text colour
   in every state — default, hover, armed (on-accent fill), and disabled — with no
   per-state overrides. Each glyph depicts what the tool ACTS ON, not a generic symbol:
   the curtain-wall set all draw the same wall rectangle with the element that tool adds. */

/* Select — the ARROW POINTER, the universal object-selection glyph. Filled rather than
   outlined so it reads as a solid cursor at 14px, where a hollow arrow turns to mush.
   It shares `currentColor` with every other glyph, so it still inverts when armed. */
export function SelectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5 18.5 12l-6.4 1.4-2.7 6.1z" />
    </svg>
  );
}

/* Pan — an open HAND, the universal drag-the-view gesture (matches the grab cursor
   the canvas switches to while the tool is armed). */
export function PanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 11V6a2 2 0 0 0-4 0" />
      <path d="M14 10V4a2 2 0 0 0-4 0v2" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

/* Pen — a pen nib: the single footprint tool, drawing vertices on an open shape and
   editing them once it closes. */
export function PenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}




/* Plan — a closed footprint outline seen from ABOVE, with its corner nodes: the
   building perimeter as drawn in the plan phase. */
export function PlanIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h11l5 5v9H4z" />
      <circle cx="4" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* Elevations — three upright wall panels side by side: the footprint's walls unrolled
   into the flat elevation strip. */
export function ElevationsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="7" width="5.5" height="13" rx="0.5" />
      <rect x="9.5" y="4" width="5" height="16" rx="0.5" />
      <rect x="16" y="9" width="5.5" height="11" rx="0.5" />
    </svg>
  );
}

/* Erase — an eraser sweeping across a stroke (Lucide-style). */
export function EraseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4L14 3a2.4 2.4 0 0 1 3.4 0l3.6 3.6a2.4 2.4 0 0 1 0 3.4L13 18" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </svg>
  );
}

/* (The "Dim" button's dimension-line glyph was removed with the button itself: that
   button existed only to host the dimensions eye, which is now a row in the left
   panel's Display ▸ Visibility list.) */

/* CW Type — a curtain-wall elevation: the wall panel gridded into bays (one vertical +
   one horizontal mullion), i.e. the SYSTEM being assigned to the panel. */
export function CwTypeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <path d="M12 3v18" />
      <path d="M3 12h18" />
    </svg>
  );
}

/* Floor Lines — the wall's side edges with the horizontal LEVEL lines the tool drops
   across it (the ground datum plus the levels above). */
export function FloorLinesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 3v18" />
      <path d="M20 3v18" />
      <path d="M3 8h18" />
      <path d="M3 14h18" />
      <path d="M3 20h18" />
    </svg>
  );
}

/* Centerlines — the wall panel with the DASHED division line the tool places (drawn
   dashed exactly like the centerlines on the canvas). */
export function CenterlinesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M12 2v20" strokeDasharray="3 2.5" />
    </svg>
  );
}

/* Framing — the mullion profile: the wall opening with a frame INSET from its edge,
   which is exactly what the framing offset draws. */
export function FramingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="1" />
      <rect x="7" y="7" width="10" height="10" rx="0.5" />
    </svg>
  );
}

/* Assign — a glazing cell carrying the HATCH the type paints on it (Vision / Spandrel /
   Opaque all render as a hatched fill, so the hatch is the shared mark). */
export function AssignIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <path d="M3 15 15 3" />
      <path d="M9 21 21 9" />
    </svg>
  );
}
