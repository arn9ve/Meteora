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
export type RoomConfig = { drones: Record<string, Pose>; cameras: Record<string, CameraConfig>; zones: Zone[] };

export async function loadPlan(path: string): Promise<Plan | null> {
  try {
    const plan = JSON.parse(await readFile(path, 'utf8')) as Plan;
    return Array.isArray(plan.walls) && plan.bounds ? plan : null;
  } catch { return null; }
}

export async function loadConfig(path: string): Promise<RoomConfig> {
  try {
    const c = JSON.parse(await readFile(path, 'utf8')) as Partial<RoomConfig>;
    return { drones: c.drones ?? {}, cameras: c.cameras ?? {}, zones: Array.isArray(c.zones) ? c.zones : [] };
  } catch { return { drones: {}, cameras: {}, zones: [] }; }
}

export async function saveConfig(path: string, config: RoomConfig): Promise<void> {
  await writeFile(path, JSON.stringify(config, null, 2));
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
