import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Odometry } from '../src/odometry.ts';

// A flight at 10 Hz. Room heading = 90 - yaw (yaw is the IMU's, clockwise). `raw(f, r, yaw)`
// turns the drone's forward/right speed (cm/s) into what a firmware would send.
function fly(odo, raw, { turn = true } = {}) {
  // The IMU yaw is wherever it was at power-on: -36° as on our drone that day.
  let t = 0, yaw = -36;
  const hold = (secs, f, r) => { for (let i = 0; i < secs * 10; i++) { t += 100; odo.add({ t, yaw, heading: 90 - (yaw + 36), ...raw(f, r, yaw) }); } };
  odo.reset({ x: 0, y: 0 });
  odo.add({ t, yaw, heading: 90, vgx: 0, vgy: 0, vgz: 0 });
  hold(1, 0, 10);                                        // take-off: slides 10 cm to its right
  let h = odo.beginMove(); hold(2, 50, 0); odo.endMove(h, 0, 100);    // forward 100 = +y (heading 90)
  if (turn) { yaw = -126; hold(0.5, 0, 0); }              // turned left 90°: heading 180
  // left 80: at heading 180 that is -y; without the turn, forward again (one direction only).
  if (turn) { h = odo.beginMove(); hold(1.6, 0, -50); odo.endMove(h, 0, -80); }
  else { h = odo.beginMove(); hold(2, 50, 0); odo.endMove(h, 0, 100); }
  return odo;
}
const bodyDm = (f, r) => ({ vgx: Math.round(f / 10), vgy: Math.round(r / 10), vgz: 0 });
// Like our Tello EDU: compass axes (x at yaw 0, y 90° clockwise), reversed, ~12 cm per unit.
const compassReversed = (f, r, yaw) => { const p = yaw * Math.PI / 180; return { vgx: Math.round(-(f * Math.cos(p) - r * Math.sin(p)) / 12), vgy: Math.round(-(f * Math.sin(p) + r * Math.cos(p)) / 12), vgz: 0 }; };

test('drone axes in dm/s: learns the reading and keeps the take-off slide', () => {
  const odo = fly(new Odometry(), bodyDm);
  assert.equal(odo.calibrated, true);
  const p = odo.position; // slide 10 right at heading 90 = +x; 100 up; then left 80 at heading 180 = -y
  assert.ok(Math.abs(p.x - 10) < 4 && Math.abs(p.y - 20) < 4, JSON.stringify(p));
  assert.match(odo.stats.reading, /drone axes, 10\.0 cm per unit/);
});

test('compass axes, reversed (our Tello EDU): recognised, and kept for the next flight', () => {
  const odo = fly(new Odometry(), compassReversed);
  assert.equal(odo.calibrated, true, JSON.stringify(odo.stats));
  const p = odo.position;
  assert.ok(Math.abs(p.x - 10) < 12 && Math.abs(p.y - 20) < 12, JSON.stringify(p)); // whole-number speeds: a few cm off
  assert.match(odo.stats.reading, /compass axes, reversed/);
  const next = new Odometry(); next.fit = JSON.parse(JSON.stringify(odo.fit));
  next.reset({ x: 500, y: 0 });
  next.add({ t: 0, yaw: 10, heading: 90, vgx: 0, vgy: 0, vgz: 0 });
  next.add({ t: 300, yaw: 10, heading: 90, ...compassReversed(120, 0, 10) }); // 36 cm ahead (+y), another power-on yaw
  assert.ok(Math.abs(next.position.y - 36) < 8 && Math.abs(next.position.x - 500) < 3, JSON.stringify(next.position));
});

test('one direction only, or telemetry that does not match the moves: not trusted', () => {
  const same = fly(new Odometry(), bodyDm, { turn: false });
  assert.equal(same.calibrated, false);
  assert.equal(same.position, null);
  const bad = new Odometry(); bad.reset({ x: 0, y: 0 });
  let t = 0; bad.add({ t, yaw: 0, heading: 0, vgx: 0, vgy: 0, vgz: 0 });
  for (const [dx, dy] of [[100, 0], [0, 100], [-100, 0]]) { const h = bad.beginMove(); for (let i = 0; i < 20; i++) bad.add({ t: (t += 100), yaw: 0, heading: 0, vgx: (i * 7) % 5 - 2, vgy: (i * 3) % 7 - 3, vgz: 0 }); bad.endMove(h, dx, dy); }
  assert.equal(bad.calibrated, false);
  // A reading from the old, flight-dependent model is ignored.
  const old = new Odometry(); old.fit = { frame: 'fixed', mirror: -1, scale: 11, angle: -2.2, residual: 0 };
  assert.equal(old.calibrated, false);
});

