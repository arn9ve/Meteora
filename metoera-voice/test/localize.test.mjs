import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';

const SERIAL = '0TQZTEST000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fake({ imu = false } = {}) {
  const socket = dgram.createSocket('udp4'); const received = []; let closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); received.push(text);
    const reply = (v) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, 10);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('90');
    else if (imu && /^(forward|back|left|right|go) /.test(text)) reply('error No valid imu');
    else reply('ok');
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  return { port: socket.address().port, received, close: () => { closed = true; socket.close(); } };
}
const drone = (f, opts = {}) => new RealTello({ host: '127.0.0.1', port: f.port, localPort: 0, statePort: 0, expectedSerial: SERIAL, cameraWarmMs: 0, ...opts });

test('the camera is off until something needs it, and off again when idle', async (t) => {
  const f = await fake();
  const d = drone(f, { cameraIdleMs: 50, keepaliveMs: 40 });
  t.after(() => { d.close(); f.close(); });
  assert.equal((await d.execute({ droneId: 'tello', action: 'takeoff' })).ok, true);
  assert.equal(f.received.includes('streamon'), false);
  assert.equal(await d.ensureCamera(), true);
  assert.equal(f.received.filter((c) => c === 'streamon').length, 1);
  await sleep(250);
  assert.ok(f.received.includes('streamoff'));
  assert.equal(d.snapshot().video, false);
  // While someone watches, it stays on.
  const release = d.holdCamera(); await sleep(250);
  assert.equal(d.snapshot().video, true);
  release(); await sleep(250);
  assert.equal(d.snapshot().video, false);
});

test('localize moves the estimate to where the photo says; a fix of more than 3 m is not believed', async (t) => {
  const f = await fake();
  let answer = { ok: true, x: 140, y: 30, seen: ['pillar-2', 't1'], residualCm: 8, note: 'two pillars' };
  const asked = [];
  const d = drone(f, { localize: async (pose) => { asked.push(pose); return answer; } });
  t.after(() => { d.close(); f.close(); });
  assert.match((await d.execute({ droneId: 'tello', action: 'localize' })).error, /Take off first/);
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'localize' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.pose.x, r.pose.y], [140, 30]);
  assert.equal(r.shiftCm, 143);
  assert.ok(f.received.includes('streamon'));
  answer = { ok: true, x: 900, y: 30, seen: ['pillar-4'], residualCm: 5, note: '' };
  const far = await d.execute({ droneId: 'tello', action: 'localize' });
  assert.equal(far.ok, false); assert.match(far.error, /not believed/);
  assert.deepEqual([d.map().pose.x, d.map().pose.y], [140, 30]);
});

test('in doubt (no telemetry yet), go_to checks with a photo on arrival and corrects once', async (t) => {
  const f = await fake();
  // The photo says it stopped 60 cm short of the target.
  const d = drone(f, { localize: async (pose) => ({ ok: true, x: pose.x - 60, y: pose.y, seen: ['pillar-3'], residualCm: 5, note: '' }) });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'go_to', x: 150, y: 0 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.checkedWithPhoto.seen, ['pillar-3']);
  const moves = f.received.filter((c) => /^(forward|go) /.test(c));
  assert.deepEqual(moves, ['forward 150', 'forward 60']);
});

test('after "No valid imu" the next route starts with a photo fix', async (t) => {
  const f = await fake({ imu: true });
  let fixes = 0;
  const d = drone(f, { localize: async (pose) => { fixes += 1; return { ok: true, x: pose.x, y: pose.y, seen: ['t1'], residualCm: 0, note: '' }; } });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const m = await d.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 50 });
  assert.match(m.error, /cannot see the floor/);
  await d.execute({ droneId: 'tello', action: 'go_to', x: 100, y: 0 });
  assert.ok(fixes >= 1, String(fixes));
});

test('survey: climbs, four photos turning on the spot, back to its heading, corrects position and heading, comes down', async (t) => {
  const f = await fake();
  let got = null;
  const d = drone(f, { start: { x: 41, y: -63, heading: 90 }, frame: async () => Buffer.from('jpg'), survey: async (input) => { got = input; return { ok: true, x: 50, y: -60, deltaHeading: -100, seen: ['pillar-3', 't3'], residualCm: 6, note: 'pillar 3 and table 3' }; } });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  assert.equal(d.surveyedThisFlight, false);
  const r = await d.execute({ droneId: 'tello', action: 'survey' });
  assert.equal(r.ok, true, r.error);
  assert.equal(got.photos.length, 4);
  assert.deepEqual(got.headings, [90, 0, -90, 180]);
  assert.deepEqual(f.received.filter((c) => /^(up|down|cw|ccw) /.test(c)), ['up 120', 'cw 90', 'cw 90', 'cw 90', 'cw 90', 'down 120']);
  assert.deepEqual([d.map().pose.x, d.map().pose.y, d.map().pose.heading], [50, -60, -10]);
  assert.equal(d.surveyedThisFlight, true);
});
