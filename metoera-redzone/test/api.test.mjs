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

test('health lists three disarmed slots', async () => {
  await withServer(async (port) => {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.slots.length, 3);
    assert.ok(health.slots.every((s) => s.armed === false));
  });
});

test('slot join + intrusion while disarmed + debounce', async () => {
  await withServer(async (port) => {
    const joined = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test phone' }),
      })
    ).json();
    assert.ok(joined.token);
    const token = joined.token;

    const first = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, score: 0.2, note: 'test-a' }),
      })
    ).json();
    assert.equal(first.accepted, true);
    assert.equal(first.event.takeoff.reason, 'disarmed');

    const second = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/intrusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, score: 0.3, note: 'test-b' }),
      })
    ).json();
    assert.equal(second.debounced, true);

    const cmd = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: { type: 'watch', watching: true } }),
      })
    ).json();
    assert.equal(cmd.ok, true);

    const hb = await (
      await fetch(`http://127.0.0.1:${port}/api/slots/1/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, watching: false, armed: false, lens: 'normal' }),
      })
    ).json();
    assert.equal(hb.ok, true);
    assert.ok(hb.commands.some((c) => c.type === 'watch'));
  });
});

test('console page is served', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/console`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Mac console/i);
  });
});
