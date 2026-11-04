import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';

const SERIAL = '0TQZTEST000001';

// Minimal fake Tello: answers like the real SDK and records what it receives.
async function fakeDrone({ serial = SERIAL, battery = '93', duplicateOk = true } = {}) {
  const socket = dgram.createSocket('udp4');
  const received = [];
  let closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString();
    received.push(text);
    const reply = (value, delay = 0) => setTimeout(() => { if (!closed) socket.send(value, peer.port, peer.address); }, delay);
    if (text === 'command') { reply('ok'); if (duplicateOk) reply('ok', 30); }
    else if (text === 'sn?') reply(serial, 60); // arrives after the duplicate "ok"
    else if (text === 'battery?') reply(battery);
    else if (text === 'forward 100') reply('ok', 800); // slow move, used to test stop
    else if (text === 'emergency') { /* the real Tello does not reply */ }
    else if (['takeoff', 'land', 'stop'].includes(text) || /^(forward|back|left|right|up|down|cw|ccw) \d+$/.test(text) || /^flip [lrfb]$/.test(text) || /^speed \d+$/.test(text)) reply('ok', 50);
    else reply('error');
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, received, close: () => { closed = true; socket.close(); } };
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
  assert.deepEqual(fake.received.filter((c) => !['command', 'sn?', 'battery?', 'streamon'].includes(c)), ['takeoff', 'forward 50', 'ccw 90', 'land']);
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
  assert.match(far.error, /20 to 100/);
  assert.equal(fake.received.some((c) => c.startsWith('forward')), false);
  assert.equal((await drone.execute({ droneId: 'tello', action: 'barrel_roll' })).error, 'Invalid action');
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

test('forceLand lands a flying drone', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.equal((await drone.forceLand()).ok, true);
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

test('flip, speed and status map to SDK commands', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'speed', cmPerSecond: 30 })).ok, true);
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'flip', direction: 'left' })).ok, true);
  const status = await drone.execute({ droneId: 'tello', action: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.drone.battery, 93);
  assert.deepEqual(fake.received.filter((c) => /^(speed|flip)/.test(c)), ['speed 30', 'flip l']);
  assert.match((await drone.execute({ droneId: 'tello', action: 'speed', cmPerSecond: 500 })).error, /10 to 100/);
});

test('flip is refused below 50% battery', async (t) => {
  const fake = await fakeDrone({ battery: '40' });
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.match((await drone.execute({ droneId: 'tello', action: 'flip', direction: 'back' })).error, /at least 50%/);
  assert.equal(fake.received.some((c) => c.startsWith('flip')), false);
});

test('stop interrupts a running move and the next command waits for it', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const move = drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stop = drone.stop();
  const land = drone.execute({ droneId: 'tello', action: 'land' });
  assert.equal((await move).error, 'move interrupted');
  assert.equal((await stop).ok, true);
  assert.equal((await land).ok, true);
  const order = fake.received.filter((c) => ['forward 100', 'stop', 'land'].includes(c));
  assert.deepEqual(order, ['forward 100', 'stop', 'land']);
});

test('move limit is configurable', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { maxMoveCm: 200 });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'move', direction: 'up', centimeters: 150 })).ok, true);
  assert.match((await drone.execute({ droneId: 'tello', action: 'move', direction: 'up', centimeters: 250 })).error, /20 to 200/);
});

// Fake camera: how many people are visible depends on how many 90-degree turns the drone made.
function fakeVision(fake, peoplePerView) {
  return async () => {
    const turns = fake.received.filter((c) => c === 'cw 90').length;
    const people = peoplePerView[turns % peoplePerView.length];
    const objects = Array.from({ length: people }, (_, i) => ({ label: 'person', confidence: 0.9, center: { x: (i + 0.5) / people, y: 0.5 } }));
    objects.push({ label: 'person', confidence: 0.2, center: { x: 0.5, y: 0.5 } }); // below threshold, ignored
    objects.push({ label: 'cup', confidence: 0.8, center: { x: 0.1, y: 0.9 } });
    return { timestamp: Date.now() / 1000, objects };
  };
}

test('scan turns 360 degrees in four steps and counts people per view', async (t) => {
  const fake = await fakeDrone();
  const withVision = tello(fake, { settleMs: 20, vision: fakeVision(fake, [2, 0, 3, 1]) });
  t.after(() => { withVision.close(); fake.close(); });
  assert.match((await withVision.execute({ droneId: 'tello', action: 'scan' })).error, /flying/);
  await withVision.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await withVision.execute({ droneId: 'tello', action: 'scan' });
  assert.equal(result.ok, true);
  assert.equal(result.scan.label, 'person');
  assert.equal(result.scan.total, 6);
  assert.deepEqual(result.scan.views.map((v) => v.count), [2, 0, 3, 1]);
  assert.equal(fake.received.filter((c) => c === 'cw 90').length, 4);
});

test('scan fails before turning when the camera has no detections', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { settleMs: 20, vision: async () => null });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'scan' });
  assert.equal(result.ok, false);
  assert.equal(fake.received.includes('cw 90'), false);
});

test('look summarises what the camera sees now', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { vision: fakeVision(fake, [2]) });
  t.after(() => { drone.close(); fake.close(); });
  const result = await drone.execute({ droneId: 'tello', action: 'look' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.seen.counts, { person: 2, cup: 1 });
  assert.deepEqual(result.seen.objects.filter((o) => o.label === 'person').map((o) => o.side), ['left', 'right']);
});

test('force land cancels queued commands and interrupts the running one', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const move = drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 });
  const queued = drone.execute({ droneId: 'tello', action: 'rotate', direction: 'clockwise', degrees: 90 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const land = await drone.forceLand();
  assert.equal(land.ok, true);
  assert.equal(land.action, 'force_land');
  assert.equal((await move).error, 'move interrupted');
  assert.equal((await queued).error, 'Cancelled by switch off');
  assert.equal(fake.received.includes('cw 90'), false);
  assert.equal(drone.snapshot().flight, 'landed');
  // New commands after the switch off work normally.
  assert.equal((await drone.execute({ droneId: 'tello', action: 'takeoff' })).ok, true);
});

test('motor kill sends emergency three times and cancels the queue', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const queued = drone.execute({ droneId: 'tello', action: 'move', direction: 'up', centimeters: 50 });
  const kill = await drone.killMotors();
  assert.equal(kill.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.received.filter((c) => c === 'emergency').length, 3);
  assert.equal((await queued).error, 'Cancelled by switch off');
  assert.equal(drone.snapshot().flight, 'landed');
});

test('force land before any connection reports it clearly', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.forceLand()).error, 'The Tello is not connected yet');
  assert.equal((await drone.killMotors()).error, 'The Tello is not connected yet');
});
