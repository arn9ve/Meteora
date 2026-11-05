import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';
import { surfaceHeightAt } from '../src/room.ts';

const SERIAL = '0TQZTEST000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = dgram.createSocket('udp4');
  await new Promise((resolve) => s.bind(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
// Fake drone 80 cm above where it took off. Over the take-off surface the ToF reads 80; once it has
// flown more than 40 cm forward it is over the floor, so the ToF reads 80 + the start surface height.
async function drone({ statePort, startSurfaceCm }) {
  const socket = dgram.createSocket('udp4');
  let forward = 0, flying = false, closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString(); let m;
    const reply = (v) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, 20);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('90');
    else if (text === 'takeoff') { flying = true; reply('ok'); } else if (text === 'land') { flying = false; reply('ok'); }
    else if ((m = /^forward (\d+)$/.exec(text))) { forward += Number(m[1]); reply('ok'); } else if (text === 'streamon' || text === 'streamoff') reply('ok'); else reply('error');
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const timer = setInterval(() => {
    if (closed) return;
    const h = flying ? 80 : 0, tof = !flying ? 10 : forward > 40 ? 80 + startSurfaceCm : 80;
    socket.send(`mid:-1;pitch:0;roll:0;yaw:0;tof:${tof};h:${h};bat:90;`, statePort, '127.0.0.1');
  }, 30);
  return { port: socket.address().port, close: () => { closed = true; clearInterval(timer); socket.close(); } };
}

test('surface under a point: table top, open floor, or not sure near an edge', () => {
  const t = [{ id: 't', name: 'table 1', kind: 'table', x: 0, y: 0, w: 1.8, d: 1.8, rotation: 0, heightM: 0.75 }];
  assert.equal(surfaceHeightAt(t, 0, 0), 75);
  assert.equal(surfaceHeightAt(t, 3, 0), 0);
  assert.equal(surfaceHeightAt(t, 0.9, 0), null);
  assert.equal(surfaceHeightAt([{ ...t[0], heightM: undefined }], 0, 0), 75);
});

test('took off from a table on the plan: the infrared confirms 75 cm once it is over the floor', async (t) => {
  const statePort = await freePort();
  const fake = await drone({ statePort, startSurfaceCm: 75 });
  // The plan: a table under the start (x < 40 cm), open floor beyond.
  const d = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL, surfaceAt: (x) => (x < 40 ? 75 : 0) });
  t.after(() => { d.close(); fake.close(); });
  assert.deepEqual(d.snapshot().startSurface, { heightCm: 75, source: 'plan' });
  assert.equal((await d.execute({ droneId: 'tello', action: 'takeoff' })).ok, true);
  await sleep(700);
  assert.deepEqual(d.snapshot().startSurface, { heightCm: 75, source: 'plan' }); // still over its table: no news
  assert.equal((await d.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 })).ok, true);
  await sleep(900);
  assert.deepEqual(d.snapshot().startSurface, { heightCm: 75, source: 'sensor' });
  assert.equal(d.snapshot().heightAboveFloorCm, 155);
});

test('the plan says floor but it took off from a 70 cm box: the infrared corrects it', async (t) => {
  const statePort = await freePort();
  const fake = await drone({ statePort, startSurfaceCm: 70 });
  const d = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL, surfaceAt: () => 0 });
  t.after(() => { d.close(); fake.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  assert.deepEqual(d.snapshot().startSurface, { heightCm: 0, source: 'plan' });
  await d.execute({ droneId: 'tello', action: 'move', direction: 'forward', centimeters: 100 });
  await sleep(900);
  assert.deepEqual(d.snapshot().startSurface, { heightCm: 70, source: 'sensor' });
});

test('a photo fix that puts the drone over a table while the infrared sees the floor is not believed', async (t) => {
  const statePort = await freePort();
  const fake = await drone({ statePort, startSurfaceCm: 0 }); // takes off from the floor: ToF 80 = floor
  const d = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL, cameraWarmMs: 0,
    surfaceAt: (x) => (x > 200 ? 75 : 0), localize: async () => ({ ok: true, x: 300, y: 0, seen: ['t1'], residualCm: 0, note: '' }) });
  t.after(() => { d.close(); fake.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  await sleep(300);
  const r = await d.execute({ droneId: 'tello', action: 'localize' });
  assert.equal(r.ok, false);
  assert.match(r.error, /infrared sees the floor/);
  assert.equal(d.map().pose.x, 0);
});

test('landed on a table higher than the take-off spot counts as landed (infrared ~10 cm), even mid-command', async (t) => {
  const statePort = await freePort();
  const socket = dgram.createSocket('udp4'); let state = 'ground', closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString();
    const reply = (v) => setTimeout(() => { if (!closed) socket.send(v, peer.port, peer.address); }, 20);
    if (text === 'command') reply('ok'); else if (text === 'sn?') reply(SERIAL); else if (text === 'battery?') reply('80');
    else if (text === 'takeoff') { state = 'air'; reply('ok'); } else reply('ok');
  });
  await new Promise((r) => socket.bind(0, '127.0.0.1', r));
  const timer = setInterval(() => { if (!closed) { const h = state === 'air' ? 80 : state === 'table' ? 75 : 0, tof = state === 'air' ? 80 : 10; socket.send(`mid:-1;pitch:0;roll:0;yaw:0;tof:${tof};h:${h};bat:80;`, statePort, '127.0.0.1'); } }, 40);
  const d = new RealTello({ host: '127.0.0.1', port: socket.address().port, localPort: 0, statePort, expectedSerial: SERIAL });
  t.after(() => { closed = true; clearInterval(timer); d.close(); socket.close(); });
  await d.execute({ droneId: 'tello', action: 'takeoff' });
  await sleep(200);
  assert.equal(d.snapshot().flight, 'flying');
  state = 'table'; // landed on a 75 cm table: h says +75, the infrared says ground
  await sleep(2600);
  assert.equal(d.snapshot().flight, 'landed');
});
