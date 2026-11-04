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
import { Claims, CLAIMS_PORT, parsePeers, udpTransport } from './src/claims.ts';

// METOERA_PORT only for running two servers on one computer in local tests.
const port = Number(process.env.METOERA_PORT ?? 18787);
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
// Every laptop may list both drones: the ownership check below decides which laptop flies each one.
const FLEET = [['tello', 'TELLO'], ['rmtt', 'RMTT']] as const;
const isIpv4 = (text: string) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(text);
function droneFromEnv(id: string, prefix: string): RealTello | null {
  const host = process.env[`${prefix}_IP`]?.trim();
  if (!host) return null;
  if (!isIpv4(host)) { console.log(`${prefix}_IP must be an IPv4 address (got "${host}"); that drone is off`); return null; }
  return new RealTello({id, host, expectedSerial:process.env[`${prefix}_SETUP_SERIAL`], port:Number(process.env[`${prefix}_PORT`] ?? 8889), localPort:Number(process.env.TELLO_LOCAL_PORT ?? 8889), statePort:Number(process.env[`${prefix}_STATE_PORT`] ?? process.env.TELLO_STATE_PORT ?? 8890), maxMoveCm:process.env.TELLO_MAX_MOVE_CM ? Number(process.env.TELLO_MAX_MOVE_CM) : undefined, vision:() => readVision(id), mayTalk:() => refusal(id)});
}
const drones = new Map<string, RealTello>();
for (const [id, prefix] of FLEET) {
  const drone = droneFromEnv(id, prefix);
  if (drone) drones.set(id, drone);
}
const NO_DRONES = 'No drone configured: set TELLO_IP / RMTT_IP (with their serials) in .env.tello and restart the server.';

// Ownership between laptops (src/claims.ts). Each laptop announces the drones it flies on
// UDP 18789; a drone another laptop owns is see-only here and never gets a packet from us.
// METOERA_PEERS (ip[:port],...) reaches laptops directly when the Wi-Fi blocks broadcasts.
const claimsPort = Number(process.env.METOERA_CLAIMS_PORT ?? CLAIMS_PORT);
let claims: Claims | null = null;
let claimsError: string | null = null;
function refusal(id: string): string | null {
  if (claims) return claims.refusal(id);
  return claimsError ?? 'Checking that no other laptop controls this drone';
}
const mine = () => [...drones.keys()].filter((id) => refusal(id) === null);
try {
  const transport = await udpTransport({port:claimsPort, peers:parsePeers(process.env.METOERA_PEERS, claimsPort)});
  claims = new Claims({
    drones: FLEET.filter(([id]) => drones.has(id)).map(([id, prefix]) => {
      const serial = process.env[`${prefix}_SETUP_SERIAL`]?.trim().toUpperCase() ?? '';
      return {id, serial:/^[A-Z0-9]{8,}$/.test(serial) ? serial : null, address:process.env[`${prefix}_IP`]!.trim()};
    }),
    status: (id) => { const s = drones.get(id)!.snapshot(); return {flight:s.flight, battery:s.battery, connected:s.connected}; },
    transport,
    // A drone that just became ours is checked at once instead of at the next 5 s probe.
    onChange: () => { for (const id of mine()) { const drone = drones.get(id)!; if (!drone.snapshot().verified) void drone.probe(); } },
  });
  claims.start();
} catch (error) {
  claimsError = `Cannot check the other laptops (UDP ${claimsPort}: ${(error as {code?: string}).code ?? (error as Error).message}), so no drone is flown. Set METOERA_CLAIMS_PORT or METOERA_PEERS`;
  console.log(claimsError);
}
// What the page shows for each drone: this laptop's own state, or what its owner announces.
function droneViews() {
  const views: Record<string, unknown>[] = [];
  for (const [id, drone] of drones) {
    const snapshot = drone.snapshot();
    const ownership = claims?.ownership(id) ?? null;
    if (ownership?.state === 'other') {
      const {flight, battery, connected} = ownership.drone;
      views.push({...snapshot, flight, battery, connected, heightCm:null, heading:null, linkError:null, lastError:null, video:false, owner:{state:'other', name:ownership.owner}});
    } else if (ownership?.state === 'lost') views.push({...snapshot, owner:{state:'lost', name:ownership.owner}});
    else if (ownership?.state === 'mine') views.push({...snapshot, owner:{state:'mine', conflict:ownership.conflict}});
    else views.push({...snapshot, owner:{state:ownership?.state ?? 'waiting', reason:refusal(id)}});
  }
  // Drones another laptop flies that this laptop does not list in .env.tello.
  for (const {owner, drone} of claims?.elsewhere() ?? []) {
    if (drones.has(drone.id) || views.some((v) => v.id === drone.id)) continue;
    views.push({id:drone.id, mode:'real', connected:drone.connected, verified:false, linkError:null, video:false, flight:drone.flight, battery:drone.battery, heightCm:null, heading:null, lastError:null, owner:{state:'other', name:owner}});
  }
  return views;
}
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

