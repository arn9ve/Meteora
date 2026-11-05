// The decision layer: during a flight to a target, a fast model picks the next step from a short
// menu, and the rules below check it before anything moves. The model only chooses; the server
// computes the route legs and the rules keep it safe. No answer in time = hover.

export type Choice =
  | { action: 'continue' }        // next leg of the route (computed by the server, at most 150 cm)
  | { action: 'hover' }           // stay, 1 s
  | { action: 'localize' }        // photo fix with the room plan
  | { action: 'look_around' }     // turn 360° on the spot: position from landmarks all around, people around
  | { action: 'climb'; cm: number }
  | { action: 'descend'; cm: number }
  | { action: 'turn'; deg: number } // + = right (clockwise)
  | { action: 'back' }            // back to the last point that was safe
  | { action: 'land' }
  | { action: 'done' };
export type DecisionState = {
  goal: string;
  remainingCm: number;
  nextLegCm: number;
  positionFrom: 'telemetry' | 'commands';
  checkedWithPhoto: boolean;     // a photo fix confirmed the position in this mission
  heightAboveFloorCm: number | null;
  surfaceBelowCm: number | null; // 0 floor, 75 table, null unsure
  ceilingCm: number;
  clearanceCm: number;           // to the nearest wall, pillar or table edge
  personOnPathM: number | null;  // a person seen by the phones near the next leg
  battery: number | null;
  haveSafePoint: boolean;
  lastSteps: { action: string; ok: boolean; note?: string }[];
  step: number;
  maxSteps: number;
};

export const MENU = ['continue', 'hover', 'localize', 'look_around', 'climb', 'descend', 'turn', 'back', 'land', 'done'] as const;

export function decisionPrompt(s: DecisionState): string {
  return `You fly a small indoor drone toward a target, one step at a time. Pick the next step.
State:
- goal: ${s.goal}; ${s.remainingCm} cm left; next route leg ${s.nextLegCm} cm (the route already avoids walls, pillars and tables)
- position from: ${s.positionFrom}${s.checkedWithPhoto ? ', checked with a photo' : ', not checked with a photo yet'}
- height above floor: ${s.heightAboveFloorCm ?? '?'} cm; below it: ${s.surfaceBelowCm === null ? 'unsure' : s.surfaceBelowCm === 0 ? 'floor' : `a table top at ${s.surfaceBelowCm} cm`}; ceiling ${s.ceilingCm} cm
- nearest wall/pillar/table: ${s.clearanceCm} cm
- person near the next leg: ${s.personOnPathM === null ? 'none seen' : `${s.personOnPathM.toFixed(1)} m from it`}
- battery: ${s.battery ?? '?'}%
- last steps: ${s.lastSteps.length ? s.lastSteps.map((l) => `${l.action} ${l.ok ? 'ok' : `failed${l.note ? ` (${l.note})` : ''}`}`).join('; ') : 'none'}
- step ${s.step} of at most ${s.maxSteps}
Menu: continue | hover | localize (one photo of the room to fix the position) | look_around (turn 360° on the spot: fixes the position from the pillars and tables in every direction and checks for people around; about 15 s) | climb N (cm) | descend N (cm) | turn N (degrees, + = right) | back (to the last safe point) | land | done.
Rules of thumb: continue when things look normal; look_around when the position comes only from commands and has never been checked with a photo, or when a localize just failed or saw too little; localize when a move failed or the drone cannot see the floor, never localize twice in a row; hover if a person is near the next leg; done when under 30 cm left.
Reply with ONLY JSON: {"action":"...","n":<number or null>,"reason":"<at most 10 words>"}`;
}

