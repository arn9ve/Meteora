// Adapter for one real Tello EDU over the Tello SDK (UDP).
// The Tello sends every reply to local port 8889, so the command socket must bind 8889.
// One request is in flight at a time; each request only accepts a reply of its own shape,
// so a late "ok" can never be read as the answer to a later query.
import dgram from 'node:dgram';

export type TelloSnapshot = {
  id: 'tello';
  mode: 'real';
  connected: boolean;
  verified: boolean;
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
  host: string;
  expectedSerial?: string;
  port?: number;
  localPort?: number;
  statePort?: number;
  keepaliveMs?: number;
  minTakeoffBattery?: number;
  hoverMs?: number;
  maxMoveCm?: number;
};

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
  readonly #host: string;
  readonly #port: number;
  readonly #localPort: number;
  readonly #statePort: number;
  readonly #expectedSerial: string | undefined;
  readonly #keepaliveMs: number;
  readonly #minTakeoffBattery: number;
  readonly #hoverMs: number;
  readonly #maxMoveCm: number;
  #interrupted = false;
  #stopDone: Promise<unknown> = Promise.resolve(); // queued work waits for a running stop
  #command: dgram.Socket | null = null;
  #state: dgram.Socket | null = null;
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
  }

  snapshot(): TelloSnapshot {
    return {
      id: 'tello',
      mode: 'real',
      connected: Date.now() - this.#lastStateAt < 3000,
      verified: this.#verified,
      flight: this.#flight,
      battery: this.#battery,
      heightCm: this.#heightCm,
      heading: this.#heading,
      lastError: this.#lastError,
      timestamp: new Date().toISOString(),
    };
  }

  execute(value: unknown): Promise<TelloResult> {
    const run = this.#queue.then(async () => {
      await this.#stopDone;
      this.#busy = true;
      try { return await this.#execute(value); } finally { this.#busy = false; }
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
    const reply = await this.#request('stop', isOk, 3000);
    this.#interrupted = false;
    if (reply === null) return this.#fail('No reply to stop');
    if (!isOk(reply)) return this.#fail(`Drone rejected stop: ${reply.slice(0, 60)}`);
    return { ok: true, mode: 'real', action: 'stop', drone: this.snapshot() };
  }

  /** Lands if flying. Used on server shutdown. Bypasses the queue on purpose. */
  async emergencyLand(): Promise<void> {
    if (this.#flight !== 'flying' || !this.#command) return;
    this.#pending?.resolve(null);
    this.#pending = null;
    if (isOk((await this.#request('land', isOk, 15000)) ?? '')) this.#flight = 'landed';
  }

  close(): void {
    if (this.#keepalive) clearInterval(this.#keepalive);
    this.#keepalive = null;
    this.#pending?.resolve(null);
    for (const socket of [this.#command, this.#state]) {
      try { socket?.close(); } catch { /* already closed */ }
    }
    this.#command = null;
    this.#state = null;
  }

  async #execute(value: unknown): Promise<TelloResult> {
    if (!isRecord(value) || value.droneId !== 'tello') return this.#fail('Invalid droneId');
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
      const up = await this.#execute({ droneId: 'tello', action: 'takeoff' });
      if (!up.ok) return up;
      const until = Date.now() + this.#hoverMs;
      while (Date.now() < until) {
        await this.#request('battery?', (t) => /^\d{1,3}$/.test(t), 1500); // keeps the SDK session alive
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, until - Date.now()))));
      }
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
    if (reply === null) return this.#fail(this.#interrupted ? `${action} interrupted by stop` : `No reply to ${action}`);
    if (!isOk(reply)) return this.#fail(`Drone rejected ${action}: ${reply.slice(0, 60)}`);
    onOk?.();
    this.#lastError = null;
    return { ok: true, mode: 'real', action, drone: this.snapshot() };
  }

  #fail(error: string): TelloResult {
    this.#lastError = error;
    return { ok: false, mode: 'real', error };
  }

  async #ensureReady(): Promise<string | null> {
    if (!this.#expectedSerial) return 'TELLO_SETUP_SERIAL is not configured';
    try { await this.#open(); } catch (error) {
      const code = (error as { code?: string }).code ?? 'UDP_ERROR';
      return code === 'EADDRINUSE' ? 'Port 8889 is in use by another Tello script' : `Cannot open UDP sockets (${code})`;
    }
    if (this.#verified) return null;
    let ready: string | null = null;
    for (let attempt = 0; attempt < 3 && !(ready && isOk(ready)); attempt += 1) ready = await this.#request('command', isOk, 3000);
    if (!ready || !isOk(ready)) return 'The Tello does not answer. Check it is on and on the same network';
    const serial = await this.#request('sn?', (t) => /^[A-Z0-9]{8,}$/i.test(t) && !isOk(t), 3000);
    if (serial?.toUpperCase() !== this.#expectedSerial.toUpperCase()) return 'Serial number does not match the configured Tello';
    this.#verified = true;
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

  async #open(): Promise<void> {
    if (this.#command) return;
    const command = dgram.createSocket('udp4');
    const state = dgram.createSocket('udp4');
    const bind = (socket: dgram.Socket, port: number) => new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, () => { socket.off('error', reject); resolve(); });
    });
    try {
      await bind(command, this.#localPort);
      await bind(state, this.#statePort);
    } catch (error) {
      try { command.close(); } catch { /* not bound */ }
      try { state.close(); } catch { /* not bound */ }
      throw error;
    }
    command.on('error', () => undefined);
    state.on('error', () => undefined);
    command.on('message', (payload, peer) => {
      if (peer.address !== this.#host || peer.port !== this.#port || !this.#pending) return;
      const text = payload.toString('utf8').replaceAll('\0', '').trim();
      if (this.#pending.accept(text) || /^error\b/i.test(text)) this.#pending.resolve(text);
    });
    state.on('message', (payload, peer) => {
      if (peer.address !== this.#host) return;
      const text = payload.toString('utf8');
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
    });
    this.#command = command;
    this.#state = state;
  }

  #request(text: string, accept: (reply: string) => boolean, timeoutMs: number): Promise<string | null> {
    const socket = this.#command;
    if (!socket) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (reply: string | null) => {
        clearTimeout(timer);
        if (this.#pending === pending) this.#pending = null;
        resolve(reply);
      };
      const pending: Pending = { accept, resolve: done };
      this.#pending = pending;
      socket.send(text, this.#port, this.#host, (error) => { if (error) done(null); });
    });
  }
}
