import assert from 'node:assert/strict';
import test from 'node:test';
import { checkChoice, parseChoice, ruleChoice, decisionPrompt } from '../src/decision.ts';
import { missionGoTo } from '../src/mission.ts';

const base = { goal: 'table 5', remainingCm: 400, nextLegCm: 150, positionFrom: 'telemetry', checkedWithPhoto: true, heightAboveFloorCm: 150, surfaceBelowCm: 0, ceilingCm: 430, clearanceCm: 120, personOnPathM: null, battery: 60, haveSafePoint: true, lastSteps: [], step: 1, maxSteps: 30 };

test('the rules check every choice of the model', () => {
  assert.deepEqual(checkChoice({ action: 'climb', cm: 500 }, base).choice, { action: 'climb', cm: 80 });
  assert.equal(checkChoice({ action: 'climb', cm: 50 }, { ...base, heightAboveFloorCm: 240 }).choice.action, 'hover'); // 250 cm cap
  assert.equal(checkChoice({ action: 'descend', cm: 80 }, { ...base, heightAboveFloorCm: 130, surfaceBelowCm: 75 }).choice.action, 'hover'); // not below 125 over a table
  assert.deepEqual(checkChoice({ action: 'turn', deg: 170 }, base).choice, { action: 'turn', deg: 90 });
  assert.equal(checkChoice({ action: 'continue' }, { ...base, personOnPathM: 0.5 }).choice.action, 'hover');
  assert.equal(checkChoice({ action: 'done' }, base).choice.action, 'hover'); // 400 cm left: not done
  assert.equal(checkChoice({ action: 'land' }, { ...base, surfaceBelowCm: null }).choice.action, 'hover');
  const low = checkChoice({ action: 'continue' }, { ...base, battery: 10 });
  assert.equal(low.choice.action, 'land'); assert.match(low.overruled, /battery/);
});

test('the model answer is read strictly; the rules choose when there is none', () => {
  assert.deepEqual(parseChoice('{"action":"climb","n":40,"reason":"table ahead"}'), { choice: { action: 'climb', cm: 40 }, reason: 'table ahead' });
  assert.deepEqual(parseChoice('```json\n{"action":"localize","n":null,"reason":"moves failed"}\n```').choice, { action: 'localize' });
  assert.equal(parseChoice('{"action":"fly to the moon"}'), null);
  assert.equal(parseChoice('{"action":"turn"}'), null);
  assert.equal(ruleChoice({ ...base, positionFrom: 'commands', checkedWithPhoto: false }).action, 'localize');
  assert.equal(ruleChoice({ ...base, remainingCm: 20 }).action, 'done');
  assert.match(decisionPrompt(base), /goal: table 5; 400 cm left/);
});

// A drone that flies exactly where it is sent (room cm), for the mission loop.
function fakeDrone({ startX = 0, startY = 0, zFloor = 150 } = {}) {
  const pose = { x: startX, y: startY, heading: 0, zFloor };
  const sent = [];
  const d = {
    generation: 0,
    execute: async (c) => { sent.push(c); if (c.action === 'go_to') { pose.x = c.x; pose.y = c.y; } return { ok: true }; },
    forceLand: async () => { sent.push({ action: 'land' }); return { ok: true }; },
    live: () => ({ flying: true, pose: { ...pose }, source: 'telemetry', startSurface: { heightCm: 0 } }),
    snapshot: () => ({ battery: 70, heightAboveFloorCm: 150 }),
  };
  return { d, sent, pose };
}
const box = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]].map(([a, b]) => ({ a, b }));
const plan = { walls: box(0, 0, 10, 6), bounds: { min: [0, 0], max: [10, 6] }, height_m: 4.3 };
const table = { id: 't', name: 'table 1', kind: 'table', x: 5, y: 3, w: 1.8, d: 1.8, rotation: 0, heightM: 0.75 };

test('mission flying low: legs of at most 300 cm around the table; nobody asked while all goes well', async () => {
  const { d, sent, pose } = fakeDrone({ startX: 100, startY: 300, zFloor: 100 });
  const steps = []; let asked = 0;
  const r = await missionGoTo('tello', d, { x: 900, y: 300, name: 'far wall' }, { plan, objects: [table], people: () => [], decide: async () => { asked += 1; return '{"action":"continue","n":null,"reason":"all normal"}'; }, onStep: (s) => steps.push(s), hoverMs: 1 });
  assert.equal(r.ok, true, r.error);
  assert.ok(Math.hypot(pose.x - 900, pose.y - 300) < 30, JSON.stringify(pose));
  let at = [100, 300];
  for (const c of sent.filter((c) => c.action === 'go_to')) {
    assert.ok(Math.hypot(c.x - at[0], c.y - at[1]) <= 301, `leg too long: ${JSON.stringify(c)}`);
    assert.equal(c.check, false);
    for (let t = 0; t <= 1; t += 0.05) { const x = (at[0] + (c.x - at[0]) * t) / 100, y = (at[1] + (c.y - at[1]) * t) / 100; assert.ok(Math.abs(x - 5) > 0.9 || Math.abs(y - 3) > 0.9, 'through the table'); }
    at = [c.x, c.y];
  }
  assert.equal(asked, 0);
  assert.ok(steps.every((s) => s.by === 'rules'));
});

