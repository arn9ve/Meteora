import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { RealTello, type Detections } from './src/tello.ts';

const port = 18787;
// Node gives each address only 250 ms to connect before trying the next one. On a busy
// network (the hackathon Wi-Fi took ~2 s to reach api.x.ai) every attempt is cut short
// and fetch fails with "Unable to connect to xAI". Give each attempt more time.
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
const root = dirname(fileURLToPath(import.meta.url));
try { loadEnvFile(join(root, '.env')); } catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
try { loadEnvFile(join(root, '.env.tello')); } catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
// Object detections from the camera, served by metoera-vision (YOLO on the Tello video).
const visionUrl = process.env.VISION_URL ?? 'http://127.0.0.1:18790';
// Each drone reads its own stream: metoera-vision separates them by drone id.
async function readVision(id: string): Promise<Detections | null> {
  try {
    const response = await fetch(`${visionUrl}/detections?drone=${encodeURIComponent(id)}`, {signal:AbortSignal.timeout(1000)});
    if (!response.ok) return null;
    const data = await response.json() as Detections;
    return Array.isArray(data.objects) ? data : null;
  } catch { return null; }
}
// Each drone is enabled only when its IP is set (in .env or .env.tello):
// TELLO_IP + TELLO_SETUP_SERIAL is droneId 'tello', RMTT_IP + RMTT_SETUP_SERIAL is droneId 'rmtt'.
// Both share local ports 8889 and 8890 (UdpPort routes replies by sender IP), so they need different IPs.
// TELLO_PORT, RMTT_PORT, TELLO_LOCAL_PORT, TELLO_STATE_PORT and RMTT_STATE_PORT are only for local tests against fake drones.
function droneFromEnv(id: string, prefix: string): RealTello | null {
  const host = process.env[`${prefix}_IP`];
  if (!host) return null;
  return new RealTello({id, host, expectedSerial:process.env[`${prefix}_SETUP_SERIAL`], port:Number(process.env[`${prefix}_PORT`] ?? 8889), localPort:Number(process.env.TELLO_LOCAL_PORT ?? 8889), statePort:Number(process.env[`${prefix}_STATE_PORT`] ?? process.env.TELLO_STATE_PORT ?? 8890), maxMoveCm:process.env.TELLO_MAX_MOVE_CM ? Number(process.env.TELLO_MAX_MOVE_CM) : undefined, vision:() => readVision(id)});
}
const drones = new Map<string, RealTello>();
for (const [id, prefix] of [['tello', 'TELLO'], ['rmtt', 'RMTT']] as const) {
  const drone = droneFromEnv(id, prefix);
  if (drone) drones.set(id, drone);
}
const tello = drones.get('tello') ?? null;
const files: Record<string, string> = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
const types: Record<string, string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);

