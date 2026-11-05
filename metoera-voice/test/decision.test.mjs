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
function fakeDrone({ startX = 0, startY = 0 } = {}) {
  const pose = { x: startX, y: startY, heading: 0, zFloor: 150 };
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

test('mission: legs of at most 150 cm along the route around the table, model choices logged', async () => {
  const { d, sent, pose } = fakeDrone({ startX: 100, startY: 300 });
  const steps = [];
  const r = await missionGoTo('tello', d, { x: 900, y: 300, name: 'far wall' }, { plan, objects: [table], people: () => [], decide: async () => '{"action":"continue","n":null,"reason":"all normal"}', onStep: (s) => steps.push(s), hoverMs: 1 });
  assert.equal(r.ok, true, r.error);
  assert.ok(Math.hypot(pose.x - 900, pose.y - 300) < 30, JSON.stringify(pose));
  let at = [100, 300];
  for (const c of sent.filter((c) => c.action === 'go_to')) {
    assert.ok(Math.hypot(c.x - at[0], c.y - at[1]) <= 151, `leg too long: ${JSON.stringify(c)}`);
    assert.equal(c.check, false);
    for (let t = 0; t <= 1; t += 0.05) { const x = (at[0] + (c.x - at[0]) * t) / 100, y = (at[1] + (c.y - at[1]) * t) / 100; assert.ok(Math.abs(x - 5) > 0.9 || Math.abs(y - 3) > 0.9, 'through the table'); }
    at = [c.x, c.y];
  }
  assert.ok(steps.every((s) => s.by === 'model' || s.action === 'done'));
});

test('mission: a slow model means hover; a person on the path means hover; stop ends it', async () => {
  const slow = fakeDrone();
  let calls = 0;
  const r1 = await missionGoTo('tello', slow.d, { x: 300, y: 300, name: 'x' }, { plan, objects: [], people: () => [], decide: () => { calls += 1; return new Promise((res) => setTimeout(() => res('{"action":"continue"}'), 200)); }, timeoutMs: 20, hoverMs: 1, maxSteps: 3 });
  assert.equal(r1.ok, false); assert.deepEqual(r1.choices, ['hover', 'hover', 'hover']); assert.equal(slow.sent.length, 0);
  const crowd = fakeDrone({ startX: 100, startY: 100 });
  const r2 = await missionGoTo('tello', crowd.d, { x: 400, y: 100, name: 'x' }, { plan, objects: [], people: () => [{ x: 1.8, y: 1.1 }], decide: async () => '{"action":"continue"}', hoverMs: 1, maxSteps: 2 });
  assert.deepEqual(r2.choices, ['hover', 'hover']);
  const stopped = fakeDrone({ startX: 100, startY: 100 });
  let n = 0;
  const r3 = await missionGoTo('tello', stopped.d, { x: 900, y: 100, name: 'x' }, { plan, objects: [], people: () => [], decide: async () => { if (++n === 2) stopped.d.generation += 1; return '{"action":"continue"}'; }, hoverMs: 1 });
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
