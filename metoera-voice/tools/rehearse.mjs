#!/usr/bin/env node
// Rehearse one instruction against the simulator. See rehearsal-core.mjs.
//
//   node --env-file=../metoera-sim/sim.env tools/rehearse.mjs "<line>" [--then "<line>"]...
import { printReport, rehearse } from './rehearsal-core.mjs';

const args = process.argv.slice(2);
const lines = [];
let pilot = 'Rehearsal', quietMs = 8000, waitMs = 0, autosend = false, verbose = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--then') lines.push(args[++i]);
  else if (args[i] === '--pilot') pilot = args[++i];
  else if (args[i] === '--quiet') quietMs = Number(args[++i]) * 1000;
  else if (args[i] === '--wait') waitMs = Number(args[++i]) * 1000;
  else if (args[i] === '--autosend') autosend = true;
  else if (args[i] === '--verbose') verbose = true;
  else lines.unshift(args[i]);
}
const port = Number(process.env.METOERA_PORT ?? 18787);
if (!lines.length || port === 18787) {
  console.log(port === 18787 ? 'Rehearsals fly the simulated drones only: run with --env-file=../metoera-sim/sim.env.\n' : '');
  console.log('Usage: node --env-file=../metoera-sim/sim.env tools/rehearse.mjs "<line>" [--then "<line>"]... [--wait S] [--autosend] [--quiet S] [--pilot NAME] [--verbose]');
  process.exit(2);
}
try {
  const report = await rehearse({ lines, pilot, quietMs, waitMs, autosend, verbose, port });
  printReport(report);
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.log(error.message);
  process.exit(2);
}
