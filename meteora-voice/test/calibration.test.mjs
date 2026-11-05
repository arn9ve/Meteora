import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';
import { runCalibration, summary } from '../src/calibration.ts';

const SERIAL = '0TQZTEST000001';
async function freePort() { const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

// Fake Tello over a 75 cm table: telemetry like our EDU (compass axes at yaw -36, reversed, 12 cm
// per unit), 60 cm/s moves. "left" really goes only 90%: the telemetry sees it, the commands do not.
async function tableDrone(statePort) {
  const socket = dgram.createSocket('udp4');
  let flying = false, f = 0, r = 0, vf = 0, vr = 0, closed = false; const yaw = -36;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); let m;
    const reply = (v, ms = 20) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, ms);
    const fly = (df, dr, ms) => { vf = df / (ms / 1000); vr = dr / (ms / 1000); setTimeout(() => { vf = 0; vr = 0; reply('ok', 0); }, ms); };
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('80');
    else if (text === 'takeoff') { flying = true; reply('ok', 300); }
    else if (text === 'land') { flying = false; reply('ok', 200); }
    else if ((m = /^(forward|back|left|right) (\d+)$/.exec(text))) { const d = +m[2]; const k = m[1] === 'left' ? 0.9 : 1; fly(m[1] === 'forward' ? d : m[1] === 'back' ? -d : 0, (m[1] === 'right' ? d : m[1] === 'left' ? -d : 0) * k, d * 12); }
    else if ((m = /^go (-?\d+) (-?\d+) (-?\d+) (\d+)$/.exec(text))) { const df = +m[1], dl = +m[2]; fly(df, -dl, Math.max(300, Math.hypot(df, dl) * 12)); }
    else reply('ok');
  });
  await new Promise((r2) => socket.bind(0, '127.0.0.1', r2));
  const timer = setInterval(() => {
    if (closed) return;
    f += vf * 0.05; r += vr * 0.05;
    const p = yaw * Math.PI / 180, vx = vf * Math.cos(p) - vr * Math.sin(p), vy = vf * Math.sin(p) + vr * Math.cos(p);
    const offTable = Math.abs(f) > 90 || Math.abs(r) > 90;
    socket.send(`pitch:0;roll:0;yaw:${yaw};vgx:${Math.round(-vx / 12)};vgy:${Math.round(-vy / 12)};vgz:0;tof:${flying ? (offTable ? 155 : 80) : 10};h:${flying ? 80 : 0};bat:80;`, statePort, '127.0.0.1');
  }, 50);
  return { port: socket.address().port, where: () => ({ f, r }), close: () => { closed = true; clearInterval(timer); socket.close(); } };
}

test('calibration: measures every move, sees the short one, comes back over the table and lands', async (t) => {
  const statePort = await freePort();
  const fake = await tableDrone(statePort);
  const d = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL, start: { x: 41, y: -63, heading: 90 }, surfaceAt: (x, y) => (Math.abs(x - 41) < 65 && Math.abs(y + 63) < 65 ? 75 : 0), cameraWarmMs: 0 });
  t.after(() => { d.close(); fake.close(); });
  await d.probe(); // the server probes every 5 s; telemetry starts flowing
  await new Promise((r) => setTimeout(r, 300));
  const lines = [];
  const report = await runCalibration('tello', d, { sizeCm: 50, pauseMs: 300, hoverMs: 500, onNote: (l) => lines.push(l) });
  assert.equal(report.ok, true, JSON.stringify(report.log));
  assert.equal(report.landed, true);
  assert.equal(report.telemetry.calibrated, true);
  assert.match(report.telemetry.reading, /compass axes, reversed/);
  // The short "left 100" (really 90) is the worst move.
  const left = report.moves.find((m) => m.command === 'left 100');
  assert.ok(left.errorCm >= 5 && left.errorCm <= 15, JSON.stringify(report.moves));
  assert.ok(report.beforeReturnCm >= 5, String(report.beforeReturnCm)); // it knew it was off
  // The return used the telemetry: the real drone ends close to where it took off, above the table.
  const end = fake.where();
  assert.ok(Math.hypot(end.f, end.r) < 15, JSON.stringify(end));
  assert.equal(report.overTableAtEnd, true);
  assert.ok(lines.length >= 8);
  assert.match(summary(report), /moves of 50-100 cm: error \d+ cm on average/);
});

test('calibration refuses to start in the air, on low battery, or when not connected', async () => {
  const base = { execute: async () => ({ ok: true }), forceLand: async () => ({ ok: true }), odometryReport: () => ({ moves: [], stats: {} }), generation: 0 };
  const live = (o = {}) => () => ({ flying: false, connected: true, pose: { x: 0, y: 0, heading: 0, zFloor: 75 }, source: 'commands', tofCm: 10, startSurface: { heightCm: 75, source: 'plan' }, ...o });
  assert.match((await runCalibration('tello', { ...base, live: live(), snapshot: () => ({ battery: 80, heightCm: 80, flight: 'flying' }) })).error, /Land first/);
  assert.match((await runCalibration('tello', { ...base, live: live(), snapshot: () => ({ battery: 25, heightCm: 0, flight: 'landed' }) })).error, /Battery 25%/);
  assert.match((await runCalibration('tello', { ...base, live: live({ connected: false }), snapshot: () => ({ battery: 80, heightCm: 0, flight: 'landed' }) })).error, /not connected/);
});
