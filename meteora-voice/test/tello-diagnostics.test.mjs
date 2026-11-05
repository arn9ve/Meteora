import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';

import { probe } from '../tools/diagnose-tello.mjs';

function bind(socket, port = 0, address = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('listening', () => {
      socket.off('error', reject);
      resolve(socket.address());
    });
    socket.bind(port, address);
  });
}

function close(socket) {
  return new Promise((resolve) => socket.close(resolve));
}

async function fakeTello(replies = { command: 'ok', 'battery?': '57', 'sdk?': '3.0' }) {
  const socket = dgram.createSocket('udp4');
  const address = await bind(socket);
  const commands = [];
  socket.on('message', (payload, peer) => {
    const command = payload.toString('utf8');
    commands.push(command);
    const reply = replies[command];
    if (reply !== undefined) socket.send(reply, peer.port, peer.address);
  });
  return { socket, address, commands };
}

test('successful probe returns only validated values and allowlisted commands', async (t) => {
  const fake = await fakeTello();
  t.after(() => close(fake.socket));

  const result = await probe({
    host: '127.0.0.1',
    commandPort: fake.address.port,
    localAddress: '127.0.0.1',
    localPort: 0,
    timeoutMs: 200,
  });

  assert.deepEqual(fake.commands, ['command', 'battery?', 'sdk?']);
  assert.deepEqual(result.command, { status: 'ok', receivedPackets: 1 });
  assert.deepEqual(result.battery, { status: 'ok', value: 57, receivedPackets: 1 });
  assert.deepEqual(result.sdk, { status: 'ok', value: '3.0', receivedPackets: 1 });
});

test('timeout is bounded and later queries are not sent', async (t) => {
  const fake = await fakeTello({});
  t.after(() => close(fake.socket));
  const started = Date.now();

  const result = await probe({
    host: '127.0.0.1',
    commandPort: fake.address.port,
    localAddress: '127.0.0.1',
    localPort: 0,
    timeoutMs: 50,
  });

  assert.equal(result.command.status, 'timeout');
  assert.deepEqual(fake.commands, ['command']);
  assert.ok(Date.now() - started < 500);
});

test('reply from an unexpected peer port is ignored', async (t) => {
  const fake = await fakeTello({});
  const impostor = dgram.createSocket('udp4');
  await bind(impostor);
  t.after(() => Promise.all([close(fake.socket), close(impostor)]));
  fake.socket.on('message', (_payload, peer) => impostor.send('ok', peer.port, peer.address));

  const result = await probe({
    host: '127.0.0.1',
    commandPort: fake.address.port,
    localAddress: '127.0.0.1',
    localPort: 0,
    timeoutMs: 60,
  });

  assert.equal(result.command.status, 'timeout');
});

test('occupied local binding returns a safe error', async (t) => {
  const occupied = dgram.createSocket('udp4');
  const address = await bind(occupied);
  t.after(() => close(occupied));

  const result = await probe({
    host: '127.0.0.1',
    commandPort: 9,
    localAddress: '127.0.0.1',
    localPort: address.port,
    timeoutMs: 50,
  });

  assert.deepEqual(result.command, { status: 'error', code: 'EADDRINUSE' });
});

test('stale ok and raw malformed payloads do not leak into results', async (t) => {
  const secret = 'RAW_SECRET_PAYLOAD';
  const fake = await fakeTello({ command: 'ok', 'battery?': 'ok' });
  t.after(() => close(fake.socket));
  fake.socket.on('message', (payload, peer) => {
    if (payload.toString() === 'battery?') fake.socket.send(secret, peer.port, peer.address);
  });

  const result = await probe({
    host: '127.0.0.1',
    commandPort: fake.address.port,
    localAddress: '127.0.0.1',
    localPort: 0,
    timeoutMs: 60,
  });

  assert.equal(result.battery.status, 'timeout');
  assert.equal(result.sdk.status, 'timeout');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('payload'));
  assert.ok(fake.commands.every((command) => ['command', 'battery?', 'sdk?'].includes(command)));
});


test('null-padded replies are accepted', async (t) => {
  const fake = await fakeTello({ command: 'ok\0', 'battery?': '57\0', 'sdk?': '3.0\0' });
  t.after(() => close(fake.socket));
  const result = await probe({host:'127.0.0.1', commandPort:fake.address.port, localAddress:'127.0.0.1', localPort:0, timeoutMs:100});
  assert.equal(result.command.status,'ok');
  assert.equal(result.battery.value,57);
});

test('drone rejection is distinguished from silence without exposing raw text', async (t) => {
  const fake = await fakeTello({ command: 'error private diagnostic text' });
  t.after(() => close(fake.socket));
  const result = await probe({host:'127.0.0.1', commandPort:fake.address.port, localAddress:'127.0.0.1', localPort:0, timeoutMs:100});
  assert.equal(result.command.status,'rejected');
  assert.equal(result.command.receivedPackets,1);
  assert.equal(JSON.stringify(result).includes('private diagnostic text'),false);
});
