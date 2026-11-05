// Finding where the drone is from one photo: which things of the room plan (pillars, tables)
// should be in view from the estimated position, and where the drone must be for them to appear
// where the vision model saw them.
//
// Units: metres and degrees in the plan frame (x right, y up, angles counterclockwise). A bearing
// is measured from the camera axis, + = to the right in the picture.

export const CAMERA_FOV_DEG = 82.6; // Tello horizontal field of view
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

/** The question for the vision model, and how to read its answer. */
export function localizePrompt(expected: Expected[]): string {
  const list = expected.map((l) => `- ${l.id}: ${l.name}, ${l.describe}; expected about ${Math.round(Math.abs(l.bearingDeg))}° ${l.bearingDeg >= 0 ? 'right' : 'left'} of the picture centre, about ${l.distanceM.toFixed(1)} m away`).join('\n');
  return `This photo is from the front camera of a small indoor drone. From its estimated position these things of the room should be visible (the estimate can be off by a metre or two):\n${list}\n\nFor each of them that you can actually see in the photo, give the horizontal position of its centre in the picture (x from 0 = left edge to 1 = right edge) and how sure you are (0 to 1). Do not guess: leave out what you cannot see. Pillars look alike: tell them apart by their order from left to right and by how near they look. Reply with ONLY JSON: {"seen":[{"id":"...","x":0.0,"confidence":0.0}],"note":"<at most 15 words about what you see>"}`;
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

/** One sighting in a survey photo: a landmark, where it is in that photo, and the heading of that photo. */
export type SurveySighting = { x: number; y: number; bearingDeg: number; headingDeg: number; id: string };

/**
 * Position AND heading from sightings in several photos taken at known relative headings (a turn
 * on the spot): tries every correction of the heading, keeps the one whose lines cross best.
 * Needs at least three sightings of at least two different landmarks.
 */
export function solveSurvey(sightings: SurveySighting[]): { x: number; y: number; deltaHeading: number; residualM: number; used: number } | null {
  if (sightings.length < 3 || new Set(sightings.map((s) => s.id)).size < 2) return null;
  let best: { x: number; y: number; deltaHeading: number; residualM: number; used: number } | null = null;
  for (let delta = -180; delta < 180; delta += 1) {
    const sol = solvePose(0, sightings.map((s) => ({ x: s.x, y: s.y, bearingDeg: s.bearingDeg - (s.headingDeg + delta), distanceM: null })));
    if (!sol) continue;
    // What a camera sees is in front of it: a line of sight crossing behind the drone is the
    // same line turned 180°, not a solution.
    const behind = sightings.some((s) => { const t = (s.headingDeg + delta - s.bearingDeg) * Math.PI / 180; return (s.x - sol.x) * Math.cos(t) + (s.y - sol.y) * Math.sin(t) < 0.3; });
    if (behind) continue;
    // Small preference for small corrections when two fit about as well.
    const score = sol.residualM + Math.abs(delta) * 0.0005;
    if (!best || score < best.residualM + Math.abs(best.deltaHeading) * 0.0005) best = { x: sol.x, y: sol.y, deltaHeading: delta, residualM: sol.residualM, used: sol.used };
  }
  return best;
}

/** The survey question for Grok vision: every landmark, and where each should appear in each photo. */
export function surveyPrompt(landmarks: Landmark[], perPhoto: Expected[][]): string {
  const all = landmarks.map((l) => `- ${l.id}: ${l.name}, ${l.describe}`).join('\n');
  const hints = perPhoto.map((exp, i) => `Photo ${i + 1}: ${exp.length ? exp.map((e) => `${e.id} ~${Math.round(Math.abs(e.bearingDeg))}° ${e.bearingDeg >= 0 ? 'right' : 'left'}, ${e.distanceM.toFixed(1)} m`).join('; ') : 'nothing expected'}`).join('\n');
  return `These ${perPhoto.length} photos come from the front camera of a small indoor drone hovering on one spot, turning 90° clockwise between photos. Things of the room that can be seen:\n${all}\n\nWhere they should appear if the drone's estimate is right (it may be off by a metre or two and by some degrees):\n${hints}\n\nFor each photo, list what you actually see, with the horizontal position of its centre in that photo (x from 0 = left edge to 1 = right edge) and how sure you are (0 to 1). Pillars look alike: use their order and how near they look, and the hints. Leave out what you cannot see. Reply with ONLY JSON: {"photos":[{"photo":1,"seen":[{"id":"...","x":0.0,"confidence":0.0}]}],"note":"<at most 20 words: what you see and where the drone seems to be>"}`;
}

export function parseSurvey(answer: string | null, landmarks: Landmark[], photos: number): { photo: number; id: string; x: number; confidence: number }[] | null {
  if (!answer) return null;
  const m = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { photos?: unknown };
    if (!Array.isArray(v.photos)) return null;
    const ids = new Set(landmarks.map((l) => l.id));
    return v.photos.flatMap((p) => {
      const o = p as { photo?: unknown; seen?: unknown };
      if (!Number.isInteger(o.photo) || (o.photo as number) < 1 || (o.photo as number) > photos || !Array.isArray(o.seen)) return [];
      return o.seen.flatMap((s) => { const q = s as { id?: unknown; x?: unknown; confidence?: unknown }; return typeof q.id === 'string' && ids.has(q.id) && typeof q.x === 'number' && q.x >= 0 && q.x <= 1 ? [{ photo: o.photo as number, id: q.id, x: q.x, confidence: typeof q.confidence === 'number' ? q.confidence : 0.5 }] : []; });
    });
  } catch { return null; }
}
