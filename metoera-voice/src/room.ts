// The room: a floor plan (walls, from a CAD file), where each drone starts, where each phone
// camera is and how its picture maps onto the floor, and the red zones drawn on the plan.
//
// Everything is in one frame: the plan's own, in metres, x to the right and y up as drawn, angles
// in degrees counterclockwise from +x. The drones' dead reckoning uses the same frame (in cm).
import { readFile, writeFile } from 'node:fs/promises';

export type Point = [number, number];
export type Plan = { units: 'm'; walls: { a: Point; b: Point }[]; above?: { solid: string; min: Point; max: Point; z_m: number }[]; bounds: { min: Point; max: Point } };
export type Pose = { x: number; y: number; heading: number; facingConfirmed?: boolean };
export type CameraConfig = { x?: number; y?: number; heading?: number; z?: number; tilt?: number; img?: Point[]; plan?: Point[]; h?: number[] | null };
export type Zone = { id: string; name: string; points: Point[] };
export type RoomObject = { id: string; name: string; kind: 'table' | 'shelf' | 'wall' | 'obstacle' | 'other'; x: number; y: number; w: number; d: number; rotation: number; heightM?: number; pad?: number };
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
    return [{id:typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 20) : `object-${i + 1}`, name:typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : `${kind} ${i + 1}`, kind, x:o.x!, y:o.y!, w:Math.max(0.05, Math.min(30, o.w!)), d:Math.max(0.05, Math.min(30, o.d!)), rotation:o.rotation!, ...(typeof o.heightM === 'number' && Number.isFinite(o.heightM) && o.heightM >= 0 ? {heightM:o.heightM} : {}), ...(Number.isInteger(o.pad) && o.pad! >= 1 && o.pad! <= 8 ? {pad:o.pad} : {})}];
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
export function resolveObjectPlace(objects: RoomObject[], place: string, fromCm: {x: number; y: number}): {x: number; y: number; minHeightCm?: number; pad?: number} | null {
  const name = (s: string) => s.trim().toLowerCase().replace(/^tavolo\s+(\d+)$/, 'table $1');
  const target = objects.find((o) => name(o.name) === name(place) || o.id.toLowerCase() === place.trim().toLowerCase());
  if (!target) return null;
  // A table with a mission pad in its centre: go to the pad itself, above the table, and centre on it.
  if (target.pad) return {x:Math.round(target.x * 100), y:Math.round(target.y * 100), minHeightCm:Math.min(250, Math.round((target.heightM ?? 0.75) * 100) + 50), pad:target.pad};
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

/**
 * Where a person's feet are on the floor, seen by a phone mounted `z` metres above the floor and
 * tilted `tilt` degrees down: the ray from the phone through the feet in the picture, down to the
 * floor. Much better than the size estimate once the height and tilt are right. Returns null when
 * the feet are at or above the horizon (no floor hit) or farther than 25 m.
 */
export function floorFromMount(cam: { x: number; y: number; heading: number; z: number; tilt: number }, box: { x: number; y: number; w: number; h: number }, lens = 'normal', aspect = 9 / 16): Point | null {
  if (!(cam.z > 0)) return null;
  const hfov = (LENS_FOV[lens] ?? LENS_FOV.normal) * Math.PI / 180;
  const vfov = 2 * Math.atan(Math.tan(hfov / 2) * aspect);
  const [u, v] = feet(box);
  const a = (u - 0.5) * 2 * Math.tan(hfov / 2), b = (v - 0.5) * 2 * Math.tan(vfov / 2);
  const h = cam.heading * Math.PI / 180, t = cam.tilt * Math.PI / 180;
  const F = [Math.cos(h), Math.sin(h), 0], Rt = [Math.sin(h), -Math.cos(h), 0];
  // Camera axes: forward pitched down by the tilt; "down" in the picture is perpendicular to it.
  const f = [F[0] * Math.cos(t), F[1] * Math.cos(t), -Math.sin(t)];
  const down = [-F[0] * Math.sin(t), -F[1] * Math.sin(t), -Math.cos(t)];
  const ray = [0, 1, 2].map((i) => f[i] + a * Rt[i] + b * down[i]);
  if (ray[2] >= -1e-6) return null;
  const s = cam.z / -ray[2];
  const p: Point = [cam.x + ray[0] * s, cam.y + ray[1] * s];
  return Math.hypot(p[0] - cam.x, p[1] - cam.y) > 25 ? null : p;
}

/**
 * What is on the floor at a room point (m), in cm: the height of the object it is on (tables
 * without a height count as 75 cm), 0 on open floor, null within `marginM` of an object's edge
 * (dead reckoning is not that precise, so do not guess there).
 */
export function surfaceHeightAt(objects: RoomObject[], x: number, y: number, marginM = 0.25): number | null {
  let edge = false;
  for (const o of objects) {
    const a = o.rotation * Math.PI / 180, dx = x - o.x, dy = y - o.y;
    const u = Math.abs(dx * Math.cos(a) + dy * Math.sin(a)), v = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a));
    if (u <= o.w / 2 - marginM && v <= o.d / 2 - marginM) return Math.round((o.heightM ?? (o.kind === 'table' ? 0.75 : 0)) * 100) || null;
    if (u <= o.w / 2 + marginM && v <= o.d / 2 + marginM) edge = true;
  }
  return edge ? null : 0;
}