test('mission flying above the tables: straight over them, few legs', async () => {
  const { d, sent, pose } = fakeDrone({ startX: 100, startY: 300, zFloor: 155 });
  const r = await missionGoTo('tello', d, { x: 900, y: 300, name: 'far wall' }, { plan, objects: [table], people: () => [], decide: null, hoverMs: 1 });
  assert.equal(r.ok, true, r.error);
  const legs = sent.filter((c) => c.action === 'go_to');
  assert.ok(legs.every((c) => c.y === 300), JSON.stringify(legs)); // a straight line, over the table
  assert.equal(legs.length, 3); // 800 cm in legs of at most 300
  assert.ok(Math.hypot(pose.x - 900, pose.y - 300) < 30);
});

test('mission: a slow model means hover; a person on the path means hover; stop ends it', async () => {
  const slow = fakeDrone();
  let calls = 0;
  const r1 = await missionGoTo('tello', slow.d, { x: 300, y: 300, name: 'x' }, { plan, objects: [], people: () => [{ x: 1.5, y: 1.5 }], decide: () => { calls += 1; return new Promise((res) => setTimeout(() => res('{"action":"continue"}'), 200)); }, timeoutMs: 20, hoverMs: 1, maxSteps: 3 });
  assert.equal(r1.ok, false); assert.deepEqual(r1.choices, ['hover', 'hover', 'hover']); assert.equal(slow.sent.length, 0);
  const crowd = fakeDrone({ startX: 100, startY: 100 });
  const r2 = await missionGoTo('tello', crowd.d, { x: 400, y: 100, name: 'x' }, { plan, objects: [], people: () => [{ x: 1.8, y: 1.1 }], decide: async () => '{"action":"continue"}', hoverMs: 1, maxSteps: 2 });
  assert.deepEqual(r2.choices, ['hover', 'hover']);
  const stopped = fakeDrone({ startX: 100, startY: 100 });
  let n = 0;
  stopped.d.execute = ((orig) => async (c) => { if (++n === 2) stopped.d.generation += 1; return orig(c); })(stopped.d.execute);
  const r3 = await missionGoTo('tello', stopped.d, { x: 900, y: 100, name: 'x' }, { plan, objects: [], people: () => [], decide: null, hoverMs: 1 });
  assert.equal(r3.ok, false); assert.match(r3.error, /stopped/);
});

