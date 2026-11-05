// Where the drone really is, from its own telemetry, 10 times a second.
//
// The Tello measures its speed over the floor with its downward camera (vgx, vgy, vgz) and its
// heading with the IMU (yaw). Integrating the speed gives the real path, including what commands
// do not tell: the drift at take-off, the slide while hovering, a move cut short.
//
// What the SDK does not say reliably is the unit (cm/s or dm/s, depending on firmware) and the
// frame of vgx/vgy (the drone's own axes, or fixed axes from power-on; and which way +y points).
// So the odometry calibrates itself: for every move the drone confirmed ("forward 50" = 50 cm
// ahead), it compares what was commanded with what the raw speeds add up to, and keeps the
// reading of the telemetry (frame, sign, scale, angle) that explains the moves best. Once that is
// known, the whole flight since take-off is integrated again with it: nothing is lost before.

/** One telemetry sample. `heading` = room heading at that moment (degrees, + = counterclockwise). */
export type Sample = { t: number; vgx: number; vgy: number; vgz: number; heading: number };
type Fit = { frame: 'body' | 'fixed'; mirror: 1 | -1; scale: number; angle: number; residual: number };
type Move = { from: number; to: number; dx: number; dy: number };

const MAX_DT = 0.3; // s: a gap in the telemetry is not integrated beyond this
const rad = (d: number) => (d * Math.PI) / 180;

export class Odometry {
  #samples: Sample[] = [];
  #moves: Move[] = [];
  #start = { x: 0, y: 0 };
  #fit: Fit | null = null;
  #pos = { x: 0, y: 0 };
  #flown = 0;
  #speed = 0;
  #open: number | null = null;

  /** Take-off: the flight starts here (room cm). Forgets the previous flight's samples, not the fit. */
  reset(start: { x: number; y: number }): void {
    this.#samples = []; this.#moves = []; this.#open = null;
    this.#start = { ...start }; this.#pos = { ...start }; this.#flown = 0; this.#speed = 0;
  }