type RoutePlan = { walls: { a: Point; b: Point }[]; bounds: { min: Point; max: Point }; pillars?: { x: number; y: number; w: number; d: number }[] };
function segDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/**
 * A way from `from` to `to` (m) that keeps `clearanceM` from walls, pillars and objects (tables):
 * A* on a `cellM` grid (50 cm from everything by default), then shortened to straight legs. Returns the waypoints after `from`
 * (the last one is `to`), [] when already there, or null when there is no way.
 * A start inside an obstacle (a drone taking off from a table) first leaves it by the shortest way.
 */
/** How far a drone keeps from walls, pillars and tables in its way (asked: 50 cm). */
export const CLEARANCE_M = 0.5;
/** Pillars get more: a drone that drifts 10-15% over a leg hit pillar 3 with 55 cm planned (5 Nov). */
export const PILLAR_EXTRA_M = 0.3;
export function planRoute(plan: RoutePlan, objects: RoomObject[], from: Point, to: Point, clearanceM = CLEARANCE_M, cellM = 0.2): Point[] | null {
  const x0 = plan.bounds.min[0], y0 = plan.bounds.min[1];
  const nx = Math.ceil((plan.bounds.max[0] - x0) / cellM) + 1, ny = Math.ceil((plan.bounds.max[1] - y0) / cellM) + 1;
  const rects = [...objects.map((o) => ({ x: o.x, y: o.y, w: o.w, d: o.d, r: o.rotation, extra: 0 })), ...(plan.pillars ?? []).map((p) => ({ ...p, r: 0, extra: PILLAR_EXTRA_M }))];
  const blockedAt = (p: Point) => {
    for (const r of rects) {
      const a = r.r * Math.PI / 180, dx = p[0] - r.x, dy = p[1] - r.y;
      const u = Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) - r.w / 2, v = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)) - r.d / 2;
      if (Math.hypot(Math.max(u, 0), Math.max(v, 0)) < clearanceM + r.extra) return true;
    }
    for (const w of plan.walls) if (segDist(p, w.a, w.b) < clearanceM) return true;
    return false;
  };
  const centre = (i: number, j: number): Point => [x0 + i * cellM, y0 + j * cellM];
  const cellOf = (p: Point): [number, number] => [Math.round((p[0] - x0) / cellM), Math.round((p[1] - y0) / cellM)];
  const blocked = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) blocked[i * ny + j] = blockedAt(centre(i, j)) ? 1 : 0;
  const free = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && !blocked[i * ny + j];
  // Nearest free cell (breadth first) for a start or goal that sits in a blocked cell.
  const nearestFree = ([si, sj]: [number, number]): [number, number] | null => {
    if (free(si, sj)) return [si, sj];
    const seen = new Set([si * ny + sj]); let q: [number, number][] = [[si, sj]];
    for (let r = 0; r < 40 && q.length; r++) {
      const next: [number, number][] = [];
      for (const [i, j] of q) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj, k = a * ny + b;
        if (a < 0 || b < 0 || a >= nx || b >= ny || seen.has(k)) continue;
        if (free(a, b)) return [a, b];
        seen.add(k); next.push([a, b]);
      }
      q = next;
    }
    return null;
  };
  const s = nearestFree(cellOf(from)), g = nearestFree(cellOf(to));
  if (!s || !g) return null;
  // A*, 8 neighbours, no corner cutting.
  const N = nx * ny, cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const gk = g[0] * ny + g[1], h = (k: number) => Math.hypot(Math.floor(k / ny) - g[0], (k % ny) - g[1]);
  const open: number[] = [s[0] * ny + s[1]]; cost[open[0]] = 0;
  while (open.length) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (cost[open[i]] + h(open[i]) < cost[open[bi]] + h(open[bi])) bi = i;
    const k = open.splice(bi, 1)[0];
    if (done[k]) continue; done[k] = 1;
    if (k === gk) break;
    const i = Math.floor(k / ny), j = k % ny;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di, b = j + dj;
      if (!free(a, b) || (di && dj && (!free(i + di, j) || !free(i, j + dj)))) continue;
      const nk = a * ny + b, c = cost[k] + Math.hypot(di, dj);
      if (c < cost[nk]) { cost[nk] = c; prev[nk] = k; open.push(nk); }
    }
  }
  if (!done[gk]) return null;
  const cells: Point[] = [];
  for (let k = gk; k !== -1; k = prev[k]) cells.unshift(centre(Math.floor(k / ny), k % ny));
  // Straighten: from each point, jump to the farthest point still in a clear straight line.
  const clear = (a: Point, b: Point) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cellM / 4)); for (let t = 1; t < n; t++) if (blockedAt([a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n])) return false; return true; };
  const startFree = free(...cellOf(from));
  const path: Point[] = startFree ? [] : [cells[0]];
  let at: Point = startFree ? from : cells[0];
  let i = 0;
  const goal: Point = free(...cellOf(to)) ? to : cells[cells.length - 1];
  const pts = [...cells.slice(1, -1), goal];
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !clear(at, pts[j])) j--;
    path.push(pts[j]); at = pts[j]; i = j + 1;
  }
  const r2 = (p: Point): Point => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
  return Math.hypot(goal[0] - from[0], goal[1] - from[1]) < 0.05 ? [] : path.map(r2);
}

