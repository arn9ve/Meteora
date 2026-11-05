import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { RealTello } from '../src/tello.ts';
import { UdpPort } from '../src/udp-port.ts';

// Like the real drones, these fakes ignore the sender's port: every reply goes to one fixed
// local port (the computer's 8889 in real life). Telemetry goes to a second fixed port.
async function fakeDrone({ serial, replyPort, statePort, battery }) {
  const socket = dgram.createSocket('udp4');
  const received = [];
  let closed = false;
  const send = (value, port, wait = 0) => setTimeout(() => { if (!closed) socket.send(value, port, '127.0.0.1'); }, wait);
  socket.on('message', (payload) => {
    const text = payload.toString();
    received.push(text);
    if (text === 'command') { send('ok', replyPort); send('ok', replyPort, 30); }
    else if (text === 'sn?') send(serial, replyPort, 60);
    else if (text === 'battery?') send(battery, replyPort);
    else if (text === 'emergency') { /* no reply */ }
    else if (['takeoff', 'land', 'streamon'].includes(text) || /^(cw|ccw) \d+$/.test(text)) send('ok', replyPort, 40);
    else send('error', replyPort);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    received,
    telemetry: (bat) => send(`pitch:0;roll:0;yaw:0;h:0;bat:${bat};`, statePort),
    close: () => { closed = true; socket.close(); },
  };
}

async function freePort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('two drones fly from one process through one shared reply port', async (t) => {
  const replyPort = await freePort();
  const edu = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  const rmtt = await fakeDrone({ serial: 'FAKERMTT000002', replyPort, statePort: 0, battery: '64' });
  const a = new RealTello({ id: 'tello', host: '127.0.0.1', port: edu.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001' });
  const b = new RealTello({ id: 'rmtt', host: '127.0.0.1', port: rmtt.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKERMTT000002' });
  t.after(() => { a.close(); b.close(); edu.close(); rmtt.close(); });

  // Opened at the same time: both bind attempts must share the port, not fail with EADDRINUSE.
  const [upA, upB] = await Promise.all([
    a.execute({ droneId: 'tello', action: 'takeoff' }),
    b.execute({ droneId: 'rmtt', action: 'takeoff' }),
  ]);
  assert.equal(upA.ok, true, JSON.stringify(upA));
  assert.equal(upB.ok, true, JSON.stringify(upB));
  assert.equal(a.snapshot().id, 'tello');
  assert.equal(b.snapshot().id, 'rmtt');
  assert.equal(a.snapshot().battery, 81);
  assert.equal(b.snapshot().battery, 64);

  const [turnA, turnB] = await Promise.all([
    a.execute({ droneId: 'tello', action: 'rotate', direction: 'clockwise', degrees: 90 }),
    b.execute({ droneId: 'rmtt', action: 'rotate', direction: 'counterclockwise', degrees: 45 }),
  ]);
  assert.equal(turnA.ok && turnB.ok, true);
  assert.equal(edu.received.includes('cw 90'), true);
  assert.equal(edu.received.includes('ccw 45'), false);
  assert.equal(rmtt.received.includes('ccw 45'), true);
  assert.equal(rmtt.received.includes('cw 90'), false);

  // A command for one drone is refused by the other link.
  assert.equal((await a.execute({ droneId: 'rmtt', action: 'land' })).error, 'Invalid droneId');

  // Closing one link keeps the shared socket open for the other.
  a.close();
  assert.equal((await b.execute({ droneId: 'rmtt', action: 'land' })).ok, true);
});

test('a serial check still runs per drone on the shared port', async (t) => {
  const replyPort = await freePort();
  const right = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  const wrong = await fakeDrone({ serial: 'SOMEOTHER00003', replyPort, statePort: 0, battery: '70' });
  const a = new RealTello({ id: 'tello', host: '127.0.0.1', port: right.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001' });
  const b = new RealTello({ id: 'rmtt', host: '127.0.0.1', port: wrong.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKERMTT000002' });
  t.after(() => { a.close(); b.close(); right.close(); wrong.close(); });
  const [ra, rb] = await Promise.all([a.execute({ droneId: 'tello', action: 'takeoff' }), b.execute({ droneId: 'rmtt', action: 'takeoff' })]);
  assert.equal(ra.ok, true);
  assert.equal(rb.error, 'Serial number does not match the configured Tello');
  assert.equal(wrong.received.includes('takeoff'), false);
});

test('two links to the same drone are refused', async (t) => {
  const replyPort = await freePort();
  const fake = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  const a = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001' });
  const b = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001' });
  t.after(() => { a.close(); b.close(); fake.close(); });
  assert.equal((await a.execute({ droneId: 'tello', action: 'status' })).ok, true);
  assert.match((await b.execute({ droneId: 'tello', action: 'status' })).error, /Another link already controls/);
});

test('telemetry on the shared state port reaches only the drone it came from', async (t) => {
  const replyPort = await freePort();
  const statePort = await freePort();
  const fake = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort, battery: '81' });
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort, expectedSerial: 'FAKEEDU0000001' });
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  fake.telemetry(42);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(drone.snapshot().battery, 42);
  assert.equal(drone.snapshot().connected, true);
  // Another sender address would not be routed here; UdpPort keys state listeners by IP.
  const port = await UdpPort.acquire(statePort);
  t.after(() => port.release());
  assert.throws(() => port.subscribe('127.0.0.1', () => {}), /already has a link/);
  assert.doesNotThrow(() => port.subscribe('192.0.2.7', () => {})());
});

test('a link that was closed and reopened keeps the drone alive again', async (t) => {
  const replyPort = await freePort();
  const fake = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001', keepaliveMs: 40 });
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  drone.close();
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  const before = fake.received.filter((line) => line === 'battery?').length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fake.received.filter((line) => line === 'battery?').length > before, true);
});

test('a drone another laptop owns never receives a packet from this laptop', async (t) => {
  const replyPort = await freePort();
  const fake = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  let refusal = 'Connected to Arnove';
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001', keepaliveMs: 40, mayTalk: () => refusal });
  t.after(() => { drone.close(); fake.close(); });
  await drone.probe();
  const results = [
    await drone.execute({ droneId: 'tello', action: 'takeoff' }),
    await drone.execute({ droneId: 'tello', action: 'status' }),
    await drone.stop(),
    await drone.forceLand(),
    await drone.killMotors(),
  ];
  for (const result of results) assert.equal(result.error, 'Connected to Arnove');
  await drone.release();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(fake.received, []);
  assert.equal(drone.snapshot().linkError, 'Connected to Arnove');

  // The other laptop let it go: now it is ours and works normally.
  refusal = null;
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  assert.equal(fake.received.includes('command'), true);

  // Should the gate close again, even the keepalive goes quiet.
  refusal = 'Connected to Arnove';
  const sent = fake.received.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fake.received.length, sent);
});

test('release stops the video before closing the link', async (t) => {
  const replyPort = await freePort();
  const fake = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001' , cameraAlwaysOn: true});
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  assert.equal(drone.snapshot().video, true);
  await drone.release();
  assert.equal(fake.received.at(-1), 'streamoff');
  assert.equal(drone.snapshot().verified, false);
});

test('a drone handed to another laptop gets streamoff, then nothing; taking it back shakes hands again', async (t) => {
  const replyPort = await freePort();
  const fake = await fakeDrone({ serial: 'FAKEEDU0000001', replyPort, statePort: 0, battery: '81' });
  let refusal = null; // ours, then "yielding" (still allowed), then the other laptop's
  const drone = new RealTello({ host: '127.0.0.1', port: fake.port, localPort: replyPort, statePort: 0, expectedSerial: 'FAKEEDU0000001', keepaliveMs: 40, mayTalk: () => refusal , cameraAlwaysOn: true});
  t.after(() => { drone.close(); fake.close(); });
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  await drone.release(); // what the server's onYield does before letting go
  assert.equal(fake.received.at(-1), 'streamoff');
  refusal = "Black is on the ground, linked to Arnove's laptop: say take off to fly it from here";
  const sent = fake.received.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fake.received.length, sent); // no keepalive once it is handed over
  assert.equal((await drone.execute({ droneId: 'tello', action: 'takeoff' })).error, refusal);
  assert.equal(fake.received.length, sent);

  refusal = null; // handed back to this laptop
  assert.equal((await drone.execute({ droneId: 'tello', action: 'status' })).ok, true);
  assert.deepEqual(fake.received.slice(sent, sent + 3), ['command', 'sn?', 'streamon']);
});
