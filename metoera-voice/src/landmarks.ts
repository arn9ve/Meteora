// Finding where the drone is from one photo: which things of the room plan (pillars, tables)
// should be in view from the estimated position, and where the drone must be for them to appear
// where the vision model saw them.
//
// Units: metres and degrees in the plan frame (x right, y up, angles counterclockwise). A bearing
// is measured from the camera axis, + = to the right in the picture.

import { HFOV_DEG } from './distance.ts';

// Tello horizontal field of view: the same camera model as distance.ts (f ≈ 683 px across 960 px,
// about 70°). DJI's 82.6° is the diagonal; taken as horizontal it put things near the picture's
// edge up to 7° off. Still to check against a real frame.
export const CAMERA_FOV_DEG = HFOV_DEG;
export type Landmark = { id: string; kind: 'pillar' | 'table' | 'object'; name: string; x: number; y: number; w: number; d: number; describe: string };
export type Expected = Landmark & { bearingDeg: number; distanceM: number };
export type Observation = { x: number; y: number; bearingDeg: number; distanceM: number | null };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const norm = (a: number) => { let v = a % 360; if (v > 180) v -= 360; if (v <= -180) v += 360; return v; };

/** Everything of the plan that can serve as a landmark. */
export function landmarksOf(plan: { pillars?: { id: string; x: number; y: number; w: number; d: number }[]; height_m?: number } | null, objects: { id: string; name: string; kind: string; x: number; y: number; w: number; d: number; heightM?: number }[]): Landmark[] {
  const h = plan?.height_m ?? 4.3;
  return [
    ...(plan?.pillars ?? []).map((p) => ({ id: p.id, kind: 'pillar' as const, name: p.id.replace('-', ' '), x: p.x, y: p.y, w: p.w, d: p.d, describe: `a rectangular concrete pillar ${p.w.toFixed(2)} x ${p.d.toFixed(2)} m, from the floor to the ${h.toFixed(1)} m ceiling` })),
    ...objects.map((o) => ({ id: o.id, kind: o.kind === 'table' ? 'table' as const : 'object' as const, name: o.name, x: o.x, y: o.y, w: o.w, d: o.d, describe: o.kind === 'table' ? `a ${Math.round(o.w * 100)} x ${Math.round(o.d * 100)} cm table, ${Math.round((o.heightM ?? 0.75) * 100)} cm high` : `a ${o.kind} ${Math.round(o.w * 100)} x ${Math.round(o.d * 100)} cm` })),
  ];
}

/** The landmarks that should be in the picture from `pose` (m, heading in degrees), nearest first. */
export function expectedInView(landmarks: Landmark[], pose: { x: number; y: number; heading: number }, maxM = 12, fovDeg = CAMERA_FOV_DEG): Expected[] {
  return landmarks.map((l) => {
    const dx = l.x - pose.x, dy = l.y - pose.y;
    return { ...l, distanceM: Math.hypot(dx, dy), bearingDeg: norm(pose.heading - deg(Math.atan2(dy, dx))) };
  }).filter((l) => l.distanceM > 0.6 && l.distanceM < maxM && Math.abs(l.bearingDeg) < fovDeg / 2 + 4).sort((a, b) => a.distanceM - b.distanceM);
}

/** Horizontal position in the picture (0 = left edge, 1 = right edge) -> bearing. */
export function bearingOfX(x: number, fovDeg = CAMERA_FOV_DEG): number {
  return deg(Math.atan((x - 0.5) * 2 * Math.tan(rad(fovDeg / 2))));
}

/**
 * Where the drone is, from landmarks seen at bearings (and distances when the depth model gave
 * one), with the heading known from the IMU. With a distance, each landmark gives a point; with
 * bearings only, the lines toward two or more landmarks cross at the drone. Returns null when it
 * cannot be told (one landmark without a distance, or lines nearly parallel).
 */
