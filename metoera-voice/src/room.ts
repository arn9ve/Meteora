// The room: a floor plan (walls, from a CAD file), where each drone starts, where each phone
// camera is and how its picture maps onto the floor, and the red zones drawn on the plan.
//
// Everything is in one frame: the plan's own, in metres, x to the right and y up as drawn, angles
// in degrees counterclockwise from +x. The drones' dead reckoning uses the same frame (in cm).
import { readFile, writeFile } from 'node:fs/promises';

export type Point = [number, number];
export type Plan = { units: 'm'; walls: { a: Point; b: Point }[]; above?: { solid: string; min: Point; max: Point; z_m: number }[]; bounds: { min: Point; max: Point } };
export type Pose = { x: number; y: number; heading: number };
export type CameraConfig = { x?: number; y?: number; heading?: number; img?: Point[]; plan?: Point[]; h?: number[] | null };
export type Zone = { id: string; name: string; points: Point[] };
export type RoomObject = { id: string; name: string; kind: 'table' | 'shelf' | 'wall' | 'obstacle' | 'other'; x: number; y: number; w: number; d: number; rotation: number; heightM?: number };
export type RoomConfig = { drones: Record<string, Pose>; cameras: Record<string, CameraConfig>; zones: Zone[]; objects: RoomObject[] };

export async function loadPlan(path: string): Promise<Plan | null> {
  try {
    const plan = JSON.parse(await readFile(path, 'utf8')) as Plan;
    return Array.isArray(plan.walls) && plan.bounds ? plan : null;
  } catch { return null; }
}

export async function loadConfig(path: string): Promise<RoomConfig> {
  try {
    const c = JSON.parse(await readFile(path, 'utf8')) as Partial<RoomConfig>;
    return { drones: c.drones ?? {}, cameras: c.cameras ?? {}, zones: Array.isArray(c.zones) ? c.zones : [], objects: sanitizeObjects(Array.isArray(c.objects) ? c.objects : []) };
  } catch { return { drones: {}, cameras: {}, zones: [], objects: [] }; }
}

export async function saveConfig(path: string, config: RoomConfig): Promise<void> {
  config.objects = sanitizeObjects(config.objects ?? []);
  await writeFile(path, JSON.stringify(config, null, 2));
}

export function sanitizeObjects(input: unknown[]): RoomObject[] {
  return input.slice(0, 100).flatMap((v, i) => {
    if (!v || typeof v !== 'object') return [];
    const o = v as Partial<RoomObject>;
    if (![o.x, o.y, o.w, o.d, o.rotation].every((n) => typeof n === 'number' && Number.isFinite(n))) return [];
    const kind = (['table', 'shelf', 'wall', 'obstacle', 'other'] as const).includes(o.kind!) ? o.kind! : 'other';
    return [{id:typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 20) : `object-${i + 1}`, name:typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : `${kind} ${i + 1}`, kind, x:o.x!, y:o.y!, w:Math.max(0.05, Math.min(30, o.w!)), d:Math.max(0.05, Math.min(30, o.d!)), rotation:o.rotation!, ...(typeof o.heightM === 'number' && Number.isFinite(o.heightM) && o.heightM >= 0 ? {heightM:o.heightM} : {})}];
  });
}

function local(o: RoomObject, p: Point): Point {
  const a = o.rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), x = p[0] - o.x, y = p[1] - o.y;
  return [x * c + y * s, -x * s + y * c];
}
export function objectCorners(o: RoomObject): Point[] {
  const a = o.rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return ([[-o.w/2, -o.d/2], [o.w/2, -o.d/2], [o.w/2, o.d/2], [-o.w/2, o.d/2]] as Point[]).map(([x, y]) => [o.x + x*c - y*s, o.y + x*s + y*c]);
}
export function approachPoint(o: RoomObject, from: Point, clearanceM = 0.6): Point {
  let dx = from[0] - o.x, dy = from[1] - o.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-9) { dx = Math.cos(o.rotation * Math.PI / 180); dy = Math.sin(o.rotation * Math.PI / 180); len = 1; }
  const [x, y] = local(o, [o.x + dx / len, o.y + dy / len]);
  const edge = Math.min(Math.abs(x) < 1e-12 ? Infinity : o.w / 2 / Math.abs(x), Math.abs(y) < 1e-12 ? Infinity : o.d / 2 / Math.abs(y));
  return [o.x + dx / len * (edge + clearanceM), o.y + dy / len * (edge + clearanceM)];
}
function crosses(o: RoomObject, from: Point, to: Point): boolean {
  const a = local(o, from), b = local(o, to);
  let lo = 0, hi = 1;
  for (let i = 0; i < 2; i++) {
    const half = (i === 0 ? o.w : o.d) / 2, delta = b[i] - a[i];
    if (Math.abs(delta) < 1e-12) { if (Math.abs(a[i]) > half) return false; continue; }
    const t1 = (-half - a[i]) / delta, t2 = (half - a[i]) / delta;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return false;
  }
  return true;
}
export function resolveObjectPlace(objects: RoomObject[], place: string, fromCm: {x: number; y: number}): {x: number; y: number; minHeightCm?: number} | null {
  const name = (s: string) => s.trim().toLowerCase().replace(/^tavolo\s+(\d+)$/, 'table $1');
  const target = objects.find((o) => name(o.name) === name(place) || o.id.toLowerCase() === place.trim().toLowerCase());
  if (!target) return null;
  const from: Point = [fromCm.x / 100, fromCm.y / 100], to = approachPoint(target, from);
  const heights = objects.filter((o) => o !== target && o.heightM !== undefined && crosses(o, from, to)).map((o) => Math.ceil(o.heightM! * 100 + 50));
  return {x:Math.round(to[0] * 100), y:Math.round(to[1] * 100), ...(heights.length ? {minHeightCm:Math.max(20, ...heights)} : {})};
}

