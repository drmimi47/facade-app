/**
 * core/referenceImage.ts
 *
 * REFERENCE IMAGES (underlays) — a raster placed in MODEL space beneath the drawing,
 * so a site plan, survey, or elevation can be traced directly. This is the familiar
 * CAD "attach image / picture frame" idea (AutoCAD XREF, Rhino PictureFrame): the
 * image is a passive backdrop with its own scale, never geometry.
 *
 * This module owns the DATA MODEL, the PLACEMENT MATH, and the FILE DECODING. The
 * drawing lives in core/renderer.ts and the interaction in PolylineTool.
 *
 * ── COORDINATES ──────────────────────────────────────────────────────────────
 * Placement is a model-space axis-aligned rect: (x, y) is the BOTTOM-LEFT corner and
 * (w, h) the size in model units (feet), with +Y up — the same convention as the
 * perimeter. Because the rect is axis-aligned, hit-testing and resizing are plain
 * interval maths and stay exact at any zoom. Rotation is deliberately NOT modelled:
 * it would make every one of those tests a transform round-trip, and a scanned plan
 * is squared up far more often than it is rotated.
 *
 * ── WHY A DEPENDENCY (pdfjs-dist) ────────────────────────────────────────────
 * Per CLAUDE.md's working agreement, this is the choice and the reason: PNG and JPEG
 * decode natively in the browser, but PDF does NOT. Rendering a PDF page needs a full
 * parser, font engine, and rasteriser — there is no dependency-free path, and the user
 * asked for PDF explicitly. Mozilla's pdf.js is the reference implementation, is the
 * same engine Firefox ships, and adds no runtime service. It is loaded through a
 * DYNAMIC import() so it stays out of the main bundle and is fetched only when someone
 * actually opens a PDF; raster imports never pay for it. The worker is bundled locally
 * (Vite `?worker`), so the app remains fully offline.
 *
 * ── WHY THE RASTER IS DOWNSCALED ─────────────────────────────────────────────
 * The placed image is stored as a data URL ON the project so it survives a reload and
 * travels with a duplicated project — but projects live in localStorage, which is only
 * a few MB. A phone photo or a 300-dpi scan would blow that budget on its own, so the
 * import is capped at {@link MAX_RASTER_PX} on the long edge and re-encoded. At that
 * size an underlay is still far sharper than the screen can show at normal zoom.
 */

/** A reference image placed in model space. Plain JSON — persists with the project. */
export interface ReferenceImage {
  /** Stable id (React key, selection target). */
  id: string;
  /** Original file name, shown in the UI so multiple underlays stay distinguishable. */
  name: string;
  /** Data URL of the decoded, downscaled raster. Self-contained so it survives reload. */
  src: string;
  /** Model x of the rect's BOTTOM-LEFT corner. */
  x: number;
  /** Model y of the rect's BOTTOM-LEFT corner (+Y up). */
  y: number;
  /** Width in model units. */
  w: number;
  /** Height in model units. */
  h: number;
  /** Native pixel aspect (width / height) — keeps corner drags proportional. */
  aspect: number;
  /** Draw opacity 0..1. Underlays are usually faded so the drawing reads on top. */
  opacity: number;
  /** When locked the image ignores hit-testing, so it can't be nudged while tracing. */
  locked: boolean;
}

/**
 * Longest edge (px) kept when re-encoding an import. See the header note on why this
 * cap exists; raise it only alongside a different persistence story than localStorage.
 */
export const MAX_RASTER_PX = 2000;

/** JPEG quality used when the source has no transparency to preserve. */
const JPEG_QUALITY = 0.82;

/** Default opacity for a freshly placed underlay — faded so the drawing stays legible. */
export const DEFAULT_IMAGE_OPACITY = 0.6;

/** Fraction of the visible view a freshly imported image is sized to occupy. */
const FIT_FRACTION = 0.6;

/** File extensions offered in the picker and accepted on drop. */
export const ACCEPTED_IMAGE_TYPES = ".pdf,.png,.jpg,.jpeg";

/** True when the file looks like a PDF (by MIME type, falling back to extension). */
function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// ---------------------------------------------------------------------------
// DECODING
// ---------------------------------------------------------------------------

/** A decoded import, before it is placed in the model. */
export interface DecodedRaster {
  src: string;
  /** Pixel dimensions AFTER downscaling — only their ratio matters downstream. */
  pxW: number;
  pxH: number;
  name: string;
  /** Page count, for a PDF (1 for rasters). Reported so the UI can say what it took. */
  pages: number;
}