export function solvePose(headingDeg: number, obs: Observation[]): { x: number; y: number; residualM: number; used: number } | null {
  if (!obs.length) return null;
  const dirs = obs.map((o) => { const t = rad(headingDeg - o.bearingDeg); return [Math.cos(t), Math.sin(t)]; });
  const withDistance = obs.map((o, i) => (o.distanceM && o.distanceM > 0.3 ? [o.x - dirs[i][0] * o.distanceM, o.y - dirs[i][1] * o.distanceM] : null)).filter(Boolean) as number[][];
  let x: number, y: number;
  if (obs.length >= 2) {
    // Least squares: the point closest to every line (landmark, direction), plus the distance points.
    let a = 0, b = 0, c = 0, bx = 0, by = 0;
    obs.forEach((o, i) => { const [ux, uy] = dirs[i]; const m11 = 1 - ux * ux, m12 = -ux * uy, m22 = 1 - uy * uy; a += m11; b += m12; c += m22; bx += m11 * o.x + m12 * o.y; by += m12 * o.x + m22 * o.y; });
    for (const [px, py] of withDistance) { a += 1; c += 1; bx += px; by += py; }
    const det = a * c - b * b;
    if (Math.abs(det) < 0.05) return null;
    x = (c * bx - b * by) / det; y = (a * by - b * bx) / det;
  } else if (withDistance.length) { [x, y] = withDistance[0]; }
  else return null;
  const residual = obs.reduce((s, o, i) => { const [ux, uy] = dirs[i]; const vx = x - o.x, vy = y - o.y; return s + Math.abs(vx * uy - vy * ux); }, 0) / obs.length;
  return { x, y, residualM: residual, used: obs.length };
}

/**
 * Where the drone is from bearings to several landmarks, the way the bearings are actually wrong:
 * each by a few degrees (Grok vision's "x in the picture" is about ±4°), not by a few centimetres.
 * - Starts from solvePose's crossing of the lines, then refines it in angle space (Gauss-Newton),
 *   so a far landmark seen 5° off no longer drags the answer by a metre.
 * - Drops the sighting that disagrees most while it is more than `maxDeg` off (another table taken
 *   for this one, a guess), keeping at least `minLandmarks` different landmarks.
 * - `sigmaM`: how sure the answer is (the larger axis of its 1-sigma ellipse for `noiseDeg` per
 *   bearing). Lines that cross at a shallow angle give a large sigmaM: do not trust those.
 * Distances (depth) are not used here: bearings only.
 */
