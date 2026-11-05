#!/usr/bin/env node
// Scored simulated missions. Vision (18800) and the red zone (18801) must already be running.
//
//   node --env-file=../metoera-sim/sim.env tools/scenarios.mjs [--only NAME] [--repeat N]
//
// Each scenario gets a fresh data folder, its own simulator and voice server, then its steps.
// The scoreboard is metoera-sim/runs/scoreboard.json, compared with the previous one.
// Exit 1 on a new failure. A scenario with "known" is reported and does not fail the batch.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { printReport, readJsonl, rehearse } from './rehearsal-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const voiceRoot = join(here, '..');
const simRoot = join(voiceRoot, '..', 'metoera-sim');
const scenarioDir = join(simRoot, 'scenarios');
const runsDir = join(simRoot, 'runs');

const lastState = (sim, drone) => [...sim].reverse().find((e) => e.kind === 'state' && e.drone === drone);

/** Failures for one run. */
export function scoreScenario(scenario, report, seconds) {
  const expect = scenario.expect ?? {};
  const fails = [];
  if (report.wouldHit.length) fails.push('would-hit');
  if (report.near.length) fails.push('person within 30 cm');
  if (report.flying.length) fails.push('still flying');
  if (report.selfLanded) fails.push('self-landing');
  if (expect.maxSeconds != null && seconds > expect.maxSeconds) fails.push(`over ${expect.maxSeconds}s (${Math.round(seconds)}s)`);
  if (expect.maxDecisionSteps != null && report.decisions.length > expect.maxDecisionSteps) fails.push(`over ${expect.maxDecisionSteps} decision steps (${report.decisions.length})`);
  for (const action of expect.refused ?? []) if (!report.commands.some((c) => c.action === action && !c.ok)) fails.push(`expected ${action} to be refused`);
  for (const action of expect.ok ?? []) if (!report.commands.some((c) => c.action === action && c.ok)) fails.push(`expected ${action} to succeed`);
  const near = expect.endNear;
  if (near) {
    const pose = lastState(report.sim, near.drone);
    if (!pose) fails.push(`no simulator pose for ${near.drone}`);
    else {
      const d = Math.hypot(pose.x - near.x, pose.y - near.y);
      if (d > near.withinM) fails.push(`ended ${d.toFixed(2)} m from the target (limit ${near.withinM} m)`);
      if (near.minM != null && d < near.minM) fails.push(`ended ${d.toFixed(2)} m from the target (closer than ${near.minM} m)`);
    }
  }
  const fix = expect.fixWithinM;
  if (fix) {
    const pose = lastState(report.sim, fix.drone);
    const done = [...(report.fixes ?? [])].reverse().find((e) => e.ok);
    if (!pose || !done?.to) fails.push('no position fix to compare with the simulator');
    else {
      const d = Math.hypot(done.to.x / 100 - pose.x, done.to.y / 100 - pose.y);
      if (d > fix.withinM) fails.push(`position fix is ${d.toFixed(2)} m from the simulator (limit ${fix.withinM} m)`);
    }
  }
  return fails;
}

async function listening(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

function serveArgs(scenario, seed) {
  const s = scenario.serve ?? {};
  const args = ['-m', 'metoera_sim.serve', 'venue', '--seed', String(seed), '--drift', String(s.drift ?? 0)];
  if (s.imuZeroAtStart) args.push('--imu-zero-at-start');
  if (s.phones === false) args.push('--no-phones');
  return args;
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function waitForText(child, pattern, ms) {
  return new Promise((resolveWait, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), ms);
    const on = (chunk) => {
      text += chunk;
      if (text.includes(pattern)) { clearTimeout(timer); resolveWait(); }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', () => { clearTimeout(timer); reject(new Error('simulator exited before it was ready')); });
  });
}

async function prepareDir(scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'metoera-scenario-'));
  const room = JSON.parse(await readFile(join(simRoot, 'venue', 'room.json'), 'utf8'));
  if (scenario.drones) room.drones = { ...room.drones, ...scenario.drones };
  await writeFile(join(dir, '.room.json'), JSON.stringify(room, null, 2));
  if (scenario.people) await writeFile(join(dir, 'people.json'), JSON.stringify(scenario.people, null, 2));
  if (scenario.calibrated) {
    const fit = { version: 2, frame: 'body', yawSign: 1, mirror: 1, flip: 1, scale: 12, residual: 0.02 };
    await writeFile(join(dir, '.odometry.json'), JSON.stringify({ tello: fit, rmtt: fit }, null, 2));
  }
  return dir;
}

