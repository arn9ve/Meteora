import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(fn) {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      REDZONE_PORT: String(port),
      REDZONE_PHONE_PORT: String(port + 1),
      PHONE_ACCESS: 'off',
      REDZONE_DEBOUNCE_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ready = false;
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* wait */
    }
    await sleep(100);
  }
  assert.equal(ready, true, 'server should start');

  try {
    await fn(port);
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
}

test('health and default disarm', async () => {
  await withServer(async (port) => {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.armed, false);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.armed, false);
  });
});

test('intrusion logs while disarmed; debounce works', async () => {
  await withServer(async (port) => {
    const first = await (
      await fetch(`http://127.0.0.1:${port}/api/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 0.2, note: 'test-a' }),
      })
    ).json();
    assert.equal(first.accepted, true);
    assert.equal(first.event.takeoff.reason, 'disarmed');

    const second = await (
      await fetch(`http://127.0.0.1:${port}/api/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 0.3, note: 'test-b' }),
      })
    ).json();
    assert.equal(second.debounced, true);

    const forced = await (
      await fetch(`http://127.0.0.1:${port}/api/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: 1, note: 'force', force: true }),
      })
    ).json();
    assert.equal(forced.accepted, true);

    const events = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
    assert.ok(events.events.some((e) => e.type === 'intrusion'));
  });
});

test('arm toggle persists until restart semantics via API', async () => {
  await withServer(async (port) => {
    const armed = await (
      await fetch(`http://127.0.0.1:${port}/api/arm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: true }),
      })
    ).json();
    assert.equal(armed.armed, true);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.armed, true);
  });
});