export function solveRobust(headingDeg: number, obs: (Observation & { id?: string })[], { maxDeg = 8, noiseDeg = 4, minLandmarks = 3 } = {}): { x: number; y: number; residualM: number; rmsDeg: number; sigmaM: number; used: number; dropped: number } | null {
  const dirOf = (o: Observation) => rad(headingDeg - o.bearingDeg);
  const keyOf = (o: Observation & { id?: string }) => o.id ?? `${o.x},${o.y}`;
  let left = [...obs];
  let dropped = 0;
  for (;;) {
    if (new Set(left.map(keyOf)).size < Math.max(2, minLandmarks)) return null;
    const first = solvePose(headingDeg, left.map((o) => ({ ...o, distanceM: null })));
    if (!first) return null;
    let x = first.x, y = first.y;
    let info = [0, 0, 0]; // J^T J
    for (let it = 0; it < 15; it += 1) {
      let a = 0, b = 0, c = 0, gx = 0, gy = 0;
      for (const o of left) {
        const dx = o.x - x, dy = o.y - y, r2 = Math.max(dx * dx + dy * dy, 1e-6);
        const e = Math.atan2(Math.sin(Math.atan2(dy, dx) - dirOf(o)), Math.cos(Math.atan2(dy, dx) - dirOf(o)));
        const jx = dy / r2, jy = -dx / r2; // d(angle to landmark)/d(x, y)
        a += jx * jx; b += jx * jy; c += jy * jy; gx += jx * e; gy += jy * e;
      }
      info = [a, b, c];
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-12) return null;
      const sx = -(c * gx - b * gy) / det, sy = -(a * gy - b * gx) / det;
      x += sx; y += sy;
      if (Math.hypot(sx, sy) < 1e-4) break;
    }
    const off = left.map((o) => Math.abs(norm(deg(Math.atan2(o.y - y, o.x - x)) - deg(dirOf(o)))));
    const worst = off.indexOf(Math.max(...off));
    if (off[worst] > maxDeg && new Set(left.filter((_, i) => i !== worst).map(keyOf)).size >= Math.max(2, minLandmarks)) {
      left = left.filter((_, i) => i !== worst);
      dropped += 1;
      continue;
    }
    // Covariance = (J^T J)^-1 * noise^2; its larger eigenvalue gives the worst direction.
    const [a, b, c] = info, det = a * c - b * b, n2 = rad(noiseDeg) ** 2;
    const caa = (c / det) * n2, cbb = (a / det) * n2, cab = (-b / det) * n2;
    const big = (caa + cbb) / 2 + Math.sqrt(((caa - cbb) / 2) ** 2 + cab * cab);
    const rmsDeg = Math.sqrt(off.reduce((s, v) => s + v * v, 0) / off.length);
    const residualM = left.reduce((s, o) => s + Math.hypot(o.x - x, o.y - y) * Math.sin(rad(Math.min(90, Math.abs(norm(deg(Math.atan2(o.y - y, o.x - x)) - deg(dirOf(o))))))), 0) / left.length;
    return { x, y, residualM, rmsDeg, sigmaM: Math.sqrt(Math.max(0, big)), used: left.length, dropped };
  }
}

/** How wide a landmark looks from `distanceM` away: half its larger side as an angle (degrees). */
export function halfWidthDeg(l: { w: number; d: number }, distanceM: number): number {
  return deg(Math.atan(Math.max(l.w, l.d) / 2 / Math.max(distanceM, 0.1)));
}

/** The question for the vision model, and how to read its answer. */
export function localizePrompt(expected: Expected[]): string {
  const list = expected.map((l) => `- ${l.id}: ${l.name}, ${l.describe}; expected about ${Math.round(Math.abs(l.bearingDeg))}° ${l.bearingDeg >= 0 ? 'right' : 'left'} of the picture centre, about ${l.distanceM.toFixed(1)} m away`).join('\n');
  return `This photo is from the front camera of a small indoor drone. From its estimated position these things of the room should be visible (the estimate can be off by a metre or two):\n${list}\n\nFor each of them that you can actually see in the photo, give the horizontal position of its centre in the picture (x from 0 = left edge to 1 = right edge) and how sure you are (0 to 1). Do not guess: leave out what you cannot see. Pillars look alike: tell them apart by their order from left to right and by how near they look. Reply with ONLY JSON: {"seen":[{"id":"...","x":0.0,"confidence":0.0}],"note":"<at most 15 words about what you see>"}`;
}

// ---- Looking around: several photos at different headings (look_around) ----
//
// Pillars all look alike, and so do tables. So the camera (YOLO) or Grok vision only says what
// KIND of landmark it sees and where across each photo, without being told what to expect (told,
// Grok echoes the expectation back and a wrong estimate confirms itself). Which pillar or table each
// sighting is gets worked out here: the position near the estimate that explains the most sightings
// best, refined in angle space, refused when it is not sure.

/** A landmark seen in one photo of a look-around: its kind and where across the picture (0..1). */
export type Sighting = { photo: number; kind: 'pillar' | 'table'; x: number; confidence: number };

/**
 * A bearing seen in a view turned to `viewHeading`, as solvePose wants it for the first view's
 * heading: the direction in the room stays the same (heading − bearing).
 */
export function bearingFromFirst(firstHeading: number, viewHeading: number, bearingDeg: number): number {
  return bearingDeg - norm(viewHeading - firstHeading);
}

