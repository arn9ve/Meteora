/**
 * Pad navigation config + Black mission builder for redzone cam1.
 * No LiDAR — physical pads are room positions. Flight stays ARM-gated in server.mjs.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const configPath = join(root, 'pad-nav.json');

/** @type {object | null} */
let cached = null;

export async function loadPadNav(force = false) {
  if (cached && !force) return cached;
  const raw = await readFile(configPath, 'utf8');
  cached = JSON.parse(raw);
  return cached;
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
 * (or PAD_NAV_EXECUTE_PATH=1). Distances in pad-nav.json are placeholders until measured.
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
      steps: [{ action: 'takeoff' }],
      executePath: false,
    };
  }
  const m = hit.mission;
  const envForce = process.env.PAD_NAV_EXECUTE_PATH === '1';
  return {
    kind: 'pad-to-pad',
    missionKey: hit.key,
    summary: m.summary,
    drone: m.drone,
    droneId: m.droneId || 'tello',
    homePad: m.homePad,
    targetPad: m.targetPad,
    steps: Array.isArray(m.path) ? m.path : [{ action: 'takeoff' }],
    executePath: Boolean(m.executePath) || envForce,
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
    signal: AbortSignal.timeout(20_000),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok && json?.ok !== false, status: response.status, body: json };
}

/**
 * Run mission steps against metoera-voice.
 * Always attempts takeoff first when present. Later move/land steps run only if executePath.
 */
export async function runPadMission(voiceUrl, mission) {
  const results = [];
  const droneId = mission.droneId || 'tello';
  const steps = mission.steps?.length ? mission.steps : [{ action: 'takeoff' }];

  for (const step of steps) {
    const action = step.action;
    if (action === 'takeoff') {
      const r = await sendVoiceCommand(voiceUrl, { droneId, action: 'takeoff' });
      results.push({ step, ...r });
      if (!r.ok) break;
      continue;
    }
    if (!mission.executePath) {
      results.push({
        step,
        ok: true,
        skipped: true,
        note: 'Path step logged only (executePath=false). Set pad-nav.json executePath or PAD_NAV_EXECUTE_PATH=1 after measuring distances.',
      });
      continue;
    }
    if (action === 'move') {
      const r = await sendVoiceCommand(voiceUrl, {
        droneId,
        action: 'move',
        direction: step.direction,
        centimeters: step.centimeters,
      });
      results.push({ step, ...r });
      if (!r.ok) break;
      continue;
    }
    if (action === 'rotate') {
      const r = await sendVoiceCommand(voiceUrl, {
        droneId,
        action: 'rotate',
        direction: step.direction,
        degrees: step.degrees,
      });
      results.push({ step, ...r });
      if (!r.ok) break;
      continue;
    }
    if (action === 'land') {
      const r = await sendVoiceCommand(voiceUrl, { droneId, action: 'land' });
      results.push({ step, ...r });
      if (!r.ok) break;
      continue;
    }
    results.push({ step, ok: false, note: `Unknown action ${action}` });
    break;
  }

  const takeoff = results.find((r) => r.step?.action === 'takeoff');
  return {
    attempted: true,
    mission,
    steps: results,
    voice: takeoff
      ? { ok: takeoff.ok, status: takeoff.status, body: takeoff.body }
      : { ok: false, error: 'No takeoff step' },
    note: mission.executePath
      ? null
      : 'Takeoff attempted; path steps deferred until executePath is enabled and distances are measured.',
  };
}
