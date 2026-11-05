// A flight to a target driven step by step by the decision layer (decision.ts): build the state,
// ask the model (1.5 s at most, otherwise the rules choose), check the choice, do it, repeat.
// The route legs come from the room plan (planRoute), never from the model.
import { checkChoice, decisionPrompt, parseChoice, ruleChoice, type Choice, type DecisionState } from './decision.ts';
import { clearanceAt, inside, planRoute, surfaceHeightAt, type Point, type RoomObject } from './room.ts';

type Plan = Parameters<typeof planRoute>[0] & { height_m?: number };
type Result = { ok: boolean; error?: string; [k: string]: unknown };
export type MissionDrone = {
  execute(command: Record<string, unknown>): Promise<Result>;
  forceLand(): Promise<Result>;
  live(): { flying: boolean; connected?: boolean; pose: { x: number; y: number; heading: number; zFloor: number }; source: 'telemetry' | 'commands'; startSurface: { heightCm: number } };
  snapshot(): { battery: number | null; heightAboveFloorCm: number | null };
  readonly generation: number;
  /** A look-around (survey) was done since take-off. */
  readonly surveyedThisFlight?: boolean;
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
  /** The plan, worked out before anything moves (to be said to the person). */
  onPlan?: (text: string) => void;
  /** The place in words (above table 1…), for what is said. */
  where?: (xCm: number, yCm: number) => string;
  timeoutMs?: number;
  hoverMs?: number;
  maxSteps?: number;
};

