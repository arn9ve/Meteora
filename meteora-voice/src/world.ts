// What one drone remembers: where it is, what it did, places to go back to, and what it saw.
//
// Position is dead reckoning in a room frame fixed at the first takeoff: x = the direction the
// drone faced then, y = its left, z = height (cm); heading in degrees, + = turned left
// (counterclockwise). Every successful move updates it; telemetry height and yaw correct z and the
// heading. It drifts a little with every move (the Tello holds position with its downward camera),
// so "go back" lands close to, not exactly on, the old spot.

export type Pose = { x: number; y: number; z: number; heading: number };
export type LogEntry = { at: string; action: string; detail: string; pose: Pose };
export type Sighting = { label: string; description: string | null; x: number; y: number; distanceCm: number | null; seenAt: string; heading: number; approx: boolean; fromX: number; fromY: number; count: number };

const rad = (deg: number) => (deg * Math.PI) / 180;
const round = (p: Pose): Pose => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), heading: Math.round(normalize(p.heading)) });
/** -180 < angle ≤ 180 */
export function normalize(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

export class World {
  #pose: Pose = { x: 0, y: 0, z: 0, heading: 0 };
  #log: LogEntry[] = [];
  #places = new Map<string, Pose>();
  #sightings: Sighting[] = [];
  #yawAtStart: number | null = null; // telemetry yaw that matches the current heading
  #anchorYaw = false; // fix the yaw reference at the next telemetry (set on takeoff)
  #path: { x: number; y: number }[] = [{ x: 0, y: 0 }]; // where it has been, for the map
  #obstacles = new Map<string, { x: number; y: number }>(); // depth hits on a 20 cm grid: walls, furniture

  /**
   * `start`: where this drone stands in the shared room frame before its first takeoff, so two
   * drones draw into one map (x = toward the wall both face at the start, y = left, heading + = left).
   */
  constructor(start: { x: number; y: number; heading: number } = { x: 0, y: 0, heading: 0 }) {
    this.#pose = { x: start.x, y: start.y, z: 0, heading: normalize(start.heading) };
    this.#path = [{ x: Math.round(start.x), y: Math.round(start.y) }];
  }

  get pose(): Pose { return round(this.#pose); }

  /**
   * The drone is on the ground at this spot of the room (placed on the plan): moves the pose there
   * without drawing a path, and fixes the yaw reference again at the next takeoff.
   */
  relocate(start: { x: number; y: number; heading: number }): void {
    this.#pose = { x: start.x, y: start.y, z: 0, heading: normalize(start.heading) };
    this.#path = [{ x: Math.round(start.x), y: Math.round(start.y) }];
    this.#places.delete('home');
    this.#yawAtStart = null;
  }

  /** Where a move would take it in the room (cm), from the current heading, without moving. */
  stepFor(sdk: string): [number, number] | null {
    let m: RegExpExecArray | null;
    let f = 0, l = 0;
    if ((m = /^(forward|back|left|right) (\d+)$/.exec(sdk))) { const d = Number(m[2]); f = m[1] === 'forward' ? d : m[1] === 'back' ? -d : 0; l = m[1] === 'left' ? d : m[1] === 'right' ? -d : 0; }
    else if ((m = /^go (-?\d+) (-?\d+) (-?\d+) \d+$/.exec(sdk))) { f = Number(m[1]); l = Number(m[2]); }
    else return null;
    const h = rad(this.#pose.heading);
    return [f * Math.cos(h) - l * Math.sin(h), f * Math.sin(h) + l * Math.cos(h)];
  }

  /** Telemetry odometry knows where it is: x,y follow it, and moves no longer add their own step. */
  #fromTelemetry = false;
  followTelemetry(on: boolean): void { this.#fromTelemetry = on; }
  setXY(x: number, y: number): void {
    this.#pose.x = x; this.#pose.y = y;
    const last = this.#path[this.#path.length - 1];
    if (!last || Math.hypot(last.x - x, last.y - y) >= 5) { this.#path.push({ x: Math.round(x), y: Math.round(y) }); if (this.#path.length > 2000) this.#path.shift(); }
  }

  /** A photo survey found the heading off by `deltaDeg` (+ = more counterclockwise): fix it for good. */
  correctHeading(deltaDeg: number): void {
    this.#pose.heading = normalize(this.#pose.heading + deltaDeg);
    if (this.#yawAtStart !== null) this.#yawAtStart += deltaDeg;
  }

  /** Applies a Tello SDK move that the drone confirmed with "ok". */
  applySdk(sdk: string): void {
    const p = this.#pose;
    let m: RegExpExecArray | null;
    if (sdk === 'takeoff') {
      // The Tello's IMU yaw can jump at takeoff (and the drone may have been moved on the
      // ground): tie the yaw reference to the heading at takeoff, not at power-on.
      this.#anchorYaw = true;
      if (!this.#places.has('home')) this.#places.set('home', { ...p, z: 0 });
      p.z = Math.max(p.z, 80);
    } else if (sdk === 'land') {
      this.#places.set('last_landing', { ...p, z: 80 });
      p.z = 0;
    } else if ((m = /^(forward|back|left|right|up|down) (\d+)$/.exec(sdk))) {
      const d = Number(m[2]);
      if (m[1] === 'up') p.z += d;
      else if (m[1] === 'down') p.z = Math.max(0, p.z - d);
      else if (!this.#fromTelemetry) this.#step(m[1] === 'forward' ? d : m[1] === 'back' ? -d : 0, m[1] === 'left' ? d : m[1] === 'right' ? -d : 0);
    } else if ((m = /^go (-?\d+) (-?\d+) (-?\d+) \d+$/.exec(sdk))) {
      if (!this.#fromTelemetry) this.#step(Number(m[1]), Number(m[2]));
      p.z = Math.max(0, p.z + Number(m[3]));
    } else if ((m = /^(cw|ccw) (\d+)$/.exec(sdk))) {
      // Once the telemetry yaw gives the heading, it already contains this turn: adding it again
      // made the drone believe it faced 100° further than it did (flight of 5 Nov, 10:19).
      if (this.#yawAtStart === null) p.heading = normalize(p.heading + (m[1] === 'ccw' ? Number(m[2]) : -Number(m[2])));
    }
  }

  /** Telemetry: height above the floor and IMU yaw (+ = clockwise on the Tello). */
  applyTelemetry(heightCm: number | null, yaw: number | null): void {
    if (heightCm !== null && heightCm >= 0) this.#pose.z = heightCm;
    if (yaw === null) return;
    if (this.#anchorYaw) { this.#yawAtStart = yaw + this.#pose.heading; this.#anchorYaw = false; return; }
    if (this.#yawAtStart === null) return; // on the ground before the first takeoff: keep the start heading
    this.#pose.heading = normalize(this.#yawAtStart - yaw);
  }

  #step(forward: number, left: number): void {
    const h = rad(this.#pose.heading);
    this.#pose.x += forward * Math.cos(h) - left * Math.sin(h);
    this.#pose.y += forward * Math.sin(h) + left * Math.cos(h);
    this.#path.push({ x: Math.round(this.#pose.x), y: Math.round(this.#pose.y) });
    if (this.#path.length > 300) this.#path.shift();
  }

  record(action: string, detail: string): void {
    this.#log.push({ at: new Date().toISOString(), action, detail, pose: this.pose });
    if (this.#log.length > 60) this.#log.shift();
  }

  mark(name: string): Pose {
    const p = this.pose;
    this.#places.set(name, p);
    return p;
  }

  place(name: string): Pose | null {
    if (name === 'previous') {
      // Where it was before its last move.
      const moves = this.#log.filter((e) => e.action !== 'look' && e.action !== 'describe' && e.action !== 'status');
      return moves.length >= 2 ? moves[moves.length - 2].pose : this.#places.get('home') ?? null;
    }
    return this.#places.get(name) ?? null;
  }

  /**
   * Remembers something seen at `bearingDeg` (+ = right of the camera axis) and `distanceCm`
   * from the current pose. Without a distance it keeps only the direction.
   */
  see(label: string, bearingDeg: number, distanceCm: number | null, description: string | null = null): Sighting {
    const heading = normalize(this.#pose.heading - bearingDeg);
    // Without a distance it is drawn as a direction from where it was seen (150 cm out, approx).
    const d = distanceCm ?? 150;
    const fromX = Math.round(this.#pose.x), fromY = Math.round(this.#pose.y);
    const point = { x: this.#pose.x + d * Math.cos(rad(heading)), y: this.#pose.y + d * Math.sin(rad(heading)) };
    // The same thing seen again: same label (and description, when both have one), and either
    // close by (distance estimates are rough, so the radius grows with distance) or, without a
    // distance, in nearly the same direction from nearly the same spot. Merge into a running mean.
    const same = this.#sightings.find((s) => {
      if (s.label !== label || (description && s.description && s.description !== description)) return false;
      if (distanceCm === null || s.approx) {
        return Math.hypot(s.fromX - fromX, s.fromY - fromY) < 50 && Math.abs(normalize(s.heading - heading)) < 15;
      }
      return Math.hypot(s.x - point.x, s.y - point.y) < Math.max(80, 0.35 * Math.max(d, s.distanceCm ?? d));
    });
    if (same) {
      const n = same.count;
      if (!(distanceCm === null && !same.approx)) {
        same.x = Math.round((same.x * n + point.x) / (n + 1));
        same.y = Math.round((same.y * n + point.y) / (n + 1));
        if (distanceCm !== null) { same.distanceCm = Math.round(((same.distanceCm ?? distanceCm) * n + distanceCm) / (n + 1)); same.approx = false; }
      }
      same.count = n + 1;
      same.description ??= description;
      same.seenAt = new Date().toISOString();
      return same;
    }
    const sighting: Sighting = {
      label, description, distanceCm, heading: Math.round(heading), seenAt: new Date().toISOString(), approx: distanceCm === null,
      x: Math.round(point.x), y: Math.round(point.y), fromX, fromY, count: 1,
    };
    this.#sightings.push(sighting);
    if (this.#sightings.length > 80) this.#sightings.shift();
    return sighting;
  }

  /**
   * The moves that bring the drone from where it is to `target`: a turn back to the target heading
   * is not included. Returns drone-frame forward/left/up in cm.
   */
  vectorTo(target: { x: number; y: number; z?: number }): { forward: number; left: number; up: number; distance: number } {
    const dx = target.x - this.#pose.x;
    const dy = target.y - this.#pose.y;
    const h = rad(this.#pose.heading);
    const forward = dx * Math.cos(h) + dy * Math.sin(h);
    const left = -dx * Math.sin(h) + dy * Math.cos(h);
    const up = target.z === undefined || target.z === 0 ? 0 : target.z - this.#pose.z;
    return { forward: Math.round(forward), left: Math.round(left), up: Math.round(up), distance: Math.round(Math.hypot(dx, dy)) };
  }

  /** Signed degrees to turn so the heading becomes `heading` (+ = clockwise). */
  turnTo(heading: number): number {
    return Math.round(normalize(this.#pose.heading - heading));
  }

  memory(lastLog = 15) {
    return {
      frame: 'Room frame fixed at the first takeoff: x = forward then, y = left, z = height, cm; heading in degrees, + = turned left.',
      pose: this.pose,
      places: Object.fromEntries(this.#places),
      log: this.#log.slice(-lastLog),
      sightings: this.#sightings.slice(-15),
    };
  }

  /**
   * Depth columns from the camera (bearing + = right, metric depth along the optical axis) become
   * obstacle points: like a LiDAR sweep, a turn all around draws the walls and furniture.
   */
  addObstacles(columns: { bearing_deg: number; depth_m: number }[]): void {
    for (const c of columns) {
      if (!Number.isFinite(c.depth_m) || c.depth_m < 0.3 || c.depth_m > 6) continue;
      const range = (c.depth_m * 100) / Math.cos(rad(c.bearing_deg)); // depth is along the axis
      const heading = rad(this.#pose.heading - c.bearing_deg);
      const x = Math.round((this.#pose.x + range * Math.cos(heading)) / 20) * 20;
      const y = Math.round((this.#pose.y + range * Math.sin(heading)) / 20) * 20;
      this.#obstacles.set(`${x},${y}`, { x, y });
    }
    while (this.#obstacles.size > 800) this.#obstacles.delete(this.#obstacles.keys().next().value!);
  }

  /** Everything the top-down map in the page draws. */
  map() {
    return { pose: this.pose, path: this.#path.slice(), places: Object.fromEntries(this.#places), sightings: this.#sightings.slice(), obstacles: [...this.#obstacles.values()] };
  }

  /** One short line for the voice model. */
  summary(): string {
    const p = this.pose;
    const last = this.#log.slice(-3).map((e) => `${e.action} ${e.detail}`.trim()).join(', ');
    const seen = this.#sightings.slice(-3).map((s) => `${s.description ?? s.label} at (${s.x},${s.y})`).join('; ');
    return `at (${p.x},${p.y}) h${p.z} heading ${p.heading}°${last ? `; last: ${last}` : ''}${seen ? `; seen: ${seen}` : ''}`;
  }
}
