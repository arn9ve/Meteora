// Calibration test: how precise is the drone's own idea of where it is?
//
// From its take-off spot (a table), it flies a pattern that returns to the start on paper
// (right S, left 2S, right S, forward S, back 2S, forward S), measures every move with the
// telemetry, looks at where it thinks it ended up, flies back to the start with that, and lands.
// With S = 50 cm a drone that started in the middle of a 1.8 m table stays above the table.
// The one true check is a person measuring where it landed; the report keeps a place for it.

type Result = { ok: boolean; error?: string; [k: string]: unknown };
export type CalibrationDrone = {
  execute(command: Record<string, unknown>): Promise<Result>;
  forceLand(): Promise<Result>;
  live(): { flying: boolean; connected: boolean; pose: { x: number; y: number; heading: number; zFloor: number }; source: 'telemetry' | 'commands'; tofCm: number | null; startSurface: { heightCm: number; source: string } };
  snapshot(): { battery: number | null; heightCm: number | null; flight: 'landed' | 'flying' };
  odometryReport(): { moves: { commanded: [number, number]; measured: [number, number]; errorCm: number }[]; stats: { reading: string | null; fitError: number | null; calibrated: boolean } };
  readonly generation: number;
};
export type CalibrationReport = {
  at: string; drone: string; sizeCm: number; ok: boolean; error?: string;
  start: { x: number; y: number };
  telemetry: { reading: string | null; fitErrorPct: number | null; calibrated: boolean };
  moves: { command: string; commandedCm: number; measuredCm: number | null; errorCm: number | null }[];
  moveErrorCm: { mean: number; max: number } | null;
  takeoffDriftCm: number | null;   // where the telemetry says it was after take-off and hover
  beforeReturnCm: number | null;   // how far from the start it thought it was before flying back
  afterReturnCm: number | null;    // the same after flying back (should be ~0 when the return worked)
  overTableAtEnd: boolean | null;  // the infrared still saw the table under it before landing
  photo: { ok: boolean; shiftCm?: number; seen?: string[]; error?: string } | null;
  landed: boolean;
  measuredLandingCm: number | null; // filled in by the person afterwards
  log: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCalibration(droneId: string, drone: CalibrationDrone, opts: { sizeCm?: number; photo?: boolean; pauseMs?: number; hoverMs?: number; onNote?: (line: string) => void } = {}): Promise<CalibrationReport> {
  const S = Math.max(20, Math.min(80, Math.round(opts.sizeCm ?? 50)));
  const pause = opts.pauseMs ?? 1000;
  const live0 = drone.live();
  const report: CalibrationReport = {
    at: new Date().toISOString(), drone: droneId, sizeCm: S, ok: false, start: { x: live0.pose.x, y: live0.pose.y },
    telemetry: { reading: null, fitErrorPct: null, calibrated: false }, moves: [], moveErrorCm: null,
    takeoffDriftCm: null, beforeReturnCm: null, afterReturnCm: null, overTableAtEnd: null, photo: null, landed: false, measuredLandingCm: null, log: [],
  };
  const note = (t: string) => { const line = `${new Date().toISOString().slice(11, 19)} ${t}`; report.log.push(line); opts.onNote?.(line); };
  const fail = (error: string) => { report.error = error; note(`stopped: ${error}`); return report; };
  // Before anything moves.
  if (!live0.connected) return fail('The drone is not connected');
  if (drone.snapshot().flight === 'flying') return fail('Land first: the test starts from the ground, on its take-off spot');
  const battery = drone.snapshot().battery;
  if (battery !== null && battery < 40) return fail(`Battery ${battery}%: at least 40% for the test`);
  const generation = drone.generation;
  const stopped = () => drone.generation !== generation;
  const dist = (p: { x: number; y: number }) => Math.round(Math.hypot(p.x - report.start.x, p.y - report.start.y));

  note(`take-off from (${report.start.x}, ${report.start.y}) cm, on ${live0.startSurface.heightCm ? `a ${live0.startSurface.heightCm} cm surface` : 'the floor'}`);
  const up = await drone.execute({ droneId, action: 'takeoff' });
  if (!up.ok) return fail(`take-off: ${up.error}`);
  await sleep(opts.hoverMs ?? 3000);
  const pattern: [string, number][] = [['right', S], ['left', 2 * S], ['right', S], ['forward', S], ['back', 2 * S], ['forward', S]];
  try {
    for (const [direction, cm] of pattern) {
      if (stopped()) return fail('stopped from outside (stop, land or emergency)');
      // look: false: the pattern is the test, so no looking around before its sideways moves.
      const r = await drone.execute({ droneId, action: 'move', direction, centimeters: cm, look: false });
      report.moves.push({ command: `${direction} ${cm}`, commandedCm: cm, measuredCm: null, errorCm: null });
      note(`${direction} ${cm}: ${r.ok ? 'ok' : `failed (${r.error})`}`);
      await sleep(pause);
    }
    // Commanded vs measured, with the reading the telemetry has by now (it needs these moves).
    const odo = drone.odometryReport();
    report.telemetry = { reading: odo.stats.reading, fitErrorPct: odo.stats.fitError, calibrated: odo.stats.calibrated };
    const confirmed = report.moves.filter((m) => !/failed/.test(report.log.find((l) => l.includes(m.command)) ?? ''));
    odo.moves.slice(-confirmed.length).forEach((m, i) => { const row = confirmed[i]; row.measuredCm = Math.round(Math.hypot(...m.measured)); row.errorCm = m.errorCm; });
    const errs = report.moves.map((m) => m.errorCm).filter((e): e is number => e !== null);
    report.moveErrorCm = errs.length ? { mean: Math.round(errs.reduce((a, b) => a + b, 0) / errs.length), max: Math.max(...errs) } : null;
    const afterPattern = drone.live();
    report.beforeReturnCm = afterPattern.source === 'telemetry' ? dist(afterPattern.pose) : null;
    note(report.telemetry.calibrated ? `telemetry: ${report.telemetry.reading}, ${report.telemetry.fitErrorPct}% unexplained; ${report.beforeReturnCm} cm from the start` : 'telemetry not understood yet: the return uses the commands only');
    if (opts.photo) {
      const p = await drone.execute({ droneId, action: 'localize' });
      report.photo = p.ok ? { ok: true, shiftCm: p.shiftCm as number, seen: p.seen as string[] } : { ok: false, error: p.error };
      note(p.ok ? `photo fix moved the estimate ${p.shiftCm} cm` : `photo fix: ${p.error}`);
    }
    // Back to the start with what it believes, then land on the table.
    if (stopped()) return fail('stopped from outside (stop, land or emergency)');
    const back = await drone.execute({ droneId, action: 'go_to', x: report.start.x, y: report.start.y, check: false, look: false });
    note(`back to the start: ${back.ok ? 'ok' : `failed (${back.error})`}`);
    await sleep(pause);
    const end = drone.live();
    report.afterReturnCm = dist(end.pose);
    const h = drone.snapshot().heightCm;
    // Over the table, the infrared reads the height above the table top (about h); over the floor, h + table.
    if (end.tofCm !== null && h !== null && live0.startSurface.heightCm > 0) report.overTableAtEnd = Math.abs(end.tofCm - h) < live0.startSurface.heightCm / 2;
    note(report.overTableAtEnd === null ? 'infrared check not possible' : report.overTableAtEnd ? 'infrared: above the table' : 'infrared: NOT above the table (over the floor?)');
  } finally {
    if (drone.snapshot().flight === 'flying' && !stopped()) {
      const down = await drone.forceLand();
      report.landed = down.ok;
      note(down.ok ? 'landed' : `landing: ${down.error}`);
    }
  }
  report.ok = report.landed;
  return report;
}

/** Short text for the person and for Grok. */
export function summary(r: CalibrationReport): string {
  if (r.error && !r.landed && !r.moves.length) return `Calibration not done: ${r.error}`;
  const parts = [
    r.telemetry.calibrated ? `telemetry understood (${r.telemetry.reading}, ${r.telemetry.fitErrorPct}% unexplained)` : 'telemetry not understood: position from commands only',
    r.moveErrorCm ? `moves of ${r.sizeCm}-${2 * r.sizeCm} cm: error ${r.moveErrorCm.mean} cm on average, ${r.moveErrorCm.max} cm at most` : null,
    r.beforeReturnCm !== null ? `after the pattern it believed it was ${r.beforeReturnCm} cm from the start` : null,
    r.overTableAtEnd === null ? null : r.overTableAtEnd ? 'back above the table' : 'NOT back above the table',
    r.photo ? (r.photo.ok ? `the photo moved the estimate ${r.photo.shiftCm} cm` : `photo: ${r.photo.error}`) : null,
    r.measuredLandingCm !== null ? `landed ${r.measuredLandingCm} cm from where it took off (measured)` : r.landed ? 'landed: measure how far from the take-off spot and enter it' : null,
  ];
  return parts.filter(Boolean).join('; ') + '.';
}
