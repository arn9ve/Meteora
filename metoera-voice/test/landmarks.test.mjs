import assert from 'node:assert/strict';
import test from 'node:test';
import { landmarksOf, expectedInView, solvePose, bearingOfX, parseSeen, localizePrompt } from '../src/landmarks.ts';

const plan = { height_m: 4.3, pillars: [-7.16, -2.36, 2.44, 7.24].map((x, i) => ({ id: `pillar-${i + 1}`, x, y: 0.937, w: 1.2, d: 0.7 })) };
const tables = [{ id: 't1', name: 'table 1', kind: 'table', x: 0.41, y: -0.66, w: 1.8, d: 1.8, heightM: 0.75 }];

test('what should be in view from a pose, with bearings (+ = right) and distances', () => {
  const lm = landmarksOf(plan, tables);
  assert.equal(lm.length, 5);
  // At (-4, 0.937) facing +x (0°): pillar 2 straight ahead 1.64 m, pillar 3 at 6.44 m; pillar 1 behind.
  const v = expectedInView(lm, { x: -4, y: 0.937, heading: 0 });
  assert.deepEqual(v.map((l) => l.id), ['pillar-2', 't1', 'pillar-3', 'pillar-4']); // nearest first, up to 12 m
  assert.ok(Math.abs(v[0].bearingDeg) < 0.01 && Math.abs(v[0].distanceM - 1.64) < 0.01);
  const t = v.find((l) => l.id === 't1'); // table 1 is ahead and to the right (lower y)
  assert.ok(t.bearingDeg > 0, String(t.bearingDeg));
  assert.ok(!v.some((l) => l.id === 'pillar-1'));
  assert.match(localizePrompt(v), /pillar-2: pillar 2, a rectangular concrete pillar/);
});

test('position from two bearings, or one bearing with a distance; nothing from one bearing alone', () => {
  const truth = { x: -4.5, y: -0.2 }, heading = 10;
  const obs = [[-2.36, 0.937], [0.41, -0.66], [2.44, 0.937]].map(([x, y]) => {
    const dir = Math.atan2(y - truth.y, x - truth.x) * 180 / Math.PI;
    return { x, y, bearingDeg: heading - dir, distanceM: null };
  });
  const p = solvePose(heading, obs);
  assert.ok(Math.abs(p.x - truth.x) < 1e-6 && Math.abs(p.y - truth.y) < 1e-6 && p.residualM < 1e-6, JSON.stringify(p));
  const one = solvePose(heading, [{ ...obs[0], distanceM: Math.hypot(-2.36 - truth.x, 0.937 - truth.y) }]);
  assert.ok(Math.abs(one.x - truth.x) < 1e-6 && Math.abs(one.y - truth.y) < 1e-6);
  assert.equal(solvePose(heading, [obs[0]]), null);
  assert.equal(Math.round(bearingOfX(0.5)), 0);
  assert.ok(Math.abs(bearingOfX(1) - 35) < 0.01 && bearingOfX(0) < -34.9); // the picture's edge: half the 70° horizontal view (distance.ts)
});

test('the model answer: only expected ids, x inside the picture', () => {
  const v = expectedInView(landmarksOf(plan, tables), { x: -4, y: 0.937, heading: 0 });
  assert.deepEqual(parseSeen('```json\n{"seen":[{"id":"pillar-2","x":0.48,"confidence":0.9},{"id":"pillar-9","x":0.3},{"id":"t1","x":1.7}],"note":"ok"}\n```', v), [{ id: 'pillar-2', x: 0.48, confidence: 0.9 }]);
  assert.equal(parseSeen('I see a pillar', v), null);
});