async function runOnce(scenario, seed) {
  const dir = await prepareDir(scenario);
  const port = String(process.env.METOERA_PORT ?? '18797');
  const env = { ...process.env, METOERA_DATA_DIR: dir, METOERA_PORT: port };
  const people = scenario.people ? join(dir, 'people.json') : join(simRoot, 'venue', 'people.json');
  const sim = spawn('python', [...serveArgs(scenario, seed), '--people', people], { cwd: simRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let voice;
  const started = Date.now();
  const direct = [];
  try {
    await waitForText(sim, 'Gaussians', 180000);
    voice = spawn(process.execPath, ['--env-file=../metoera-sim/sim.env', 'server.ts'], { cwd: voiceRoot, env, stdio: 'ignore' });
    const end = Date.now() + 60000;
    while (Date.now() < end && !await listening(`http://127.0.0.1:${port}/api/drones`)) await new Promise((r) => setTimeout(r, 500));
    if (!await listening(`http://127.0.0.1:${port}/api/drones`)) throw new Error('timed out waiting for the voice server');
    const lines = [];
    for (const step of scenario.steps) {
      if (step.wait) await new Promise((r) => setTimeout(r, step.wait * 1000));
      if (step.do) {
        const [drone, action, args] = step.do;
        const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
          body: JSON.stringify({ droneId: drone, action, ...(args ?? {}) }),
        });
        const result = await response.json().catch(() => ({}));
        direct.push({ drone, action, ok: Boolean(result.ok), error: result.error });
        console.log(`${result.ok ? '✓' : '✗'} ${drone} ${action}${result.ok ? '' : `: ${result.error}`}`);
      }
      if (step.say) lines.push(step.say);
    }
    let spoken = null;
    if (lines.length) { spoken = await rehearse({ lines, port: Number(port) }); printReport(spoken); }
    await new Promise((r) => setTimeout(r, 1500));
    const simLog = (await readJsonl(join(simRoot, 'runs'), (f) => f.endsWith('.jsonl'))).filter((e) => e.t * 1000 >= started);
    const flights = (await readJsonl(join(dir, 'flights'), (f) => f.endsWith('.jsonl'))).filter((e) => Date.parse(e.at) >= started);
    const commands = [...direct, ...(spoken?.commands ?? [])];
    const landed = flights.some((e) => e.event === 'command' && e.sdk === 'land') || commands.some((c) => c.action === 'land' && c.ok);
    const leftTheAir = simLog.some((e) => e.kind === 'state' && e.flying) && !simLog.slice().reverse().find((e) => e.kind === 'state')?.flying;
    const report = {
      commands,
      decisions: flights.filter((e) => e.event === 'decision'),
      sim: simLog,
      wouldHit: simLog.filter((e) => e.kind === 'would_hit'),
      near: simLog.filter((e) => e.kind === 'near_person'),
      flying: spoken?.flying ?? [],
      selfLanded: leftTheAir && !landed,
      fixes: flights.filter((e) => e.event === 'fix'),
    };
    return { report, seconds: (Date.now() - started) / 1000 };
  } finally {
    killTree(voice);
    killTree(sim);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let only = null, repeat = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--only') only = args[++i];
    else if (args[i] === '--repeat') repeat = Number(args[++i]);
  }
  if (Number(process.env.METOERA_PORT ?? 18787) === 18787) {
    console.log('Scenarios fly the simulated drones only: run with --env-file=../metoera-sim/sim.env.');
    process.exit(2);
  }
  if (!await listening('http://127.0.0.1:18800/health')) {
    console.log('Vision is not running. From metoera-vision:\n  python -m metoera_vision --port 18800 --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002');
    process.exit(2);
  }
  if (!await listening('http://127.0.0.1:18801/')) {
    console.log('The red zone is not running. From metoera-redzone:\n  node --env-file=../metoera-sim/sim.env server.mjs');
    process.exit(2);
  }
  const names = (await readdir(scenarioDir)).filter((f) => f.endsWith('.json')).sort();
  const previous = JSON.parse(await readFile(join(runsDir, 'scoreboard.json'), 'utf8').catch(() => '{}'));
  const board = {};
  let failed = false;
  for (const file of names) {
    const scenario = JSON.parse(await readFile(join(scenarioDir, file), 'utf8'));
    if (only && scenario.name !== only) continue;
    const n = repeat ?? scenario.repeat ?? 1;
    const passes = [];
    for (let i = 0; i < n; i += 1) {
      console.log(`\n==== ${scenario.name} ${i + 1}/${n}`);
      const { report, seconds } = await runOnce(scenario, (scenario.serve?.seed ?? 1) + i);
      const fails = scoreScenario(scenario, report, seconds);
      passes.push(fails.length === 0);
      console.log(fails.length ? `${scenario.known ? 'KNOWN' : 'FAIL'} ${fails.join('; ')}` : 'PASS');
      if (fails.length && !scenario.known) failed = true;
    }
    const rate = passes.filter(Boolean).length / passes.length;
    const before = previous[scenario.name];
    board[scenario.name] = rate;
    console.log(`${scenario.name}: ${(rate * 100).toFixed(0)}%${before == null ? '' : ` (was ${(before * 100).toFixed(0)}%)`}`);
  }
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, 'scoreboard.json'), JSON.stringify(board, null, 2));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
