import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';

const SERIAL = '0TQZTEST000001';

async function freePort() {
  const s = dgram.createSocket('udp4');
  await new Promise((resolve) => s.bind(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// Fake Tello with a mission pad sensor: pad 1 under the start, pad `next` after `padAtCm` forward.
async function padDrone({ statePort, padAtCm = 90, next = 2, mon = true }) {
  const socket = dgram.createSocket('udp4');
  const received = [];
  let forward = 0, flying = false, padsOn = false, closed = false;
  socket.on('message', (payload, peer) => {
    const text = payload.toString();
    received.push(text);
    const reply = (value, delay = 20) => setTimeout(() => { if (!closed) socket.send(value, peer.port, peer.address); }, delay);
    let m;
    if (text === 'command') reply('ok');
    else if (text === 'sn?') reply(SERIAL);
    else if (text === 'battery?') reply('90');
    else if (text === 'takeoff') { flying = true; reply('ok'); }
    else if (text === 'land') { flying = false; reply('ok'); }
    else if (text === 'mon' || text === 'mdirection 0') { if (mon) { padsOn = true; reply('ok'); } else reply('error'); }
    else if ((m = /^forward (\d+)$/.exec(text))) { forward += Number(m[1]); reply('ok', 60); }
    else if (/^go 0 0 \d+ \d+ m\d$/.test(text)) reply('ok');
    else reply('error');
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  // Telemetry: the pad seen below depends on how far the drone went (sensor range about ±25 cm).
  const timer = setInterval(() => {
    if (closed) return;
    let mid = -1;
    if (padsOn && flying) mid = forward < 25 ? 1 : Math.abs(forward - padAtCm) <= 25 ? next : -1;
    socket.send(`mid:${mid};x:0;y:0;z:0;pitch:0;roll:0;yaw:0;h:${flying ? 80 : 0};bat:90;`, statePort, '127.0.0.1');
  }, 40);
  return { port: socket.address().port, received, close: () => { closed = true; clearInterval(timer); socket.close(); } };
}

test('pad_hop flies straight until the next pad and centres over it', async (t) => {
  const statePort = await freePort();
  const fake = await padDrone({ statePort });
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL });
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'takeoff' })).ok, true);
  const r = await drone.execute({ droneId: 'tello', action: 'pad_hop' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.fromPad, 1);
  assert.equal(r.pad, 2);
  assert.ok(r.travelledCm >= 60 && r.travelledCm <= 120, String(r.travelledCm));
  assert.ok(fake.received.includes('mon') && fake.received.includes('mdirection 0'));
  assert.ok(fake.received.includes('go 0 0 80 30 m2'));
  assert.equal(r.centred, true);
});

test('pad_hop gives up after maxCentimeters and hovers', async (t) => {
  const statePort = await freePort();
  const fake = await padDrone({ statePort, padAtCm: 900 });
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL });
  t.after(() => { drone.close(); fake.close(); });
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await drone.execute({ droneId: 'tello', action: 'pad_hop', maxCentimeters: 90 });
  assert.equal(r.ok, false);
  assert.match(r.error, /No new pad within 90 cm/);
  assert.equal(fake.received.filter((c) => c.startsWith('forward')).reduce((s, c) => s + Number(c.split(' ')[1]), 0), 90);
  assert.equal(fake.received.some((c) => c.startsWith('go ')), false);
});

test('pad_hop refuses on the ground and when the drone has no pad sensor', async (t) => {
  const statePort = await freePort();
  const fake = await padDrone({ statePort, mon: false });
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: 0, statePort, expectedSerial: SERIAL });
  t.after(() => { drone.close(); fake.close(); });
  assert.match((await drone.execute({ droneId: 'tello', action: 'pad_hop' })).error, /take off first/);
  await drone.execute({ droneId: 'tello', action: 'takeoff' });
  const r = await drone.execute({ droneId: 'tello', action: 'pad_hop' });
  assert.match(r.error, /mission pad detection/);
  assert.equal(fake.received.some((c) => c.startsWith('forward')), false);
});
