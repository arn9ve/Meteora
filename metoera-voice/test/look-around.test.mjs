// Looking around when in doubt: finding the position from what is seen all around, the plan's
// clear distances, the decision layer's rules, and the drone's look_around against a fake Tello.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { landmarksOf, expectedInView, aroundPrompt, parseSightings, boxSightings, locateAround, CAMERA_FOV_DEG } from '../src/landmarks.ts';
import { clearAlong } from '../src/room.ts';
import { checkChoice, parseChoice, ruleChoice, decisionPrompt } from '../src/decision.ts';
import { missionGoTo } from '../src/mission.ts';
import { RealTello } from '../src/tello.ts';

const plan = { height_m: 4.3, pillars: [-7.16, -2.36, 2.44, 7.24].map((x, i) => ({ id: `pillar-${i + 1}`, x, y: 0.937, w: 1.2, d: 0.7 })) };
// The six tables the simulator's venue starts with.
const T = (n, x, y) => ({ id: `t${n}`, name: `table ${n}`, kind: 'table', x, y, w: 1.8, d: 1.8, rotation: 0, heightM: 0.75 });
const tables = [T(1, 0.41, -0.66), T(2, 1.94, 2.54), T(3, 4.21, -1.37), T(4, 4.71, 1.95), T(5, 8.17, -1.37), T(6, 8.70, 1.95)];
// Where a landmark at `bearing` (+ = right) appears across the picture (inverse of bearingOfX).
const xOf = (bearing) => 0.5 + Math.tan((bearing * Math.PI) / 180) / (2 * Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180));
// Six views turning clockwise by 60°, from `first` (degrees, counterclockwise).
const headings = (first) => Array.from({ length: 6 }, (_, i) => first - 60 * i);
// What a camera at `truth` sees in each view: kind and place across the picture, give or take `noise`°.
function sightingsFrom(truth, hs, noise = () => 0) {
  const lm = landmarksOf(plan, tables);
  return hs.flatMap((h, i) => expectedInView(lm, { ...truth, heading: h }).filter((l) => l.distanceM > 1.9)
    .map((l) => ({ photo: i + 1, kind: l.kind, x: xOf(l.bearingDeg + noise()), confidence: 0.9 })));
}

test('looking around finds the position where one photo could not, from an estimate 1.2 m off', () => {
  const truth = { x: 5.4, y: -1.3 }, lm = landmarksOf(plan, tables);
  // Facing 60°, the photo ahead has one pillar (and a table 3.6 m off): not enough for one photo.
  assert.deepEqual(expectedInView(lm, { ...truth, heading: 60 }).filter((l) => l.kind === 'pillar').map((l) => l.id), ['pillar-4']);
  const hs = headings(60);
  let k = 0;
  const wobble = () => [3, -2, 4, -4, 1, -3, 2, 0][k++ % 8]; // degrees, as Grok vision's "x" is
  const r = locateAround(lm, hs, sightingsFrom(truth, hs, wobble), { x: truth.x - 1.0, y: truth.y + 0.7 });
  assert.equal(r.ok, true, r.error);
  assert.ok(Math.hypot(r.fix.x - truth.x, r.fix.y - truth.y) < 0.2, JSON.stringify(r.fix));
  assert.ok(r.fix.sigmaM < 0.35 && new Set(r.fix.matched.map((m) => m.id)).size >= 3, JSON.stringify(r.fix));
});

test('a wrong sighting is left out; too little or too ambiguous is refused, never guessed', () => {
  const truth = { x: 5.4, y: -1.3 }, lm = landmarksOf(plan, tables), hs = headings(60);
  const seen = sightingsFrom(truth, hs);
  const bad = [...seen, { photo: 2, kind: 'table', x: 0.12, confidence: 0.9 }]; // a table that is not there
  const r = locateAround(lm, hs, bad, { x: 5.0, y: -1.0 });
  assert.equal(r.ok, true, r.error);
  assert.ok(Math.hypot(r.fix.x - truth.x, r.fix.y - truth.y) < 0.05, JSON.stringify(r.fix));
  const one = locateAround(lm, hs, seen.filter((s) => s.kind === 'pillar').slice(0, 1), truth);
  assert.equal(one.ok, false); assert.match(one.error, /not enough/);
  assert.equal(locateAround(lm, hs, [], truth).ok, false);
});