/**
 * Homography from 4 (or more) image points (u, v in 0–1 of the picture) to floor points (x, y in
 * metres). Solves the 8 unknowns with h33 = 1 (least squares when more than 4 points).
 * Returns null when the points are degenerate (three in a line, or the same point twice).
 */
export function homography(img: Point[], plan: Point[]): number[] | null {
  if (img.length < 4 || img.length !== plan.length) return null;
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < img.length; i += 1) {
    const [u, v] = img[i];
    const [x, y] = plan[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y]); rhs.push(y);
  }
  // Normal equations A^T A h = A^T b, then Gaussian elimination with partial pivoting.
  const n = 8;
  const m = Array.from({ length: n }, (_, r) => {
    const row = Array.from({ length: n }, (_, c) => rows.reduce((s, a) => s + a[r] * a[c], 0));
    row.push(rows.reduce((s, a, k) => s + a[r] * rhs[k], 0));
    return row;
  });
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k += 1) m[r][k] -= f * m[c][k];
    }
  }
  const h = m.map((row, i) => row[n] / row[i]);
  h.push(1);
  return h.every(Number.isFinite) ? h : null;
}

export function project(h: number[], u: number, v: number): Point | null {
  const w = h[6] * u + h[7] * v + h[8];
  if (Math.abs(w) < 1e-9) return null;
  return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
}

/** Largest error in metres when the calibration maps its own image points back onto the plan. */
export function calibrationError(h: number[], img: Point[], plan: Point[]): number {
  return Math.max(...img.map((p, i) => { const q = project(h, p[0], p[1]); return q ? Math.hypot(q[0] - plan[i][0], q[1] - plan[i][1]) : Infinity; }));
}

export function inside(point: Point, polygon: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A person box (normalized, top-left x, y, w, h) -> where the feet touch the floor. */
export function feet(box: { x: number; y: number; w: number; h: number }): Point {
  return [box.x + box.w / 2, Math.min(1, box.y + box.h)];
}

/** Horizontal field of view of a phone camera, in degrees, per lens (typical phone values). */
export const LENS_FOV: Record<string, number> = {wide: 100, normal: 68, tele: 32};
const PERSON_HEIGHT_M = 1.7;

/**
 * Where a person seen by a phone that is placed on the plan but not calibrated probably stands.
 * Direction: the phone's heading, turned by where the person is across the picture.
 * Distance: from how tall the person looks (a 1.7 m person; picture assumed 16:9 landscape).
 * Rough (about ±1 m at 5 m), but it needs no calibration. Returns null when nothing sensible.
 */
export function estimateFromPose(cam: { x: number; y: number; heading: number }, box: { x: number; y: number; w: number; h: number }, lens = 'normal', aspect = 9 / 16): Point | null {
  const hfov = (LENS_FOV[lens] ?? LENS_FOV.normal) * Math.PI / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) * aspect);
  if (!(box.h > 0.02)) return null;
  // A person cut by the bottom or top of the picture looks shorter than they are: they are nearer.
  const clipped = box.y + box.h > 0.98 || box.y < 0.02;
  let distance = PERSON_HEIGHT_M / (box.h * 2 * Math.tan(vfov / 2));
  if (clipped) distance *= 0.8;
  distance = Math.min(15, Math.max(0.5, distance));
  const u = box.x + box.w / 2;
  // Right of the picture centre = turned clockwise (headings are counterclockwise).
  const bearing = cam.heading * Math.PI / 180 - Math.atan((u - 0.5) * 2 * Math.tan(hfov / 2));
  return [cam.x + Math.cos(bearing) * distance, cam.y + Math.sin(bearing) * distance];
}

/** {people, summary} from a vision answer that should be JSON (tolerates ``` fences and extra text). */
export function parseVisionJson(answer: string | null): { people: number; summary: string } | null {
  if (!answer) return null;
  const match = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/g, ''));
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]) as { people?: unknown; summary?: unknown };
    const people = typeof v.people === 'number' && Number.isFinite(v.people) ? Math.max(0, Math.round(v.people)) : null;
    if (people === null) return null;
    return { people, summary: typeof v.summary === 'string' ? v.summary.trim().slice(0, 160) : '' };
  } catch { return null; }
}