test('the real flight of 5 Nov: waits for two directions, then one reading explains every confirmed move', () => {
  const ev = readFileSync(new URL('./fixtures/flight-2026-11-05-black.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ok = new Set(['right 136', 'go -75 123 0 60', 'go 26 28 0 60', 'back 34', 'go 55 -143 0 60']);
  const step = (sdk, h) => { let m, f = 0, l = 0; if ((m = /^(forward|back|left|right) (\d+)$/.exec(sdk))) { const d = +m[2]; f = m[1] === 'forward' ? d : m[1] === 'back' ? -d : 0; l = m[1] === 'left' ? d : m[1] === 'right' ? -d : 0; } else if ((m = /^go (-?\d+) (-?\d+)/.exec(sdk))) { f = +m[1]; l = +m[2]; } else return null; const r = h * Math.PI / 180; return [f * Math.cos(r) - l * Math.sin(r), f * Math.sin(r) + l * Math.cos(r)]; };
  const odo = new Odometry(); let open = null, heading = 90; const when = [];
  for (const e of ev) {
    if (e.event === 'takeoff') odo.reset({ x: 41, y: -63 });
    if (e.event === 'sample') { heading = e.heading; odo.add(e); }
    if (e.event === 'command' || e.event === 'landed') {
      if (open && ok.has(open.sdk)) { const s = step(open.sdk, heading); if (s) odo.endMove(open.h, s[0], s[1]); }
      when.push([open?.sdk, odo.calibrated]);
      open = e.event === 'command' ? { sdk: e.sdk, h: odo.beginMove() } : null;
    }
  }
  // Not after the two "right 136" (one direction), only once a second direction came.
  assert.deepEqual(when.filter(([, c]) => c).map(([s]) => s)[0], 'go -75 123 0 60');
  assert.match(odo.stats.reading, /compass axes, reversed, 12\.\d cm per unit/);
  assert.ok(odo.stats.fitError <= 2, String(odo.stats.fitError));
  const p = odo.position; // forward 75, right 373 from the take-off spot, facing 90 on the plan
  assert.ok(Math.abs(p.x - 414) < 15 && Math.abs(p.y - 12) < 15, JSON.stringify(p));
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
  let flying = false, vx = 0, vy = 0, yaw = -36, closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); let m;
    const reply = (v, ms = 20) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, ms);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('90');
    else if (text === 'takeoff') { flying = true; vy = 1; setTimeout(() => { vy = 0; reply('ok', 0); }, 1000); }
    else if ((m = /^forward (\d+)$/.exec(text))) { vx = 5; setTimeout(() => { vx = 0; reply('ok', 0); }, Number(m[1]) * 20); }
    else if ((m = /^right (\d+)$/.exec(text))) { vy = 5; setTimeout(() => { vy = 0; reply('ok', 0); }, Number(m[1]) * 20); }
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
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'right', centimeters: 60 })).ok, true);
  assert.equal((await d.execute({ droneId: 'tello', action: 'rotate', direction: 'counterclockwise', degrees: 90 })).ok, true);
  await new Promise((r) => setTimeout(r, 300));
  const s = d.snapshot();
  assert.equal(s.positionFrom, 'telemetry');
  const p = d.live().pose;
  // Start (0,0) facing 0: slid 10 right (y -10), forward 100, right 60 (y -60), then turned.
  assert.ok(Math.abs(p.x - 100) < 15 && Math.abs(p.y - -70) < 15, JSON.stringify(p));
  assert.ok(saved && saved.frame === 'body', JSON.stringify(saved));
  assert.ok(log.some((e) => e.event === 'takeoff') && log.filter((e) => e.event === 'sample').length > 20 && log.some((e) => e.event === 'calibrated'));
});
