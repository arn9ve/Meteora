#!/usr/bin/env node
// Supervised test flight: takeoff → hover 5 s → land. Nothing else.
// Run from macOS Terminal while watching the drone.
//   Any key / Ctrl+C  → land now
//   x                 → EMERGENCY: motors stop immediately (the drone drops)
import dgram from 'node:dgram';
import readline from 'node:readline';
import { readFile } from 'node:fs/promises';

const host = process.argv[2] ?? '192.168.5.137';
const port = Number(process.env.TELLO_PORT ?? 8889); // override only for local tests
const HOVER_MS = 5000;
const MIN_BATTERY = 30;

const expectedSerial = (await readFile(new URL('../.env.tello', import.meta.url), 'utf8').catch(() => ''))
  .match(/^TELLO_SETUP_SERIAL=(.*)$/m)?.[1]?.trim();

const socket = dgram.createSocket('udp4');
socket.on('error', () => {});
await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(8889, resolve); })
  .catch((error) => { console.log(`Port 8889 unavailable (${error.code}). Close other Tello scripts.`); process.exit(1); });

const ACCEPT = {
  'command': (t) => /^ok$/i.test(t),
  'battery?': (t) => /^\d{1,3}$/.test(t),
  'sn?': (t) => /^[A-Z0-9]{8,}$/i.test(t) && !/^ok$/i.test(t),
  'takeoff': (t) => /^ok$/i.test(t),
  'land': (t) => /^ok$/i.test(t),
};

function send(command) {
  socket.send(command, port, host);
}

function query(command, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); socket.off('message', onMessage); resolve(value); };
    const onMessage = (payload, peer) => {
      if (peer.address !== host || peer.port !== port) return;
      const text = payload.toString('utf8').replaceAll('\0', '').trim();
      if (ACCEPT[command](text) || /^error\b/i.test(text)) done(text);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('message', onMessage);
    send(command);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let airborne = false;
let stopping = false;

async function landNow(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${reason} → landing.`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await query('land', 10000);
    if (answer === 'ok') { console.log('Landed.'); break; }
    console.log(`Reply to land: ${answer ?? 'none'}; retrying…`);
  }
  finish(0);
}

async function emergency() {
  stopping = true;
  // Wait for each datagram to leave before closing the socket, or it can be dropped.
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => socket.send('emergency', port, host, resolve));
  }
  console.log('\nEMERGENCY sent: motors stopped.');
  finish(2);
}

function finish(code) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  socket.close();
  process.exit(code);
}

// --- Pre-flight checks (no motors) ---
console.log(`Test flight at ${host}: takeoff, hover ${HOVER_MS / 1000} s, land.`);
let ready = null;
for (let attempt = 0; attempt < 3 && ready !== 'ok'; attempt += 1) ready = await query('command');
if (ready !== 'ok') { console.log('The drone does not answer. No flight.'); finish(1); }
const serial = await query('sn?');
if (!expectedSerial || serial !== expectedSerial) { console.log('Serial not confirmed. No flight.'); finish(1); }
const battery = Number(await query('battery?'));
console.log(`Serial confirmed. Battery: ${battery}%.`);
if (!(battery >= MIN_BATTERY)) { console.log(`Battery below ${MIN_BATTERY}%. No flight.`); finish(1); }

console.log('\nBefore you continue:');
console.log('  • at least 2 m clear around and above the drone, people away');
console.log('  • drone on a flat surface, textured floor, good light');
console.log('  • in flight: ANY KEY = land now, x = emergency motor stop (the drone drops)');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise((resolve) => rl.question('\nType FLY and press Enter to take off: ', resolve));
rl.close();
if (answer.trim() !== 'FLY') { console.log('Cancelled. No flight.'); finish(0); }

// --- Flight ---
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (key) => {
  const k = key.toString();
  if (k === 'x' || k === 'X') emergency();
  else landNow('Key pressed'); // includes Ctrl+C, which raw mode delivers as a key
});
process.on('SIGINT', () => landNow('Ctrl+C'));

console.log('Taking off…');
airborne = true; // from here on, any stop path sends land
const takeoff = await query('takeoff', 20000);
if (stopping) await new Promise(() => {});
if (takeoff !== 'ok') { await landNow(`Takeoff not confirmed (${takeoff ?? 'no reply'})`); }
console.log(`Airborne. Hovering for ${HOVER_MS / 1000} s…`);
const until = Date.now() + HOVER_MS;
while (Date.now() < until && !stopping) {
  const level = await query('battery?', 2000); // also keeps the SDK session alive
  if (!stopping && level) process.stdout.write(`  battery ${level}%\r`);
  await wait(1000);
}
if (!stopping) await landNow('Flight complete');
await new Promise(() => {});