test('the vision answer about six photos (no hints given), and the detector boxes', () => {
  assert.match(aroundPrompt(6), /every rectangular concrete pillar/);
  assert.doesNotMatch(aroundPrompt(6), /expected/);
  const seen = parseSightings('```json\n{"seen":[{"photo":1,"kind":"pillar","x":0.6,"confidence":0.9},{"photo":7,"kind":"table","x":0.5},{"photo":2,"kind":"chair","x":0.5},{"photo":2,"kind":"table","x":1.4}],"note":""}\n```', 6);
  assert.deepEqual(seen, [{ photo: 1, kind: 'pillar', x: 0.6, confidence: 0.9 }]);
  assert.equal(parseSightings('I see two pillars', 6), null);
  assert.deepEqual(boxSightings([[{ label: 'pillar', x: 0.3, confidence: 0.8 }, { label: 'person', x: 0.5, confidence: 0.9 }], [{ label: 'dining table', x: 0.7, confidence: 0.6 }, { label: 'pillar', x: 0.1, confidence: 0.2 }]]),
    [{ photo: 1, kind: 'pillar', x: 0.3, confidence: 0.8 }, { photo: 2, kind: 'table', x: 0.7, confidence: 0.6 }]);
});

test('how far the plan is clear in a direction, and what is there', () => {
  const walls = [{ a: [10, -5], b: [10, 5] }];
  const room = { ...plan, walls, bounds: { min: [-12, -6], max: [12, 6] } };
  assert.deepEqual(clearAlong(room, tables, [6.2, -3], 0, 0.8), { m: 3.8, what: 'a wall' });
  const up = clearAlong(room, tables, [7.24, -1], 90, 0.8); // pillar 4's face at y = 0.587
  assert.ok(Math.abs(up.m - 1.587) < 1e-6 && up.what === 'pillar 4', JSON.stringify(up));
  assert.equal(clearAlong(room, tables, [4.71, 0.3], 90, 0.8).what, 'table 4'); // a 75 cm table reaches a drone at 80 cm
  assert.equal(clearAlong(room, tables, [4.71, 0.3], 90, 1.5).what, null); // not one flying at 1.5 m
});

