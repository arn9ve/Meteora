import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { NO_DRONE_NETWORK, TelloLink, findDroneAddress, parseState } from './tello-link.mjs';

const STATE = 'pitch:-1;roll:2;yaw:3;vgx:0;vgy:0;vgz:0;templ:60;temph:62;tof:10;h:0;bat:78;baro:100.50;time:5;agx:0.00;agy:0.00;agz:-0.98;';

test('parses telemetry fields', () => {
  const state = parseState('pitch:-1;roll:2;yaw:3;h:0;bat:78;baro:100.50;agz:-0.98;');
  assert.equal(state.pitch, -1);
  assert.equal(state.h, 0);
  assert.equal(state.bat, 78);
  assert.equal(state.baro, 100.5);
  assert.equal(state.agz, -0.98);
  assert.deepEqual(parseState(''), {});
});

test('rejects distances and angles outside the SDK range', () => {
  const link = new TelloLink();
  assert.throws(() => link.move('forward', 19), { message: 'centimeters must be an integer from 20 to 500' });
  assert.throws(() => link.move('up', 501), { message: 'centimeters must be an integer from 20 to 500' });
  assert.throws(() => link.move('forward', 20.5), { message: 'centimeters must be an integer from 20 to 500' });
  assert.throws(() => link.rotate('clockwise', 0), { message: 'degrees must be an integer from 1 to 360' });
  assert.throws(() => link.rotate('counterclockwise', 361), { message: 'degrees must be an integer from 1 to 360' });
  assert.throws(() => link.move('backward', 20), { message: 'Unknown direction: backward' });
  assert.throws(() => link.rotate('left', 90), { message: 'Unknown direction: left' });
});

test('names the missing aircraft network', async () => {
  if (findDroneAddress()) return;
  const link = new TelloLink({ keepAliveMs: 0 });
  await assert.rejects(() => link.connect(), { message: NO_DRONE_NETWORK });
});

test('identifies a Tello Edu', async () => {
  await withLink({ hardware: 'TELLO', sdk: '30', sn: 'TLW004', battery: '78' }, async (link, drone) => {
    const identity = await link.connect();
    assert.deepEqual(identity, { model: 'tello-edu', hardware: 'TELLO', sdk: 30, sn: 'TLW004', battery: 78 });
    assert.deepEqual(drone.received.slice(0, 5), ['command', 'sdk?', 'sn?', 'battery?', 'hardware?']);
    assert.equal(drone.received.includes('takeoff'), false);
    assert.equal(drone.received.includes('ap'), false);
    assert.equal(drone.received.includes('streamon'), false);
    await waitFor(() => link.state);
    assert.equal(link.state.h, 0);
    assert.equal(link.state.bat, 78);
    assert.equal(link.state.yaw, 3);
    assert.equal(link.state.agz, -0.98);
  });
});

test('identifies a RoboMaster TT', async () => {
  await withLink({ hardware: 'RMTT', sdk: '30', sn: 'RMTT-1', battery: '64' }, async (link) => {
    const identity = await link.connect();
    assert.deepEqual(identity, { model: 'robomaster-tt', hardware: 'RMTT', sdk: 30, sn: 'RMTT-1', battery: 64 });
  });
});

test('links old firmware that rejects hardware?', async () => {
  await withLink({ hardware: 'unknown command', sdk: '20', sn: 'OLDEDU', battery: '55' }, async (link) => {
    const identity = await link.connect();
    assert.deepEqual(identity, { model: 'tello-edu', hardware: 'unknown', sdk: 20, sn: 'OLDEDU', battery: 55 });
  });
});

test('retries the SDK handshake when the first packet is dropped', async () => {
  await withLink({ hardware: 'TELLO', sdk: '30', sn: 'RETRY', battery: '70', dropFirstCommand: true, commandRetryMs: 40 }, async (link, drone) => {
    const identity = await link.connect();
    assert.equal(identity.sn, 'RETRY');
    const commands = drone.received.map((text, index) => (text === 'command' ? index : -1)).filter((index) => index >= 0);
    assert.ok(commands.length >= 2);
    assert.ok(commands.at(-1) < drone.received.indexOf('sdk?'));
  });
});

