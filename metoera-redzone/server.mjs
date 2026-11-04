/**
 * Metoera red-zone: up to 3 phone sessions + Mac console.
 * Phones do on-device person detection; Mac oversees via snapshots + remote commands.
 * ARM takeoff defaults OFF; resets OFF on process start.
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
const phoneDir = join(root, '.phone');
const STALE_MS = 8_000;
const PREVIEW_MAX = 120_000;

try {
  loadEnvFile(join(root, '.env'));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

const voiceUrl = (process.env.METOERA_VOICE_URL ?? 'http://127.0.0.1:18787').replace(/\/$/, '');
const webhookUrl = (process.env.REDZONE_WEBHOOK_URL ?? '').trim();
const debounceMs = Number(process.env.REDZONE_DEBOUNCE_MS ?? 8000);

const files = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/console': 'console.html',
  '/console.html': 'console.html',
  '/console.js': 'console.js',
  '/console.css': 'console.css',
};
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

const SLOT_IDS = ['1', '2', '3'];

function emptySlot(id) {
  return {
    id,
    name: `Phone ${id}`,
    token: null,
    online: false,
    lastSeenAt: null,
    watching: false,
    armed: false,
    lens: 'normal',
    lensesAvailable: { wide: false, normal: true, tele: false },
    /** 0 = least sensitive (high confidence), 100 = most sensitive. Default 35 → ~0.65 score. */
    sensitivity: 35,
    dwellMs: 0,
    roi: null,
    personScore: null,
    lastIntrusionAt: null,
    lastError: null,
    previewJpeg: null,
    previewAt: null,
    /** @type {Set<(at: number) => void>} */
    previewWaiters: new Set(),
    /** @type {object[]} */
    pendingCommands: [],
  };
}

/** @type {Record<string, ReturnType<typeof emptySlot>>} */
const slots = Object.fromEntries(SLOT_IDS.map((id) => [id, emptySlot(id)]));

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

function slotPublic(slot, { includePreviewMeta = true } = {}) {
  return {
    id: slot.id,
    name: slot.name,
    online: Boolean(slot.lastSeenAt && Date.now() - slot.lastSeenAt < STALE_MS),
    lastSeenAt: slot.lastSeenAt,
    watching: slot.watching,
    armed: slot.armed,
    lens: slot.lens,
    lensesAvailable: slot.lensesAvailable,
    sensitivity: slot.sensitivity,
    dwellMs: slot.dwellMs,
    roi: slot.roi,
    personScore: slot.personScore,
    lastIntrusionAt: slot.lastIntrusionAt,
    lastError: slot.lastError,
    hasPreview: Boolean(slot.previewJpeg),
    previewAt: includePreviewMeta ? slot.previewAt : null,
    joined: Boolean(slot.token),
  };
}