/** The question for the vision model about all the photos of a look-around: no hints. */
export function aroundPrompt(photos: number): string {
  return `These ${photos} photos come from the front camera of a small indoor drone, turning clockwise on the spot (photo 2 is 60° to the right of photo 1, and so on). In each photo, find every rectangular concrete pillar (floor to ceiling) and every table. For each one give the photo number, its kind ("pillar" or "table"), the horizontal position of its centre in that photo (x from 0 = left edge to 1 = right edge) and how sure you are (0 to 1). Count only what you clearly see; a table cut by the photo's edge counts only if its middle is in the photo. Reply with ONLY JSON: {"seen":[{"photo":1,"kind":"pillar","x":0.0,"confidence":0.0}],"note":"<at most 15 words>"}`;
}

/** The answer to aroundPrompt. */
export function parseSightings(answer: string | null, photos: number): Sighting[] | null {
  if (!answer) return null;
  const m = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { seen?: unknown };
    if (!Array.isArray(v.seen)) return null;
    return v.seen.flatMap((s) => {
      const o = s as { photo?: unknown; kind?: unknown; x?: unknown; confidence?: unknown };
      const ok = typeof o.photo === 'number' && Number.isInteger(o.photo) && o.photo >= 1 && o.photo <= photos && (o.kind === 'pillar' || o.kind === 'table') && typeof o.x === 'number' && o.x >= 0 && o.x <= 1;
      return ok ? [{ photo: o.photo as number, kind: o.kind as 'pillar' | 'table', x: o.x as number, confidence: typeof o.confidence === 'number' ? o.confidence : 0.5 }] : [];
    });
  } catch { return null; }
}

/** The detector's boxes as sightings: a venue model's `pillar`, and COCO's `dining table`. */
export function boxSightings(views: { label: string; x: number; confidence: number }[][], minConfidence = 0.4): Sighting[] {
  const kindOf = (label: string) => (label === 'pillar' ? 'pillar' as const : label === 'dining table' || label === 'table' ? 'table' as const : null);
  return views.flatMap((boxes, i) => boxes.flatMap((b) => {
    const kind = kindOf(b.label.toLowerCase());
    return kind && b.confidence >= minConfidence ? [{ photo: i + 1, kind, x: b.x, confidence: b.confidence }] : [];
  }));
}

export type AroundFix = { x: number; y: number; sigmaM: number; rmsDeg: number; matched: { id: string; photo: number }[]; dropped: number; secondBestM: number | null };

/**
 * Where the drone is, from sightings in views at `headings` (room degrees, counterclockwise):
 * 1. Every position within `searchM` of `guess` (m), on a `stepM` grid: for each sighting, the
 *    nearest landmark of the same kind that should be in that photo from there (in the field of
 *    view, not so close that it has no clear middle); its angular error, capped at `capDeg`.
 *    The position with the smallest total wins.
 * 2. Those pairs, refined in angle space (solveRobust: outliers dropped, how sure it is).
 * 3. Not sure: fewer than three landmarks matched, `sigmaM` over `maxSigmaM`, the bearings not
 *    fitting (`rmsDeg` over 6), or another position more than 60 cm away explaining the sightings
 *    almost as well (ambiguous).
 */
