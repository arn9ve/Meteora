import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';
import { resolveObjectPlace, padsOf } from '../src/room.ts';
import { missionGoTo } from '../src/mission.ts';

const SERIAL = '0TQZTEST000001';
async function freePort() { const s = dgram.createSocket('udp4'); await new Promise((r) => s.bind(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
// Pad 3 lies 200 cm ahead. The drone really flies 10% short; its sensor sees the pad within 25 cm,
// and "go 0 0 h 30 m3" puts it exactly over the pad.
async function padDrone(statePort) {
  const socket = dgram.createSocket('udp4'); const received = []; let real = 0, flying = false, closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); received.push(text); let m;
    const reply = (v) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, 20);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('80');
    else if (text === 'takeoff') { flying = true; reply('ok'); } else if (text === 'land') { flying = false; reply('ok'); }
    else if ((m = /^forward (\d+)$/.exec(text))) { real += Number(m[1]) * 0.9; reply('ok'); }
    else if (/^go 0 0 \d+ 30 m3$/.test(text)) { real = 200; reply('ok'); }
    else reply('ok');
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  const timer = setInterval(() => {
    if (closed) return;
    const near = flying && Math.abs(real - 200) <= 25;
    socket.send(`mid:${near ? 3 : -1};x:${near ? Math.round(real - 200) : 0};y:0;z:${near ? 80 : 0};pitch:0;roll:0;yaw:0;tof:${flying ? 80 : 10};h:${flying ? 80 : 0};bat:80;`, statePort, '127.0.0.1');
  }, 40);
  return { port: socket.address().port, received, real: () => real, close: () => { closed = true; clearInterval(timer); socket.close(); } };
}

test('go_to a table with a pad: centres over the pad and takes its exact position', async (t) => {
  const statePort = await freePort();
  const fake = await padDrone(statePort);
  const pads = [{ pad: 3, x: 200, y: 0, surfaceCm: 75, name: 'table 3' }];
  const d = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL, cameraWarmMs: 0, pads: () => pads });
  t.after(() => { d.close(); fake.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  assert.ok(fake.received.includes('mon') && fake.received.includes('mdirection 0'));
  const r = await d.execute({ droneId: 'tello', action: 'go_to', x: 200, y: 0, pad: 3 });
  assert.equal(r.ok, true, r.error);
  assert.ok(fake.received.some((c) => /^go 0 0 \d+ 30 m3$/.test(c)));
  assert.equal(fake.real(), 200);                        // the real drone is on the pad
  assert.deepEqual([d.map().pose.x, d.map().pose.y], [200, 0]);
  assert.equal(r.name, 'table 3');
});

test('pad not under the drone: says so instead of pretending', async (t) => {
  const statePort = await freePort();
  const fake = await padDrone(statePort);
  const d = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL, cameraWarmMs: 0, pads: () => [{ pad: 3, x: 200, y: 0, surfaceCm: 75, name: 'table 3' }] });
  t.after(() => { d.close(); fake.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await d.execute({ droneId: 'tello', action: 'pad_center', pad: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Pad 3 \(table 3\) is not under the drone/);
});

test('a table with a pad is a target at its centre, above it; the mission ends centred on it', async () => {
  const t3 = { id: 't3', name: 'table 3', kind: 'table', x: 4.21, y: -1.37, w: 1.8, d: 1.8, rotation: 0, heightM: 0.75, pad: 3 };
  assert.deepEqual(resolveObjectPlace([t3], 'tavolo 3', { x: 0, y: 0 }), { x: 421, y: -137, minHeightCm: 125, pad: 3 });
  assert.deepEqual(padsOf([t3, { ...t3, id: 't1', name: 'table 1', pad: undefined }]), [{ pad: 3, x: 421, y: -137, surfaceCm: 75, name: 'table 3' }]);
  const box = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]].map(([a, b]) => ({ a, b }));
  const plan = { walls: box(-2, -4, 8, 3), bounds: { min: [-2, -4], max: [8, 3] }, height_m: 4.3 };
  const pose = { x: 41, y: -66, heading: 90, zFloor: 155 }, sent = [];
  const drone = { generation: 0, execute: async (c) => { sent.push(c); if (c.action === 'go_to') { pose.x = c.x; pose.y = c.y; } return { ok: true }; }, forceLand: async () => ({ ok: true }), live: () => ({ flying: true, pose: { ...pose }, source: 'telemetry', startSurface: { heightCm: 75 } }), snapshot: () => ({ battery: 70, heightAboveFloorCm: 155 }) };
  const t1 = { ...t3, id: 't1', name: 'table 1', x: 0.41, y: -0.66, pad: undefined };
  const r = await missionGoTo('tello', drone, { x: 421, y: -137, name: 'table 3', pad: 3, minHeightCm: 125 }, { plan, objects: [t1, t3], people: () => [], decide: async () => '{"action":"continue"}', hoverMs: 1 });
  assert.equal(r.ok, true, r.error);
  const last = sent[sent.length - 1];
  assert.deepEqual({ x: last.x, y: last.y, pad: last.pad, minHeightCm: last.minHeightCm }, { x: 421, y: -137, pad: 3, minHeightCm: 125 });
});