function notifyPreview(slot) {
  for (const wake of slot.previewWaiters) {
    try {
      wake(slot.previewAt);
    } catch {
      /* ignore */
    }
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify({ type: 'slots', slots: SLOT_IDS.map((id) => slotPublic(slots[id])) })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

setInterval(() => {
  let changed = false;
  for (const id of SLOT_IDS) {
    const slot = slots[id];
    const online = Boolean(slot.lastSeenAt && Date.now() - slot.lastSeenAt < STALE_MS);
    if (slot.online !== online) {
      slot.online = online;
      changed = true;
    }
  }
  if (changed) broadcast();
}, 2000).unref();

async function appendEvent(event) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(eventsPath, JSON.stringify(event) + '\n');
}

async function readEvents(limit = 50) {
  try {
    const text = await readFile(eventsPath, 'utf8');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
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

async function readJson(req, max = 200_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > max) throw new Error('Message too large');
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

function parseSlotId(raw) {
  const id = String(raw ?? '');
  return SLOT_IDS.includes(id) ? id : null;
}

function authSlot(req, slot, bodyToken) {
  const header = req.headers['x-slot-token'];
  const token = typeof bodyToken === 'string' ? bodyToken : typeof header === 'string' ? header : '';
  return Boolean(slot.token && token && sameKey(token, slot.token));
}

function enqueueCommand(slot, command) {
  slot.pendingCommands.push({ ...command, id: randomBytes(4).toString('hex'), at: Date.now() });
  if (slot.pendingCommands.length > 20) slot.pendingCommands.splice(0, slot.pendingCommands.length - 20);
  broadcast();
}

async function tryTakeoff(eventId, slotId) {
  const result = { attempted: true, voice: null, webhook: null, note: null, slotId };
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'redzone.intrusion',
          eventId,
          slotId,
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
      result.note = 'Voice takeoff did not succeed. Is metoera-voice running with TELLO_IP set?';
    }
  } catch (error) {
    result.voice = { ok: false, error: error instanceof Error ? error.message : String(error) };
    result.note = 'Could not reach metoera-voice. Event logged; keep ARM OFF until ready.';
  }
  if (!webhookUrl && !result.voice?.ok) {
    result.note = (result.note ? result.note + ' ' : '') + 'Stub: would takeoff.';
  }
  return result;
}

async function handleIntrusion(slot, body) {
  const now = Date.now();
  const force = Boolean(body?.force);
  const since = slot.lastIntrusionAt == null ? Infinity : now - slot.lastIntrusionAt;
  if (!force && since < debounceMs) {
    return { accepted: false, debounced: true, retryAfterMs: debounceMs - since, armed: slot.armed };
  }
  slot.lastIntrusionAt = now;
  const eventId = randomBytes(8).toString('hex');
  const event = {
    id: eventId,
    type: 'intrusion',
    slotId: slot.id,
    at: new Date(now).toISOString(),
    score: typeof body.score === 'number' ? body.score : null,
    roi: body.roi && typeof body.roi === 'object' ? body.roi : slot.roi,
    note: typeof body.note === 'string' ? body.note.slice(0, 200) : null,
    lens: body.lens ?? slot.lens,
    armed: slot.armed,
    takeoff: null,
  };
  if (!slot.armed) {
    event.takeoff = {
      attempted: false,
      reason: 'disarmed',
      note: 'ARM is OFF (default). Enable from Mac console or phone only with a human next to the drone.',
    };
  } else {
    event.takeoff = await tryTakeoff(eventId, slot.id);
  }
  await appendEvent(event);
  broadcast();
  return { accepted: true, debounced: false, event, armed: slot.armed };
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
    const openssl =
      (await access('/usr/bin/openssl')
        .then(() => '/usr/bin/openssl')
        .catch(() => null)) ?? 'openssl';
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
          Location: path + (url.searchParams.get('slot') ? `?slot=${url.searchParams.get('slot')}` : ''),
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
      debounceMs,
      voiceUrl,
      webhookConfigured: Boolean(webhookUrl),
      lan: lanAddress ?? null,
      phonePort: phone ? phonePort : null,
      slots: SLOT_IDS.map((id) => slotPublic(slots[id])),
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/slots') {
    json(res, 200, { slots: SLOT_IDS.map((id) => slotPublic(slots[id])), debounceMs });
    return;
  }

  if (req.method === 'GET' && path === '/api/events') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    json(res, 200, { events: await readEvents(limit) });
    return;
  }

  if (req.method === 'GET' && path === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'slots', slots: SLOT_IDS.map((id) => slotPublic(slots[id])) })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  const previewMatch = /^\/api\/slots\/([123])\/preview\.jpg$/.exec(path);
  if (req.method === 'GET' && previewMatch) {
    const slot = slots[previewMatch[1]];
    if (!slot.previewJpeg) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }).end(slot.previewJpeg);
    return;
  }

  // Low-latency MJPEG for Mac console (~phone upload rate, small frames).
  const mjpegMatch = /^\/api\/slots\/([123])\/preview\.mjpeg$/.exec(path);
  if (req.method === 'GET' && mjpegMatch) {
    const slot = slots[mjpegMatch[1]];
    const boundary = 'metoeraframe';
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    let closed = false;
    let lastSent = 0;
    const writeFrame = () => {
      if (closed || !slot.previewJpeg || slot.previewAt === lastSent) return;
      lastSent = slot.previewAt;
      const buf = slot.previewJpeg;
      res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    };
    const onPreview = () => writeFrame();
    slot.previewWaiters.add(onPreview);
    writeFrame();
    const tick = setInterval(writeFrame, 200);
    req.on('close', () => {
      closed = true;
      clearInterval(tick);
      slot.previewWaiters.delete(onPreview);
    });
    return;
  }

  const slotMatch = /^\/api\/slots\/([123])(?:\/([a-z]+))?$/.exec(path);
  if (slotMatch) {
    const slotId = slotMatch[1];
    const action = slotMatch[2] || '';
    const slot = slots[slotId];

    if (req.method === 'POST' && action === 'join') {
      try {
        const body = await readJson(req);
        slot.token = randomBytes(16).toString('hex');
        slot.name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : `Phone ${slotId}`;
        slot.lastSeenAt = Date.now();
        slot.online = true;
        slot.watching = false;
        slot.armed = false;
        slot.lastError = null;
        slot.pendingCommands = [];
        await appendEvent({
          id: randomBytes(6).toString('hex'),
          type: 'join',
          slotId,
          at: new Date().toISOString(),
          name: slot.name,
        });
        broadcast();
        json(res, 200, { ok: true, token: slot.token, slot: slotPublic(slot) });
      } catch {
        json(res, 400, { ok: false, error: 'Invalid join' });
      }
      return;
    }

    if (req.method === 'POST' && action === 'leave') {
      try {
        const body = await readJson(req);
        if (!authSlot(req, slot, body.token)) {
          json(res, 401, { ok: false, error: 'Unauthorized slot' });
          return;
        }
        const waiters = slot.previewWaiters;
        Object.assign(slot, emptySlot(slotId));
        slot.previewWaiters = waiters;
        broadcast();
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { ok: false, error: 'Invalid leave' });
      }
      return;
    }

    if (req.method === 'POST' && action === 'heartbeat') {
      try {
        const body = await readJson(req);
        if (!authSlot(req, slot, body.token)) {
          json(res, 401, { ok: false, error: 'Unauthorized slot' });
          return;
        }
        slot.lastSeenAt = Date.now();
        slot.online = true;
        if (typeof body.watching === 'boolean') slot.watching = body.watching;
        if (typeof body.armed === 'boolean') slot.armed = body.armed;
        if (typeof body.lens === 'string') slot.lens = body.lens;
        if (typeof body.sensitivity === 'number') {
          slot.sensitivity = Math.min(100, Math.max(0, Math.round(body.sensitivity)));
        }
        if (typeof body.dwellMs === 'number') slot.dwellMs = Math.max(0, body.dwellMs);
        if (body.lensesAvailable && typeof body.lensesAvailable === 'object') {
          slot.lensesAvailable = {
            wide: Boolean(body.lensesAvailable.wide),
            normal: Boolean(body.lensesAvailable.normal),
            tele: Boolean(body.lensesAvailable.tele),
          };
        }
        if (body.roi && typeof body.roi === 'object') slot.roi = body.roi;
        if (typeof body.personScore === 'number' || body.personScore === null) slot.personScore = body.personScore;
        if (typeof body.error === 'string') slot.lastError = body.error.slice(0, 200);
        const commands = slot.pendingCommands.splice(0, slot.pendingCommands.length);
        // Heartbeats are frequent — don't SSE-broadcast every one (avoids Mac UI thrash).
        json(res, 200, { ok: true, commands, slot: slotPublic(slot) });
      } catch {
        json(res, 400, { ok: false, error: 'Invalid heartbeat' });
      }
      return;
    }

    if (req.method === 'POST' && action === 'preview') {
      try {
        const body = await readJson(req, 300_000);
        if (!authSlot(req, slot, body.token)) {
          json(res, 401, { ok: false, error: 'Unauthorized slot' });
          return;
        }
        const dataUrl = typeof body.jpeg === 'string' ? body.jpeg : '';
        const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 0 && buf.length <= PREVIEW_MAX) {
          slot.previewJpeg = buf;
          slot.previewAt = Date.now();
          slot.lastSeenAt = Date.now();
          slot.online = true;
          notifyPreview(slot);
          // Don't broadcast SSE on every frame — MJPEG clients wake via previewWaiters.
        }
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { ok: false, error: 'Invalid preview' });
      }
      return;
    }

    if (req.method === 'POST' && action === 'intrusion') {
      try {
        const body = await readJson(req);
        if (!authSlot(req, slot, body.token)) {
          json(res, 401, { ok: false, error: 'Unauthorized slot' });
          return;
        }
        slot.lastSeenAt = Date.now();
        json(res, 200, await handleIntrusion(slot, body));
      } catch {
        json(res, 400, { ok: false, error: 'Invalid intrusion' });
      }
      return;
    }

    // Mac (or phone) remote command into the slot queue
    if (req.method === 'POST' && action === 'command') {
      try {
        const body = await readJson(req);
        const cmd = body.command && typeof body.command === 'object' ? body.command : body;
        const type = cmd.type;
        if (!['watch', 'arm', 'lens', 'roi', 'clearRoi', 'sensitivity'].includes(type)) {
          json(res, 400, { ok: false, error: 'Unknown command type' });
          return;
        }
        // Optimistic local state for Mac UI; phone confirms via heartbeat.
        if (type === 'watch') slot.watching = Boolean(cmd.watching);
        if (type === 'arm') {
          slot.armed = Boolean(cmd.armed);
          await appendEvent({
            id: randomBytes(6).toString('hex'),
            type: 'arm',
            slotId,
            at: new Date().toISOString(),
            armed: slot.armed,
            source: 'console',
          });
        }
        if (type === 'lens' && typeof cmd.lens === 'string') slot.lens = cmd.lens;
        if (type === 'sensitivity' && typeof cmd.sensitivity === 'number') {
          slot.sensitivity = Math.min(100, Math.max(0, Math.round(cmd.sensitivity)));
        }
        if (type === 'roi' && cmd.roi && typeof cmd.roi === 'object') slot.roi = cmd.roi;
        if (type === 'clearRoi') slot.roi = null;
        enqueueCommand(slot, cmd);
        json(res, 200, { ok: true, slot: slotPublic(slot) });
      } catch {
        json(res, 400, { ok: false, error: 'Invalid command' });
      }
      return;
    }

    if (req.method === 'GET' && action === '') {
      json(res, 200, { slot: slotPublic(slot) });
      return;
    }
  }

  // Legacy global arm/intrusion kept for simple tests — maps to slot 1
  if (req.method === 'POST' && path === '/api/arm') {
    try {
      const body = await readJson(req);
      const slot = slots['1'];
      slot.armed = Boolean(body.armed);
      enqueueCommand(slot, { type: 'arm', armed: slot.armed });
      await appendEvent({
        id: randomBytes(6).toString('hex'),
        type: 'arm',
        slotId: '1',
        at: new Date().toISOString(),
        armed: slot.armed,
      });
      json(res, 200, { ok: true, armed: slot.armed });
    } catch {
      json(res, 400, { ok: false, error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    json(res, 200, { ...slotPublic(slots['1']), debounceMs, slots: SLOT_IDS.map((id) => slotPublic(slots[id])) });
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

for (const id of SLOT_IDS) {
  slots[id].armed = false;
}

const phone = await phoneSetup().catch((error) => {
  console.log(`Phone HTTPS off: ${error instanceof Error ? error.message : error}`);
  return null;
});

const server = http.createServer((req, res) => {
  void handle(req, res, false);
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Redzone Mac console: http://127.0.0.1:${port}/console`);
  console.log(`Redzone (LAN http):  http://${lanAddress ?? 'YOUR-LAN-IP'}:${port}/console`);
});

if (phone) {
  https
    .createServer({ cert: phone.cert, key: phone.certKey }, (req, res) => {
      void handle(req, res, true);
    })
    .listen(phonePort, '0.0.0.0', () => {
      const base = `https://${lanAddress}:${phonePort}/?key=${phone.key}`;
      console.log('Redzone phones (same Wi‑Fi) — one phone per slot:');
      console.log(`  Phone 1: ${base}&slot=1`);
      console.log(`  Phone 2: ${base}&slot=2`);
      console.log(`  Phone 3: ${base}&slot=3`);
      console.log('  Or open without slot= and pick A/B/C on the phone.');
      console.log('  Self-signed cert: Advanced → Proceed once. ARM defaults OFF.');
    });
} else {
  console.log('Phone HTTPS not started (no LAN IPv4 or PHONE_ACCESS=off).');
}