export function locateAround(landmarks: Landmark[], headings: number[], sightings: Sighting[], guess: { x: number; y: number }, { searchM = 2.5, stepM = 0.1, capDeg = 10, maxSigmaM = 0.35, fovDeg = CAMERA_FOV_DEG } = {}): { ok: true; fix: AroundFix } | { ok: false; error: string } {
  if (!sightings.length) return { ok: false, error: 'no pillar or table seen in any direction' };
  const seen = sightings.map((s) => ({ ...s, bearing: bearingOfX(s.x, fovDeg) }));
  const usable = (l: Landmark, d: number) => d > 0.6 && d < 14 && halfWidthDeg(l, d) <= 25;
  // For each sighting: the landmark of its kind that best explains it from (x, y), and the error.
  const explain = (x: number, y: number) => seen.map((s) => {
    const h = headings[s.photo - 1];
    let err = capDeg, id: string | null = null;
    for (const l of landmarks) {
      if (l.kind !== s.kind) continue;
      const d = Math.hypot(l.x - x, l.y - y);
      if (!usable(l, d)) continue;
      const predicted = norm(h - deg(Math.atan2(l.y - y, l.x - x)));
      if (Math.abs(predicted) > fovDeg / 2 + 4) continue;
      const e = Math.abs(predicted - s.bearing);
      if (e < err) { err = e; id = l.id; }
    }
    return { s, id, err };
  });
  const n = Math.round(searchM / stepM);
  const grid: { x: number; y: number; cost: number }[] = [];
  for (let i = -n; i <= n; i += 1) for (let j = -n; j <= n; j += 1) {
    if (Math.hypot(i, j) > n) continue;
    const x = guess.x + i * stepM, y = guess.y + j * stepM;
    grid.push({ x, y, cost: explain(x, y).reduce((t, e) => t + e.err, 0) });
  }
  grid.sort((a, b) => a.cost - b.cost);
  const best = grid[0];
  const rival = grid.find((g) => Math.hypot(g.x - best.x, g.y - best.y) > 0.6);
  const pairs = explain(best.x, best.y).filter((e) => e.id !== null && e.err < capDeg);
  const ids = new Set(pairs.map((p) => p.id));
  if (ids.size < 3) return { ok: false, error: `only ${ids.size} landmark${ids.size === 1 ? '' : 's'} could be told apart all around: not enough to tell the position` };
  // Refine with the matched pairs, in angle space, relative to the first view's heading.
  const obs = pairs.map((p) => {
    const l = landmarks.find((q) => q.id === p.id)!;
    return { id: l.id, x: l.x, y: l.y, distanceM: null, bearingDeg: bearingFromFirst(headings[0], headings[p.s.photo - 1], p.s.bearing) };
  });
  const sol = solveRobust(headings[0], obs);
  if (!sol) return { ok: false, error: 'the landmarks seen all around do not fit together' };
  if (sol.rmsDeg > 6) return { ok: false, error: `the landmarks seen all around do not fit together (${sol.rmsDeg.toFixed(0)}° off)` };
  if (sol.sigmaM > maxSigmaM) return { ok: false, error: `the landmarks seen all around do not pin the position down (±${Math.round(sol.sigmaM * 100)} cm)` };
  if (rival && rival.cost <= best.cost * 1.15 + 2) return { ok: false, error: `two places ${Math.hypot(rival.x - best.x, rival.y - best.y).toFixed(1)} m apart fit what was seen about equally well: not sure which` };
  return { ok: true, fix: { x: sol.x, y: sol.y, sigmaM: sol.sigmaM, rmsDeg: sol.rmsDeg, matched: pairs.map((p) => ({ id: p.id!, photo: p.s.photo })), dropped: sol.dropped, secondBestM: rival ? Math.hypot(rival.x - best.x, rival.y - best.y) : null } };
}

export function parseSeen(answer: string | null, expected: Expected[]): { id: string; x: number; confidence: number }[] | null {
  if (!answer) return null;
  const m = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { seen?: unknown };
    if (!Array.isArray(v.seen)) return null;
    const ids = new Set(expected.map((e) => e.id));
    return v.seen.flatMap((s) => {
      const o = s as { id?: unknown; x?: unknown; confidence?: unknown };
      return typeof o.id === 'string' && ids.has(o.id) && typeof o.x === 'number' && o.x >= 0 && o.x <= 1 ? [{ id: o.id, x: o.x, confidence: typeof o.confidence === 'number' ? o.confidence : 0.5 }] : [];
    });
  } catch { return null; }
}
