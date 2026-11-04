/**
 * Pad navigation config + cam1→Black mission state machine.
 * No LiDAR — physical pads are room positions. Flight stays ARM-gated in server.mjs.
 *
 * Default: armed intrusion only *triggers* a mission. The voice UI (named pilot) claims
 * and runs steps so Black stays under that person for return-home commands. Direct
 * execution via runPadMission is available for tests (PAD_NAV_DIRECT=1).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, 'pad-nav.json');

/** @type {object | null} */
let cached = null;

/**
 * Live mission state for cam1 Black hop.
 * phases: idle | triggered | claimed | outbound | awaiting_command | returning | landed | hovering_home | failed
 * @type {{
 *   phase: string,
 *   eventId: string | null,
 *   missionKey: string | null,
 *   mission: object | null,
 *   claimedBy: string | null,
 *   report: string | null,
 *   reportId: string | null,
 *   at: string | null,
 *   updatedAt: string | null,
 *   note: string | null,
 *   lastError: string | null,
 * }}
 */
let missionState = emptyMissionState();

function emptyMissionState() {
  return {
    phase: 'idle',
    eventId: null,
    missionKey: null,
    mission: null,
    claimedBy: null,
    report: null,
    reportId: null,
    at: null,
    updatedAt: null,
    note: null,
    lastError: null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export async function loadPadNav(force = false) {
  if (cached && !force) return cached;
  const raw = await readFile(configPath, 'utf8');
  cached = JSON.parse(raw);
  return cached;
}

export function getMissionState() {
  return { ...missionState, mission: missionState.mission ? { ...missionState.mission } : null };
}

export function resetMissionState() {
  missionState = emptyMissionState();
  return getMissionState();
}

export function missionForSlot(config, slotId) {
  const missions = config?.missions ?? {};
  for (const key of Object.keys(missions)) {
    const m = missions[key];
    if (String(m.slotId) === String(slotId)) return { key, mission: m };
  }
  return null;
}

/**
 * Build the structured mission payload logged on intrusion.
 * Path steps after takeoff only execute when mission.executePath is true
 * (or PAD_NAV_EXECUTE_PATH=1). Distance for this test: 200 cm pad-01→pad-02.
 */
export function buildMissionEvent(config, slotId) {
  const hit = missionForSlot(config, slotId);
  if (!hit) {
    return {
      kind: 'takeoff-only',
      summary: `Slot ${slotId}: takeoff (no pad mission mapped)`,
      drone: 'Black',
      droneId: 'tello',
      homePad: null,
      targetPad: null,
      distanceCm: null,
      steps: [{ action: 'takeoff' }],
      executePath: false,
      commands: null,
      describeQuestion: null,
    };
  }
  const m = hit.mission;
  const envForce = process.env.PAD_NAV_EXECUTE_PATH === '1';
  const describeQuestion =
    typeof m.describeQuestion === 'string' && m.describeQuestion.trim()
      ? m.describeQuestion.trim()
      : 'Briefly describe the scene: people, objects, left/centre/right. Two short sentences.';
  const steps = Array.isArray(m.path) ? m.path.map((step) => {
    if (step?.action === 'describe' && !step.question) return { ...step, question: describeQuestion };
    return step;
  }) : [{ action: 'takeoff' }];
  return {
    kind: 'pad-to-pad',
    missionKey: hit.key,
    summary: m.summary,
    drone: m.drone,
    droneId: m.droneId || 'tello',
    homePad: m.homePad,
    targetPad: m.targetPad,
    distanceCm: typeof m.distanceCm === 'number' ? m.distanceCm : null,
    steps,
    executePath: Boolean(m.executePath) || envForce,
    commands: m.commands ?? null,
    describeQuestion,
  };
}

/** Record an armed cam1 intrusion so the voice UI can claim and fly. */
export function triggerMission(eventId, mission) {
  missionState = {
    phase: 'triggered',
    eventId: String(eventId),
    missionKey: mission.missionKey ?? null,
    mission,
    claimedBy: null,
    report: null,
    reportId: null,
    at: nowIso(),
    updatedAt: nowIso(),
    note: 'ARM trigger recorded. Voice UI (named pilot) should claim and fly Black.',
    lastError: null,
  };
  return getMissionState();
}

/**
 * Voice UI claims a triggered mission. Only one claim wins.
 * @param {string} claimedBy display name or session label
 * @param {string} [eventId] optional; must match if provided
 */
export function claimMission(claimedBy, eventId) {
  if (missionState.phase !== 'triggered') {
    return { ok: false, error: `Nothing to claim (phase=${missionState.phase})`, state: getMissionState() };
  }
  if (eventId && missionState.eventId && String(eventId) !== String(missionState.eventId)) {
    return { ok: false, error: 'eventId mismatch', state: getMissionState() };
  }
  const who = typeof claimedBy === 'string' && claimedBy.trim() ? claimedBy.trim().slice(0, 40) : 'voice-ui';
  missionState = {
    ...missionState,
    phase: 'claimed',
    claimedBy: who,
    updatedAt: nowIso(),
    note: `${who} claimed the pad mission.`,
  };
  return { ok: true, state: getMissionState(), mission: missionState.mission };
}

const PHASES = new Set([
  'idle',
  'triggered',
  'claimed',
  'outbound',
  'awaiting_command',
  'returning',
  'landed',
  'hovering_home',
  'failed',
]);

/**
 * Voice UI / runner updates phase and optional Grok describe report.
 */
export function updateMissionPhase(phase, extra = {}) {
  if (!PHASES.has(phase)) return { ok: false, error: `Unknown phase ${phase}`, state: getMissionState() };
  const report = typeof extra.report === 'string' ? extra.report.slice(0, 1200) : missionState.report;
  const reportId =
    typeof extra.report === 'string' && extra.report
      ? `${missionState.eventId || 'pad'}-${Date.now().toString(36)}`
      : missionState.reportId;
  missionState = {
    ...missionState,
    phase,
    report,
    reportId,
    updatedAt: nowIso(),
    note: typeof extra.note === 'string' ? extra.note.slice(0, 400) : missionState.note,
    lastError: typeof extra.error === 'string' ? extra.error.slice(0, 400) : phase === 'failed' ? missionState.lastError : null,
  };
  return { ok: true, state: getMissionState() };
}

export function commandSteps(mission, command) {
  const cmds = mission?.commands ?? {};
  const hit = cmds[command];
  if (!hit) return null;
  return {
    command,
    summary: hit.summary ?? command,
    steps: Array.isArray(hit.steps) ? hit.steps : [],
  };
}

export async function sendVoiceCommand(voiceUrl, body) {
  const response = await fetch(`${voiceUrl}/api/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: voiceUrl.includes('127.0.0.1') ? 'http://127.0.0.1:18787' : 'http://localhost:18787',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(body?.action === 'describe' ? 45_000 : 30_000),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok && json?.ok !== false, status: response.status, body: json };
}

async function runStep(voiceUrl, droneId, step) {
  const action = step.action;
  if (action === 'wait') {
    return { step, ok: true, waited: true, note: step.note || 'Waiting for next command (no auto-land).' };
  }
  if (action === 'takeoff') {
    return { step, ...(await sendVoiceCommand(voiceUrl, { droneId, action: 'takeoff' })) };
  }
  if (action === 'move') {
    return {
      step,
      ...(await sendVoiceCommand(voiceUrl, {
        droneId,
        action: 'move',
        direction: step.direction,
        centimeters: step.centimeters,
      })),
    };
  }
  if (action === 'rotate') {
    return {
      step,
      ...(await sendVoiceCommand(voiceUrl, {
        droneId,
        action: 'rotate',
        direction: step.direction,
        degrees: step.degrees,
      })),
    };
  }
  if (action === 'go_to') {
    return {
      step,
      ...(await sendVoiceCommand(voiceUrl, {
        droneId,
        action: 'go_to',
        place: step.place || 'home',
      })),
    };
  }
  if (action === 'describe') {
    const question =
      typeof step.question === 'string' && step.question.trim()
        ? step.question.trim()
        : 'Briefly describe the scene: people, objects, left/centre/right. Two short sentences.';
    const r = await sendVoiceCommand(voiceUrl, { droneId, action: 'describe', question });
    return { step, ...r, report: typeof r.body?.answer === 'string' ? r.body.answer : null };
  }
  if (action === 'land') {
    return { step, ...(await sendVoiceCommand(voiceUrl, { droneId, action: 'land' })) };
  }
  return { step, ok: false, note: `Unknown action ${action}` };
}

/**
 * Run mission steps against metoera-voice (direct / test path).
 * Always attempts takeoff first when present. Later move/describe/wait run only if executePath.
 * Does not auto-land after describe — ends in wait / awaiting_command.
 */
export async function runPadMission(voiceUrl, mission) {
  const results = [];
  const droneId = mission.droneId || 'tello';
  const steps = mission.steps?.length ? mission.steps : [{ action: 'takeoff' }];
  let report = null;

  updateMissionPhase('outbound', { note: 'Direct pad mission running.' });

  for (const step of steps) {
    const action = step.action;
    if (action === 'takeoff') {
      const r = await runStep(voiceUrl, droneId, step);
      results.push(r);
      if (!r.ok) {
        updateMissionPhase('failed', { error: r.body?.error || r.note || 'takeoff failed' });
        break;
      }
      continue;
    }
    if (!mission.executePath) {
      results.push({
        step,
        ok: true,
        skipped: true,
        note: 'Path step logged only (executePath=false). Set pad-nav.json executePath or PAD_NAV_EXECUTE_PATH=1 after confirming the 2.0 m heading.',
      });
      continue;
    }
    const r = await runStep(voiceUrl, droneId, step);
    results.push(r);
    if (r.report) report = r.report;
    if (!r.ok) {
      updateMissionPhase('failed', { error: r.body?.error || r.note || `${action} failed` });
      break;
    }
    if (action === 'wait') {
      updateMissionPhase('awaiting_command', {
        report: report || undefined,
        note: 'At target (or path complete). Waiting for return-home-land or go-home-wait.',
      });
    }
  }

  const takeoff = results.find((r) => r.step?.action === 'takeoff');
  const endedWait = results.some((r) => r.step?.action === 'wait' && r.waited && !r.skipped);
  if (mission.executePath && endedWait && missionState.phase === 'outbound') {
    updateMissionPhase('awaiting_command', {
      report: report || undefined,
      note: 'Path finished; awaiting voice command.',
    });
  } else if (!mission.executePath && takeoff?.ok) {
    updateMissionPhase('awaiting_command', {
      note: 'Takeoff done; path deferred (executePath=false). Enable path for pad-01→pad-02 hop + describe.',
    });
  }

  return {
    attempted: true,
    mission,
    steps: results,
    report,
    state: getMissionState(),
    voice: takeoff
      ? { ok: takeoff.ok, status: takeoff.status, body: takeoff.body }
      : { ok: false, error: 'No takeoff step' },
    note: mission.executePath
      ? endedWait
        ? 'Arrived (or path ran); hovering — no auto-land. Use return-home-land or go-home-wait.'
        : null
      : 'Takeoff attempted; path steps deferred until executePath is enabled.',
  };
}

/**
 * Run a post-arrival command (return-home-land | go-home-wait) via voice API.
 * Prefer running these from the voice UI under the named pilot; this is for direct/tests.
 */
export async function runPadCommand(voiceUrl, command, mission = missionState.mission) {
  const plan = commandSteps(mission, command);
  if (!plan) return { ok: false, error: `Unknown command ${command}` };
  if (!['awaiting_command', 'hovering_home', 'claimed', 'outbound'].includes(missionState.phase) && missionState.phase !== 'idle') {
    // Allow from awaiting_command / hovering_home primarily; still run if idle with explicit mission.
  }
  updateMissionPhase('returning', { note: `Running ${command}` });
  const droneId = mission?.droneId || 'tello';
  const results = [];
  for (const step of plan.steps) {
    if (!mission?.executePath && step.action !== 'land' && step.action !== 'wait' && process.env.PAD_NAV_EXECUTE_PATH !== '1') {
      // Return moves also need path enabled (same 2 m). Land alone is always attempted.
      if (step.action === 'go_to' || step.action === 'move') {
        results.push({
          step,
          ok: true,
          skipped: true,
          note: 'Return path skipped (executePath=false).',
        });
        continue;
      }
    }
    const r = await runStep(voiceUrl, droneId, step);
    results.push(r);
    if (!r.ok) {
      updateMissionPhase('failed', { error: r.body?.error || r.note || `${command} failed` });
      return { ok: false, command, steps: results, state: getMissionState() };
    }
  }
  if (command === 'return-home-land') {
    updateMissionPhase('landed', { note: 'Returned to pad-01 and landed.' });
  } else if (command === 'go-home-wait') {
    updateMissionPhase('hovering_home', { note: 'Back at pad-01; hovering, waiting for next command.' });
  }
  return { ok: true, command, summary: plan.summary, steps: results, state: getMissionState() };
}
