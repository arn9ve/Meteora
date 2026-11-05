import assert from 'node:assert/strict';
import test from 'node:test';
import { Odometry } from '../src/odometry.ts';

// A flight sampled at 10 Hz. `v(heading)` gives the raw telemetry for a ground velocity
// (cm/s, room frame) the way a given firmware would report it.
function fly(odo, v) {
  let t = 0, heading = 0;
  const hold = (secs, vx, vy) => { for (let i = 0; i < secs * 10; i++) { t += 100; odo.add({ t, heading, ...v(vx, vy, heading) }); } };
  odo.reset({ x: 0, y: 0 });
  odo.add({ t, heading, vgx: 0, vgy: 0, vgz: 0 });
  hold(1, 0, -10);                       // take-off: slides 10 cm to the right, nobody asked
  let h = odo.beginMove(); hold(2, 50, 0); odo.endMove(h, 100, 0);   // forward 100
  heading = 90; hold(0.5, 0, 0);         // turned left 90°
  h = odo.beginMove(); hold(2, 0, 50); odo.endMove(h, 0, 100);       // forward 100 = +y now
  return odo;
}

test('Tello axes in dm/s: learns the reading and keeps the take-off drift', () => {
  // Drone axes (x ahead, y right), decimetres per second, rounded like the real telemetry.
  const v = (vx, vy, heading) => { const h = heading * Math.PI / 180; const f = vx * Math.cos(h) + vy * Math.sin(h), l = -vx * Math.sin(h) + vy * Math.cos(h); return { vgx: Math.round(f / 10), vgy: Math.round(-l / 10), vgz: 0 }; };
  const odo = fly(new Odometry(), v);
  assert.equal(odo.calibrated, true);
  const p = odo.position;
  assert.ok(Math.abs(p.x - 100) < 3 && Math.abs(p.y - 90) < 3, JSON.stringify(p)); // 100 ahead, 100 left, minus the 10 cm slide
  assert.match(odo.stats.reading, /drone axes, 10\.0 cm per unit/);
  assert.equal(odo.stats.fromTakeoffCm, 135);
  assert.ok(odo.stats.flownCm >= 205 && odo.stats.flownCm <= 215, String(odo.stats.flownCm));
  assert.equal(odo.fit.frame, 'body');
});

test('fixed axes in cm/s are recognised too, and the reading survives into the next flight', () => {
  const v = (vx, vy) => ({ vgx: vx, vgy: -vy, vgz: 0 }); // room axes, y right, cm/s
  const odo = fly(new Odometry(), v);
  const p = odo.position;
  assert.ok(Math.abs(p.x - 100) < 2 && Math.abs(p.y - 90) < 2, JSON.stringify(p));
  assert.equal(odo.fit.frame, 'fixed');
  assert.ok(Math.abs(odo.fit.scale - 1) < 0.05);
  // Next flight: already calibrated, tracked from the first sample.
  const next = new Odometry(); next.fit = odo.fit;
  next.reset({ x: 500, y: 0 }); next.add({ t: 0, heading: 0, vgx: 0, vgy: 0, vgz: 0 }); next.add({ t: 100, heading: 0, vgx: 30, vgy: 0, vgz: 0 });
  assert.ok(Math.abs(next.position.x - 503) < 0.01);
});

test('not calibrated before enough confirmed moves; nonsense telemetry is not trusted', () => {
  const odo = new Odometry();
  odo.reset({ x: 0, y: 0 });
  for (let t = 0; t < 2000; t += 100) odo.add({ t, heading: 0, vgx: 5, vgy: 0, vgz: 0 });
  assert.equal(odo.calibrated, false);
  assert.equal(odo.position, null);
  // Telemetry that has nothing to do with the moves (random) never calibrates.
  const bad = new Odometry(); bad.reset({ x: 0, y: 0 });
  let t = 0; bad.add({ t, heading: 0, vgx: 0, vgy: 0, vgz: 0 });
  for (const [dx, dy] of [[100, 0], [0, 100], [-100, 0]]) { const h = bad.beginMove(); for (let i = 0; i < 20; i++) bad.add({ t: (t += 100), heading: 0, vgx: (i * 7) % 5 - 2, vgy: (i * 3) % 7 - 3, vgz: 0 }); bad.endMove(h, dx, dy); }
  assert.equal(bad.calibrated, false);
});

import dgram from 'node:dgram';
import { RealTello } from '../src/tello.ts';
const SERIAL = '0TQZTEST000001';
async function freePort() { const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }

test('a real flight: the drone is tracked from its telemetry, take-off slide included, and logged', async (t) => {
  const statePort = await freePort();
  // Fake Tello: dm/s in its own axes (x ahead, y right). Slides right 10 cm/s for the first
  // second after take-off; "forward N" flies at 50 cm/s; "ccw 90" turns.
  const socket = dgram.createSocket('udp4');
  let flying = false, vx = 0, vy = 0, yaw = 0, closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); let m;
    const reply = (v, ms = 20) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, ms);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('90');
    else if (text === 'takeoff') { flying = true; vy = 1; setTimeout(() => { vy = 0; reply('ok', 0); }, 1000); }
    else if ((m = /^forward (\d+)$/.exec(text))) { vx = 5; setTimeout(() => { vx = 0; reply('ok', 0); }, Number(m[1]) * 20); }
    else if (text === 'ccw 90') { yaw -= 90; reply('ok', 100); }
    else if (text === 'land') { flying = false; reply('ok', 100); }
    else reply('error');
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  const timer = setInterval(() => { if (!closed) socket.send(`pitch:0;roll:0;yaw:${yaw};vgx:${vx};vgy:${vy};vgz:0;tof:${flying ? 80 : 10};h:${flying ? 80 : 0};bat:90;`, statePort, '127.0.0.1'); }, 100);
  const log = []; let saved = null;
  const d = new RealTello({ host: '127.0.0.1', port: socket.address().port, localPort: 0, statePort, expectedSerial: SERIAL, flightLog: (e) => log.push(e), onOdometryFit: (f) => { saved = f; } });
  t.after(() => { closed = true; clearInterval(timer); d.close(); socket.close(); });
  assert.equal((await d.execute({ droneId: 'tello', action: 'takeoff' })).ok, true);
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 })).ok, true);
  assert.equal((await d.execute({ droneId: 'tello', action: 'rotate', direction: 'counterclockwise', degrees: 90 })).ok, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 })).ok, true);
  await new Promise((r) => setTimeout(r, 300));
  const s = d.snapshot();
  assert.equal(s.positionFrom, 'telemetry');
  const p = d.live().pose;
  assert.ok(Math.abs(p.x - 100) < 15 && Math.abs(p.y - 90) < 15, JSON.stringify(p)); // 10 cm right of the commanded spot
  assert.ok(saved && saved.frame === 'body', JSON.stringify(saved));
  assert.ok(log.some((e) => e.event === 'takeoff') && log.filter((e) => e.event === 'sample').length > 20 && log.some((e) => e.event === 'calibrated'));
});
