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
    let bearingRight = -(Math.atan2(dy, dx) * 180 / Math.PI - p.heading); // + = right of the camera axis
    bearingRight = ((bearingRight % 360) + 540) % 360 - 180;
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
  assert.match(moves[0], /^go \d+ -\d+ 0 60$/, moves.join(', '));
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

// ---- memory, go_to and find ----
import { World } from '../src/world.ts';

test('world tracks position from moves and turns, and the way back', () => {
  const w = new World();
  w.applySdk('takeoff');
  w.applySdk('forward 100');
  w.applySdk('ccw 90');     // now facing +y (left of the start)
  w.applySdk('forward 50');
  assert.deepEqual([w.pose.x, w.pose.y, w.pose.heading], [100, 50, 90]);
  const back = w.vectorTo({ x: 0, y: 0 });
  // Facing +y, the drone's left is -x: home is back 50 and 100 to its left.
  assert.deepEqual([back.forward, back.left], [-50, 100]);
  w.applySdk('go 0 -50 0 40'); // 50 cm to the right while facing +y = toward +x
  assert.deepEqual([w.pose.x, w.pose.y], [150, 50]);
  w.see('person', 0, 200);    // straight ahead (heading 90°) 2 m away
  assert.deepEqual([w.memory().sightings[0].x, w.memory().sightings[0].y], [150, 250]);
});

test('go_to home flies back to the takeoff point, also after landing and taking off again', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  await drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 });
  await drone.execute({ droneId: 'tello', action: 'rotate', direction: 'counterclockwise', degrees: 90 });
  await drone.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 80 });
  await drone.execute({ droneId: 'tello', action: 'land' });
  assert.match((await drone.execute({ droneId: 'tello', action: 'go_to', place: 'home' })).error, /take off first/);
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'go_to', place: 'home' });
  assert.equal(result.ok, true, result.error);
  assert.ok(Math.hypot(result.pose.x, result.pose.y) < 25, JSON.stringify(result.pose));
  assert.equal(result.pose.heading, 0); // faces the original direction again
  const mem = (await drone.execute({ droneId: 'tello', action: 'memory' })).memory;
  assert.ok(mem.log.some((e) => e.action === 'land'));
  assert.ok('last_landing' in mem.places);
  assert.match((await drone.execute({ droneId: 'tello', action: 'go_to', place: 'kitchen' })).error, /No place called kitchen/);
});

test('find uses Grok vision on four photos, turns to the match, and approach then reaches it', async (t) => {
  const fake = await fakeDrone();
  const room = fakeRoom(fake, { distanceCm: 300, angleDeg: 100 }); // behind, to the right
  let prompt = '';
  const drone = tello(fake, {
    settleMs: 10, vision: room, frame: async () => Buffer.from('jpeg'),
    askVision: async (images, text) => { prompt = text; assert.equal(images.length, 4); return 'Sure: {"photo": 2, "x": 0.62, "note": "a man in a green t-shirt"}'; },
  });
  t.after(() => { drone.close(); fake.close(); });
  assert.match((await drone.execute({ droneId: 'tello', action: 'find', description: 'person in a green t-shirt' })).error, /take off first/);
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const found = await drone.execute({ droneId: 'tello', action: 'find', description: 'person in a green t-shirt' });
  assert.equal(found.ok, true, found.error);
  assert.equal(found.found, true);
  assert.match(prompt, /green t-shirt/);
  assert.ok(found.turnedDeg >= 95 && found.turnedDeg <= 105, `turned ${found.turnedDeg}`);
  const approach = await drone.execute({ droneId: 'tello', action: 'approach' });
  assert.equal(approach.ok, true, approach.error);
  const left = room.distanceNow();
  assert.ok(left >= 90 && left <= 135, `ended ${Math.round(left)} cm away`);
});

test('explore turns all the way round in six steps and maps YOLO and Grok vision finds', async (t) => {
  const fake = await fakeDrone();
  const room = fakeRoom(fake, { distanceCm: 250, angleDeg: 120 }); // a person behind-right
  let photos = 0;
  const drone = tello(fake, {
    settleMs: 10, vision: room, frame: async () => Buffer.from('jpeg'), start: { x: 0, y: -150, heading: 0 },
    askVision: async (images) => { photos = images.length; return '[{"photo": 3, "x": 0.5, "label": "door", "description": "white door"}, {"photo": 9, "label": "bad"}]'; },
  });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'explore' });
  assert.equal(result.ok, true, result.error);
  assert.equal(photos, 6);
  assert.equal(fake.received.filter((c) => c === 'cw 60').length, 6);
  assert.equal(result.pose.heading, 0); // back to where it faced
  const person = result.found.find((f) => f.label === 'person');
  assert.ok(person, JSON.stringify(result.found));
  // 250 cm away, 120° to the right of the start heading, from the start point (0,-150).
  const ex = 250 * Math.cos(-120 * Math.PI / 180), ey = -150 + 250 * Math.sin(-120 * Math.PI / 180);
  assert.ok(Math.hypot(person.x - ex, person.y - ey) < 60, `person at (${person.x},${person.y}), expected near (${Math.round(ex)},${Math.round(ey)})`);
  const door = result.found.find((f) => f.label === 'door');
  assert.equal(door.description, 'white door');
  assert.equal(result.found.some((f) => f.label === 'bad'), false);
  const map = drone.map();
  assert.ok(map.sightings.length >= 2);
  assert.deepEqual(map.path[0], { x: 0, y: -150 });
});