const LEG_CM = 200; // shorter legs: the position is checked (and the route redone) more often
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function segPointDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Flies `droneId` to `target` (room cm). Ends when there, landed, stopped from outside, or out of steps. */
export async function missionGoTo(droneId: string, drone: MissionDrone, target: { x: number; y: number; name: string; pad?: number; minHeightCm?: number; face?: { x: number; y: number }; zone?: Point[] }, deps: MissionDeps): Promise<Result> {
  const maxSteps = deps.maxSteps ?? 30, timeoutMs = deps.timeoutMs ?? 1500;
  if (!drone.live().flying) return { ok: false, error: 'Take off first' };
  const generation = drone.generation;
  const lastSteps: DecisionState['lastSteps'] = [];
  let safe: Point | null = null, checked = false, stuck = 0, photoFails = 0, waits = 0;
  const choices: string[] = [];
  // Look first: the first flight to somewhere after a take-off starts with a survey (up, four photos,
  // Grok vision, position and heading), unless the drone has none. Then think: the plan from there.
  let surveyNote = '';
  if (drone.surveyedThisFlight === false) {
    deps.onPlan?.('Looking around first: climbing a little and taking four photos to see where I am.');
    const sv = await drone.execute({ droneId, action: 'survey' });
    deps.log?.({ event: 'decision', step: 0, by: 'rules', did: { action: 'survey' }, ok: sv.ok, error: sv.error });
    if (drone.generation !== generation) return { ok: false, error: 'Mission stopped (stop, land or emergency)', steps: 0, choices };
    const here = deps.where ? deps.where(drone.live().pose.x, drone.live().pose.y) : '';
    surveyNote = sv.ok
      ? `I saw ${(sv.seen as string[] ?? []).join(', ')}${sv.note ? ` (${sv.note})` : ''}: I am ${here}${Math.abs(Number(sv.deltaHeading) || 0) >= 10 ? `, and I was facing ${Math.abs(Number(sv.deltaHeading))}° ${Number(sv.deltaHeading) > 0 ? 'more to the left' : 'more to the right'} than I thought` : ''}${Number(sv.shiftCm) >= 30 ? `, ${sv.shiftCm} cm from where I thought` : ''}. `
      : `The look-around did not settle it (${String(sv.error ?? '').replace(/^Survey: /, '')}), so I go by my telemetry: I am ${here}. `;
  }
  const plan = surveyNote + planText(drone.live().pose, target, deps);
  deps.onPlan?.(plan);
  deps.log?.({ event: 'mission', target, plan });
  for (let step = 1; step <= maxSteps; step += 1) {
    if (drone.generation !== generation) return { ok: false, error: 'Mission stopped (stop, land or emergency)', steps: step - 1, choices };
    if (!drone.live().flying) return { ok: false, error: 'The drone landed: mission over', steps: step - 1, choices };
    if (drone.live().connected === false) return { ok: false, error: 'Lost the Wi-Fi link: the drone backs up toward home; when the link is back it flies home and lands, otherwise it lands where it is', steps: step - 1, choices, linkLost: true };
    const live = drone.live(), at: Point = [live.pose.x / 100, live.pose.y / 100];
    const remainingCm = Math.round(Math.hypot(target.x - live.pose.x, target.y - live.pose.y));
    // Tables are obstacles only when the drone flies lower than 50 cm above them; pillars and walls always.
    const blocking = blockingAt(deps.objects, live.pose.zFloor);
    const route = planRoute(deps.plan, blocking, at, [target.x / 100, target.y / 100]);
    // The first route point at least 30 cm away (closer ones are skipped: too short to fly).
    const next: Point | null = route && route.length ? (route.find((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) >= 0.3) ?? route[route.length - 1]) : null;
    // A leg goes to that point, at most 200 cm (under 20 cm the drone would not move at all).
    const legEnd: Point | null = next ? (() => { const d = Math.hypot(next[0] - at[0], next[1] - at[1]); if (d < 0.2) return null; const k = Math.min(1, (LEG_CM / 100) / d); return [at[0] + (next[0] - at[0]) * k, at[1] + (next[1] - at[1]) * k] as Point; })() : null;
    // People at the destination are why it goes (a person in the red zone): only people on the
    // way, not in the target zone and not within 1.5 m of the target point, make it wait.
    const onTheWay = deps.people().filter((p) => !(target.zone && inside([p.x, p.y], target.zone)) && Math.hypot(p.x - target.x / 100, p.y - target.y / 100) > 1.5);
    const nearPerson = legEnd ? onTheWay.reduce<number | null>((best, p) => { const d = segPointDist([p.x, p.y], at, legEnd); return best === null || d < best ? d : best; }, null) : null;
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
    // Photos that keep failing here are not worth more tries in this mission.
    if (choice.action === 'localize' && photoFails >= 2) { choice = state.nextLegCm >= 20 ? { action: 'continue' } : { action: 'hover' }; reason = 'photos are not helping here'; }
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
      case 'done': {
        // Into a zone: inside it by the position? If not, one short correction; then a photo to confirm.
        if (target.zone) {
          const isIn = () => { const p = drone.live().pose; return inside([p.x / 100, p.y / 100], target.zone!); };
          if (!isIn() && drone.live().flying) await drone.execute({ droneId, action: 'go_to', x: target.x, y: target.y, check: false });
          const photo = drone.live().flying ? await drone.execute({ droneId, action: 'localize' }) : { ok: false, error: 'landed' };
          if (photo.ok && !isIn() && drone.live().flying) await drone.execute({ droneId, action: 'go_to', x: target.x, y: target.y, check: false });
          const inZone = isIn();
          const where = deps.where ? deps.where(drone.live().pose.x, drone.live().pose.y) : '';
          // Look left, ahead and right with photos, and a report from Grok vision.
          const pan = drone.live().flying ? await drone.execute({ droneId, action: 'pan_report' }) : { ok: false, error: 'landed' };
          const report = pan.ok ? String(pan.report ?? '') : '';
          if (report) deps.onPlan?.(`Report from ${target.name}: ${report}`);
          deps.onPlan?.(inZone ? `I am inside ${target.name}${photo.ok ? ', checked with a photo' : ' (by my position; the photo did not confirm it)'}: ${where}.` : `I could not get inside ${target.name}: I am ${where}.`);
          deps.log?.({ event: 'zone-arrival', zone: target.name, inside: inZone, photo: photo.ok, photoError: photo.ok ? undefined : photo.error });
          return { ok: inZone, action: 'go_to', reached: inZone, insideZone: inZone, checkedWithPhoto: photo.ok, report: report || null, reportError: pan.ok ? undefined : pan.error, ...(inZone ? {} : { error: `not inside ${target.name}` }), steps: step, choices, plan };
        }
        // Arrived: face what we came to (a table), so the camera looks at it.
        if (target.face) { const turn = turnTo(live.pose, target.face); if (Math.abs(turn) >= 20) await drone.execute({ droneId, action: 'rotate', direction: turn > 0 ? 'counterclockwise' : 'clockwise', degrees: Math.min(180, Math.abs(turn)) }); }
        return { ok: true, action: 'go_to', reached: true, remainingCm, steps: step, choices, checkedWithPhoto: checked, plan };
      }
      case 'land': r = await drone.forceLand(); return { ...r, action: 'go_to', reached: false, landed: true, steps: step, choices };
      case 'hover': await sleep(deps.hoverMs ?? 1000); r = { ok: true }; break;
      case 'localize': r = await drone.execute({ droneId, action: 'localize' }); if (r.ok) checked = true; else photoFails += 1; break;
      case 'climb': r = await drone.execute({ droneId, action: 'move', direction: 'up', centimeters: c.cm }); break;
      case 'descend': r = await drone.execute({ droneId, action: 'move', direction: 'down', centimeters: c.cm }); break;
      case 'turn': r = await drone.execute({ droneId, action: 'rotate', direction: c.deg > 0 ? 'clockwise' : 'counterclockwise', degrees: Math.abs(c.deg) }); break;
      case 'back': r = safe ? await drone.execute({ droneId, action: 'go_to', x: Math.round(safe[0] * 100), y: Math.round(safe[1] * 100), check: false }) : { ok: false, error: 'no safe point' }; break;
      case 'continue': {
        if (!legEnd) { r = { ok: true }; break; }
        // Face the way it is going first: the camera then sees what is ahead.
        const turn = turnTo(live.pose, { x: legEnd[0] * 100, y: legEnd[1] * 100 });
        if (Math.abs(turn) >= 20) { const t = await drone.execute({ droneId, action: 'rotate', direction: turn > 0 ? 'counterclockwise' : 'clockwise', degrees: Math.min(180, Math.abs(turn)) }); if (!t.ok) { r = t; break; } }
        // Look before flying: the camera faces the leg now; the depth model says how far the nearest
        // thing is. Nothing within 90 cm, and the leg ends 60 cm before what it sees.
        let end = legEnd;
        const look = await drone.execute({ droneId, action: 'ahead' });
        if (look.ok && typeof look.aheadM === 'number') {
          const legM = Math.hypot(legEnd[0] - at[0], legEnd[1] - at[1]);
          if (look.aheadM < 0.9) { deps.log?.({ event: 'obstacle', aheadM: look.aheadM }); deps.onStep?.({ step, action: 'stopped', reason: `something ${look.aheadM} m ahead`, by: 'rules', overruled: null, ms: 0 }); r = { ok: false, error: `obstacle ${look.aheadM} m ahead` }; break; }
          if (look.aheadM - 0.6 < legM) { const k = (look.aheadM - 0.6) / legM; end = [at[0] + (legEnd[0] - at[0]) * k, at[1] + (legEnd[1] - at[1]) * k]; }
        }
        r = await drone.execute({ droneId, action: 'go_to', x: Math.round(end[0] * 100), y: Math.round(end[1] * 100), check: false });
        break;
      }
    }
    // A move that did not move the drone is not progress: three in a row and the mission stops.
    const after = drone.live().pose;
    if (['continue', 'back'].includes(c.action)) {
      const moved = Math.hypot(after.x - live.pose.x, after.y - live.pose.y);
      if (r.ok && moved < 10) { stuck += 1; r = { ok: false, error: 'did not move' }; } else stuck = 0;
      if (stuck >= 3) return { ok: false, error: 'Stopped and hovering: three steps without getting closer. Tell me where it is, or ask it to look around', steps: step, choices };
    }
    // Waiting a long time for a person to move: say so and stop, hovering, instead of waiting on.
    waits = c.action === 'hover' ? waits + 1 : 0;
    if (waits >= 10) return { ok: false, error: 'Stopped and hovering: a person has been in the way for 10 seconds', steps: step, choices };
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

/** Degrees to turn (+ = counterclockwise) to face a point from a pose (room cm, heading in degrees). */
export function turnTo(pose: { x: number; y: number; heading: number }, to: { x: number; y: number }): number {
  const bearing = Math.atan2(to.y - pose.y, to.x - pose.x) * 180 / Math.PI;
  let t = (bearing - pose.heading) % 360;
  if (t > 180) t -= 360;
  if (t <= -180) t += 360;
  return Math.round(t);
}

/** The plan in words, before moving: distance, which way, the turn, what it flies over. */
export function planText(pose: { x: number; y: number; heading: number; zFloor: number }, target: { x: number; y: number; name: string; pad?: number }, deps: Pick<MissionDeps, 'plan' | 'objects'>): string {
  const d = Math.hypot(target.x - pose.x, target.y - pose.y) / 100;
  const turn = turnTo(pose, target);
  const side = Math.abs(turn) < 20 ? 'straight ahead' : Math.abs(turn) > 160 ? 'behind it' : `${turn > 0 ? 'to its left' : 'to its right'} (${Math.abs(turn)}°)`;
  const route = planRoute(deps.plan, blockingAt(deps.objects, pose.zFloor), [pose.x / 100, pose.y / 100], [target.x / 100, target.y / 100]);
  if (!route) return `${target.name} is ${d.toFixed(1)} m away, ${side}, but there is no safe way from here.`;
  const over = deps.objects.filter((o) => !blockingAt([o], pose.zFloor).length && [[pose.x / 100, pose.y / 100], ...route].some((p, i, all) => i > 0 && segPointDist([o.x, o.y], all[i - 1] as Point, p as Point) < Math.max(o.w, o.d) / 2)).map((o) => o.name);
  const legs = route.length;
  return `${target.name} is ${d.toFixed(1)} m away, ${side}. ${Math.abs(turn) >= 20 ? `Turning ${Math.abs(turn)}° ${turn > 0 ? 'left' : 'right'}, then` : 'Then'} ${legs > 1 ? `${legs} straight legs around the pillars` : 'one straight line'}${over.length ? `, over ${over.join(' and ')}` : ''}${target.pad ? `, and centring on pad ${target.pad}` : ''}.`;
}
