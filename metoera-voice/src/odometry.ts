// Where the drone really is, from its own telemetry, 10 times a second.
//
// The Tello measures its speed over the floor with its downward camera (vgx, vgy, vgz) and its
// heading with the IMU (yaw). Integrating the speed gives the real path, including what commands
// do not tell: the drift at take-off, the slide while hovering, a move cut short.
//
// What the SDK does not say reliably is how vgx/vgy are given. Measured on our Tello EDU (flight
// of 5 Nov 2026): in fixed compass axes (turned by the yaw), with the opposite sign, about 12 cm
// per unit. Other firmwares may differ, so the reading is learned: for the moves the drone
// confirmed ("right 136" = 136 cm to its right), it tries every way the telemetry can be read
// (drone axes or compass axes, yaw sign, y sign, overall sign) and fits only the scale. A reading
// does not depend on where the drone starts or faces, so it is kept for the next flights.
// It is trusted only after two moves in clearly different directions that it explains well and
// no other reading explains as well; then the whole flight is integrated again with it.

/** One telemetry sample: raw values, and the room heading at that moment (degrees, + = counterclockwise). */
export type Sample = { t: number; vgx: number; vgy: number; vgz: number; yaw: number; heading: number };
export type Reading = { version: 2; frame: 'body' | 'compass'; yawSign: 1 | -1; mirror: 1 | -1; flip: 1 | -1; scale: number; residual: number };
type Move = { from: number; to: number; dx: number; dy: number };

const MAX_DT = 0.3; // s: a gap in the telemetry is not integrated beyond this
const rad = (d: number) => (d * Math.PI) / 180;
const CANDIDATES: Omit<Reading, 'scale' | 'residual'>[] = [];
for (const flip of [-1, 1] as const) for (const mirror of [1, -1] as const) {
  for (const yawSign of [1, -1] as const) CANDIDATES.push({ version: 2, frame: 'compass', yawSign, mirror, flip });
  CANDIDATES.push({ version: 2, frame: 'body', yawSign: 1, mirror, flip });
}
const same = (a: Omit<Reading, 'scale' | 'residual'>, b: Omit<Reading, 'scale' | 'residual'>) => a.frame === b.frame && a.yawSign === b.yawSign && a.mirror === b.mirror && a.flip === b.flip;

export class Odometry {
  #samples: Sample[] = [];
  #moves: Move[] = [];
  #start = { x: 0, y: 0 };
  #fit: Reading | null = null;
  #pos = { x: 0, y: 0 };
  #flown = 0;
  #speed = 0;
  #open: number | null = null;
  #version = 0; // bumps every time the reading changes (the position may jump then)

  /** Take-off: the flight starts here (room cm). Forgets the previous flight's samples, not the reading. */
  reset(start: { x: number; y: number }): void {
    this.#samples = []; this.#moves = []; this.#open = null;
    this.#start = { ...start }; this.#pos = { ...start }; this.#flown = 0; this.#speed = 0;
  }