/** Distance (m) from a point to the nearest wall, pillar or object edge (0 inside one). */
export function clearanceAt(plan: RoutePlan | null, objects: RoomObject[], p: Point): number {
  let best = Infinity;
  const rects = [...objects.map((o) => ({ x: o.x, y: o.y, w: o.w, d: o.d, r: o.rotation })), ...(plan?.pillars ?? []).map((q) => ({ ...q, r: 0 }))];
  for (const r of rects) {
    const a = r.r * Math.PI / 180, dx = p[0] - r.x, dy = p[1] - r.y;
    const u = Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) - r.w / 2, v = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)) - r.d / 2;
    best = Math.min(best, Math.hypot(Math.max(u, 0), Math.max(v, 0)));
  }
  for (const w of plan?.walls ?? []) best = Math.min(best, segDist(p, w.a, w.b));
  return best;
}

/** Mission pads on the plan: number -> centre (room cm) and the height of what it lies on. */
export function padsOf(objects: RoomObject[]): { pad: number; x: number; y: number; surfaceCm: number; name: string }[] {
  return objects.filter((o) => o.pad).map((o) => ({ pad: o.pad!, x: Math.round(o.x * 100), y: Math.round(o.y * 100), surfaceCm: Math.round((o.heightM ?? (o.kind === 'table' ? 0.75 : 0)) * 100), name: o.name }));
}

/**
 * Where a point is, in words, from the room plan: "above table 1", "next to table 3 (40 cm from
 * its edge)", "between table 1 and pillar 3". For Grok to say, instead of coordinates.
 */
export function describePlace(objects: RoomObject[], pillars: { id: string; x: number; y: number; w: number; d: number }[], xCm: number, yCm: number): string {
  const p: Point = [xCm / 100, yCm / 100];
  const things = [
    ...objects.map((o) => ({ name: o.name, x: o.x, y: o.y, w: o.w, d: o.d, r: o.rotation })),
    ...pillars.map((q) => ({ name: q.id.replace('-', ' '), x: q.x, y: q.y, w: q.w, d: q.d, r: 0 })),
  ].map((t) => {
    const a = t.r * Math.PI / 180, dx = p[0] - t.x, dy = p[1] - t.y;
    const u = Math.abs(dx * Math.cos(a) + dy * Math.sin(a)) - t.w / 2, v = Math.abs(-dx * Math.sin(a) + dy * Math.cos(a)) - t.d / 2;
    return { ...t, edge: Math.hypot(Math.max(u, 0), Math.max(v, 0)), inside: u <= 0 && v <= 0 };
  }).sort((a, b) => a.edge - b.edge);
  if (!things.length) return 'in the room';
  const [a, b] = things;
  if (a.inside) return `above ${a.name}`;
  const cm = Math.round(a.edge * 100);
  if (cm <= 80) return `next to ${a.name} (${cm} cm from its edge)`;
  if (b && b.edge < 2.5) return `between ${a.name} and ${b.name} (${(a.edge).toFixed(1)} m from ${a.name})`;
  return `${a.edge.toFixed(1)} m from ${a.name}, the nearest thing`;
}

/** A zone named in words: "zone 1", "zona 1", its id. */
export function findZone(zones: Zone[], place: string): Zone | null {
  const norm = (t: string) => t.trim().toLowerCase().replace(/^(la |the )/, '').replace(/^zona\b/, 'zone').replace(/\s+/g, ' ');
  const p = norm(place);
  return zones.find((z) => norm(z.name) === p || z.id.toLowerCase() === p) ?? null;
}

/**
 * Where to go to be inside a zone: a point inside it, at least 50 cm from walls, pillars and the
 * zone's own edge when possible, as near its middle as that allows (m). Null for a zone with no room.
 */
export function zoneTarget(zone: Zone, plan: RoutePlan | null, objects: RoomObject[]): Point | null {
  const pts = zone.points;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let best: { p: Point; score: number } | null = null;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.1) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 0.1) {
    const p: Point = [x, y];
    if (!inside(p, pts)) continue;
    const edge = Math.min(...pts.map((a, i) => segDist(p, a, pts[(i + 1) % pts.length])));
    const clear = clearanceAt(plan, objects.filter((o) => o.kind !== 'table'), p); // over tables is fine at flying height
    // Room around it matters up to 50 cm; then being near the middle wins.
    // Walls and pillars: up to 1 m of room counts (a drone 11 m from its start can be ~1 m off).
    const score = Math.min(edge, 0.5) * 2 + Math.min(clear, 1.0) * 2 - Math.hypot(x - cx, y - cy) * 0.3;
    if (!best || score > best.score) best = { p, score };
  }
  return best ? [Math.round(best.p[0] * 100) / 100, Math.round(best.p[1] * 100) / 100] : null;
}