// Phone access: HTTPS on the local network (browsers only allow the microphone over HTTPS)
// with a secret key in the link, so nobody else on the shared Wi-Fi can fly the drones.
// The key and a self-signed certificate are created once and kept in .phone/ (git-ignored).
const phonePort = Number(process.env.PHONE_PORT ?? port + 1);
const lanAddress = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(a.address))?.address;
const phoneDir = join(root, '.phone');
async function phoneSetup(): Promise<{key: string; cert: Buffer; certKey: Buffer} | null> {
  if (!lanAddress || process.env.PHONE_ACCESS === 'off') return null;
  await mkdir(phoneDir, {recursive:true, mode:0o700});
  let key = (await readFile(join(phoneDir, 'key.txt'), 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{32}$/.test(key)) { key = randomBytes(16).toString('hex'); await writeFile(join(phoneDir, 'key.txt'), key, {mode:0o600}); }
  const certPath = join(phoneDir, `cert-${lanAddress}.pem`);
  const keyPath = join(phoneDir, `tls-${lanAddress}.pem`);
  let cert = await readFile(certPath).catch(() => null);
  let certKey = await readFile(keyPath).catch(() => null);
  if (!cert || !certKey) {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=Metoera', '-addext', `subjectAltName=IP:${lanAddress}`, '-keyout', keyPath, '-out', certPath], {stdio:'ignore'});
    await chmod(keyPath, 0o600);
    cert = await readFile(certPath);
    certKey = await readFile(keyPath);
  }
  allowedOrigins.add(`https://${lanAddress}:${phonePort}`);
  return {key, cert, certKey};
}
const phone = await phoneSetup().catch((error) => { console.log(`Phone access off: ${error instanceof Error ? error.message : error}`); return null; });
function cookieKey(req: http.IncomingMessage): string {
  return /(?:^|;\s*)metoera_key=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1] ?? '';
}
function sameKey(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Live annotated video of one drone, passed through from metoera-vision.
async function proxyVideo(id: string, res: http.ServerResponse) {
  try {
    const upstream = await fetch(`${visionUrl}/stream?drone=${encodeURIComponent(id)}`);
    if (!upstream.ok || !upstream.body) { res.writeHead(503).end(); return; }
    res.writeHead(200, {'Content-Type':upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace', 'Cache-Control':'no-store'});
    const reader = upstream.body.getReader();
    res.on('close', () => { void reader.cancel().catch(() => undefined); });
    for (;;) { const {done, value} = await reader.read(); if (done) break; if (!res.write(value)) await new Promise((r) => res.once('drain', r)); }
    res.end();
  } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
}
function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value));
}
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new Error('Message too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function handle(req: http.IncomingMessage, res: http.ServerResponse, remote: boolean) {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (remote) {
    // The phone link carries ?key=…; it becomes a cookie, then the address bar is cleaned.
    const given = url.searchParams.get('key') ?? '';
    if (phone && given && sameKey(given, phone.key)) {
      res.writeHead(302, {'Set-Cookie':`metoera_key=${phone.key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`, Location:path}).end();
      return;
    }
    if (!phone || !sameKey(cookieKey(req), phone.key)) { res.writeHead(401, {'Content-Type':'text/plain; charset=utf-8'}).end('Open the full link printed by the server (it contains the access key).'); return; }
  }
  const video = /^\/video\/([a-z]+)$/.exec(path);
  if (req.method === 'GET' && video && drones.has(video[1])) { await proxyVideo(video[1], res); return; }
  if (req.method === 'POST' && ['/session','/api/command','/api/emergency'].includes(path)) {
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) { json(res, 403, {error:'Unauthorized origin'}); return; }
    // Emergency buttons: they skip the command queue and cancel whatever is waiting in it.
    if (path === '/api/emergency') {
      try {
        // Applies to every configured drone at once; the reply for 'tello' keeps the old shape.
        const body = await readJson(req) as {kind?: unknown};
        if (drones.size === 0) json(res, 200, {ok:false, mode:'real', error:'The Tello is not configured.'});
        else if (body?.kind !== 'land' && body?.kind !== 'motors') json(res, 400, {ok:false, mode:'real', error:'kind must be land or motors'});
        else {
          const ids = [...drones.keys()];
          const results = await Promise.all(ids.map((id) => body.kind === 'land' ? drones.get(id)!.forceLand() : drones.get(id)!.killMotors()));
          const byDrone = Object.fromEntries(ids.map((id, i) => [id, results[i]]));
          // A drone that was never linked has nothing to land; it only counts if no drone is linked.
          const linked = results.filter((result) => result.ok || result.error !== 'The Tello is not connected yet');
          const failed = (linked.length ? linked : results).find((result) => !result.ok);
          json(res, 200, {...(failed ?? linked[0]), drones:byDrone});
        }
      } catch { json(res, 400, {ok:false, mode:'real', error:'Invalid request'}); }
      return;
    }
    if (path === '/api/command') {
      try {
        const body = await readJson(req) as {droneId?: unknown; action?: unknown};
        const drone = typeof body?.droneId === 'string' ? drones.get(body.droneId) : undefined;
        if (drones.size === 0) json(res, 200, {ok:false, mode:'real', error:'The Tello is not configured. Set TELLO_IP in .env.tello and restart the server.'});
        else if (!drone) json(res, 200, {ok:false, mode:'real', error:'Invalid droneId'});
        // stop must reach the drone while a move is still running, so it skips the queue.
        else if (body.action === 'stop' && Object.keys(body).length === 2) json(res, 200, await drone.stop());
        else if (body.action === 'emergency' && Object.keys(body).length === 2) json(res, 200, await drone.killMotors());
        else json(res, 200, await drone.execute(body));
      }
      catch { json(res, 400, {ok:false, mode:'real', error:'Invalid request'}); }
      return;
    }
    if (!process.env.XAI_API_KEY) {
      delete process.env.XAI_API_KEY;
      try { loadEnvFile(join(root, '.env')); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { json(res, 500, {error:'Unable to read the .env file.'}); return; }
      }
    }
    if (!process.env.XAI_API_KEY) { json(res, 503, {error:'Add XAI_API_KEY to the project .env file.'}); return; }
    try {
      const upstream = await fetch('https://api.x.ai/v1/realtime/client_secrets', {method:'POST', headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify({expires_after:{seconds:300}})});
      if (!upstream.ok) { json(res, 502, {error:'Unable to obtain an xAI token. Check your key and account.'}); return; }
      json(res, 200, await upstream.json());
    } catch { json(res, 502, {error:'Unable to connect to xAI.'}); }
    return;
  }
  if (req.method === 'GET' && path === '/api/drones') { json(res, 200, {drone:tello?.snapshot() ?? null, drones:[...drones.values()].map((drone) => drone.snapshot())}); return; }
  if (req.method !== 'GET' || !files[path]) { res.writeHead(404).end(); return; }
  try { const file = files[path]; res.writeHead(200, {'Content-Type':types[extname(file)]}).end(await readFile(join(root,'public',file))); }
  catch { res.writeHead(500).end(); }
}
const server = http.createServer((req, res) => { void handle(req, res, false); });
if (phone) {
  https.createServer({cert:phone.cert, key:phone.certKey}, (req, res) => { void handle(req, res, true); })
    .listen(phonePort, '0.0.0.0', () => console.log(`Phone (same Wi-Fi): https://${lanAddress}:${phonePort}/?key=${phone.key}\n  The certificate is self-signed: accept the warning once on the phone.`));
}
server.listen(port, '127.0.0.1', () => console.log(`Metoera: http://localhost:${port} (${drones.size ? [...drones.keys()].map((id) => `${id} at ${process.env[`${id.toUpperCase()}_IP`]}`).join(', ') : 'no Tello configured: set TELLO_IP in .env.tello'})`));
// Check every drone link in the background so the page shows whether each one is connected
// before anyone gives a command. Read-only: command, sn?, streamon.
for (const drone of drones.values()) { void drone.probe(); setInterval(() => { void drone.probe(); }, 5000).unref(); }
// If the server stops while the real drone is flying, land it first.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    const flying = [...drones.values()].filter((drone) => drone.snapshot().flight === 'flying');
    if (flying.length) { console.log('Landing before exit…'); await Promise.all(flying.map((drone) => drone.forceLand())); }
    for (const drone of drones.values()) drone.close();
    process.exit(0);
  });
}