  add(s: Sample): void {
    const prev = this.#samples[this.#samples.length - 1];
    this.#samples.push(s);
    if (this.#samples.length > 20000) this.#samples.shift(); // ~33 min at 10 Hz
    if (!this.#fit || !prev) return;
    const [dx, dy] = this.#step(prev, s, this.#fit, this.#fit.scale);
    this.#pos.x += dx; this.#pos.y += dy;
    const d = Math.hypot(dx, dy); this.#flown += d;
    const dt = (s.t - prev.t) / 1000; this.#speed = dt > 0 ? d / dt : this.#speed;
  }

  /** A photo fix moved the position: the telemetry carries on from there. */
  shift(dx: number, dy: number): void { this.#pos.x += dx; this.#pos.y += dy; }

  /** A move command is about to start: returns its handle. */
  beginMove(): number { this.#open = this.#samples.length; return this.#open; }

  /** The drone confirmed the move started at `handle`; it was meant to move (dx, dy) cm in the room. */
  endMove(handle: number, dx: number, dy: number): void {
    if (this.#open !== handle) return;
    this.#open = null;
    const to = this.#samples.length;
    if (Math.hypot(dx, dy) < 20 || to - handle < 5) return;
    this.#moves.push({ from: Math.max(1, handle), to, dx, dy });
    this.#calibrate();
  }

  get calibrated(): boolean { return this.#fit !== null; }
  /** Changes whenever the reading changes: a route in progress must not chase the jump. */
  get version(): number { return this.#version; }
  get fit(): Reading | null { return this.#fit ? { ...this.#fit } : null; }
  /** A reading kept from an earlier flight (version 2 only: older ones depended on the flight). */
  set fit(f: unknown) {
    const v = f as Partial<Reading> | null;
    if (v && v.version === 2 && (v.frame === 'body' || v.frame === 'compass') && [1, -1].includes(v.yawSign!) && [1, -1].includes(v.mirror!) && [1, -1].includes(v.flip!) && Number.isFinite(v.scale) && v.scale! > 0) {
      this.#fit = { version: 2, frame: v.frame, yawSign: v.yawSign!, mirror: v.mirror!, flip: v.flip!, scale: v.scale!, residual: Number(v.residual) || 0 };
    }
  }
  /** Room position from the telemetry (cm), or null while the reading is not known. */
  get position(): { x: number; y: number } | null { return this.#fit ? { x: this.#pos.x, y: this.#pos.y } : null; }
  get stats() {
    const f = this.#fit;
    return {
      calibrated: Boolean(f),
      reading: f ? `${f.frame === 'compass' ? 'compass axes' : 'drone axes'}${f.flip === -1 ? ', reversed' : ''}, ${f.scale.toFixed(1)} cm per unit` : null,
      fitError: f ? Math.round(f.residual * 100) : null, // % of the commanded moves not explained
      flownCm: Math.round(this.#flown),
      fromTakeoffCm: Math.round(Math.hypot(this.#pos.x - this.#start.x, this.#pos.y - this.#start.y)),
      speedCms: Math.round(this.#speed),
      samples: this.#samples.length,
      moves: this.#moves.length,
    };
  }

  // Displacement of one sample interval in room cm, for a reading, scale 1.
  #step(a: Sample, b: Sample, r: Omit<Reading, 'scale' | 'residual'>, scale = 1): [number, number] {
    const dt = Math.min(MAX_DT, Math.max(0, (b.t - a.t) / 1000));
    let forward: number, right: number;
    if (r.frame === 'body') { forward = b.vgx; right = r.mirror * b.vgy; }
    else {
      // Compass axes: x where yaw 0 points, y 90° clockwise from it (or the mirror). Into the drone's axes.
      const psi = rad(r.yawSign * b.yaw), vx = b.vgx, vy = r.mirror * b.vgy;
      forward = vx * Math.cos(psi) + vy * Math.sin(psi);
      right = -vx * Math.sin(psi) + vy * Math.cos(psi);
    }
    forward *= r.flip * scale * dt; right *= r.flip * scale * dt;
    const h = rad(b.heading);
    // Room frame: heading h, left = +90°.
    return [forward * Math.cos(h) + right * Math.sin(h), forward * Math.sin(h) - right * Math.cos(h)];
  }

  #calibrate(): void {
    // Two moves at least 45° apart: one direction alone fits several readings.
    const dirs = this.#moves.map((m) => Math.atan2(m.dy, m.dx));
    let spread = 0;
    for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) { let d = Math.abs(dirs[i] - dirs[j]) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; spread = Math.max(spread, d); }
    if (this.#moves.length < 2 || spread < rad(45)) return;
    const ee = this.#moves.reduce((s, m) => s + m.dx * m.dx + m.dy * m.dy, 0);
    const fits: Reading[] = [];
    for (const c of CANDIDATES) {
      const raws = this.#moves.map((m) => { let x = 0, y = 0; for (let i = m.from; i < m.to; i++) { const [a, b] = this.#step(this.#samples[i - 1], this.#samples[i], c); x += a; y += b; } return [x, y]; });
      let num = 0, den = 0;
      this.#moves.forEach((m, k) => { num += m.dx * raws[k][0] + m.dy * raws[k][1]; den += raws[k][0] ** 2 + raws[k][1] ** 2; });
      if (den < 1e-9 || num <= 0) continue;
      const scale = num / den;
      if (scale < 0.3 || scale > 50) continue;
      let err = 0; this.#moves.forEach((m, k) => { err += (m.dx - scale * raws[k][0]) ** 2 + (m.dy - scale * raws[k][1]) ** 2; });
      fits.push({ ...c, scale, residual: err / ee });
    }
    fits.sort((a, b) => a.residual - b.residual);
    const best = fits[0];
    if (!best || best.residual > 0.15) return;
    // Another reading that explains the moves almost as well: not sure yet, wait for more moves.
    const rival = fits.find((f) => !same(f, best) && f.residual < best.residual + 0.1);
    if (rival && !(this.#fit && same(this.#fit, best))) return;
    if (!this.#fit || !same(this.#fit, best) || Math.abs(this.#fit.scale - best.scale) / best.scale > 0.02) this.#version += 1;
    this.#fit = best;
    this.#pos = { ...this.#start }; this.#flown = 0;
    for (let i = 1; i < this.#samples.length; i++) { const [dx, dy] = this.#step(this.#samples[i - 1], this.#samples[i], best, best.scale); this.#pos.x += dx; this.#pos.y += dy; this.#flown += Math.hypot(dx, dy); }
  }
}
