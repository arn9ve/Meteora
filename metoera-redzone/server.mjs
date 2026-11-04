/**
 * Metoera red-zone camera: phone HTTPS page + motion events + optional takeoff hook.
 * Separate from metoera-voice so we do not fight open PRs there.
 *
 * Safety: drone takeoff runs only when the ARM switch is ON (default OFF).
 */
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile, mkdir, appendFile, chmod, access } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.REDZONE_PORT ?? 18791);
const phonePort = Number(process.env.REDZONE_PHONE_PORT ?? port + 1);
const dataDir = join(root, 'data');
const eventsPath = join(dataDir, 'events.jsonl');
const statePath = join(dataDir, 'state.json');
const phoneDir = join(root, '.phone');

try {
  loadEnvFile(join(root, '.env'));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const voiceUrl = (process.env.METOERA_VOICE_URL ?? 'http://127.0.0.1:18787').replace(/\/$/, '');
const webhookUrl = (process.env.REDZONE_WEBHOOK_URL ?? '').trim();
const debounceMs = Number(process.env.REDZONE_DEBOUNCE_MS ?? 8000);

const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (a) =>
      a &&
      a.family === 'IPv4' &&
      !a.internal &&
      /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a.address),
  )?.address;

/** @type {{ armed: boolean; lastIntrusionAt: number | null; takeoffCount: number }} */
let state = { armed: false, lastIntrusionAt: null, takeoffCount: 0 };

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8'));
    state = {
      armed: Boolean(raw.armed),
      lastIntrusionAt: typeof raw.lastIntrusionAt === 'number' ? raw.lastIntrusionAt : null,
      takeoffCount: Number(raw.takeoffCount) || 0,
    };
  } catch {
    /* fresh state */
  }
}

async function saveState() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
}

async function appendEvent(event) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(eventsPath, JSON.stringify(event) + '\n');
}

