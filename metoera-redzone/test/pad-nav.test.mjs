import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMissionEvent,
  claimMission,
  commandSteps,
  getMissionState,
  loadPadNav,
  missionForSlot,
  resetMissionState,
  triggerMission,
  updateMissionPhase,
} from '../pad-nav.mjs';

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('pad-nav maps cam1 to Black pad-01 → pad-02 (2.0 m, describe, wait)', async () => {
  resetMissionState();
  const config = await loadPadNav(true);
  assert.equal(config.missions.cam1.homePad, 'pad-01');
  assert.equal(config.missions.cam1.targetPad, 'pad-02');
  assert.equal(config.missions.cam1.droneId, 'tello');
  assert.equal(config.missions.cam1.distanceCm, 200);
  assert.equal(config.missions.cam1.executePath, false);
  assert.equal(missionForSlot(config, '1')?.key, 'cam1');
  assert.equal(missionForSlot(config, '2'), null);

  const mission = buildMissionEvent(config, '1');
  assert.equal(mission.kind, 'pad-to-pad');
  assert.equal(mission.homePad, 'pad-01');
  assert.equal(mission.targetPad, 'pad-02');
  assert.equal(mission.distanceCm, 200);
  assert.equal(mission.executePath, false);
  assert.ok(mission.steps.some((s) => s.action === 'takeoff'));
  assert.ok(mission.steps.some((s) => s.action === 'move' && s.centimeters === 200));
  assert.ok(mission.steps.some((s) => s.action === 'describe'));
  assert.ok(mission.steps.some((s) => s.action === 'wait'));
  assert.ok(!mission.steps.some((s) => s.action === 'land'));
  assert.ok(commandSteps(mission, 'return-home-land')?.steps.some((s) => s.action === 'land'));
  assert.ok(commandSteps(mission, 'go-home-wait')?.steps.some((s) => s.action === 'go_to'));
});

test('mission state: trigger → claim → awaiting_command with report', () => {
  resetMissionState();
  const mission = {
    kind: 'pad-to-pad',
    missionKey: 'cam1',
    droneId: 'tello',
    homePad: 'pad-01',
    targetPad: 'pad-02',
    steps: [{ action: 'takeoff' }],
    executePath: true,
  };
  triggerMission('evt-1', mission);
  assert.equal(getMissionState().phase, 'triggered');

  const claimed = claimMission('Masoud', 'evt-1');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.state.phase, 'claimed');
  assert.equal(claimed.state.claimedBy, 'Masoud');

  const again = claimMission('Other', 'evt-1');
  assert.equal(again.ok, false);

  updateMissionPhase('awaiting_command', { report: 'A person in a blue shirt, centre.' });
  const state = getMissionState();
  assert.equal(state.phase, 'awaiting_command');
  assert.match(state.report, /blue shirt/);
  assert.ok(state.reportId);
});

async function withServer(fn) {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      REDZONE_PORT: String(port),
      REDZONE_PHONE_PORT: String(port + 1),
      PHONE_ACCESS: 'off',
      REDZONE_DEBOUNCE_MS: '5000',
      // Point at a closed port so takeoff fails fast without hanging the test.
      METOERA_VOICE_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ready = false;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* wait */
    }
    await sleep(100);
  }
  assert.equal(ready, true, 'server should start');

  try {
    await fn(port);
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

test('armed slot-1 intrusion triggers pad mission for voice UI claim (ARM still required)', async () => {
  await withServer(async (port) => {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.padNav.homePad, 'pad-01');
    assert.equal(health.padNav.targetPad, 'pad-02');
    assert.equal(health.padNav.distanceCm, 200);

    const padNav = await (await fetch(`http://127.0.0.1:${port}/api/pad-nav`)).json();
    assert.equal(padNav.missions.cam1.drone, 'Black');
    assert.equal(padNav.state.phase, 'idle');

    const joined = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Pad nav phone' }),
      })
    ).json();
    const token = joined.token;

    const disarmed = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, score: 0.9, note: 'disarmed-check', force: true }),
      })
    ).json();
    assert.equal(disarmed.event.takeoff.reason, 'disarmed');

    await fetch(`http://127.0.0.1:${port}/api/slots/1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { type: 'arm', armed: true } }),
    });

    const armed = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, score: 0.91, note: 'armed-pad-mission', force: true }),
      })
    ).json();
    assert.equal(armed.accepted, true);
    assert.equal(armed.event.takeoff.attempted, true);
    assert.equal(armed.event.takeoff.deferred, true);
    assert.equal(armed.event.takeoff.mission.homePad, 'pad-01');
    assert.equal(armed.event.takeoff.mission.targetPad, 'pad-02');
    assert.equal(armed.event.takeoff.mission.drone, 'Black');
    assert.equal(armed.event.takeoff.mission.distanceCm, 200);
    assert.match(armed.event.takeoff.mission.summary, /pad-01.*pad-02/i);

    const after = await (await fetch(`http://127.0.0.1:${port}/api/pad-nav`)).json();
    assert.equal(after.state.phase, 'triggered');

    const claim = await (
      await fetch(`http://127.0.0.1:${port}/api/pad-nav/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimedBy: 'Masoud', eventId: after.state.eventId }),
      })
    ).json();
    assert.equal(claim.ok, true);
    assert.equal(claim.state.phase, 'claimed');

    const phase = await (
      await fetch(`http://127.0.0.1:${port}/api/pad-nav/phase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'awaiting_command', report: 'Desk and chair, centre.' }),
      })
    ).json();
    assert.equal(phase.ok, true);
    assert.equal(phase.state.phase, 'awaiting_command');
    assert.match(phase.state.report, /Desk/);
  });
});