test('a box cut off by the frame edge gives no distance unless it fills the view', () => {
  assert.equal(estimateDistanceCm('person', { x: 0, y: 0, w: 0.3, h: 1 }), null);
  assert.equal(estimateDistanceCm('chair', { x: 0, y: 0.5, w: 0.2, h: 0.5 }), null);
  assert.equal(estimateDistanceCm('person', { x: 0, y: 0, w: 1, h: 1 }), 40);
});

test('the same person seen from overlapping views becomes one sighting', () => {
  const w = new World();
  w.see('person', 10, 300);
  w.applySdk('cw 60');
  w.see('person', -50, 260); // same spot, seen from the next view
  w.see('person', -48, 340);
  const people = w.memory().sightings.filter((s) => s.label === 'person');
  assert.equal(people.length, 1, JSON.stringify(people));
  assert.equal(people[0].count, 3);
  w.see('person', 80, 200); // somewhere else entirely
  assert.equal(w.memory().sightings.filter((s) => s.label === 'person').length, 2);
});

test('heading reference is fixed at takeoff, not before', () => {
  const w = new World();
  w.applyTelemetry(0, 40);   // on the ground, IMU says 40°
  w.applyTelemetry(0, 75);   // moved by hand: ignored
  assert.equal(w.pose.heading, 0);
  w.applySdk('takeoff');
  w.applyTelemetry(80, 120); // IMU jumped at takeoff: this becomes heading 0
  assert.equal(w.pose.heading, 0);
  w.applyTelemetry(80, 210); // turned 90° clockwise
  assert.equal(w.pose.heading, -90);
});

test('with metric depth, explore uses measured distances and draws walls', async (t) => {
  const fake = await fakeDrone();
  // A person straight ahead whose box is cut at the bottom (no size estimate possible), 2.4 m away.
  const view = async () => ({ timestamp: Date.now() / 1000, objects: [{ label: 'person', confidence: 0.9, center: { x: 0.5, y: 0.5 }, box: { x: 0.45, y: 0.3, w: 0.1, h: 0.7 } }] });
  const depth = async () => ({
    timestamp: Date.now() / 1000,
    objects: [{ label: 'person', confidence: 0.9, center: { x: 0.5, y: 0.5 }, box: { x: 0.45, y: 0.3, w: 0.1, h: 0.7 }, depth_m: 2.4 }],
    columns: [-30, -15, 0, 15, 30].map((b) => ({ x: 0.5 + b / 70, bearing_deg: b, depth_m: 3 })), // a wall 3 m ahead
  });
  const drone = tello(fake, { settleMs: 10, vision: view, depth });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const result = await drone.execute({ droneId: 'tello', action: 'explore' });
  assert.equal(result.ok, true, result.error);
  const first = drone.map().sightings.find((s) => s.label === 'person');
  assert.equal(first.distanceCm, 240);
  assert.deepEqual([first.x, first.y], [240, 0]);
  const map = drone.map();
  assert.ok(map.obstacles.length >= 20, `${map.obstacles.length} obstacle points`);
  // The wall straight ahead at the start is about 300 cm away on the x axis.
  assert.ok(map.obstacles.some((o) => Math.abs(o.x - 300) <= 20 && Math.abs(o.y) <= 20));
});

test('go_to with minHeightCm climbs first, then flies', async (t) => {
  const fake = await fakeDrone();
  const drone = tello(fake);
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await drone.execute({ droneId: 'tello', action: 'go_to', x: 150, y: 0, minHeightCm: 170 });
  assert.equal(r.ok, true, r.error);
  const moves = fake.received.filter((c) => c.startsWith('up') || c.startsWith('go ') || c.startsWith('forward'));
  assert.equal(moves[0], 'up 90');
  assert.match(moves[1], /^(forward 150|go 150 0 0 \d+)$/); // stays up: no descent back down
  assert.equal((await drone.execute({ droneId: 'tello', action: 'go_to', x: 0, y: 0, minHeightCm: 999 })).ok, false);
});

test('a turn is not counted twice when the heading comes from the telemetry (5 Nov, 10:19)', async () => {
  const { World } = await import('../src/world.ts');
  const w = new World({ x: 0, y: 0, heading: 90 });
  w.applySdk('takeoff');
  w.applyTelemetry(80, 0);      // anchors: yaw 0 = heading 90
  w.applyTelemetry(80, 100);    // the drone turned 100° clockwise: heading -10
  w.applySdk('cw 100');         // the "ok" of that turn arrives after the telemetry
  assert.equal(w.pose.heading, -10);
  const v = w.vectorTo({ x: 228, y: -42 }); // table 3, from table 1: straight ahead now
  assert.ok(v.forward > 225 && Math.abs(v.left) < 10, JSON.stringify(v));
  w.correctHeading(15); w.applyTelemetry(80, 100);
  assert.equal(w.pose.heading, 5); // a survey correction holds with the next telemetry
});
