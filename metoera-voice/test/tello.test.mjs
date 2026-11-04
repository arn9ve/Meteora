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
    else if (['takeoff', 'land', 'stop'].includes(text) || /^(forward|back|left|right|up|down|cw|ccw) \d+$/.test(text) || /^go -?\d+ -?\d+ -?\d+ \d+$/.test(text) || /^flip [lrfb]$/.test(text) || /^speed \d+$/.test(text)) reply('ok', 50);
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

test('background probe reports an offline drone and connects when it answers', async (t) => {
  const offline = new RealTello({ host: '127.0.0.1', port: 9, localPort: 0, statePort: 0, expectedSerial: SERIAL });
  t.after(() => offline.close());
  await offline.probe();
  assert.equal(offline.snapshot().verified, false);
  assert.match(offline.snapshot().linkError, /does not answer/);

  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.probe();
  assert.equal(drone.snapshot().verified, true);
  assert.equal(drone.snapshot().linkError, null);
  assert.deepEqual(fake.received.filter((c) => ['command', 'sn?'].includes(c)), ['command', 'sn?']);
  assert.equal(fake.received.some((c) => /^(takeoff|land|forward|cw)/.test(c)), false);
});

test('probe forgets a session whose telemetry stopped and shakes hands again', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.probe();
  const realNow = Date.now;
  Date.now = () => realNow() + 6000; // no telemetry for 6 s
  try { await drone.probe(); } finally { Date.now = realNow; }
  assert.equal(fake.received.filter((c) => c === 'command').length, 2);
  assert.equal(drone.snapshot().verified, true);
});

// ---- approach: distance from the camera only ----
import { estimateDistanceCm, bearingDeg, FOCAL_PX, FRAME_W } from '../src/distance.ts';

test('distance estimate from a person box and bearing from its position', () => {
  // Shoulders 50 cm wide at 2 m are 683*0.5/2 ≈ 171 px wide.
  const w = (FOCAL_PX * 0.5) / 2 / FRAME_W;
  const d = estimateDistanceCm('person', { x: 0.5 - w / 2, y: 0.2, w, h: 0.5 });
  assert.ok(d >= 190 && d <= 210, `got ${d}`);
  assert.equal(estimateDistanceCm('unicorn', { x: 0.4, y: 0.4, w: 0.1, h: 0.1 }), null);
  assert.equal(bearingDeg(0.5), 0);
  assert.equal(bearingDeg(1), 35);
  assert.equal(bearingDeg(0), -35);
});

// A simulated room: the drone starts at (0,0) facing +x; one person stands `distanceCm` away,
// `angleDeg` to the right. The fake camera works out the person's box from every move and turn
// the fake drone has received (go x y: x forward, y left).
function fakeRoom(fake, { distanceCm = 350, angleDeg = 15 } = {}) {
  const rad = (d) => (d * Math.PI) / 180;
  const person = { x: distanceCm * Math.cos(rad(angleDeg)), y: -distanceCm * Math.sin(rad(angleDeg)) };
  const pose = () => {
    let x = 0, y = 0, heading = 0; // heading: degrees, + = left (counterclockwise)
    for (const c of fake.received) {
      let m;
      const step = (fwd, left) => { x += fwd * Math.cos(rad(heading)) - left * Math.sin(rad(heading)); y += fwd * Math.sin(rad(heading)) + left * Math.cos(rad(heading)); };
      if ((m = /^go (-?\d+) (-?\d+) -?\d+ \d+$/.exec(c))) step(Number(m[1]), Number(m[2]));
      else if ((m = /^(forward|back|left|right) (\d+)$/.exec(c))) step(m[1] === 'forward' ? +m[2] : m[1] === 'back' ? -m[2] : 0, m[1] === 'left' ? +m[2] : m[1] === 'right' ? -m[2] : 0);
      else if ((m = /^(cw|ccw) (\d+)$/.exec(c))) heading += m[1] === 'ccw' ? Number(m[2]) : -Number(m[2]);
    }
    return { x, y, heading };
  };
  const view = async () => {
    const p = pose();
    const dx = person.x - p.x, dy = person.y - p.y;
    const d = Math.hypot(dx, dy);
    const bearingRight = -(Math.atan2(dy, dx) * 180 / Math.PI - p.heading); // + = right of the camera axis
    if (Math.abs(bearingRight) > 35) return { timestamp: Date.now() / 1000, objects: [] }; // outside the 70° view
    const w = Math.min(1, (FOCAL_PX * 0.5) / (d / 100) / FRAME_W);
    const cx = 0.5 + Math.tan(rad(bearingRight)) / (2 * Math.tan(rad(35)));
    return { timestamp: Date.now() / 1000, objects: [{ label: 'person', confidence: 0.9, center: { x: cx, y: 0.5 }, box: { x: cx - w / 2, y: 0.25, w, h: 0.5 } }] };
  };
  view.distanceNow = () => { const p = pose(); return Math.hypot(person.x - p.x, person.y - p.y); };
  return view;
}

test('approach flies a straight line toward a person on the right and stops about 1 m away', async (t) => {
  const fake = await fakeDrone();
  const room = fakeRoom(fake, { distanceCm: 350, angleDeg: 20 });
  const drone = tello(fake, { settleMs: 10, vision: room });
  t.after(() => { drone.close(); fake.close(); });
  assert.match((await drone.execute({ droneId: 'tello', action: 'approach' })).error, /flying/);
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'approach' });
  assert.equal(result.ok, true, result.error);
  const moves = fake.received.filter((c) => /^(go|forward|left|right|cw|ccw) /.test(c));
  // It moves diagonally (forward and to the right) instead of turning first.
  assert.match(moves[0], /^go \d+ -\d+ 0 40$/, moves.join(', '));
  assert.equal(moves.some((c) => /^(cw|ccw) /.test(c)), false, moves.join(', '));
  const left = room.distanceNow();
  assert.ok(left >= 90 && left <= 130, `ended ${Math.round(left)} cm away after ${moves.join(', ')}`);
});

test('approach turns first when the person is at the edge of the picture', async (t) => {
  const fake = await fakeDrone();
  const room = fakeRoom(fake, { distanceCm: 250, angleDeg: -30 });
  const drone = tello(fake, { settleMs: 10, vision: room });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'approach' });
  assert.equal(result.ok, true, result.error);
  const moves = fake.received.filter((c) => /^(go|forward|left|right|cw|ccw) /.test(c));
  assert.match(moves[0], /^ccw \d+$/, moves.join(', '));
  const left = room.distanceNow();
  assert.ok(left >= 90 && left <= 130, `ended ${Math.round(left)} cm away after ${moves.join(', ')}`);
});

test('approach refuses when nothing is in view and never moves', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { settleMs: 10, vision: async () => ({ timestamp: Date.now() / 1000, objects: [] }) });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'approach', label: 'bottle' });
  assert.match(result.error, /do not see a bottle/);
  assert.equal(fake.received.some((c) => /^(forward|cw|ccw) /.test(c)), false);
});

test('approach does not move when the person is already closer than the stop distance', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake, { settleMs: 10, vision: fakeRoom(fake, { distanceCm: 90, angleDeg: 0 }) });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'approach' });
  assert.equal(result.ok, true);
  assert.equal(fake.received.some((c) => c.startsWith('forward')), false);
});