export function parseChoice(answer: string | null): { choice: Choice; reason: string } | null {
  if (!answer) return null;
  const m = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { action?: unknown; n?: unknown; reason?: unknown };
    const reason = typeof v.reason === 'string' ? v.reason.slice(0, 80) : '';
    const n = typeof v.n === 'number' && Number.isFinite(v.n) ? Math.round(v.n) : null;
    switch (v.action) {
      case 'continue': case 'hover': case 'localize': case 'look_around': case 'back': case 'land': case 'done': return { choice: { action: v.action }, reason };
      case 'climb': case 'descend': return n === null ? null : { choice: { action: v.action, cm: Math.abs(n) }, reason };
      case 'turn': return n === null ? null : { choice: { action: 'turn', deg: n }, reason };
      default: return null;
    }
  } catch { return null; }
}

/** What to do without the model (no key, no answer in time, nonsense answer). */
export function ruleChoice(s: DecisionState): Choice {
  if (s.battery !== null && s.battery <= 12) return { action: 'land' };
  if (s.remainingCm < 30) return { action: 'done' };
  if (s.personOnPathM !== null && s.personOnPathM < 1) return { action: 'hover' };
  const failed = s.lastSteps.slice(-1)[0];
  // One photo saw too little: look all around instead of asking again.
  if (failed && !failed.ok && failed.action === 'localize') return { action: 'look_around' };
  // A position that was never checked, and that comes only from commands: one photo often sees a single pillar.
  if (!s.checkedWithPhoto && s.positionFrom === 'commands' && failed?.action !== 'look_around') return { action: 'look_around' };
  if (!s.checkedWithPhoto && failed && !failed.ok && !['localize', 'look_around'].includes(failed.action)) return { action: 'localize' };
  return { action: 'continue' };
}

/**
 * The rules every choice must pass. Returns what will really be done and, when it differs, why.
 * Hard limits: battery, ceiling, floor and table tops, people on the path, turn size.
 */
export function checkChoice(c: Choice, s: DecisionState): { choice: Choice; overruled: string | null } {
  const keep = (choice: Choice) => ({ choice, overruled: null });
  const hover = (why: string) => ({ choice: { action: 'hover' } as Choice, overruled: why });
  if (s.battery !== null && s.battery <= 12 && c.action !== 'land') return { choice: s.surfaceBelowCm === null ? { action: 'hover' } : { action: 'land' }, overruled: `battery ${s.battery}%: landing` };
  switch (c.action) {
    case 'continue':
      if (s.personOnPathM !== null && s.personOnPathM < 1) return hover('a person is on the next leg');
      if (s.nextLegCm <= 0) return { choice: { action: 'done' }, overruled: 'no leg left' };
      return keep(c);
    case 'done':
      return s.remainingCm <= 60 ? keep(c) : hover(`not there yet (${s.remainingCm} cm left)`);
    case 'climb': {
      const room = Math.min(250, s.ceilingCm - 80) - (s.heightAboveFloorCm ?? 9999);
      if (room < 20) return hover('no room to climb');
      return keep({ action: 'climb', cm: Math.max(20, Math.min(c.cm, room, 80)) });
    }
    case 'descend': {
      const floor = Math.max(60, (s.surfaceBelowCm ?? 75) + 50);
      const room = (s.heightAboveFloorCm ?? 0) - floor;
      if (room < 20) return hover('too low to descend');
      return keep({ action: 'descend', cm: Math.max(20, Math.min(c.cm, room, 80)) });
    }
    case 'turn': {
      const deg = Math.max(-90, Math.min(90, c.deg));
      return Math.abs(deg) < 5 ? hover('turn too small') : keep({ action: 'turn', deg });
    }
    case 'back':
      return s.haveSafePoint ? keep(c) : hover('no safe point yet');
    case 'land':
      return s.surfaceBelowCm === null ? hover('not sure what is below: not landing on an edge') : keep(c);
    case 'localize': {
      // A photo check that just failed is not asked again: look all around instead.
      const last = s.lastSteps.slice(-1)[0];
      return last && !last.ok && (last.action === 'localize' || last.action === 'look_around')
        ? { choice: { action: 'look_around' }, overruled: 'the last position check failed: looking all around instead' }
        : keep(c);
    }
    default:
      return keep(c);
  }
}
