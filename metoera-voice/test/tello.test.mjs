import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';

const SERIAL = '0TQZTEST000001';

// Minimal fake Tello: answers like the real SDK and records what it receives.
async function fakeDrone({ serial = SERIAL, battery = '93', duplicateOk = true } = {}) {
  const socket = dgram.createSocket('udp4');
  const received = [];
  socket.on('message', (payload, peer) => {
    const text = payload.toString();
    received.push(text);
    const reply = (value, delay = 0) => setTimeout(() => socket.send(value, peer.port, peer.address), delay);
    if (text === 'command') { reply('ok'); if (duplicateOk) reply('ok', 30); }
    else if (text === 'sn?') reply(serial, 60); // arrives after the duplicate "ok"
    else if (text === 'battery?') reply(battery);
    else if (['takeoff', 'land'].includes(text) || /^(forward|back|left|right|up|down|cw|ccw) \d+$/.test(text)) reply('ok', 50);
    else reply('error');
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, received, close: () => socket.close() };
}

function tello(fake, options = {}) {
  return new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort: 0, expectedSerial: SERIAL, ...options });
}

test('full voice sequence maps to the right SDK commands', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });

  assert.equal((await drone.execute({ droneId: 'tello', action: 'takeoff' })).ok, true);
  assert.equal(drone.snapshot().flight, 'flying');
  assert.equal((await drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 50 })).ok, true);
  assert.equal((await drone.execute({ droneId: 'tello', action: 'rotate', direction: 'counterclockwise', degrees: 90 })).ok, true);
  assert.equal((await drone.execute({ droneId: 'tello', action: 'land' })).ok, true);
  assert.equal(drone.snapshot().flight, 'landed');
  assert.deepEqual(fake.received.filter((c) => !['command', 'sn?', 'battery?'].includes(c)), ['takeoff', 'forward 50', 'ccw 90', 'land']);
  assert.equal(drone.snapshot().verified, true);
});

test('a late duplicate "ok" is not read as the serial', async (t) => {
  const fake = await fakeDrone({ duplicateOk: true });
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  const result = await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.equal(result.ok, true);
});

test('wrong serial refuses every motion and never sends takeoff', async (t) => {
  const fake = await fakeDrone({ serial: 'OTHERDRONE0001' });
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  const result = await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.deepEqual(result, { ok: false, mode: 'real', error: 'Serial number does not match the configured Tello' });
  assert.equal(fake.received.includes('takeoff'), false);
});

test('missing serial configuration refuses before any packet', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { expectedSerial: '' });
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'takeoff' })).ok, false);
  assert.equal(fake.received.length, 0);
});

test('low battery refuses takeoff', async (t) => {
  const fake = await fakeDrone({ battery: '12' });
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  const result = await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.equal(result.ok, false);
  assert.match(result.error, /below 20%/);
  assert.equal(fake.received.includes('takeoff'), false);
});

test('moves above 100 cm and motions on the ground are rejected locally', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 50 })).error, 'move requires a flying drone');
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const far = await drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 300 });
  assert.match(far.error, /from 20 to 100/);
  assert.equal(fake.received.some((c) => c.startsWith('forward')), false);
  assert.equal((await drone.execute({ droneId: 'tello', action: 'flip' })).error, 'Invalid action');
});

test('keepalive uses battery? and records no error', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { keepaliveMs: 50 });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const before = fake.received.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const extra = fake.received.slice(before);
  assert.ok(extra.length >= 2);
  assert.ok(extra.every((c) => c === 'battery?'));
  assert.equal(drone.snapshot().lastError, null);
});

test('emergencyLand lands a flying drone', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  await drone.emergencyLand();
  assert.equal(fake.received.at(-1), 'land');
});

test('test_flight takes off, hovers and lands as one action', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { hoverMs: 300 });
  t.after(() => { drone.close(); fake.close(); });
  const result = await drone.execute({ droneId: 'tello', action: 'test_flight' });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'test_flight');
  assert.equal(drone.snapshot().flight, 'landed');
  assert.deepEqual(fake.received.filter((c) => ['takeoff', 'land'].includes(c)), ['takeoff', 'land']);
});
