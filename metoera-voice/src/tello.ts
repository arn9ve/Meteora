// Adapter for one real Tello EDU or RoboMaster TT over the Tello SDK (UDP).
// The Tello sends every reply to local port 8889, so the command socket must bind 8889.
// Several links (one per drone) share that port through UdpPort, which routes by sender IP.
// One request is in flight at a time; each request only accepts a reply of its own shape,
// so a late "ok" can never be read as the answer to a later query.
import { UdpPort, type Datagram } from './udp-port.ts';
import { estimateDistanceCm, bearingDeg, type Box } from './distance.ts';
import { World, normalize } from './world.ts';

export type TelloSnapshot = {
  id: string;
  mode: 'real';
  connected: boolean;
  verified: boolean;
  /** Why the background link check last failed, or null. */
  linkError: string | null;
  video: boolean;
  flight: 'landed' | 'flying';
  battery: number | null;
  heightCm: number | null;
  heading: number | null;
  lastError: string | null;
  /** Short memory line: position, last actions, recent sightings. */
  memory: string;
  timestamp: string;
};

export type TelloResult =
  | { ok: true; mode: 'real'; action: string; drone: TelloSnapshot }
  | { ok: false; mode: 'real'; error: string };

export type TelloOptions = {
  /** The droneId voice commands use for this drone. Default 'tello'. */
  id?: string;
  host: string;
  expectedSerial?: string;
  port?: number;
  localPort?: number;
  statePort?: number;
  keepaliveMs?: number;
  minTakeoffBattery?: number;
  hoverMs?: number;
  maxMoveCm?: number;
  /** Latest object detections from the camera (metoera-vision), or null when unavailable. */
  vision?: () => Promise<Detections | null>;
  /** Latest camera frame as JPEG (with the YOLO boxes), for the vision model. */
  frame?: () => Promise<Buffer | null>;
  /** Asks Grok vision about one or more JPEG images; returns its text answer. */
  askVision?: (images: Buffer[], prompt: string) => Promise<string | null>;
  /** Where the drone stands in the shared room frame before its first takeoff. */
  start?: { x: number; y: number; heading: number };
  /** Pause after each scan rotation before a frame counts, so the image is steady. */
  settleMs?: number;
  /**
   * Null when this laptop may talk to the drone; otherwise why not ("Black is flown by Amir on Barry's laptop").
   * Checked before every packet, so a drone another laptop owns never hears from this one.
   */
  mayTalk?: () => string | null;
};

export type Detection = { label: string; confidence: number; center: { x: number; y: number }; box?: Box };
export type Detections = { timestamp: number | null; objects: Detection[] };

const MIN_CONFIDENCE = 0.5;
const SCAN_VIEWS = 4; // 4 x 90 degrees; the Tello camera sees about 82 degrees across
const side = (x: number) => (x < 1 / 3 ? 'left' : x > 2 / 3 ? 'right' : 'center');


const MOVE_DIRECTIONS = ['forward', 'back', 'left', 'right', 'up', 'down'] as const;
const ROTATE_DIRECTIONS = ['clockwise', 'counterclockwise'] as const;
const FLIP_DIRECTIONS = { left: 'l', right: 'r', forward: 'f', back: 'b' } as const;
const FLIP_MIN_BATTERY = 50; // the Tello refuses flips below 50%
const isOk = (text: string) => /^ok$/i.test(text);

type Pending = { accept: (text: string) => boolean; resolve: (text: string | null) => void };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tello move for a drone-frame vector in cm, capped to maxLen; null when every axis is under 20 cm. */
export function moveSdk(forward: number, left: number, up: number, maxLen: number): string | null {
  const length = Math.hypot(forward, left, up);
  if (length === 0) return null;
  const k = Math.min(1, maxLen / length);
  const f = Math.round(forward * k), l = Math.round(left * k), u = Math.round(up * k);
  const big = [Math.abs(f) >= 20, Math.abs(l) >= 20, Math.abs(u) >= 20];
  if (!big.some(Boolean)) return null;
  if (big.filter(Boolean).length === 1) {
    if (big[0]) return f > 0 ? `forward ${f}` : `back ${-f}`;
    if (big[1]) return l > 0 ? `left ${l}` : `right ${-l}`;
    return u > 0 ? `up ${u}` : `down ${-u}`;
  }
  return `go ${f} ${l} ${u} 40`; // Tello go: x forward, y left, z up, speed cm/s
}

export class RealTello {
  readonly #id: string;
  readonly #host: string;
  readonly #port: number;
  readonly #localPort: number;
  readonly #statePort: number;
  readonly #expectedSerial: string | undefined;
  readonly #keepaliveMs: number;
  readonly #minTakeoffBattery: number;
  readonly #hoverMs: number;
  readonly #maxMoveCm: number;
  readonly #vision: (() => Promise<Detections | null>) | null;
  readonly #frame: (() => Promise<Buffer | null>) | null;
  readonly #askVision: ((images: Buffer[], prompt: string) => Promise<string | null>) | null;
  readonly #world: World;
  readonly #settleMs: number;
  readonly #mayTalk: () => string | null;
  #video = false;
  #linkError: string | null = null;
  #probing = false;
  #verifiedAt = 0;
  #groundSince = 0;
  #interrupted = false; // true while stop / force land / motor kill own the drone
  #generation = 0; // bumped by force land and motor kill; queued commands from before are cancelled
  #stopDone: Promise<unknown> = Promise.resolve(); // queued work waits for a running stop
  #command: UdpPort | null = null;
  #state: UdpPort | null = null;
  #unsubscribe: (() => void)[] = [];
  #opening: Promise<void> | null = null;
  #pending: Pending | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #busy = false;
  #keepalive: NodeJS.Timeout | null = null;
  #verified = false;
  #flight: 'landed' | 'flying' = 'landed';
  #battery: number | null = null;
  #heightCm: number | null = null;
  #heading: number | null = null;
  #lastStateAt = 0;
  #lastError: string | null = null;