/**
 * Scale factor that fits (w x h) inside {@link MAX_RASTER_PX} on its long edge.
 * Never upscales — a small source stays at its native size.
 */
function downscaleFactor(w: number, h: number): number {
  return Math.min(1, MAX_RASTER_PX / Math.max(w, h));
}

/**
 * Whether a canvas holds any non-opaque pixel, sampled on a stride rather than every
 * pixel (a 2000px image is 4M pixels and this runs on the import path). Decides
 * PNG-vs-JPEG re-encoding: transparency must survive, but an opaque scan should not
 * pay PNG's size for nothing.
 */
function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h);
  // Every 16th pixel: dense enough to catch a transparent region, cheap enough to be
  // imperceptible. A stray single transparent pixel is not worth the full scan.
  for (let i = 3; i < data.length; i += 4 * 16) {
    if (data[i] < 255) return true;
  }
  return false;
}

/** Re-encode a canvas, preserving transparency only when the image actually has it. */
function encode(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): string {
  return hasTransparency(ctx, canvas.width, canvas.height)
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** Decode a PNG/JPEG File into a downscaled data URL. */
async function decodeRaster(file: File): Promise<DecodedRaster> {
  const bitmap = await createImageBitmap(file);
  try {
    const k = downscaleFactor(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get a 2D context to decode the image.");
    ctx.drawImage(bitmap, 0, 0, w, h);

    return { src: encode(canvas, ctx), pxW: w, pxH: h, name: file.name, pages: 1 };
  } finally {
    bitmap.close();
  }
}

/**
 * Rasterise the FIRST page of a PDF into a downscaled data URL.
 *
 * Only page 1 is taken: an underlay is a single backdrop, and a multi-page document
 * would need a page chooser to be meaningful. The page count is returned so the caller
 * can say so plainly rather than silently dropping pages.
 */
async function decodePdf(file: File): Promise<DecodedRaster> {
  // Dynamic import: keeps ~1.6 MB of parser + worker out of the main bundle and off
  // the raster import path entirely. See the header note.
  const pdfjs = await import("pdfjs-dist");
  const { default: PdfWorker } = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
  // A bundled worker (not a CDN URL) is what keeps PDF import working offline.
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

  const data = await file.arrayBuffer();
  // Teardown lives on the LOADING TASK, not the document — releasing it is what stops
  // the worker and frees the parsed page, which matters since we only ever take page 1.
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    // Render at scale 1 first only to learn the page's natural size, then pick the
    // scale that lands the long edge on the cap — so a big sheet is rasterised at
    // full useful detail in ONE pass rather than drawn twice.
    const base = page.getViewport({ scale: 1 });
    const scale = downscaleFactor(base.width, base.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not get a 2D context to render the PDF.");
    // PDF pages are transparent where nothing is drawn; a white ground makes the
    // underlay read like the sheet it came from instead of showing the app behind it.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    return {
      src: encode(canvas, ctx),
      pxW: canvas.width,
      pxH: canvas.height,
      name: file.name,
      pages: doc.numPages,
    };
  } finally {
    await task.destroy();
  }
}

/**
 * Decode any accepted file (PDF / PNG / JPEG) into a placeable raster.
 * Throws with a human-readable message the UI can surface directly.
 */
export async function decodeImageFile(file: File): Promise<DecodedRaster> {
  try {
    return isPdf(file) ? await decodePdf(file) : await decodeRaster(file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read "${file.name}". ${why}`);
  }
}

// ---------------------------------------------------------------------------
// PLACEMENT
// ---------------------------------------------------------------------------

/** The visible model-space rect an import should be fitted into. */
export interface ViewRect {
  /** Model x/y of the view's centre. */
  cx: number;
  cy: number;
  /** Model width/height currently visible. */
  w: number;
  h: number;
}

/**
 * Place a decoded raster centred in the current view, scaled to {@link FIT_FRACTION}
 * of it while preserving the source aspect. Landing it in view (rather than at the
 * model origin, which may be off-screen) is what makes the import feel like it
 * "auto-populates onto the canvas".
 */
export function placeInView(raster: DecodedRaster, view: ViewRect, id: string): ReferenceImage {
  const aspect = raster.pxW / raster.pxH;
  // Fit inside the target box: whichever axis binds first decides the scale.
  const boxW = view.w * FIT_FRACTION;
  const boxH = view.h * FIT_FRACTION;
  let w = boxW;
  let h = w / aspect;
  if (h > boxH) {
    h = boxH;
    w = h * aspect;
  }
  return {
    id,
    name: raster.name,
    src: raster.src,
    x: view.cx - w / 2,
    y: view.cy - h / 2,
    w,
    h,
    aspect,
    opacity: DEFAULT_IMAGE_OPACITY,
    locked: false,
  };
}

// ---------------------------------------------------------------------------
// TRANSFORM HANDLES
// ---------------------------------------------------------------------------

/**
 * The eight resize grips, named by the corner/edge they sit on. Dragging one moves
 * that corner or edge while the OPPOSITE one stays pinned, which is the behaviour
 * every design tool shares and the reason resizing feels predictable.
 */
export type HandleKey = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLE_KEYS: HandleKey[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Corner grips scale both axes; edge grips scale one. */
export function isCornerHandle(k: HandleKey): boolean {
  return k === "nw" || k === "ne" || k === "se" || k === "sw";
}

/** The CSS cursor for a grip, so the pointer states what the drag will do. */
export function handleCursor(k: HandleKey): string {
  switch (k) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    default:
      return "ew-resize";
  }
}

/** A grip's anchor point in MODEL space (+Y up, so "n" is y + h). */
export function handlePoint(img: ReferenceImage, k: HandleKey): { x: number; y: number } {
  const midX = img.x + img.w / 2;
  const midY = img.y + img.h / 2;
  const left = img.x;
  const right = img.x + img.w;
  const bottom = img.y;
  const top = img.y + img.h;
  switch (k) {
    case "nw": return { x: left, y: top };
    case "n": return { x: midX, y: top };
    case "ne": return { x: right, y: top };
    case "e": return { x: right, y: midY };
    case "se": return { x: right, y: bottom };
    case "s": return { x: midX, y: bottom };
    case "sw": return { x: left, y: bottom };
    case "w": return { x: left, y: midY };
  }
}

/** True when a MODEL-space point lies inside the image rect. */
export function hitImageBody(img: ReferenceImage, p: { x: number; y: number }): boolean {
  return p.x >= img.x && p.x <= img.x + img.w && p.y >= img.y && p.y <= img.y + img.h;
}

/**
 * Smallest size (model units) a drag may shrink an image to. Prevents a rect
 * collapsing to zero — which would make it unclickable and its aspect undefined.
 */
const MIN_SIZE = 1e-3;

/**
 * Resize by dragging `k` to model point `p`, holding the opposite corner/edge fixed.
 *
 * `preserveAspect` governs CORNER drags: on by default, because a stretched site plan
 * is almost always a mistake rather than an intent, with Shift as the deliberate
 * override. Edge drags always scale their single axis — that IS their purpose.
 */
export function resizeImage(
  img: ReferenceImage,
  k: HandleKey,
  p: { x: number; y: number },
  preserveAspect: boolean,
): ReferenceImage {
  const left = img.x;
  const right = img.x + img.w;
  const bottom = img.y;
  const top = img.y + img.h;

  // Which edges this grip moves, and therefore which stay pinned.
  const movesLeft = k === "nw" || k === "w" || k === "sw";
  const movesRight = k === "ne" || k === "e" || k === "se";
  const movesTop = k === "nw" || k === "n" || k === "ne";
  const movesBottom = k === "sw" || k === "s" || k === "se";

  let nx = left;
  let ny = bottom;
  let nw = img.w;
  let nh = img.h;

  if (movesLeft) {
    nx = Math.min(p.x, right - MIN_SIZE);
    nw = right - nx;
  } else if (movesRight) {
    nw = Math.max(MIN_SIZE, p.x - left);
  }

  if (movesBottom) {
    ny = Math.min(p.y, top - MIN_SIZE);
    nh = top - ny;
  } else if (movesTop) {
    nh = Math.max(MIN_SIZE, p.y - bottom);
  }

  if (preserveAspect && isCornerHandle(k)) {
    // Drive both axes from whichever the pointer moved PROPORTIONALLY further, so the
    // rect tracks the cursor diagonally instead of snapping to one axis.
    const byWidth = nw / img.w >= nh / img.h;
    if (byWidth) nh = nw / img.aspect;
    else nw = nh * img.aspect;
    nw = Math.max(MIN_SIZE, nw);
    nh = Math.max(MIN_SIZE, nh);
    // Re-pin against the anchored edges, which the proportional correction just moved.
    if (movesLeft) nx = right - nw;
    if (movesBottom) ny = top - nh;
  }

  return { ...img, x: nx, y: ny, w: nw, h: nh };
}

/** Deep-copy the list so a stored snapshot is detached from live state. */
export function cloneReferenceImages(list: ReferenceImage[]): ReferenceImage[] {
  return list.map((i) => ({ ...i }));
}