test('the decision layer looks all around instead of asking for one photo again', () => {
  const base = { goal: 'table 1', remainingCm: 300, nextLegCm: 150, positionFrom: 'commands', checkedWithPhoto: false, heightAboveFloorCm: 80, surfaceBelowCm: 0, ceilingCm: 430, clearanceCm: 120, personOnPathM: null, battery: 60, haveSafePoint: true, lastSteps: [], step: 2, maxSteps: 30 };
  // Never checked, and the position is only from the commands: look all around before one photo.
  assert.equal(ruleChoice(base).action, 'look_around');
  assert.equal(ruleChoice({ ...base, positionFrom: 'telemetry' }).action, 'continue');
  assert.equal(ruleChoice({ ...base, checkedWithPhoto: true }).action, 'continue');
  const failed = { ...base, lastSteps: [{ action: 'localize', ok: false, note: 'Saw only pillar-4' }] };
  assert.equal(ruleChoice(failed).action, 'look_around');
  const again = checkChoice({ action: 'localize' }, failed);
  assert.equal(again.choice.action, 'look_around'); assert.match(again.overruled, /looking all around/);
  assert.equal(checkChoice({ action: 'localize' }, base).choice.action, 'localize');
  assert.deepEqual(parseChoice('{"action":"look_around","n":null,"reason":"photo saw one pillar"}').choice, { action: 'look_around' });
  assert.match(decisionPrompt(base), /look_around \(turn 360°/);
});

function missionDrone({ located = { ok: false, error: 'Saw only pillar-4 all around' }, flying = () => true } = {}) {
  const pose = { x: 100, y: 300, heading: 0, zFloor: 80 };
  const sent = [];
  let awake = 0;
  const d = {
    generation: 0,
    execute: async (c) => { sent.push(c.action); if (c.action === 'look_around') return { ok: true, located }; if (c.action === 'localize') return { ok: false, error: 'Saw only pillar-4' }; return { ok: true }; },
    forceLand: async () => ({ ok: true }),
    live: () => ({ flying: flying(), pose: { ...pose }, source: 'commands', startSurface: { heightCm: 0 } }),
    snapshot: () => ({ battery: 70, heightAboveFloorCm: 80 }),
    keepAwake: async () => { awake += 1; },
    seenPeople: () => [],
  };
  return { d, sent, awake: () => awake };
}
const room = { walls: [], bounds: { min: [0, 0], max: [10, 6] }, height_m: 4.3 };

test('mission: lost after looking around twice, it stops instead of guessing; kept awake; ends when not flying', async () => {
  const lost = missionDrone();
  const r = await missionGoTo('tello', lost.d, { x: 600, y: 300, name: 'x' }, { plan: room, objects: [], people: () => [], decide: async () => '{"action":"localize"}', hoverMs: 1 });
  assert.equal(r.ok, false); assert.match(r.error, /Position unknown: looked all around twice/);
  assert.deepEqual(lost.sent, ['localize', 'look_around', 'look_around']); // the second localize became look_around
  assert.ok(lost.awake() >= 3);
  let n = 0;
  const landed = missionDrone({ flying: () => (n += 1) < 3 });
  const r2 = await missionGoTo('tello', landed.d, { x: 600, y: 300, name: 'x' }, { plan: room, objects: [], people: () => [], decide: async () => '{"action":"hover"}', hoverMs: 1 });
  assert.equal(r2.ok, false); assert.match(r2.error, /not flying any more/);
});

test('mission: a person who stays near the way ends the mission after a short wait', async () => {
  const still = missionDrone();
  still.d.seenPeople = () => [{ x: 2.0, y: 3.05 }]; // 5 cm off the first leg
  const r = await missionGoTo('tello', still.d, { x: 600, y: 300, name: 'x' }, { plan: room, objects: [], people: () => [], decide: async () => '{"action":"continue"}', hoverMs: 1 });
  assert.equal(r.ok, false); assert.match(r.error, /A person stays near the way/);
  assert.equal(r.choices.length, 6); assert.ok(r.choices.every((c) => c === 'hover'));
});

// ---- the drone itself, against a fake Tello

const SERIAL = '0TQZTEST000001';
async function fakeTello() {
  const socket = dgram.createSocket('udp4'); const received = []; let closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); received.push(text);
    const reply = (v) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, 10);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('90'); else reply('ok');
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  return { port: socket.address().port, received, close: () => { closed = true; socket.close(); } };
}
// A camera that sees `objects()` in every view.
const camera = (objects) => ({ vision: async () => ({ timestamp: Date.now() / 1000, objects: objects() }), frame: async () => Buffer.from('jpeg') });
const person = { label: 'person', confidence: 0.8, center: { x: 0.5, y: 0.45 }, box: { x: 0.4, y: 0.1, w: 0.2, h: 0.7 } };
function drone(f, opts = {}) {
  return new RealTello({ host: '127.0.0.1', port: f.port, localPort: 0, statePort: 0, expectedSerial: SERIAL, cameraWarmMs: 0, settleMs: 0, ...opts });
}
const turns = (f) => f.received.filter((c) => c === 'cw 60').length;