  constructor(options: TelloOptions) {
    this.#id = options.id ?? 'tello';
    this.#host = options.host;
    this.#port = options.port ?? 8889;
    this.#localPort = options.localPort ?? 8889;
    this.#statePort = options.statePort ?? 8890;
    this.#expectedSerial = options.expectedSerial?.trim() || undefined;
    this.#keepaliveMs = options.keepaliveMs ?? 5000;
    this.#minTakeoffBattery = options.minTakeoffBattery ?? 20;
    this.#hoverMs = options.hoverMs ?? 5000;
    // Indoor cap for voice control; the SDK itself allows 500.
    this.#maxMoveCm = Math.min(500, Math.max(20, options.maxMoveCm ?? 100));
    this.#vision = options.vision ?? null;
    this.#frame = options.frame ?? null;
    this.#askVision = options.askVision ?? null;
    this.#world = new World(options.start);
    this.#settleMs = options.settleMs ?? 700;
    this.#mayTalk = options.mayTalk ?? (() => null);
  }

  /** True while a queued command (takeoff, move, scan…) is running on this drone. */
  get busy(): boolean {
    return this.#busy;
  }

  /** What the top-down map draws for this drone. */
  map() {
    return this.#world.map();
  }

  snapshot(): TelloSnapshot {
    return {
      id: this.#id,
      mode: 'real',
      connected: Date.now() - this.#lastStateAt < 3000,
      verified: this.#verified,
      linkError: this.#linkError,
      video: this.#video,
      flight: this.#flight,
      battery: this.#battery,
      heightCm: this.#heightCm,
      heading: this.#heading,
      lastError: this.#lastError,
      memory: this.#world.summary(),
      timestamp: new Date().toISOString(),
    };
  }

