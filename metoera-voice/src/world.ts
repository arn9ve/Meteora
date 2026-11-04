// What one drone remembers: where it is, what it did, places to go back to, and what it saw.
//
// Position is dead reckoning in a room frame fixed at the first takeoff: x = the direction the
// drone faced then, y = its left, z = height (cm); heading in degrees, + = turned left
// (counterclockwise). Every successful move updates it; telemetry height and yaw correct z and the
// heading. It drifts a little with every move (the Tello holds position with its downward camera),
// so "go back" lands close to, not exactly on, the old spot.

export type Pose = { x: number; y: number; z: number; heading: number };
export type LogEntry = { at: string; action: string; detail: string; pose: Pose };
export type Sighting = { label: string; description: string | null; x: number; y: number; distanceCm: number | null; seenAt: string; heading: number };

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
  #yawAtStart: number | null = null; // telemetry yaw when the room frame was fixed

  get pose(): Pose { return round(this.#pose); }

  /** Applies a Tello SDK move that the drone confirmed with "ok". */
  applySdk(sdk: string): void {
    const p = this.#pose;
    let m: RegExpExecArray | null;
    if (sdk === 'takeoff') {
      if (!this.#places.has('home')) this.#places.set('home', { ...p, z: 0 });
      p.z = Math.max(p.z, 80);
    } else if (sdk === 'land') {
      this.#places.set('last_landing', { ...p, z: 80 });
      p.z = 0;
    } else if ((m = /^(forward|back|left|right|up|down) (\d+)$/.exec(sdk))) {
      const d = Number(m[2]);
      if (m[1] === 'up') p.z += d;
      else if (m[1] === 'down') p.z = Math.max(0, p.z - d);
      else this.#step(m[1] === 'forward' ? d : m[1] === 'back' ? -d : 0, m[1] === 'left' ? d : m[1] === 'right' ? -d : 0);
    } else if ((m = /^go (-?\d+) (-?\d+) (-?\d+) \d+$/.exec(sdk))) {
      this.#step(Number(m[1]), Number(m[2]));
      p.z = Math.max(0, p.z + Number(m[3]));
    } else if ((m = /^(cw|ccw) (\d+)$/.exec(sdk))) {
      p.heading = normalize(p.heading + (m[1] === 'ccw' ? Number(m[2]) : -Number(m[2])));
    }
  }

  /** Telemetry: height above the floor and IMU yaw (+ = clockwise on the Tello). */
  applyTelemetry(heightCm: number | null, yaw: number | null): void {
    if (heightCm !== null && heightCm >= 0) this.#pose.z = heightCm;
    if (yaw === null) return;
    if (this.#yawAtStart === null) { this.#yawAtStart = yaw + this.#pose.heading; return; }
    this.#pose.heading = normalize(this.#yawAtStart - yaw);
  }

  #step(forward: number, left: number): void {
    const h = rad(this.#pose.heading);
    this.#pose.x += forward * Math.cos(h) - left * Math.sin(h);
    this.#pose.y += forward * Math.sin(h) + left * Math.cos(h);
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
    const d = distanceCm ?? 0;
    const sighting: Sighting = {
      label, description, distanceCm, heading: Math.round(heading), seenAt: new Date().toISOString(),
      x: Math.round(this.#pose.x + d * Math.cos(rad(heading))), y: Math.round(this.#pose.y + d * Math.sin(rad(heading))),
    };
    // The same thing seen again near the same spot replaces the older sighting.
    this.#sightings = this.#sightings.filter((s) => !(s.label === label && (description === null || s.description === description) && Math.hypot(s.x - sighting.x, s.y - sighting.y) < 60));
    this.#sightings.push(sighting);
    if (this.#sightings.length > 40) this.#sightings.shift();
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

  /** One short line for the voice model. */
  summary(): string {
    const p = this.pose;
    const last = this.#log.slice(-3).map((e) => `${e.action} ${e.detail}`.trim()).join(', ');
    const seen = this.#sightings.slice(-3).map((s) => `${s.description ?? s.label} at (${s.x},${s.y})`).join('; ');
    return `at (${p.x},${p.y}) h${p.z} heading ${p.heading}°${last ? `; last: ${last}` : ''}${seen ? `; seen: ${seen}` : ''}`;
  }
}
