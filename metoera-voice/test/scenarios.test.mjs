import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreScenario } from '../tools/scenarios.mjs';

const quiet = { wouldHit: [], near: [], flying: [], selfLanded: false, commands: [], decisions: [], sim: [], fixes: [] };

test('a clean landing next to the table passes, a would-hit or a blind ending does not', () => {
  const scenario = { expect: { endNear: { drone: 'tello', x: 1, y: 2, withinM: 1 }, maxSeconds: 100, maxDecisionSteps: 10 } };
  const sim = [{ kind: 'state', drone: 'tello', x: 1.2, y: 2.1, flying: false }];
  assert.deepEqual(scoreScenario(scenario, { ...quiet, sim, decisions: [{}, {}] }, 40), []);
  assert.ok(scoreScenario(scenario, { ...quiet, sim, wouldHit: [{ kind: 'would_hit' }] }, 40).includes('would-hit'));
  assert.ok(scoreScenario(scenario, { ...quiet, sim: [{ kind: 'state', drone: 'tello', x: 5, y: 5, flying: false }] }, 40).some((f) => f.startsWith('ended')));
});

test('a position fix is compared with the simulator, and a refused move can be required', () => {
  const scenario = { expect: { fixWithinM: { drone: 'rmtt', withinM: 0.3 }, refused: ['move'] } };
  const report = { ...quiet, commands: [{ action: 'move', ok: false }], sim: [{ kind: 'state', drone: 'rmtt', x: 5.4, y: -1.3 }], fixes: [{ ok: true, to: { x: 545, y: -125 } }] };
  assert.deepEqual(scoreScenario(scenario, report, 10), []);
  assert.ok(scoreScenario(scenario, { ...report, fixes: [{ ok: true, to: { x: 800, y: 0 } }] }, 10).some((f) => f.startsWith('position fix')));
});