// Voice "take a photo": saves the latest annotated camera frame of that drone in photos/.
const photosDir = join(root, 'photos');
async function takePhoto(id: string) {
  try {
    const frame = await fetch(`${visionUrl}/frame.jpg?drone=${encodeURIComponent(id)}`, {signal:AbortSignal.timeout(3000)});
    if (!frame.ok) return {ok:false, mode:'real', error:'No camera image. Is metoera-vision running?'};
    const name = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    await mkdir(photosDir, {recursive:true});
    await writeFile(join(photosDir, name), Buffer.from(await frame.arrayBuffer()));
    const seen = await readVision(id);
    const counts: Record<string, number> = {};
    for (const o of seen?.objects ?? []) if (o.confidence >= 0.5) counts[o.label] = (counts[o.label] ?? 0) + 1;
    return {ok:true, mode:'real', action:'photo', photo:`/photos/${name}`, seen:counts};
  } catch { return {ok:false, mode:'real', error:'No camera image. Is metoera-vision running?'}; }
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
  const photo = /^\/photos\/([a-z]+-[0-9TZ-]+\.jpg)$/.exec(path);
  if (req.method === 'GET' && photo) {
    try { res.writeHead(200, {'Content-Type':'image/jpeg'}).end(await readFile(join(photosDir, photo[1]))); }
    catch { res.writeHead(404).end(); }
    return;
  }
  const video = /^\/video\/([a-z]+)$/.exec(path);
  // Only this laptop's drones stream here; another laptop's drone sends its video to that laptop.
  if (req.method === 'GET' && video && drones.has(video[1]) && refusal(video[1]) === null) { await proxyVideo(video[1], res); return; }
  if (req.method === 'POST' && ['/session','/api/command','/api/emergency'].includes(path)) {
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) { json(res, 403, {error:'Unauthorized origin'}); return; }
    // Emergency buttons: they skip the command queue and cancel whatever is waiting in it.
    if (path === '/api/emergency') {
      try {
        // Applies at once to every drone this laptop flies; another laptop's drone is never
        // touched. `ok` and `error` sum them up; `drones` has each result.
        const body = await readJson(req) as {kind?: unknown};
        if (drones.size === 0) json(res, 200, {ok:false, mode:'real', error:NO_DRONES});
        else if (body?.kind !== 'land' && body?.kind !== 'motors') json(res, 400, {ok:false, mode:'real', error:'kind must be land or motors'});
        else if (mine().length === 0) json(res, 200, {ok:false, mode:'real', error:'This laptop flies no drone right now'});
        else {
          const ids = mine();
          const results = await Promise.all(ids.map((id) => body.kind === 'land' ? drones.get(id)!.forceLand() : drones.get(id)!.killMotors()));
          const byDrone = Object.fromEntries(ids.map((id, i) => [id, results[i]]));
          // A drone that was never linked has nothing to land; it only counts if no drone is linked.
          const linked = results.filter((result) => result.ok || result.error !== 'The Tello is not connected yet');
          const failed = (linked.length ? linked : results).find((result) => !result.ok);
          json(res, 200, {ok:!failed, mode:'real', ...(failed && 'error' in failed ? {error:failed.error} : {}), drones:byDrone});
        }
      } catch { json(res, 400, {ok:false, mode:'real', error:'Invalid request'}); }
      return;
    }
    if (path === '/api/command') {
      try {
        const body = await readJson(req) as {droneId?: unknown; action?: unknown};
        const id = typeof body?.droneId === 'string' ? body.droneId : '';
        const drone = drones.get(id);
        const elsewhere = claims?.elsewhere().find((e) => e.drone.id === id);
        if (drones.size === 0 && !elsewhere) json(res, 200, {ok:false, mode:'real', error:NO_DRONES});
        else if (!drone) json(res, 200, {ok:false, mode:'real', error:elsewhere ? `Connected to ${elsewhere.owner}` : 'Invalid droneId'});
        // Another laptop's drone (or one not yet confirmed as ours) gets nothing, emergency included.
        else if (refusal(id)) json(res, 200, {ok:false, mode:'real', error:refusal(id)});
        // stop must reach the drone while a move is still running, so it skips the queue.
        else if (body.action === 'stop' && Object.keys(body).length === 2) json(res, 200, await drone.stop());
        else if (body.action === 'emergency' && Object.keys(body).length === 2) json(res, 200, await drone.killMotors());
        else if (body.action === 'photo' && Object.keys(body).length === 2) json(res, 200, await takePhoto(String(body.droneId)));
        // A spoken "land" is always sent to the drone, whatever the server believes about its
        // state (a lost takeoff reply must never block a landing), and it skips the queue.
        else if (body.action === 'land' && Object.keys(body).length === 2) json(res, 200, await drone.forceLand());
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
  if (req.method === 'GET' && path === '/api/drones') { json(res, 200, {drones:droneViews(), me:claims?.name ?? null, clients:claims?.clients() ?? [], claimsError}); return; }
  if (req.method !== 'GET' || !files[path]) { res.writeHead(404).end(); return; }
  try { const file = files[path]; res.writeHead(200, {'Content-Type':types[extname(file)]}).end(await readFile(join(root,'public',file))); }
  catch { res.writeHead(500).end(); }
}
const server = http.createServer((req, res) => { void handle(req, res, false); });
if (phone) {
  https.createServer({cert:phone.cert, key:phone.certKey}, (req, res) => { void handle(req, res, true); })
    .listen(phonePort, '0.0.0.0', () => console.log(`Phone (same Wi-Fi): https://${lanAddress}:${phonePort}/?key=${phone.key}\n  The certificate is self-signed: accept the warning once on the phone.`));
}
server.listen(port, '127.0.0.1', () => console.log(`Metoera: http://localhost:${port} (${drones.size ? [...drones.keys()].map((id) => `${id} at ${process.env[`${id.toUpperCase()}_IP`]}`).join(', ') : NO_DRONES})${claims ? `\n  This laptop is "${claims.name}" to the others (UDP ${claimsPort}). A drone another laptop flies stays see-only.` : ''}`));
// Check this laptop's drone links in the background so the page shows whether each one is
// connected before anyone gives a command. Read-only: command, sn?, streamon. A drone another
// laptop owns is skipped (and the link refuses to send to it anyway).
for (const [id, drone] of drones) {
  const check = () => { if (refusal(id) === null) void drone.probe(); };
  check();
  setInterval(check, 5000).unref();
}
// When the server stops: land what is flying, stop the video of every drone we fly, then tell
// the other laptops our drones are free.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    const owned = mine().map((id) => drones.get(id)!);
    const flying = owned.filter((drone) => drone.snapshot().flight === 'flying');
    if (flying.length) { console.log('Landing before exit…'); await Promise.all(flying.map((drone) => drone.forceLand())); }
    await Promise.all(owned.map((drone) => drone.release()));
    await claims?.close();
    for (const drone of drones.values()) drone.close();
    process.exit(0);
  });
}
