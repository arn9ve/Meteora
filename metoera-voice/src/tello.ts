// Adapter for one real Tello EDU or RoboMaster TT over the Tello SDK (UDP).
// The Tello sends every reply to local port 8889, so the command socket must bind 8889.
// Several links (one per drone) share that port through UdpPort, which routes by sender IP.
// One request is in flight at a time; each request only accepts a reply of its own shape,
// so a late "ok" can never be read as the answer to a later query.
import { UdpPort, type Datagram } from './udp-port.ts';

export type TelloSnapshot = {
  id: string;
  mode: 'real';
  connected: boolean;
  verified: boolean;
  video: boolean;
  flight: 'landed' | 'flying';
  battery: number | null;
  heightCm: number | null;
  heading: number | null;
  lastError: string | null;
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
  /** Pause after each scan rotation before a frame counts, so the image is steady. */
  settleMs?: number;
};

export type Detection = { label: string; confidence: number; center: { x: number; y: number } };
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
  readonly #settleMs: number;
  #video = false;
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
    this.#settleMs = options.settleMs ?? 700;
  }

  snapshot(): TelloSnapshot {
    return {
      id: this.#id,
      mode: 'real',
      connected: Date.now() - this.#lastStateAt < 3000,
      verified: this.#verified,
      video: this.#video,
      flight: this.#flight,
      battery: this.#battery,
      heightCm: this.#heightCm,
      heading: this.#heading,
      lastError: this.#lastError,
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
    if (!this.#command || !this.#verified) return this.#fail('The Tello is not connected yet');
    this.#interrupted = true;
    this.#pending?.resolve(null);
    this.#pending = null;
    let reply: string | null = null;
    for (let attempt = 0; attempt < 3 && !(reply && isOk(reply)); attempt += 1) reply = await this.#request('land', isOk, 10000, true);
    this.#interrupted = false;
    if (reply && isOk(reply)) {
      this.#flight = 'landed';
      return { ok: true, mode: 'real', action: 'force_land', drone: this.snapshot() };
    }
    return this.#fail(reply ? `Drone rejected land: ${reply.slice(0, 60)}` : 'No reply to land. Use the motor kill only if the drone is in danger');
  }

  /** Emergency: the motors stop at once and the drone drops. Bypasses everything. */
  async killMotors(): Promise<TelloResult> {
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

  close(): void {
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;
    // A reopened link verifies the serial again, which also restarts the keepalive.
    this.#verified = false;
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
      return {
        ok: true, mode: 'real', action: 'look', drone: this.snapshot(),
        seen: { counts, objects: objects.map((o) => ({ label: o.label, confidence: Math.round(o.confidence * 100) / 100, side: side(o.center.x) })) },
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

  async #ensureReady(): Promise<string | null> {
    if (!this.#expectedSerial) return 'TELLO_SETUP_SERIAL is not configured';
    try { await this.#open(); } catch (error) {
      const code = (error as { code?: string }).code ?? 'UDP_ERROR';
      if (code === 'EADDRINUSE') return 'Port 8889 is in use by another Tello script';
      if (code === 'EHOSTINUSE') return `Another link already controls the drone at ${this.#host}`;
      return `Cannot open UDP sockets (${code})`;
    }
    if (this.#verified) return null;
    let ready: string | null = null;
    for (let attempt = 0; attempt < 3 && !(ready && isOk(ready)); attempt += 1) ready = await this.#request('command', isOk, 3000);
    if (!ready || !isOk(ready)) return 'The Tello does not answer. Check it is on and on the same network';
    const serial = await this.#request('sn?', (t) => /^[A-Z0-9]{8,}$/i.test(t) && !isOk(t), 3000);
    if (serial?.toUpperCase() !== this.#expectedSerial.toUpperCase()) return 'Serial number does not match the configured Tello';
    this.#verified = true;
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
    this.#heading = read('yaw');
    this.#lastStateAt = Date.now();
  }

  #request(text: string, accept: (reply: string) => boolean, timeoutMs: number, priority = false): Promise<string | null> {
    const socket = this.#command;
    if (!socket) return Promise.resolve(null);
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