async function readEvents(limit = 50) {
  try {
    const text = await readFile(eventsPath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .reverse();
  } catch {
    return [];
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64_000) throw new Error('Message too large');
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sameKey(a, b) {
  return a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieKey(req) {
  return /(?:^|;\s*)redzone_key=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1] ?? '';
}

async function phoneSetup() {
  if (!lanAddress || process.env.PHONE_ACCESS === 'off') return null;
  await mkdir(phoneDir, { recursive: true, mode: 0o700 });
  let key = (await readFile(join(phoneDir, 'key.txt'), 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{32}$/.test(key)) {
    key = randomBytes(16).toString('hex');
    await writeFile(join(phoneDir, 'key.txt'), key, { mode: 0o600 });
  }
  const certPath = join(phoneDir, `cert-${lanAddress}.pem`);
  const keyPath = join(phoneDir, `tls-${lanAddress}.pem`);
  let cert = await readFile(certPath).catch(() => null);
  let certKey = await readFile(keyPath).catch(() => null);
  if (!cert || !certKey) {
    const openssl = (await access('/usr/bin/openssl').then(() => '/usr/bin/openssl').catch(() => null))
      ?? 'openssl';
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '30',
        '-subj',
        '/CN=Metoera-Redzone',
        '-addext',
        `subjectAltName=IP:${lanAddress}`,
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { stdio: 'ignore' },
    );
    await chmod(keyPath, 0o600);
    cert = await readFile(certPath);
    certKey = await readFile(keyPath);
  }
  return { key, cert, certKey };
}

/**
 * Optional real takeoff via metoera-voice when armed.
 * Voice checks Origin against its allow-list; we send the local origin so a server-side call works.
 */
async function tryTakeoff(eventId) {
  const result = {
    attempted: true,
    voice: null,
    webhook: null,
    note: null,
  };

  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'redzone.intrusion',
          eventId,
          at: new Date().toISOString(),
          source: 'metoera-redzone',
          actionRequested: 'takeoff',
        }),
        signal: AbortSignal.timeout(4000),
      });
      result.webhook = { ok: response.ok, status: response.status };
    } catch (error) {
      result.webhook = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const response = await fetch(`${voiceUrl}/api/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: voiceUrl.includes('127.0.0.1') ? 'http://127.0.0.1:18787' : 'http://localhost:18787',
      },
      body: JSON.stringify({ droneId: 'tello', action: 'takeoff' }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json().catch(() => ({}));
    result.voice = { ok: response.ok && body?.ok !== false, status: response.status, body };
    if (!result.voice.ok) {
      result.note =
        'Voice takeoff did not succeed. Is metoera-voice running with TELLO_IP set? See README for the stub path.';
    }
  } catch (error) {
    result.voice = { ok: false, error: error instanceof Error ? error.message : String(error) };
    result.note =
      'Could not reach metoera-voice. Event was logged; start voice + set ARM only when a human is watching the drone.';
  }

  if (!webhookUrl && !result.voice?.ok) {
    result.note =
      (result.note ? result.note + ' ' : '') +
      'Stub: would takeoff. Set REDZONE_WEBHOOK_URL and/or run metoera-voice; keep ARM OFF until ready.';
  }

  return result;
}

async function handleIntrusion(body) {
  const now = Date.now();
  const force = Boolean(body?.force);
  const since = state.lastIntrusionAt == null ? Infinity : now - state.lastIntrusionAt;
  if (!force && since < debounceMs) {
    return {
      accepted: false,
      debounced: true,
      retryAfterMs: debounceMs - since,
      armed: state.armed,
    };
  }

  state.lastIntrusionAt = now;
  const eventId = randomBytes(8).toString('hex');
  const event = {
    id: eventId,
    type: 'intrusion',
    at: new Date(now).toISOString(),
    score: typeof body.score === 'number' ? body.score : null,
    roi: body.roi && typeof body.roi === 'object' ? body.roi : null,
    note: typeof body.note === 'string' ? body.note.slice(0, 200) : null,
    armed: state.armed,
    takeoff: null,
  };

  if (!state.armed) {
    event.takeoff = {
      attempted: false,
      reason: 'disarmed',
      note: 'ARM is OFF (default). Flip ARM on the phone page only when a human is next to the drone.',
    };
  } else {
    state.takeoffCount += 1;
    event.takeoff = await tryTakeoff(eventId);
  }

  await saveState();
  await appendEvent(event);
  return { accepted: true, debounced: false, event, armed: state.armed };
}

async function handle(req, res, remote) {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (remote) {
    const given = url.searchParams.get('key') ?? '';
    if (phone && given && sameKey(given, phone.key)) {
      res
        .writeHead(302, {
          'Set-Cookie': `redzone_key=${phone.key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
          Location: path === '/' ? '/' : path,
        })
        .end();
      return;
    }
    if (!phone || !sameKey(cookieKey(req), phone.key)) {
      res
        .writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Open the full link printed by the server (it contains the access key).');
      return;
    }
  }

  if (req.method === 'GET' && path === '/api/health') {
    json(res, 200, {
      ok: true,
      service: 'metoera-redzone',
      armed: state.armed,
      debounceMs,
      voiceUrl,
      webhookConfigured: Boolean(webhookUrl),
      lan: lanAddress ?? null,
      phonePort: phone ? phonePort : null,
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    json(res, 200, { ...state, debounceMs });
    return;
  }

  if (req.method === 'POST' && path === '/api/arm') {
    try {
      const body = await readJson(req);
      state.armed = Boolean(body.armed);
      await saveState();
      await appendEvent({
        id: randomBytes(6).toString('hex'),
        type: 'arm',
        at: new Date().toISOString(),
        armed: state.armed,
      });
      json(res, 200, { ok: true, armed: state.armed });
    } catch {
      json(res, 400, { ok: false, error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/events') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    json(res, 200, { events: await readEvents(limit) });
    return;
  }

  if (req.method === 'POST' && path === '/api/intrusion') {
    try {
      const body = await readJson(req);
      json(res, 200, await handleIntrusion(body ?? {}));
    } catch {
      json(res, 400, { ok: false, error: 'Invalid request' });
    }
    return;
  }

  if (req.method !== 'GET' || !files[path]) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = files[path];
    res.writeHead(200, { 'Content-Type': types[extname(file)] }).end(await readFile(join(root, 'public', file)));
  } catch {
    res.writeHead(500).end();
  }
}

await loadState();
// Always boot disarmed after restart — never inherit a previous ARM across process restarts.
if (state.armed) {
  state.armed = false;
  await saveState();
  console.log('Safety: ARM reset to OFF on startup.');
}

const phone = await phoneSetup().catch((error) => {
  console.log(`Phone HTTPS off: ${error instanceof Error ? error.message : error}`);
  return null;
});

const server = http.createServer((req, res) => {
  void handle(req, res, false);
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Redzone (Mac):     http://127.0.0.1:${port}/`);
  console.log(`Redzone (LAN http): http://${lanAddress ?? 'YOUR-LAN-IP'}:${port}/  (camera may need HTTPS on iPhone)`);
});

if (phone) {
  https
    .createServer({ cert: phone.cert, key: phone.certKey }, (req, res) => {
      void handle(req, res, true);
    })
    .listen(phonePort, '0.0.0.0', () => {
      console.log(
        `Redzone (iPhone HTTPS): https://${lanAddress}:${phonePort}/?key=${phone.key}\n` +
          '  Self-signed cert: tap Advanced → Proceed on Safari once.\n' +
          '  ARM takeoff defaults OFF. Only enable with a human next to the drone.',
      );
    });
} else {
  console.log('Phone HTTPS not started (no LAN IPv4 or PHONE_ACCESS=off).');
}
