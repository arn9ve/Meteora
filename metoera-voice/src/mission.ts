// A flight to a target driven step by step by the decision layer (decision.ts): build the state,
// ask the model (1.5 s at most, otherwise the rules choose), check the choice, do it, repeat.
// The route legs come from the room plan (planRoute), never from the model.
import { checkChoice, decisionPrompt, parseChoice, ruleChoice, type Choice, type DecisionState } from './decision.ts';
import { clearanceAt, planRoute, surfaceHeightAt, type Point, type RoomObject } from './room.ts';

type Plan = Parameters<typeof planRoute>[0] & { height_m?: number };
type Result = { ok: boolean; error?: string; [k: string]: unknown };
export type MissionDrone = {
  execute(command: Record<string, unknown>): Promise<Result>;
  forceLand(): Promise<Result>;
  live(): { flying: boolean; pose: { x: number; y: number; heading: number; zFloor: number }; source: 'telemetry' | 'commands'; startSurface: { heightCm: number } };
  snapshot(): { battery: number | null; heightAboveFloorCm: number | null };
  readonly generation: number;
};
export type MissionDeps = {
  plan: Plan;
  objects: RoomObject[];
  /** People seen by the phones now (m). */
  people(): { x: number; y: number }[];
  /** The model; null = not configured (rules only). */
  decide: ((prompt: string) => Promise<string | null>) | null;
  log?: (event: Record<string, unknown>) => void;
  onStep?: (info: { step: number; action: string; reason: string; by: 'model' | 'rules' | 'timeout'; overruled: string | null; ms: number }) => void;
  timeoutMs?: number;
  hoverMs?: number;
  maxSteps?: number;
};

