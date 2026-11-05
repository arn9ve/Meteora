// Distance to an object from its YOLO box, with a pinhole camera model.
//
// The Tello / RoboMaster TT camera streams 960x720 with an 82.6° diagonal field of view, so its
// focal length is about 600 / tan(41.3°) ≈ 683 px (horizontal FOV ≈ 70°). An object of real
// height H that is h pixels tall is about f·H/h away. We only know typical sizes, so this is an
// estimate (±30 % or worse); every caller treats it as such and keeps a safety margin.
// The Tello EDU's infrared sensor points down (height above the floor only); it cannot help here.

export const FRAME_W = 960;
export const FRAME_H = 720;
export const FOCAL_PX = 683;
export const HFOV_DEG = 70;

/** Typical real sizes in metres: height (h) and/or width (w). */
const SIZES: Record<string, { h?: number; w?: number }> = {
  person: { w: 0.5 },
  bottle: { h: 0.25 },
  cup: { h: 0.1 },
  'wine glass': { h: 0.18 },
  chair: { h: 0.9 },
  couch: { w: 1.8 },
  bed: { w: 1.6 },
  'dining table': { w: 1.2 },
  laptop: { w: 0.33 },
  tv: { w: 0.9 },
  keyboard: { w: 0.45 },
  mouse: { w: 0.1 },
  'cell phone': { h: 0.15 },
  book: { h: 0.24 },
  backpack: { h: 0.45 },
  handbag: { h: 0.3 },
  suitcase: { h: 0.6 },
  'potted plant': { h: 0.5 },
  clock: { w: 0.3 },
  vase: { h: 0.3 },
  dog: { h: 0.5 },
  cat: { h: 0.25 },
  'teddy bear': { h: 0.3 },
  umbrella: { h: 0.9 },
  'sports ball': { w: 0.22 },
};

export type Box = { x: number; y: number; w: number; h: number }; // normalized 0–1, top-left origin

/** Box touches an edge of the frame, so its size on that axis is cut off. */
function clipped(box: Box) {
  return {
    vertical: box.y <= 0.01 || box.y + box.h >= 0.99,
    horizontal: box.x <= 0.01 || box.x + box.w >= 0.99,
  };
}

/**
 * Estimated distance in centimetres, or null when the class has no known size.
 * For a person, the width (shoulders ~50 cm) is used, plus the height when the whole body is
 * visible (standing ~1.65 m, sitting ~1.0 m); the closer of the two wins, to stay on the safe side.
 */
export function estimateDistanceCm(label: string, box: Box): number | null {
  const hPx = box.h * FRAME_H;
  const wPx = box.w * FRAME_W;
  if (hPx < 2 || wPx < 2) return null;
  const cut = clipped(box);
  const estimates: number[] = [];
  if (label === 'person') {
    if (!cut.horizontal) estimates.push((FOCAL_PX * 0.5) / wPx);
    if (!cut.vertical) estimates.push((FOCAL_PX * (box.h / box.w > 2 ? 1.65 : 1.0)) / hPx);
    // Cut off on both axes: only when it really fills the view is it very close; otherwise unknown.
    if (!estimates.length) return box.w * box.h > 0.5 ? 40 : null;
  } else {
    const size = SIZES[label];
    if (!size) return null;
    if (size.h && !cut.vertical) estimates.push((FOCAL_PX * size.h) / hPx);
    if (size.w && !cut.horizontal) estimates.push((FOCAL_PX * size.w) / wPx);
    if (!estimates.length) return box.w * box.h > 0.5 ? 40 : null;
  }
  return Math.round(Math.min(...estimates) * 100);
}

/** Degrees to turn so the object is centred: negative = left (counterclockwise). */
export function bearingDeg(centerX: number): number {
  const offset = Math.tan(((HFOV_DEG / 2) * Math.PI) / 180) * (centerX - 0.5) * 2;
  return Math.round((Math.atan(offset) * 180) / Math.PI);
}
