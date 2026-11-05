import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

export const DRONE_HOST = '192.168.10.1';
export const COMMAND_PORT = 8889;
export const STATE_PORT = 8890;
export const NO_DRONE_NETWORK = 'No drone network. Join the aircraft Wi-Fi (TELLO-... for the Edu, RMTT-... for the Talent) and run again.';

const MOVE = { forward: 'forward', back: 'back', left: 'left', right: 'right', up: 'up', down: 'down' };
const ROTATE = { clockwise: 'cw', counterclockwise: 'ccw' };

export function findDroneAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4;
      if (ipv4 && !entry.internal && entry.address.startsWith('192.168.10.')) return entry.address;
    }
  }
  return null;
}

export function parseState(message) {
  const state = {};
  for (const part of String(message).trim().split(';')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    const numeric = Number(value);
    state[key] = value.trim() !== '' && Number.isFinite(numeric) ? numeric : value;
  }
  return state;
}

function bindSocket(socket, port, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, address);
  });
}

function requireInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function classifyHardware(reply) {
  const hardware = reply.trim();
  const token = hardware.toUpperCase();
  if (token === 'RMTT') return { model: 'robomaster-tt', hardware: 'RMTT' };
  if (token === 'TELLO') return { model: 'tello-edu', hardware: 'TELLO' };
  return { model: 'tello-edu', hardware };
}

export class TelloLink extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host ?? DRONE_HOST;
    this.commandPort = options.commandPort ?? COMMAND_PORT;
    this.statePort = options.statePort ?? STATE_PORT;
    this.localAddress = options.localAddress ?? null;
    this.queryTimeout = options.queryTimeout ?? 5000;
    this.motionTimeout = options.motionTimeout ?? 20000;
    this.keepAliveMs = options.keepAliveMs ?? 5000;
    this.commandRetryMs = options.commandRetryMs ?? 500;
    this.commandAttempts = options.commandAttempts ?? 3;
    this.identity = null;
    this.state = null;
    this.recentStates = [];
    this.closed = false;
    this.busy = false;
    this.pending = null;
    this.chain = Promise.resolve();
    this.commandSocket = null;
    this.stateSocket = null;
    this.keepAliveTimer = null;
  }

  async connect() {
    if (this.closed) throw new Error('Link closed');
    if (this.identity) return this.identity;
    try {
      await this.#open();
      const ready = await this.send('command', { timeout: this.queryTimeout, retransmit: this.commandRetryMs });
      if (!/^ok\b/i.test(ready)) throw new Error(ready);
      const sdk = await this.send('sdk?');
      const sn = await this.send('sn?');
      const battery = await this.send('battery?');
      let hardware = 'unknown';
      let model = 'tello-edu';
      try {
        const classified = classifyHardware(await this.send('hardware?'));
        hardware = classified.hardware;
        model = classified.model;
      } catch (error) {
        if (!/unknown command/i.test(error.message)) throw error;
      }
      this.identity = {
        model,
        hardware,
        sdk: readNumber(sdk),
        sn,
        battery: readNumber(battery),
      };
      this.#startKeepAlive();
      return this.identity;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  send(text, options = {}) {
    const timeout = options.timeout ?? this.queryTimeout;
    const retransmit = options.retransmit ?? 0;
    const run = this.chain.then(() => this.#dispatch(text, timeout, retransmit));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  takeoff() {
    return this.send('takeoff', { timeout: this.motionTimeout });
  }

  land() {
    return this.send('land', { timeout: this.motionTimeout });
  }

  move(direction, centimeters) {
    const command = MOVE[direction];
    if (!command) throw new Error(`Unknown direction: ${direction}`);
    const distance = requireInteger(centimeters, 20, 500, 'centimeters');
    return this.send(`${command} ${distance}`, { timeout: this.motionTimeout });
  }

  rotate(direction, degrees) {
    const command = ROTATE[direction];
    if (!command) throw new Error(`Unknown direction: ${direction}`);
    const angle = requireInteger(degrees, 1, 360, 'degrees');
    return this.send(`${command} ${angle}`, { timeout: this.motionTimeout });
  }

  emergency() {
    return this.send('emergency', { timeout: this.queryTimeout });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.finish(pending.reject, new Error('Link closed'));
    }
    for (const socket of [this.commandSocket, this.stateSocket]) {
      if (!socket) continue;
      socket.removeAllListeners();
      try { socket.close(); } catch { /* already closed */ }
    }
    this.commandSocket = null;
    this.stateSocket = null;
  }

  async #open() {
    this.localAddress ??= findDroneAddress();
    if (!this.localAddress) throw new Error(NO_DRONE_NETWORK);
    this.commandSocket = dgram.createSocket('udp4');
    this.stateSocket = dgram.createSocket('udp4');
    try {
      await bindSocket(this.commandSocket, 0, this.localAddress);
      await bindSocket(this.stateSocket, this.statePort, this.localAddress);
    } catch (error) {
      this.close();
      throw error;
    }
    this.statePort = this.stateSocket.address().port;
    this.commandSocket.on('message', (message) => this.#onCommand(message));
    this.stateSocket.on('message', (message) => this.#onState(message));
    this.commandSocket.on('error', (error) => this.#fail(error));
    this.stateSocket.on('error', (error) => this.#fail(error));
  }

  #dispatch(text, timeout, retransmitMs) {
    if (this.closed) return Promise.reject(new Error('Link closed'));
    if (!this.commandSocket) return Promise.reject(new Error('Link is not open'));
    this.busy = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      let resend;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (resend) clearInterval(resend);
        if (this.pending?.finish === finish) this.pending = null;
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error(`No reply to ${text}`)), timeout);
      this.pending = { finish, resolve, reject };
      let attempts = 0;
      const transmit = () => {
        if (settled || this.closed || !this.commandSocket) return;
        const limit = retransmitMs ? this.commandAttempts : 1;
        if (attempts >= limit) return;
        attempts += 1;
        this.commandSocket.send(Buffer.from(text), this.commandPort, this.host, (error) => {
          if (error) finish(reject, error);
        });
      };
      transmit();
      if (retransmitMs) {
        resend = setInterval(transmit, retransmitMs);
        resend.unref?.();
      }
    }).finally(() => {
      this.busy = false;
    });
  }

  #onCommand(message) {
    const reply = textOf(message);
    const pending = this.pending;
    if (!pending) return;
    if (/^(error\b|unknown command\b)/i.test(reply)) pending.finish(pending.reject, new Error(reply));
    else pending.finish(pending.resolve, reply);
  }

  #onState(message) {
    const state = parseState(textOf(message));
    if (!Object.keys(state).length) return;
    this.state = state;
    this.recentStates.push(state);
    if (this.recentStates.length > 3) this.recentStates.shift();
    this.emit('state', state);
  }

  #startKeepAlive() {
    if (!this.keepAliveMs) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.closed || this.busy || this.pending) return;
      this.send('battery?').catch(() => {});
    }, this.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }

  #fail(error) {
    if (this.closed) return;
    const pending = this.pending;
    if (pending) pending.finish(pending.reject, error);
  }
}

function readNumber(reply) {
  const value = Number(reply);
  if (!Number.isFinite(value)) throw new Error(`Unexpected reply: ${reply}`);
  return value;
}

function textOf(message) {
  return message.toString().replaceAll('\0', '').trim();
}