test('look_around turns all the way round, finds the position and says who is around', async (t) => {
  const f = await fakeTello();
  const asked = [];
  const d = drone(f, { ...camera(() => [person]), localizeAround: async (pose, views) => { asked.push(views); return { ok: true, x: pose.x + 40, y: pose.y, seen: ['pillar-3', 'pillar-4'], residualCm: 6, note: '', by: 'vision' }; }, planClear: () => ({ cm: 320, what: 'a wall' }) });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'look_around' });
  assert.equal(r.ok, true, r.error);
  assert.equal(turns(f), 6);
  assert.equal(r.pose.heading, 0); // facing where it started
  assert.deepEqual(asked[0].map((v) => v.heading), [0, -60, -120, 180, 120, 60]);
  assert.ok(asked[0].every((v) => v.image && v.detections));
  assert.deepEqual([r.located.ok, r.located.shiftCm, r.located.by], [true, 40, 'vision']);
  assert.equal(r.pose.x, 40);
  assert.match(r.summary, /ahead 3\.2 m to a wall, a person 1\.\d m away/);
  assert.equal(r.people.length, 6); // the same person in every view of this fake camera
});

test('one photo that sees too little turns into a look all around', async (t) => {
  const f = await fakeTello();
  const d = drone(f, { ...camera(() => []), localize: async () => ({ ok: false, error: 'Saw only pillar-4 and no distance: not enough to tell the position' }), localizeAround: async (pose) => ({ ok: true, x: pose.x - 30, y: pose.y + 10, seen: ['pillar-4', 't4'], residualCm: 9, note: '' }) });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'localize' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lookedAround, true); assert.equal(r.shiftCm, 32);
  assert.equal(turns(f), 6);
});

test('before moving sideways it looks around, refuses toward a person, and reuses a recent look', async (t) => {
  const f = await fakeTello();
  let people = [person];
  const d = drone(f, camera(() => people));
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'move', direction: 'right', centimeters: 100 });
  assert.equal(r.ok, false); assert.match(r.error, /Looked around first: a person about 1\.\d m away to the right/);
  assert.equal(turns(f), 6);
  assert.equal(f.received.includes('right 100'), false);
  people = [];
  const back = await d.execute({ droneId: 'tello', action: 'move', direction: 'back', centimeters: 50 });
  assert.equal(back.ok, false); // the look of a moment ago still has the person behind too
  assert.equal(turns(f), 6); // reused, not looked again
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 50 })).ok, true); // ahead: the camera sees it
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'left', centimeters: 50, look: false })).ok, true); // the calibration pattern
});

test('the plan refuses a sideways move into a table; nothing in the way lets it go', async (t) => {
  const f = await fakeTello();
  const d = drone(f, { ...camera(() => []), planClear: (x, y, heading) => (Math.round(heading) === -90 ? { cm: 80, what: 'table 4' } : { cm: 500, what: 'a wall' }) });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'move', direction: 'right', centimeters: 100 });
  assert.equal(r.ok, false); assert.match(r.error, /Table 4 is 0\.8 m to the right on the room plan/);
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'left', centimeters: 100 })).ok, true);
  assert.ok(f.received.includes('left 100'));
});

test('go_to turns to face a leg that is off to the side, then flies forward', async (t) => {
  const f = await fakeTello();
  const d = drone(f);
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'go_to', x: 0, y: 150 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(f.received.filter((c) => /^(ccw|cw|forward|left|go) /.test(c)), ['ccw 90', 'forward 150']);
  await d.execute({ droneId: 'tello', action: 'go_to', x: 0, y: 0, look: false }); // calibration's way back: straight
  assert.ok(f.received.includes('back 150'), f.received.join(', '));
});

test('a slow position answer does not let the Tello land by itself', async (t) => {
  const f = await fakeTello();
  const d = drone(f, { ...camera(() => []), localizeAround: () => new Promise((r) => setTimeout(() => r({ ok: false, error: 'Grok vision did not answer' }), 5200)) });
  t.after(() => { d.close(); f.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'look_around' });
  assert.equal(r.ok, true); assert.equal(r.located.ok, false);
  const last = f.received.lastIndexOf('cw 60');
  assert.ok(f.received.slice(last + 1).includes('battery?'), f.received.slice(last).join(', '));
});