test('mission without a model: the rules look first when the position is only from commands, then go', async () => {
  const { d, sent } = fakeDrone({ startX: 100, startY: 300 });
  d.live = ((orig) => () => ({ ...orig(), source: 'commands' }))(d.live);
  const r = await missionGoTo('tello', d, { x: 300, y: 300, name: 'x' }, { plan, objects: [], people: () => [], decide: null, hoverMs: 1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(sent[0].action, 'localize');
  assert.equal(sent[1].action, 'go_to');
});

test('a drone that does not move is not left pretending: three useless steps and the mission stops', async () => {
  const { d } = fakeDrone({ startX: 100, startY: 300 });
  d.execute = async () => ({ ok: true }); // says ok, does not move
  const r = await missionGoTo('tello', d, { x: 900, y: 300, name: 'x' }, { plan, objects: [], people: () => [], decide: null, hoverMs: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /three steps without getting closer/);
  assert.ok(r.steps <= 4);
});

test('where the drone is, in words', async () => {
  const { describePlace } = await import('../src/room.ts');
  const tables = [{ id: 't1', name: 'table 1', kind: 'table', x: 0.41, y: -0.66, w: 1.8, d: 1.8, rotation: 0 }, { id: 't3', name: 'table 3', kind: 'table', x: 4.21, y: -1.37, w: 1.8, d: 1.8, rotation: 0 }];
  const pillars = [{ id: 'pillar-3', x: 2.44, y: 0.937, w: 1.2, d: 0.7 }];
  assert.equal(describePlace(tables, pillars, 41, -66), 'above table 1');
  assert.equal(describePlace(tables, pillars, 272, -108), 'next to table 3 (59 cm from its edge)');
  assert.match(describePlace(tables, pillars, 900, 300), /m from /);
});

import { planText, turnTo } from '../src/mission.ts';

test('the plan, worked out before moving, in words', () => {
  assert.equal(turnTo({ x: 0, y: 0, heading: 90 }, { x: 100, y: 0 }), -90); // target on the right: turn right
  const t1 = { id: 't1', name: 'table 1', kind: 'table', x: 2, y: 3, w: 1.8, d: 1.8, rotation: 0, heightM: 0.75 };
  const text = planText({ x: 100, y: 300, heading: 90, zFloor: 155 }, { x: 400, y: 300, name: 'table 3' }, { plan, objects: [t1] });
  assert.equal(text, 'table 3 is 3.0 m away, to its right (90°). Turning 90° right, then one straight line, over table 1.');
});

test('it turns to face each leg before flying it, and faces the table on arrival', async () => {
  const { d, sent, pose } = fakeDrone({ startX: 100, startY: 300 });
  pose.heading = 90;
  d.execute = ((orig) => async (c) => { if (c.action === 'rotate') pose.heading += c.direction === 'counterclockwise' ? c.degrees : -c.degrees; return orig(c); })(d.execute);
  const plans = [];
  const r = await missionGoTo('tello', d, { x: 400, y: 300, name: 'table 3', face: { x: 500, y: 200 } }, { plan, objects: [], people: () => [], decide: null, hoverMs: 1, onPlan: (p) => plans.push(p) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(sent.slice(0, 2).map((c) => c.action === 'rotate' ? `rotate ${c.direction} ${c.degrees}` : c.action), ['rotate clockwise 90', 'go_to']);
  assert.equal(sent.at(-1).action, 'rotate'); // faces table 3 at the end
  assert.equal(plans.length, 1);
});

test('photos that keep failing are not asked for again; a landed drone ends the mission', async () => {
  const { d, sent } = fakeDrone({ startX: 100, startY: 300 });
  d.live = ((orig) => () => ({ ...orig(), source: 'commands' }))(d.live);
  d.execute = ((orig) => async (c) => (c.action === 'localize' ? { ok: false, error: 'no landmarks' } : orig(c)))(d.execute);
  const r = await missionGoTo('tello', d, { x: 400, y: 300, name: 'x' }, { plan, objects: [], people: () => [], decide: async () => '{"action":"localize","reason":"doubt"}', hoverMs: 1 });
  assert.equal(r.ok, true, r.error);
  assert.ok(sent.filter((c) => c.action === 'localize').length <= 2, JSON.stringify(sent.map((c) => c.action)));
  const landed = fakeDrone({ startX: 100, startY: 300 });
  let n = 0; landed.d.live = ((orig) => () => ({ ...orig(), flying: ++n < 3 }))(landed.d.live);
  const r2 = await missionGoTo('tello', landed.d, { x: 900, y: 300, name: 'x' }, { plan, objects: [], people: () => [], decide: null, hoverMs: 1 });
  assert.match(r2.error, /landed/);
});

test('into a zone: ends inside it, checked; short of it, one correction', async () => {
  const zone = [[3.5, 2], [5.5, 2], [5.5, 4], [3.5, 4]];
  // A drone that flies 20% short: the first arrival is outside the zone, the correction gets in.
  const { d, sent, pose } = fakeDrone({ startX: 100, startY: 300 });
  d.execute = async (c) => { sent.push(c); if (c.action === 'go_to') { pose.x += (c.x - pose.x) * 0.8; pose.y += (c.y - pose.y) * 0.8; } return c.action === 'localize' ? { ok: false, error: 'not two landmarks' } : { ok: true }; };
  const said = [];
  const r = await missionGoTo('tello', d, { x: 450, y: 300, name: 'Zone 1', zone }, { plan, objects: [], people: () => [], decide: null, hoverMs: 1, onPlan: (t) => said.push(t), where: () => 'next to table 3' });
  assert.equal(r.insideZone, true, JSON.stringify(r));
  assert.ok(sent.some((c) => c.action === 'localize'));
  assert.match(said.at(-1), /I am inside Zone 1 \(by my position; the photo did not confirm it\)/);
});

test('a person inside the target zone does not stop the drone going there; one on the way for long stops it', async () => {
  const zone = [[3.5, 2], [5.5, 2], [5.5, 4], [3.5, 4]];
  const a = fakeDrone({ startX: 100, startY: 300 });
  const r = await missionGoTo('tello', a.d, { x: 450, y: 300, name: 'Zone 1', zone }, { plan, objects: [], people: () => [{ x: 4.5, y: 3 }], decide: null, hoverMs: 1 });
  assert.equal(r.insideZone, true, JSON.stringify(r));
  const b = fakeDrone({ startX: 100, startY: 300 });
  const r2 = await missionGoTo('tello', b.d, { x: 800, y: 300, name: 'x' }, { plan, objects: [], people: () => [{ x: 2.5, y: 3 }], decide: null, hoverMs: 1 });
  assert.match(r2.error, /person has been in the way/);
});