  add(s: Sample): void {
    const prev = this.#samples[this.#samples.length - 1];
    this.#samples.push(s);
    if (this.#samples.length > 20000) this.#samples.shift(); // ~33 min at 10 Hz
    if (!this.#fit || !prev) return;
    const [dx, dy] = this.#step(prev, s, this.#fit);
    this.#pos.x += dx; this.#pos.y += dy;
    const d = Math.hypot(dx, dy); this.#flown += d;
    const dt = (s.t - prev.t) / 1000; this.#speed = dt > 0 ? d / dt : this.#speed;
  }

  /** A move command is about to start: returns its handle. */
  beginMove(): number { this.#open = this.#samples.length; return this.#open; }

  /**
   * The drone confirmed the move started at `handle`; it was meant to move (dx, dy) cm in the
   * room. Short moves (< 20 cm) and moves with too few samples teach nothing.
   */
  endMove(handle: number, dx: number, dy: number): void {
    if (this.#open !== handle) return;
    this.#open = null;
    const to = this.#samples.length;
    if (Math.hypot(dx, dy) < 20 || to - handle < 5) return;
    this.#moves.push({ from: Math.max(1, handle), to, dx, dy });
    this.#calibrate();
  }

  get calibrated(): boolean { return this.#fit !== null; }
  /** The reading of the telemetry, to keep across restarts (same drone, same firmware). */
  get fit(): Fit | null { return this.#fit ? { ...this.#fit } : null; }
  set fit(f: unknown) {
    const v = f as Partial<Fit> | null;
    if (v && (v.frame === 'body' || v.frame === 'fixed') && (v.mirror === 1 || v.mirror === -1) && Number.isFinite(v.scale) && Number.isFinite(v.angle)) this.#fit = { frame:v.frame, mirror:v.mirror, scale:v.scale!, angle:v.angle!, residual:Number(v.residual) || 0 };
  }
  /** Room position from the telemetry (cm), or null before the first calibration. */
  get position(): { x: number; y: number } | null { return this.#fit ? { x: this.#pos.x, y: this.#pos.y } : null; }
  get stats() {
    const f = this.#fit;
    return {
      calibrated: Boolean(f),
      reading: f ? `${f.frame === 'body' ? 'drone axes' : 'fixed axes'}${f.mirror === 1 ? ', +y left' : ''}, ${f.scale.toFixed(1)} cm per unit` : null,
      fitError: f ? Math.round(f.residual * 100) : null, // % of the commanded distance not explained
      flownCm: Math.round(this.#flown),
      fromTakeoffCm: Math.round(Math.hypot(this.#pos.x - this.#start.x, this.#pos.y - this.#start.y)),
      speedCms: Math.round(this.#speed),
      samples: this.#samples.length,
      moves: this.#moves.length,
    };
  }

  // Raw displacement of one sample interval, in room cm, under a reading of the telemetry.
  #raw(a: Sample, b: Sample, frame: 'body' | 'fixed', mirror: 1 | -1): [number, number] {
    const dt = Math.min(MAX_DT, Math.max(0, (b.t - a.t) / 1000));
    const vx = b.vgx, vy = mirror * b.vgy; // local: x ahead, y left
    if (frame === 'fixed') return [vx * dt, vy * dt];
    const h = rad(b.heading);
    return [(vx * Math.cos(h) - vy * Math.sin(h)) * dt, (vx * Math.sin(h) + vy * Math.cos(h)) * dt];
  }

  #step(a: Sample, b: Sample, f: Fit): [number, number] {
    const [rx, ry] = this.#raw(a, b, f.frame, f.mirror);
    const c = Math.cos(f.angle) * f.scale, s = Math.sin(f.angle) * f.scale;
    return [rx * c - ry * s, rx * s + ry * c];
  }

  #calibrate(): void {
    const total = this.#moves.reduce((s, m) => s + Math.hypot(m.dx, m.dy), 0);
    if (total < 60) return;
    let best: Fit | null = null;
    for (const frame of ['body', 'fixed'] as const) for (const mirror of [-1, 1] as const) {
      // Complex least squares: commanded ≈ z · measured, z = scale · e^(i angle).
      let nr = 0, ni = 0, den = 0, ee = 0;
      const raws = this.#moves.map((m) => {
        let x = 0, y = 0;
        for (let i = m.from; i < m.to; i++) { const [a, b] = this.#raw(this.#samples[i - 1], this.#samples[i], frame, mirror); x += a; y += b; }
        return [x, y];
      });
      this.#moves.forEach((m, k) => { const [x, y] = raws[k]; nr += m.dx * x + m.dy * y; ni += m.dy * x - m.dx * y; den += x * x + y * y; ee += m.dx * m.dx + m.dy * m.dy; });
      if (den < 1e-6) continue;
      const zr = nr / den, zi = ni / den, scale = Math.hypot(zr, zi), angle = Math.atan2(zi, zr);
      if (scale < 0.3 || scale > 30) continue;
      let err = 0;
      this.#moves.forEach((m, k) => { const [x, y] = raws[k]; err += (m.dx - (zr * x - zi * y)) ** 2 + (m.dy - (zr * y + zi * x)) ** 2; });
      // In the drone's own axes the angle should be about 0: a big turn there is not this reading.
      if (frame === 'body' && Math.abs(angle) > rad(30)) continue;
      const fit: Fit = { frame, mirror, scale, angle: frame === 'body' ? 0 : angle, residual: err / ee };
      if (frame === 'body') { // refit the scale alone with angle 0
        let num = 0; this.#moves.forEach((m, k) => { num += m.dx * raws[k][0] + m.dy * raws[k][1]; });
        fit.scale = num / den;
        let e2 = 0; this.#moves.forEach((m, k) => { e2 += (m.dx - fit.scale * raws[k][0]) ** 2 + (m.dy - fit.scale * raws[k][1]) ** 2; });
        fit.residual = e2 / ee;
      }
      // Prefer the plain reading (drone axes, +y right as on the Tello) unless another is clearly better.
      const bias = frame === 'body' && mirror === -1 ? 0 : 0.03;
      if (!best || fit.residual + bias < best.residual + (best.frame === 'body' && best.mirror === -1 ? 0 : 0.03)) best = fit;
    }
    if (!best || best.residual > 0.2) return;
    this.#fit = best;
    // Integrate the whole flight again with the reading that fits.
    this.#pos = { ...this.#start }; this.#flown = 0;
    for (let i = 1; i < this.#samples.length; i++) { const [dx, dy] = this.#step(this.#samples[i - 1], this.#samples[i], best); this.#pos.x += dx; this.#pos.y += dy; this.#flown += Math.hypot(dx, dy); }
  }
}
