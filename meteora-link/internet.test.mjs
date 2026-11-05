import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { aircraftAnswers, checkReach, formatReport, openTls, pcCanReachInternet } from './internet.mjs';

test('reports internet and the aircraft as separate facts', async () => {
  const offline = await checkReach({
    internet: async () => { throw new Error('offline'); },
    aircraft: async () => true,
  });
  const unlinked = await checkReach({
    internet: async () => true,
    aircraft: async () => { throw new Error('No reply to command'); },
  });
  assert.deepEqual(offline, { internet: false, aircraft: true });
  assert.deepEqual(unlinked, { internet: true, aircraft: false });
  assert.equal(formatReport(offline), 'internet: no\naircraft: yes');
  assert.equal(formatReport(unlinked), 'internet: yes\naircraft: no');
});

test('starts the internet check and the aircraft check together', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const check = (value) => async () => {
    started += 1;
    if (started === 2) release();
    await gate;
    return value;
  };
  const result = await checkReach({ internet: check(false), aircraft: check(true) });
  assert.deepEqual(result, { internet: false, aircraft: true });
});

test('treats a completed TLS handshake as internet', async () => {
  assert.equal(await pcCanReachInternet({ connect: async () => {} }), true);
});

test('treats a failed or late TLS handshake as no internet', async () => {
  const closed = await listen();
  try {
    assert.equal(await pcCanReachInternet({
      connect: ({ timeout }) => openTls({ host: '127.0.0.1', port: closed.port, timeout }),
      timeout: 1000,
    }), false);
  } finally {
    await closed.close();
  }
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  assert.equal(await pcCanReachInternet({ connect: () => pending, timeout: 20 }), false);
  release();
});

test('uses the existing handshake and does not send ap', async () => {
  const calls = [];
  const link = {
    async connect() { calls.push('connect'); },
    close() { calls.push('close'); },
    send(text) { calls.push(text); },
  };
  assert.equal(await aircraftAnswers({ link }), true);
  assert.deepEqual(calls, ['connect', 'close']);
});

test('closes the link when the aircraft does not answer', async () => {
  let closed = false;
  const link = {
    connect() { return Promise.reject(new Error('No reply to command')); },
    close() { closed = true; },
  };
  assert.equal(await aircraftAnswers({ link }), false);
  assert.equal(closed, true);
});

function listen() {
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