test('queues a command until the aircraft replies', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    await withLink({ hardware: 'TELLO', sdk: '30', sn: 'QUEUE', battery: '80', hold: gate }, async (link, drone) => {
      await link.connect();
      const first = link.move('forward', 40);
      await waitFor(() => drone.received.includes('forward 40'));
      const second = link.move('back', 25);
      await delay(50);
      assert.equal(drone.received.includes('back 25'), false);
      release();
      await first;
      await second;
      assert.ok(drone.received.indexOf('back 25') > drone.received.indexOf('forward 40'));
    });
  } finally {
    release();
  }
});

test('encodes the shared flight commands', async () => {
  await withLink({ hardware: 'RMTT', sdk: '30', sn: 'MOVE', battery: '90' }, async (link, drone) => {
    await link.connect();
    const before = drone.received.length;
    await link.takeoff();
    await link.move('forward', 20);
    await link.move('back', 500);
    await link.move('left', 20);
    await link.move('right', 21);
    await link.move('up', 20);
    await link.move('down', 22);
    await link.rotate('clockwise', 1);
    await link.rotate('counterclockwise', 360);
    await link.land();
    await link.emergency();
    assert.deepEqual(drone.received.slice(before), [
      'takeoff', 'forward 20', 'back 500', 'left 20', 'right 21', 'up 20', 'down 22', 'cw 1', 'ccw 360', 'land', 'emergency',
    ]);
  });
});

test('asks for the battery while the link is idle', async () => {
  await withLink({ hardware: 'TELLO', sdk: '30', sn: 'KEEP', battery: '81', keepAliveMs: 40 }, async (link, drone) => {
    await link.connect();
    const asked = () => drone.received.filter((text) => text === 'battery?').length;
    const before = asked();
    await waitFor(() => asked() > before);
  });
});

async function withLink(spec, run) {
  let link;
  const drone = await FakeDrone.listen((event) => reply(spec, link, event));
  link = new TelloLink({
    host: '127.0.0.1',
    localAddress: '127.0.0.1',
    commandPort: drone.commandPort,
    statePort: 0,
    queryTimeout: 1000,
    motionTimeout: 1000,
    keepAliveMs: spec.keepAliveMs ?? 0,
    commandRetryMs: spec.commandRetryMs ?? 60_000,
  });
  try {
    await run(link, drone);
  } finally {
    link.close();
    await drone.close();
  }
}

function reply(spec, link, { text, rinfo, drone }) {
  if (text === 'command') {
    if (spec.dropFirstCommand && !spec.sawCommand) {
      spec.sawCommand = true;
      return null;
    }
    if (link.statePort) drone.send(STATE, link.statePort, rinfo.address);
    return 'ok';
  }
  if (text === 'sdk?') return spec.sdk;
  if (text === 'sn?') return spec.sn;
  if (text === 'battery?') return spec.battery;
  if (text === 'hardware?') return spec.hardware;
  if (text === 'forward 40' && spec.hold) return spec.hold.then(() => 'ok');
  if (/^(takeoff|land|emergency|(forward|back|left|right|up|down|cw|ccw) \d+)$/.test(text)) return 'ok';
  return 'error';
}

function waitFor(ready, timeout = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ready()) resolve();
      else if (Date.now() - started > timeout) reject(new Error('Timed out waiting'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeDrone {
  static listen(handler) {
    const socket = dgram.createSocket('udp4');
    const drone = new FakeDrone(socket, handler);
    socket.on('error', () => {});
    socket.on('message', (message, rinfo) => drone.#onMessage(message, rinfo));
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => {
        socket.off('error', reject);
        drone.commandPort = socket.address().port;
        resolve(drone);
      });
    });
  }

  constructor(socket, handler) {
    this.socket = socket;
    this.handler = handler;
    this.received = [];
    this.commandPort = 0;
    this.closed = false;
  }

  send(payload, port, address) {
    if (this.closed) return;
    this.socket.send(Buffer.from(payload), port, address);
  }

  close() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }

  async #onMessage(message, rinfo) {
    const text = message.toString().replaceAll('\0', '').trim();
    this.received.push(text);
    try {
      const answer = await this.handler({ text, rinfo, drone: this });
      if (answer == null || this.closed) return;
      this.send(String(answer), rinfo.port, rinfo.address);
    } catch { /* the link closed while a reply was held */ }
  }
}