  execute(value: unknown): Promise<TelloResult> {
    const generation = this.#generation;
    const run = this.#queue.then(async () => {
      await this.#stopDone;
      if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
      this.#busy = true;
      try { return await this.#execute(value, generation); } finally { this.#busy = false; }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Hover in place now, interrupting a running move. Bypasses the queue on purpose. */
  stop(): Promise<TelloResult> {
    const run = this.#stop();
    this.#stopDone = run.catch(() => undefined);
    return run;
  }

  async #stop(): Promise<TelloResult> {
    const refused = this.#mayTalk();
    if (refused) return this.#fail(refused);
    if (!this.#command || !this.#verified) return this.#fail('The Tello is not connected yet');
    this.#interrupted = true;
    this.#pending?.resolve(null);
    this.#pending = null;
    const reply = await this.#request('stop', isOk, 3000, true);
    this.#interrupted = false;
    if (reply === null) return this.#fail('No reply to stop');
    if (!isOk(reply)) return this.#fail(`Drone rejected stop: ${reply.slice(0, 60)}`);
    return { ok: true, mode: 'real', action: 'stop', drone: this.snapshot() };
  }

  /** Lands if flying. Used on server shutdown. Bypasses the queue on purpose. */
  /**
   * Switch off: cancel everything queued, interrupt what is running and land now.
   * Bypasses the queue on purpose. Also used when the server shuts down.
   */
  forceLand(): Promise<TelloResult> {
    this.#generation += 1;
    const run = this.#forceLand();
    this.#stopDone = run.catch(() => undefined);
    return run;
  }

  async #forceLand(): Promise<TelloResult> {
    const refused = this.#mayTalk();
    if (refused) return this.#fail(refused);
    if (!this.#command || !this.#verified) return this.#fail('The Tello is not connected yet');
    this.#interrupted = true;
    this.#pending?.resolve(null);
    this.#pending = null;
    let reply: string | null = null;
    for (let attempt = 0; attempt < 3 && !(reply && isOk(reply)); attempt += 1) reply = await this.#request('land', isOk, 10000, true);
    this.#interrupted = false;
    if (reply && isOk(reply)) {
      this.#flight = 'landed';
      this.#world.applySdk('land');
      this.#world.record('land', 'forced');
      return { ok: true, mode: 'real', action: 'force_land', drone: this.snapshot() };
    }
    return this.#fail(reply ? `Drone rejected land: ${reply.slice(0, 60)}` : 'No reply to land. Use the motor kill only if the drone is in danger');
  }

  /** Emergency: the motors stop at once and the drone drops. Bypasses everything. */
  async killMotors(): Promise<TelloResult> {
    const refused = this.#mayTalk();
    if (refused) return this.#fail(refused);
    this.#generation += 1;
    const socket = this.#command;
    if (!socket) return this.#fail('The Tello is not connected yet');
    this.#interrupted = true;
    this.#pending?.resolve(null);
    this.#pending = null;
    // No reply is awaited: every datagram must leave before anything else happens.
    for (let i = 0; i < 3; i += 1) await socket.send('emergency', this.#port, this.#host);
    this.#flight = 'landed';
    this.#interrupted = false;
    return { ok: true, mode: 'real', action: 'emergency', drone: this.snapshot() };
  }

  /**
   * Background link check, run by the server every few seconds. Read-only: it only sends
   * `command`, `sn?` and `streamon`. If telemetry stopped (drone rebooted or left the network)
   * it forgets the old session so the next check shakes hands again.
   */
  probe(): Promise<void> {
    if (this.#probing) return Promise.resolve();
    this.#probing = true;
    const run = this.#queue.then(async () => {
      await this.#stopDone;
      if (this.#verified && Date.now() - Math.max(this.#lastStateAt, this.#verifiedAt) > 5000) this.#resetSession();
      if (this.#verified) { this.#linkError = null; return; }
      this.#linkError = await this.#ensureReady(1, 1500);
    }).finally(() => { this.#probing = false; });
    this.#queue = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  /**
   * Hand the drone back when this server stops: stop its video so it no longer reaches this
   * computer, then close the link. The laptop that takes it over starts with a clean stream.
   */
  release(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#command && this.#verified && this.#video) {
        const reply = await this.#request('streamoff', isOk, 1000);
        if (reply && isOk(reply)) this.#video = false;
      }
    }).finally(() => this.close());
    this.#queue = run.catch(() => undefined);
    return run.catch(() => undefined);
  }

  #resetSession(): void {
    this.#verified = false;
    this.#video = false;
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;
  }

  close(): void {
    // A reopened link verifies the serial again, which also restarts the keepalive.
    this.#resetSession();
    this.#pending?.resolve(null);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    this.#command?.release();
    this.#state?.release();
    this.#command = null;
    this.#state = null;
  }

  async #execute(value: unknown, generation = this.#generation): Promise<TelloResult> {
    if (!isRecord(value) || value.droneId !== this.#id) return this.#fail('Invalid droneId');
    const ready = await this.#ensureReady();
    if (ready) return this.#fail(ready);

    if (value.action === 'takeoff') {
      if (Object.keys(value).length !== 2) return this.#fail('Unknown argument for takeoff');
      if (this.#flight === 'flying') return this.#fail('takeoff requires a landed drone');
      const level = await this.#request('battery?', (t) => /^\d{1,3}$/.test(t), 3000);
      if (level === null || !/^\d{1,3}$/.test(level)) return this.#fail('Battery level unavailable');
      const battery = Number(level);
      this.#battery = battery;
      if (battery < this.#minTakeoffBattery) return this.#fail(`Battery ${battery}% is below ${this.#minTakeoffBattery}%`);
      return this.#motion('takeoff', 'takeoff', 20000, () => { this.#flight = 'flying'; });
    }

    // Same as tools/test-flight.mjs: take off, hover, land, as one action.
    if (value.action === 'test_flight') {
      if (Object.keys(value).length !== 2) return this.#fail('Unknown argument for test_flight');
      if (this.#flight === 'flying') return this.#fail('test_flight requires a landed drone');
      const up = await this.#execute({ droneId: this.#id, action: 'takeoff' }, generation);
      if (!up.ok) return up;
      const until = Date.now() + this.#hoverMs;
      while (Date.now() < until) {
        if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
        await this.#request('battery?', (t) => /^\d{1,3}$/.test(t), 1500); // keeps the SDK session alive
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, until - Date.now()))));
      }
      if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
      let down: TelloResult = this.#fail('land not attempted');
      for (let attempt = 0; attempt < 3 && !down.ok; attempt += 1) down = await this.#motion('land', 'land', 20000, () => { this.#flight = 'landed'; });
      return down.ok ? { ok: true, mode: 'real', action: 'test_flight', drone: this.snapshot() } : down;
    }

    if (value.action === 'land') {
      if (Object.keys(value).length !== 2) return this.#fail('Unknown argument for land');
      if (this.#flight !== 'flying') return this.#fail('land requires a flying drone');
      return this.#motion('land', 'land', 20000, () => { this.#flight = 'landed'; });
    }

    if (value.action === 'move') {
      const { direction, centimeters } = value;
      if (Object.keys(value).some((k) => !['droneId', 'action', 'direction', 'centimeters'].includes(k))) return this.#fail('Unknown argument for move');
      if (!MOVE_DIRECTIONS.includes(direction as never)) return this.#fail('Invalid move direction');
      if (typeof centimeters !== 'number' || !Number.isInteger(centimeters) || centimeters < 20 || centimeters > this.#maxMoveCm) {
        return this.#fail(`centimeters must be an integer from 20 to ${this.#maxMoveCm}`);
      }
      if (this.#flight !== 'flying') return this.#fail('move requires a flying drone');
      return this.#motion('move', `${direction} ${centimeters}`, 15000);
    }

    if (value.action === 'rotate') {
      const { direction, degrees } = value;
      if (Object.keys(value).some((k) => !['droneId', 'action', 'direction', 'degrees'].includes(k))) return this.#fail('Unknown argument for rotate');
      if (!ROTATE_DIRECTIONS.includes(direction as never)) return this.#fail('Invalid rotate direction');
      if (typeof degrees !== 'number' || !Number.isInteger(degrees) || degrees < 1 || degrees > 360) return this.#fail('degrees must be an integer from 1 to 360');
      if (this.#flight !== 'flying') return this.#fail('rotate requires a flying drone');
      return this.#motion('rotate', `${direction === 'clockwise' ? 'cw' : 'ccw'} ${degrees}`, 15000);
    }

    if (value.action === 'flip') {
      const { direction } = value;
      if (Object.keys(value).some((k) => !['droneId', 'action', 'direction'].includes(k))) return this.#fail('Unknown argument for flip');
      if (typeof direction !== 'string' || !Object.hasOwn(FLIP_DIRECTIONS, direction)) return this.#fail('Invalid flip direction');
      if (this.#flight !== 'flying') return this.#fail('flip requires a flying drone');
      const level = await this.#request('battery?', (t) => /^\d{1,3}$/.test(t), 3000);
      if (level === null || !/^\d{1,3}$/.test(level)) return this.#fail('Battery level unavailable');
      this.#battery = Number(level);
      if (this.#battery < FLIP_MIN_BATTERY) return this.#fail(`Flips need at least ${FLIP_MIN_BATTERY}% battery (now ${this.#battery}%)`);
      return this.#motion('flip', `flip ${FLIP_DIRECTIONS[direction as keyof typeof FLIP_DIRECTIONS]}`, 15000);
    }

    if (value.action === 'speed') {
      const { cmPerSecond } = value;
      if (Object.keys(value).some((k) => !['droneId', 'action', 'cmPerSecond'].includes(k))) return this.#fail('Unknown argument for speed');
      if (typeof cmPerSecond !== 'number' || !Number.isInteger(cmPerSecond) || cmPerSecond < 10 || cmPerSecond > 100) return this.#fail('cmPerSecond must be an integer from 10 to 100');
      return this.#motion('speed', `speed ${cmPerSecond}`, 3000);
    }

    if (value.action === 'look') {
      if (Object.keys(value).some((k) => !['droneId', 'action', 'label'].includes(k))) return this.#fail('Unknown argument for look');
      const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim().toLowerCase() : null;
      const view = await this.#freshView(Date.now() - 1500, 3000);
      if (!view) return this.#fail(this.#visionError());
      const objects = view.objects.filter((o) => o.confidence >= MIN_CONFIDENCE && (!label || o.label.toLowerCase() === label));
      const counts: Record<string, number> = {};
      for (const o of objects) counts[o.label] = (counts[o.label] ?? 0) + 1;
      for (const o of objects) this.#world.see(o.label, bearingDeg(o.center.x), o.box ? estimateDistanceCm(o.label, o.box) : null);
      this.#world.record('look', label ?? 'all');
      return {
        ok: true, mode: 'real', action: 'look', drone: this.snapshot(),
        seen: { counts, objects: objects.map((o) => ({ label: o.label, confidence: Math.round(o.confidence * 100) / 100, side: side(o.center.x), distanceCm: o.box ? estimateDistanceCm(o.label, o.box) : null })), note: 'distanceCm is estimated from the camera image (about ±30%)' },
      } as TelloResult;
    }

    // Turn 360 degrees in four 90-degree steps and count one kind of object in each view.
    if (value.action === 'scan') {
      if (Object.keys(value).some((k) => !['droneId', 'action', 'label'].includes(k))) return this.#fail('Unknown argument for scan');
      const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim().toLowerCase() : 'person';
      if (this.#flight !== 'flying') return this.#fail('scan requires a flying drone');
      const views: { view: number; degreesFromStart: number; count: number | null; sides: string[] }[] = [];
      for (let i = 0; i < SCAN_VIEWS; i += 1) {
        if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
        const frame = await this.#freshView(Date.now() + this.#settleMs, 4000);
        if (!frame && i === 0) return this.#fail(this.#visionError());
        const matches = frame ? frame.objects.filter((o) => o.confidence >= MIN_CONFIDENCE && o.label.toLowerCase() === label) : [];
        for (const o of matches) this.#world.see(o.label, bearingDeg(o.center.x), o.box ? estimateDistanceCm(o.label, o.box) : null);
        views.push({ view: i + 1, degreesFromStart: i * 90, count: frame ? matches.length : null, sides: matches.map((o) => side(o.center.x)) });
        const turn = await this.#motion('rotate', 'cw 90', 15000);
        if (!turn.ok) return { ok: false, mode: 'real', error: `scan stopped after view ${i + 1}: ${'error' in turn ? turn.error : ''}`, views } as TelloResult;
      }
      const counted = views.filter((v) => v.count !== null);
      const total = counted.reduce((sum, v) => sum + (v.count ?? 0), 0);
      return {
        ok: true, mode: 'real', action: 'scan', drone: this.snapshot(),
        scan: {
          label, total, views,
          note: `Sum of ${counted.length} views 90 degrees apart, back at the starting heading. Approximate: something at the edge between two views can be missed or counted twice.`,
        },
      } as TelloResult;
    }

    // Fly toward a person or object in front and stop at a safe distance, camera only.
    // Each step: find the closest match, estimate its distance (box size) and angle (box
    // position), work out the point `stopCm` in front of it and fly a straight line there with
    // `go x y z` (forward and sideways at once, no turning). Only part of the way per step,
    // because the estimate is rough, then look again. It turns only when the target is about to
    // leave the picture, and if it loses the target it looks toward the side it was last seen.
    if (value.action === 'approach') {
      if (Object.keys(value).some((k) => !['droneId', 'action', 'label', 'stopCm'].includes(k))) return this.#fail('Unknown argument for approach');
      const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim().toLowerCase() : 'person';
      const stopCm = value.stopCm === undefined ? 100 : value.stopCm;
      if (typeof stopCm !== 'number' || !Number.isInteger(stopCm) || stopCm < 50 || stopCm > 300) return this.#fail('stopCm must be an integer from 50 to 300');
      if (this.#flight !== 'flying') return this.#fail('approach requires a flying drone');
      const steps: { distanceCm: number | null; angleDeg: number; action: string }[] = [];
      let startDistanceCm: number | null = null;
      let travelledCm = 0;
      let lastAngle = 0;
      let trackX: number | null = null;
      let searched = false;
      const MAX_TRAVEL_CM = 400;
      const STEP_CM = Math.min(100, this.#maxMoveCm);
      const report = (ok: boolean, reason: string): TelloResult => {
        const finalDistanceCm = [...steps].reverse().find((s) => s.distanceCm !== null)?.distanceCm ?? null;
        const approach = { label, stopCm, startDistanceCm, finalDistanceCm, travelledCm, steps, reason, note: 'Distances and angles are estimated from the camera image (about ±30%).' };
        // The failure result keeps the steps so far, like scan does with its views.
        return (ok ? { ok: true, mode: 'real', action: 'approach', drone: this.snapshot(), approach }
          : { ok: false, mode: 'real', error: reason, approach } as unknown) as TelloResult;
      };
      const turn = async (deg: number) => {
        const sdk = `${deg > 0 ? 'cw' : 'ccw'} ${Math.min(Math.abs(deg), 90)}`;
        steps.push({ distanceCm: null, angleDeg: deg, action: sdk });
        return this.#motion('rotate', sdk, 15000);
      };
      for (let i = 0; i < 14; i += 1) {
        if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
        const frame = await this.#freshView(Date.now() + this.#settleMs, 4000);
        if (!frame) return i === 0 ? this.#fail(this.#visionError()) : report(false, 'Lost the camera image');
        const matches = frame.objects.filter((o) => o.confidence >= MIN_CONFIDENCE && o.label.toLowerCase() === label && o.box);
        // The closest one is the biggest box.
        // First look: the one most in front of the drone (among the near ones); afterwards: the
        // one closest to where the target was, so it keeps following the same person.
        const biggest = Math.max(0, ...matches.map((o) => o.box!.w * o.box!.h));
        const candidates = matches.filter((o) => o.box!.w * o.box!.h >= biggest * 0.3);
        const aim: number = trackX ?? 0.5;
        const target: Detection | undefined = candidates.sort((a, b) => Math.abs(a.center.x - aim) - Math.abs(b.center.x - aim))[0];
        if (target) trackX = target.center.x;
        if (!target) {
          if (i === 0) return this.#fail(`I do not see a ${label} in front of me`);
          // Lost it after a move: look once toward the side where it was.
          if (!searched) {
            searched = true;
            trackX = lastAngle >= 0 ? 0.25 : 0.75; // after turning toward it, expect it on the other side
            const look = await turn(lastAngle >= 0 ? 30 : -30);
            if (!look.ok) return report(false, 'error' in look ? look.error : 'rotate failed');
            continue;
          }
          return report(false, `Lost sight of the ${label}`);
        }
        searched = false;
        const distanceCm = estimateDistanceCm(label, target.box!);
        const angleDeg = bearingDeg(target.center.x); // + right, - left
        lastAngle = angleDeg;
        startDistanceCm ??= distanceCm;
        // Near the edge of the picture: turn toward it first so it stays in view.
        if (Math.abs(angleDeg) > 25) {
          const r = await turn(angleDeg);
          if (!r.ok) return report(false, 'error' in r ? r.error : 'rotate failed');
          continue;
        }
        if (distanceCm === null) {
          // Unknown size: go by how much of the frame the box fills, straight at it.
          if (target.box!.h >= 0.45 || target.box!.w >= 0.45) {
            steps.push({ distanceCm, angleDeg, action: 'arrived' });
            return report(true, `Close to the ${label} (it fills much of the view)`);
          }
          if (Math.abs(angleDeg) >= 8) { const r = await turn(angleDeg); if (!r.ok) return report(false, 'error' in r ? r.error : 'rotate failed'); continue; }
          const move = await this.#motion('move', 'forward 30', 15000);
          steps.push({ distanceCm, angleDeg, action: 'forward 30' });
          if (!move.ok) return report(false, 'error' in move ? move.error : 'move failed');
          travelledCm += 30;
          continue;
        }
        // Where to end up: on the line to the target, stopCm short of it.
        const rad = (angleDeg * Math.PI) / 180;
        const ahead = Math.cos(rad) * distanceCm - stopCm; // still to go forward
        const side = Math.sin(rad) * distanceCm;            // + right, - left
        if (ahead < 20 && Math.abs(side) < 20) {
          steps.push({ distanceCm, angleDeg, action: 'arrived' });
          this.#world.see(label, angleDeg, distanceCm);
          return report(true, `About ${distanceCm} cm from the ${label}${Math.abs(angleDeg) >= 8 ? `, ${Math.abs(angleDeg)}° to the ${angleDeg > 0 ? 'right' : 'left'}` : ''}`);
        }
        const budget = MAX_TRAVEL_CM - travelledCm;
        if (budget < 20) return report(true, `Stopped after ${travelledCm} cm, the most one approach may travel`);
        // 70% of the way, at most STEP_CM per step, never closer than the stop distance.
        let x = Math.max(0, ahead) > 60 ? Math.max(0, ahead) * 0.7 : Math.max(0, ahead);
        let y = Math.abs(side) > 60 ? side * 0.7 : side;
        const length = Math.hypot(x, y);
        const scale = Math.min(1, STEP_CM / length, budget / length);
        x = Math.round(x * scale);
        y = Math.round(y * scale);
        // The Tello rejects a go where every axis is under 20 cm: use the plain moves then.
        let sdk: string;
        if (Math.abs(x) >= 20 || Math.abs(y) >= 20) {
          if (Math.abs(x) < 20) sdk = y > 0 ? `right ${Math.abs(y)}` : `left ${Math.abs(y)}`;
          else if (Math.abs(y) < 20) sdk = `forward ${x}`;
          else sdk = `go ${x} ${-y} 0 40`; // Tello go: x forward, y left, z up, speed cm/s
        } else {
          steps.push({ distanceCm, angleDeg, action: 'arrived' });
          return report(true, `About ${distanceCm} cm from the ${label}`);
        }
        steps.push({ distanceCm, angleDeg, action: sdk });
        const move = await this.#motion('move', sdk, 15000);
        if (!move.ok) return report(false, 'error' in move ? move.error : 'move failed');
        travelledCm += Math.round(Math.hypot(x, y));
      }
      return report(true, 'Stopped after the maximum number of steps');
    }

    // Explore from where the drone is: six photos turning 60° each (the views overlap), YOLO
    // places what it recognises with a distance, and Grok vision lists the rest with details
    // (clothes, colours, doors, obstacles). Everything goes into the room map.
    if (value.action === 'explore') {
      if (Object.keys(value).length !== 2) return this.#fail('Unknown argument for explore');
      if (this.#flight !== 'flying') return this.#fail('explore requires a flying drone: take off first');
      const VIEWS = 6;
      const photos: Buffer[] = [];
      const detections: (Detections | null)[] = [];
      const found: { label: string; description: string | null; x: number; y: number; distanceCm: number | null }[] = [];
      for (let i = 0; i < VIEWS; i += 1) {
        if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
        const view = await this.#freshView(Date.now() + this.#settleMs, 4000);
        if (!view && i === 0) return this.#fail(this.#visionError());
        detections.push(view);
        for (const o of view?.objects ?? []) {
          if (o.confidence < MIN_CONFIDENCE) continue;
          const s = this.#world.see(o.label, bearingDeg(o.center.x), o.box ? estimateDistanceCm(o.label, o.box) : null);
          found.push({ label: s.label, description: null, x: s.x, y: s.y, distanceCm: s.distanceCm });
        }
        const image = this.#frame ? await this.#frame() : null;
        if (image) photos.push(image);
        const turn = await this.#motion('rotate', `cw ${360 / VIEWS}`, 15000);
        if (!turn.ok) return turn;
      }
      // Back at the starting heading. One vision call over all photos adds what YOLO cannot name.
      let visionNote: string | null = null;
      if (this.#askVision && photos.length === VIEWS) {
        const reply = await this.#askVision(photos, `These ${VIEWS} photos come from an indoor drone camera, taken while turning clockwise ${360 / VIEWS}° each time: photo 1 straight ahead, photo 2 at ${360 / VIEWS}° right, and so on. List up to 12 notable things in the room: people (with clothes and colours), furniture, doors, windows, objects, obstacles. Answer with JSON only: [{"photo": number, "x": horizontal centre from 0 (left) to 1 (right), "label": "one or two English words", "description": "a few words"}].`);
        try {
          const list = JSON.parse((reply ?? '').replace(/^[^[]*/, '').replace(/[^\]]*$/, '')) as { photo?: unknown; x?: unknown; label?: unknown; description?: unknown }[];
          for (const item of Array.isArray(list) ? list.slice(0, 12) : []) {
            if (typeof item.photo !== 'number' || item.photo < 1 || item.photo > VIEWS || typeof item.label !== 'string') continue;
            const x = typeof item.x === 'number' && item.x >= 0 && item.x <= 1 ? item.x : 0.5;
            const near = detections[item.photo - 1]?.objects.filter((o) => o.box && o.confidence >= MIN_CONFIDENCE).sort((a, b) => Math.abs(a.center.x - x) - Math.abs(b.center.x - x))[0];
            const distanceCm = near && Math.abs(near.center.x - x) < 0.12 ? estimateDistanceCm(near.label, near.box!) : null;
            const bearing = normalize((item.photo - 1) * (360 / VIEWS) + bearingDeg(x));
            const description = typeof item.description === 'string' ? item.description.slice(0, 80) : null;
            const s = this.#world.see(item.label.toLowerCase().slice(0, 30), bearing, distanceCm, description);
            found.push({ label: s.label, description, x: s.x, y: s.y, distanceCm });
          }
        } catch { visionNote = reply ? 'Grok vision did not return a list; only YOLO objects were mapped.' : 'Grok vision did not answer; only YOLO objects were mapped.'; }
      } else visionNote = 'Grok vision was not available; only YOLO objects were mapped.';
      this.#world.record('explore', `${found.length} things`);
      return { ok: true, mode: 'real', action: 'explore', drone: this.snapshot(), pose: this.#world.pose, found, ...(visionNote ? { note: visionNote } : {}) } as TelloResult;
    }

    // ---- Memory: where the drone is, what it did, places, things it saw ----
    if (value.action === 'memory') {
      if (Object.keys(value).length !== 2) return this.#fail('Unknown argument for memory');
      return { ok: true, mode: 'real', action: 'memory', drone: this.snapshot(), memory: this.#world.memory() } as TelloResult;
    }

    if (value.action === 'mark') {
      const name = typeof value.name === 'string' ? value.name.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 30) : '';
      if (!name || Object.keys(value).some((k) => !['droneId', 'action', 'name'].includes(k))) return this.#fail('mark needs a name');
      const pose = this.#world.mark(name);
      this.#world.record('mark', name);
      return { ok: true, mode: 'real', action: 'mark', drone: this.snapshot(), place: { name, ...pose } } as TelloResult;
    }

    // Fly back to a remembered place (home, last_landing, previous, or one saved with mark) or
    // to room coordinates, in straight lines of at most 200 cm, then face the old heading.
    if (value.action === 'go_to') {
      if (Object.keys(value).some((k) => !['droneId', 'action', 'place', 'x', 'y'].includes(k))) return this.#fail('Unknown argument for go_to');
      if (this.#flight !== 'flying') return this.#fail('go_to requires a flying drone: take off first');
      let target: { x: number; y: number; z?: number; heading?: number } | null = null;
      if (typeof value.place === 'string' && value.place.trim()) {
        target = this.#world.place(value.place.trim().toLowerCase());
        if (!target) return this.#fail(`No place called ${value.place}. Known places: ${Object.keys(this.#world.memory().places).join(', ') || 'none yet'}`);
      } else if (typeof value.x === 'number' && typeof value.y === 'number') target = { x: value.x, y: value.y };
      else return this.#fail('go_to needs a place or x and y');
      for (let leg = 0; leg < 8; leg += 1) {
        if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
        const v = this.#world.vectorTo(target);
        const sdk = moveSdk(v.forward, v.left, v.up, 200);
        if (!sdk) break;
        const move = await this.#motion('go_to', sdk, 20000);
        if (!move.ok) return move;
      }
      if (target.heading !== undefined) {
        const turn = this.#world.turnTo(target.heading);
        if (Math.abs(turn) >= 10) {
          const r = await this.#motion('go_to', `${turn > 0 ? 'cw' : 'ccw'} ${Math.min(Math.abs(turn), 180)}`, 15000);
          if (!r.ok) return r;
        }
      }
      this.#world.record('go_to', typeof value.place === 'string' ? value.place : `(${value.x},${value.y})`);
      return { ok: true, mode: 'real', action: 'go_to', drone: this.snapshot(), pose: this.#world.pose, note: 'Position is dead reckoning: expect some tens of cm of drift.' } as TelloResult;
    }

    // ---- Grok vision: look at real camera images ----
    if (value.action === 'describe') {
      if (Object.keys(value).some((k) => !['droneId', 'action', 'question'].includes(k))) return this.#fail('Unknown argument for describe');
      if (!this.#frame || !this.#askVision) return this.#fail('Vision is not configured on the server');
      const image = await this.#frame();
      if (!image) return this.#fail(this.#visionError());
      const question = typeof value.question === 'string' && value.question.trim() ? value.question.trim().slice(0, 300) : 'What do you see? Mention people (clothes, colours), objects and where they are (left, centre, right; near or far).';
      const answer = await this.#askVision([image], `You are the camera of an indoor drone. Answer briefly and only from the image. ${question}`);
      if (!answer) return this.#fail('The vision model did not answer');
      this.#world.record('describe', question.slice(0, 60));
      return { ok: true, mode: 'real', action: 'describe', drone: this.snapshot(), answer } as TelloResult;
    }

    // Find something described in words ("the person in the green t-shirt"): photos at 0°, 90°,
    // 180° and 270° (turning clockwise), Grok vision picks the photo and where in it, then the
    // drone turns to face it. Use approach afterwards to fly to it.
    if (value.action === 'find') {
      if (Object.keys(value).some((k) => !['droneId', 'action', 'description'].includes(k))) return this.#fail('Unknown argument for find');
      const description = typeof value.description === 'string' ? value.description.trim().slice(0, 200) : '';
      if (!description) return this.#fail('find needs a description');
      if (!this.#frame || !this.#askVision) return this.#fail('Vision is not configured on the server');
      if (this.#flight !== 'flying') return this.#fail('find requires a flying drone: take off first');
      const photos: Buffer[] = [];
      const detections: (Detections | null)[] = [];
      for (let i = 0; i < SCAN_VIEWS; i += 1) {
        if (generation !== this.#generation) return this.#fail('Cancelled by switch off');
        const view = await this.#freshView(Date.now() + this.#settleMs, 4000);
        const image = await this.#frame();
        if (!image) return this.#fail(this.#visionError());
        photos.push(image);
        detections.push(view);
        const turn = await this.#motion('rotate', 'cw 90', 15000);
        if (!turn.ok) return turn;
      }
      const reply = await this.#askVision(photos, `These ${photos.length} photos come from an indoor drone camera, taken while turning clockwise: photo 1 straight ahead, photo 2 at 90° right, photo 3 behind (180°), photo 4 at 90° left. Find: "${description}". Answer with JSON only: {"photo": number 1-${photos.length} or null if not visible, "x": horizontal centre of it in that photo from 0 (left edge) to 1 (right edge), "note": "a few words about what you see there"}.`);
      const parsed = (() => { try { return JSON.parse((reply ?? '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')) as { photo?: unknown; x?: unknown; note?: unknown }; } catch { return null; } })();
      const photo = typeof parsed?.photo === 'number' && Number.isInteger(parsed.photo) && parsed.photo >= 1 && parsed.photo <= photos.length ? parsed.photo : null;
      const note = typeof parsed?.note === 'string' ? parsed.note.slice(0, 200) : (reply ?? '').slice(0, 200);
      this.#world.record('find', description.slice(0, 60));
      if (!photo) return { ok: true, mode: 'real', action: 'find', drone: this.snapshot(), found: false, note } as TelloResult;
      const x = typeof parsed?.x === 'number' && parsed.x >= 0 && parsed.x <= 1 ? parsed.x : 0.5;
      // Distance from the YOLO box nearest to that spot, when there is one.
      const near = detections[photo - 1]?.objects.filter((o) => o.box && o.confidence >= MIN_CONFIDENCE).sort((a, b) => Math.abs(a.center.x - x) - Math.abs(b.center.x - x))[0];
      const distanceCm = near && Math.abs(near.center.x - x) < 0.15 ? estimateDistanceCm(near.label, near.box!) : null;
      // Back at the starting heading now: turn to face it (shortest way).
      const turnDeg = Math.round(normalize((photo - 1) * 90 + bearingDeg(x)));
      if (Math.abs(turnDeg) >= 5) {
        const r = await this.#motion('rotate', `${turnDeg > 0 ? 'cw' : 'ccw'} ${Math.abs(turnDeg)}`, 15000);
        if (!r.ok) return r;
      }
      const sighting = this.#world.see(near?.label ?? 'object', 0, distanceCm, description);
      return { ok: true, mode: 'real', action: 'find', drone: this.snapshot(), found: true, photo, turnedDeg: turnDeg, distanceCm, note, sighting, next: 'It is now in front of the drone: use approach to fly to it.' } as TelloResult;
    }

    if (value.action === 'status') {
      if (Object.keys(value).length !== 2) return this.#fail('Unknown argument for status');
      const level = await this.#request('battery?', (t) => /^\d{1,3}$/.test(t), 3000);
      if (level !== null && /^\d{1,3}$/.test(level)) this.#battery = Number(level);
      return { ok: true, mode: 'real', action: 'status', drone: this.snapshot() };
    }

    return this.#fail('Invalid action');
  }

  async #motion(action: string, sdk: string, timeoutMs: number, onOk?: () => void): Promise<TelloResult> {
    const reply = await this.#request(sdk, isOk, timeoutMs);
    if (reply === null) return this.#fail(this.#interrupted ? `${action} interrupted` : `No reply to ${action}`);
    if (!isOk(reply)) return this.#fail(`Drone rejected ${action}: ${reply.slice(0, 60)}`);
    onOk?.();
    this.#lastError = null;
    this.#world.applySdk(sdk);
    this.#world.record(action, sdk);
    return { ok: true, mode: 'real', action, drone: this.snapshot() };
  }

  /** Waits for a detection result computed from a frame newer than `after` (ms since epoch). */
  async #freshView(after: number, timeoutMs: number): Promise<Detections | null> {
    if (!this.#vision) return null;
    const deadline = Math.max(after, Date.now()) + timeoutMs;
    while (Date.now() < deadline) {
      if (Date.now() >= after) {
        const result = await this.#vision().catch(() => null);
        if (result?.timestamp && result.timestamp * 1000 >= after) return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  #visionError(): string {
    if (!this.#vision) return 'Vision is not configured on the server';
    if (!this.#video) return 'No camera stream: the drone did not accept streamon';
    return 'No fresh camera detections. Is metoera-vision running on port 18790?';
  }

  #fail(error: string): TelloResult {
    this.#lastError = error;
    return { ok: false, mode: 'real', error };
  }

  async #ensureReady(attempts = 3, timeoutMs = 3000): Promise<string | null> {
    const refused = this.#mayTalk();
    if (refused) return refused;
    if (!this.#expectedSerial) return 'TELLO_SETUP_SERIAL is not configured';
    try { await this.#open(); } catch (error) {
      const code = (error as { code?: string }).code ?? 'UDP_ERROR';
      if (code === 'EADDRINUSE') return 'Port 8889 is in use by another Tello script';
      if (code === 'EHOSTINUSE') return `Another link already controls the drone at ${this.#host}`;
      return `Cannot open UDP sockets (${code})`;
    }
    if (this.#verified) return null;
    let ready: string | null = null;
    for (let attempt = 0; attempt < attempts && !(ready && isOk(ready)); attempt += 1) ready = await this.#request('command', isOk, timeoutMs);
    if (!ready || !isOk(ready)) return 'The Tello does not answer. Check it is on and on the same network';
    const serial = await this.#request('sn?', (t) => /^[A-Z0-9]{8,}$/i.test(t) && !isOk(t), timeoutMs);
    if (serial?.toUpperCase() !== this.#expectedSerial.toUpperCase()) return 'Serial number does not match the configured Tello';
    this.#verified = true;
    this.#verifiedAt = Date.now();
    this.#linkError = null;
    // Start the camera stream for metoera-vision (UDP 11111). Flying does not depend on it.
    this.#video = isOk((await this.#request('streamon', isOk, 3000)) ?? '');
    this.#keepalive = setInterval(() => this.#keepaliveTick(), this.#keepaliveMs);
    this.#keepalive.unref();
    return null;
  }

  // The Tello lands by itself after 15 s without commands; a numeric query keeps it alive
  // without ever producing an "ok" that could be mistaken for a motion reply.
  #keepaliveTick(): void {
    if (this.#busy || this.#pending) return;
    const run = this.#queue.then(async () => {
      await this.#stopDone;
      const level = await this.#request('battery?', (t) => /^\d{1,3}$/.test(t), 3000);
      if (level !== null && /^\d{1,3}$/.test(level)) this.#battery = Number(level);
    });
    this.#queue = run.catch(() => undefined);
  }

  #open(): Promise<void> {
    if (this.#command) return Promise.resolve();
    this.#opening ??= this.#bind().finally(() => { this.#opening = null; });
    return this.#opening;
  }

  async #bind(): Promise<void> {
    let command: UdpPort | null = null;
    let state: UdpPort | null = null;
    const unsubscribe: (() => void)[] = [];
    try {
      command = await UdpPort.acquire(this.#localPort);
      state = await UdpPort.acquire(this.#statePort);
      unsubscribe.push(command.subscribe(this.#host, (datagram) => this.#onReply(datagram), this.#port));
      unsubscribe.push(state.subscribe(this.#host, (datagram) => this.#onState(datagram)));
    } catch (error) {
      for (const drop of unsubscribe) drop();
      command?.release();
      state?.release();
      throw error;
    }
    this.#command = command;
    this.#state = state;
    this.#unsubscribe = unsubscribe;
  }

  #onReply({ text: payload, port }: Datagram): void {
    if (port !== this.#port || !this.#pending) return;
    const text = payload.replaceAll('\0', '').trim();
    if (this.#pending.accept(text) || /^error\b/i.test(text)) this.#pending.resolve(text);
  }

  #onState({ text }: Datagram): void {
    const read = (key: string) => {
      const match = new RegExp(`(?:^|;)${key}:(-?\\d+)(?:;|$)`).exec(text);
      return match ? Number(match[1]) : null;
    };
    const bat = read('bat');
    if (bat === null) return;
    this.#battery = bat;
    this.#heightCm = read('h');
    // Telemetry is the truth about flying: a lost takeoff or land reply must not leave the
    // server thinking the drone is somewhere else.
    if (this.#heightCm !== null) {
      if (this.#heightCm >= 20) { this.#flight = 'flying'; this.#groundSince = 0; }
      else if (this.#heightCm <= 0 && !this.#busy) {
        this.#groundSince ||= Date.now();
        if (Date.now() - this.#groundSince > 2000) this.#flight = 'landed';
      } else this.#groundSince = 0;
    }
    this.#heading = read('yaw');
    this.#world.applyTelemetry(this.#heightCm, this.#heading);
    this.#lastStateAt = Date.now();
  }

  #request(text: string, accept: (reply: string) => boolean, timeoutMs: number, priority = false): Promise<string | null> {
    const socket = this.#command;
    if (!socket) return Promise.resolve(null);
    // The one place a request leaves: never toward a drone another laptop owns.
    if (this.#mayTalk()) return Promise.resolve(null);
    // While stop / force land own the drone, nothing else may take the single reply slot.
    if (this.#interrupted && !priority) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (reply: string | null) => {
        clearTimeout(timer);
        if (this.#pending === pending) this.#pending = null;
        resolve(reply);
      };
      const pending: Pending = { accept, resolve: done };
      this.#pending = pending;
      void socket.send(text, this.#port, this.#host).then((error) => { if (error) done(null); });
    });
  }
}
