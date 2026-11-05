#!/usr/bin/env node
// Read-only SDK check of the Tello on the shared LAN. Sends only: command, battery?, sdk?, sn?, hardware?.
// TELLO_EXPECT_SERIAL=... compares against another drone (e.g. the RoboMaster TT) instead of .env.tello.
// No flight, Wi-Fi or configuration commands. Run from macOS Terminal (Local Network access).
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';

const host = process.argv[2] ?? '192.168.5.137';
const expectedSerial = process.env.TELLO_EXPECT_SERIAL?.trim() || (await readFile(new URL('../.env.tello', import.meta.url), 'utf8').catch(() => ''))
  .match(/^TELLO_SETUP_SERIAL=(.*)$/m)?.[1]?.trim();

const ACCEPT = {
  'command': (t) => /^ok$/i.test(t),
  'battery?': (t) => /^\d{1,3}$/.test(t),
  'sdk?': (t) => /^\d+(?:\.\d+)*$/.test(t),
  'sn?': (t) => /^[A-Z0-9]{8,}$/i.test(t) && !/^ok$/i.test(t),
  // SDK 3.0: RMTT when the expansion board (ESP32) is attached, TELLO otherwise.
  'hardware?': (t) => /^[A-Za-z]{4,10}$/.test(t) && !/^ok$/i.test(t),
};

const socket = dgram.createSocket('udp4');
socket.on('error', () => {});

// The Tello always replies to local port 8889.
await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(8889, resolve); })
  .catch((error) => { console.log(`Port 8889 is busy or unavailable (${error.code}). Close other Tello scripts and retry.`); process.exit(1); });

function query(command) {
  return new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); socket.off('message', onMessage); resolve(value); };
    const onMessage = (payload, peer) => {
      if (peer.address !== host || peer.port !== 8889) return;
      const text = payload.toString('utf8').replaceAll('\0', '').trim();
      if (ACCEPT[command](text) || /^error\b/i.test(text)) done(text);
    };
    const timer = setTimeout(() => done(null), 3000);
    socket.on('message', onMessage);
    socket.send(command, 8889, host, (error) => { if (error) done(`error ${error.code}`); });
  });
}

console.log(`Read-only SDK check of the Tello at ${host} (no flight).`);
let ready = null;
for (let attempt = 0; attempt < 3 && ready !== 'ok'; attempt += 1) ready = await query('command');
console.log(`SDK: ${ready ?? 'no reply'}`);
if (ready === 'ok') {
  const battery = await query('battery?');
  const sdk = await query('sdk?');
  const serial = await query('sn?');
  const hardware = await query('hardware?');
  console.log(`Battery: ${battery ?? 'unavailable'}%`);
  console.log(`SDK version: ${sdk ?? 'unavailable'}`);
  console.log(`Hardware: ${hardware ?? 'unavailable'}`);
  console.log(`Serial: ${serial ? (serial.toUpperCase() === expectedSerial?.toUpperCase() ? 'matches your Tello' : `DIFFERENT from expected (drone reports ${serial})`) : 'unavailable'}`);
}
socket.close();
console.log('Done. No flight command sent.');