const LEG_CM = 300; // the Tello's own go accepts up to 500 cm; it flies them with its own sensors
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function segPointDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Flies `droneId` to `target` (room cm). Ends when there, landed, stopped from outside, or out of steps. */
export async function missionGoTo(droneId: string, drone: MissionDrone, target: { x: number; y: number; name: string; pad?: number; minHeightCm?: number }, deps: MissionDeps): Promise<Result> {
  const maxSteps = deps.maxSteps ?? 30, timeoutMs = deps.timeoutMs ?? 1500;
  if (!drone.live().flying) return { ok: false, error: 'Take off first' };
  const generation = drone.generation;
  const lastSteps: DecisionState['lastSteps'] = [];
  let safe: Point | null = null, checked = false, stuck = 0;
  const choices: string[] = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    if (drone.generation !== generation) return { ok: false, error: 'Mission stopped (stop, land or emergency)', steps: step - 1, choices };
    const live = drone.live(), at: Point = [live.pose.x / 100, live.pose.y / 100];
    const remainingCm = Math.round(Math.hypot(target.x - live.pose.x, target.y - live.pose.y));
    // Tables are obstacles only when the drone flies lower than 50 cm above them; pillars and walls always.
    const blocking = blockingAt(deps.objects, live.pose.zFloor);
    const route = planRoute(deps.plan, blocking, at, [target.x / 100, target.y / 100]);
    // The first route point at least 30 cm away (closer ones are skipped: too short to fly).
    const next: Point | null = route && route.length ? (route.find((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) >= 0.3) ?? route[route.length - 1]) : null;
    // A leg goes to that point, at most 150 cm (under 20 cm the drone would not move at all).
    const legEnd: Point | null = next ? (() => { const d = Math.hypot(next[0] - at[0], next[1] - at[1]); if (d < 0.2) return null; const k = Math.min(1, (LEG_CM / 100) / d); return [at[0] + (next[0] - at[0]) * k, at[1] + (next[1] - at[1]) * k] as Point; })() : null;
    const nearPerson = legEnd ? deps.people().reduce<number | null>((best, p) => { const d = segPointDist([p.x, p.y], at, legEnd); return best === null || d < best ? d : best; }, null) : null;
    const snap = drone.snapshot();
    const state: DecisionState = {
      goal: target.name, remainingCm, nextLegCm: legEnd ? Math.round(Math.hypot(legEnd[0] - at[0], legEnd[1] - at[1]) * 100) : 0,
      positionFrom: live.source, checkedWithPhoto: checked,
      heightAboveFloorCm: snap.heightAboveFloorCm, surfaceBelowCm: surfaceHeightAt(deps.objects, at[0], at[1]),
      ceilingCm: Math.round((deps.plan.height_m ?? 4.3) * 100), clearanceCm: Math.round(clearanceAt(deps.plan, deps.objects, at) * 100),
      personOnPathM: nearPerson !== null && nearPerson < 2 ? nearPerson : null,
      battery: snap.battery, haveSafePoint: safe !== null, lastSteps: lastSteps.slice(-4), step, maxSteps,
    };
    if (!route && remainingCm >= 30) return { ok: false, error: 'No safe way to the target from here', steps: step - 1, choices };
    // A table with a mission pad: once the route has reached its edge, climb over the table, fly to
    // the centre and centre exactly over the pad (the drone's own sensor). Nothing for the model to decide.
    if (target.pad && (state.nextLegCm < 20 || remainingCm < 30)) {
      deps.onStep?.({ step, action: `over ${target.name}, centre on pad ${target.pad}`, reason: 'final approach', by: 'rules', overruled: null, ms: 0 });
      const r = await drone.execute({ droneId, action: 'go_to', x: target.x, y: target.y, pad: target.pad, check: false, ...(target.minHeightCm ? { minHeightCm: target.minHeightCm } : {}) });
      deps.log?.({ event: 'decision', step, by: 'rules', did: { action: 'pad_final', pad: target.pad }, ok: r.ok, error: r.error });
      return { ...r, action: 'go_to', reached: r.ok, padCentred: r.ok, steps: step, choices: [...choices, `pad ${target.pad}`] };
    }
    // Ask the model; the rules answer if it is not configured, too slow, or makes no sense.
    const t0 = Date.now();
    let by: 'model' | 'rules' | 'timeout' = 'rules', reason = 'on the way', choice: Choice = ruleChoice(state);
    // The normal case needs nobody to think: distance and direction come from the plan. The model is
    // asked only when something is off: a failed or useless step, a person on the leg, low battery.
    const last = state.lastSteps[state.lastSteps.length - 1];
    const trouble = (last && !last.ok) || state.personOnPathM !== null || (state.battery !== null && state.battery <= 20);
    if (deps.decide && trouble) {
      const answer = await Promise.race([deps.decide(decisionPrompt(state)).catch(() => null), sleep(timeoutMs).then(() => 'timeout' as const)]);
      if (answer === 'timeout') { by = 'timeout'; choice = { action: 'hover' }; reason = `no answer in ${timeoutMs} ms`; }
      else { const parsed = parseChoice(answer); if (parsed) { by = 'model'; choice = parsed.choice; reason = parsed.reason; } }
    }
    const checkedChoice = checkChoice(choice, state);
    const ms = Date.now() - t0;
    const c = checkedChoice.choice;
    const label = c.action + ('cm' in c ? ` ${c.cm}` : 'deg' in c ? ` ${c.deg}` : '');
    choices.push(label);
    deps.onStep?.({ step, action: label, reason, by, overruled: checkedChoice.overruled, ms });
    deps.log?.({ event: 'decision', step, by, asked: choice, did: c, overruled: checkedChoice.overruled, reason, ms, remainingCm, positionFrom: live.source });
    if (drone.generation !== generation) return { ok: false, error: 'Mission stopped (stop, land or emergency)', steps: step, choices };
    let r: Result;
    switch (c.action) {
      case 'done': return { ok: true, action: 'go_to', reached: true, remainingCm, steps: step, choices, checkedWithPhoto: checked };
      case 'land': r = await drone.forceLand(); return { ...r, action: 'go_to', reached: false, landed: true, steps: step, choices };
      case 'hover': await sleep(deps.hoverMs ?? 1000); r = { ok: true }; break;
      case 'localize': r = await drone.execute({ droneId, action: 'localize' }); if (r.ok) checked = true; break;
      case 'climb': r = await drone.execute({ droneId, action: 'move', direction: 'up', centimeters: c.cm }); break;
      case 'descend': r = await drone.execute({ droneId, action: 'move', direction: 'down', centimeters: c.cm }); break;
      case 'turn': r = await drone.execute({ droneId, action: 'rotate', direction: c.deg > 0 ? 'clockwise' : 'counterclockwise', degrees: Math.abs(c.deg) }); break;
      case 'back': r = safe ? await drone.execute({ droneId, action: 'go_to', x: Math.round(safe[0] * 100), y: Math.round(safe[1] * 100), check: false }) : { ok: false, error: 'no safe point' }; break;
      case 'continue': r = legEnd ? await drone.execute({ droneId, action: 'go_to', x: Math.round(legEnd[0] * 100), y: Math.round(legEnd[1] * 100), check: false }) : { ok: true }; break;
    }
    // A move that did not move the drone is not progress: three in a row and the mission stops.
    const after = drone.live().pose;
    if (['continue', 'back'].includes(c.action)) {
      const moved = Math.hypot(after.x - live.pose.x, after.y - live.pose.y);
      if (r.ok && moved < 10) { stuck += 1; r = { ok: false, error: 'did not move' }; } else stuck = 0;
      if (stuck >= 3) return { ok: false, error: 'Stopped and hovering: three steps without getting closer. Tell me where it is, or ask it to look around', steps: step, choices };
    }
    lastSteps.push({ action: c.action, ok: r.ok, ...(r.ok ? {} : { note: String(r.error ?? '').slice(0, 60) }) });
    // A point with room around it, reached without trouble, is where "back" goes.
    if (r.ok && c.action !== 'hover') { const p = drone.live().pose; const q: Point = [p.x / 100, p.y / 100]; if (clearanceAt(deps.plan, deps.objects, q) > 0.5) safe = q; }
  }
  return { ok: false, error: `Not there after ${maxSteps} steps: hovering`, steps: maxSteps, choices };
}

/** The objects a drone at `zFloorCm` above the floor must fly around: those within 50 cm of its height. */
export function blockingAt(objects: RoomObject[], zFloorCm: number): RoomObject[] {
  return objects.filter((o) => Math.round((o.heightM ?? (o.kind === 'table' ? 0.75 : 2)) * 100) + 50 > zFloorCm);
}
