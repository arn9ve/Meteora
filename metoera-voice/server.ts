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
import { RealTello, type Detections, type DepthView } from './src/tello.ts';
import { Claims, CLAIMS_PORT, describeElsewhere, parsePeers, udpTransport } from './src/claims.ts';
import { Pilots, TAKEOFF } from './src/pilots.ts';

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
// Where each drone stands before its first takeoff, in one room frame shared by both drones:
// TELLO_START / RMTT_START = "x,y,heading" in cm and degrees (x = toward the wall both face,
// y = left). Defaults: Black at 0,0 and Red 150 cm to its right, both facing the same way.
function startOf(prefix: string): {x: number; y: number; heading: number} {
  const raw = process.env[`${prefix}_START`] ?? (prefix === 'RMTT' ? '0,-150,0' : '0,0,0');
  const [x, y, heading] = raw.split(',').map((v) => Number(v.trim()));
  return [x, y, heading].every(Number.isFinite) ? {x, y, heading} : {x:0, y:0, heading:0};
}
// Metric depth for one drone's latest frame (Depth Anything V2 Metric Indoor in metoera-vision).
async function readDepth(id: string): Promise<DepthView | null> {
  try {
    const response = await fetch(`${visionUrl}/depth?drone=${encodeURIComponent(id)}`, {signal:AbortSignal.timeout(5000)});
    if (!response.ok) return null;
    const data = await response.json() as DepthView;
    return Array.isArray(data.objects) && Array.isArray(data.columns) ? data : null;
  } catch { return null; }
}
// The latest camera frame of one drone (with YOLO boxes), as JPEG.
async function readFrame(id: string): Promise<Buffer | null> {
  try {
    const response = await fetch(`${visionUrl}/frame.jpg?drone=${encodeURIComponent(id)}`, {signal:AbortSignal.timeout(2000)});
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch { return null; }
}
// Grok vision looks at real camera images (describe, find). VISION_LLM_MODEL picks the model.
const visionModel = process.env.VISION_LLM_MODEL ?? 'grok-4.20-non-reasoning';
async function askVision(images: Buffer[], prompt: string): Promise<string | null> {
  if (!process.env.XAI_API_KEY) return null;
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method:'POST', signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`, 'Content-Type':'application/json'},
      body:JSON.stringify({model:visionModel, max_tokens:300, messages:[{role:'user', content:[
        ...images.map((image) => ({type:'image_url', image_url:{url:`data:image/jpeg;base64,${image.toString('base64')}`, detail:'low'}})),
        {type:'text', text:prompt},
      ]}]}),
    });
    if (!response.ok) return null;
    const data = await response.json() as {choices?: {message?: {content?: string}}[]};
    return data.choices?.[0]?.message?.content?.trim() || null;
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
  return new RealTello({id, host, expectedSerial:process.env[`${prefix}_SETUP_SERIAL`], port:Number(process.env[`${prefix}_PORT`] ?? 8889), localPort:Number(process.env.TELLO_LOCAL_PORT ?? 8889), statePort:Number(process.env[`${prefix}_STATE_PORT`] ?? process.env.TELLO_STATE_PORT ?? 8890), maxMoveCm:process.env.TELLO_MAX_MOVE_CM ? Number(process.env.TELLO_MAX_MOVE_CM) : undefined, vision:() => readVision(id), frame:() => readFrame(id), askVision, start:startOf(prefix), depth:() => readDepth(id), mayTalk:() => mayTalk(id)});
}
const drones = new Map<string, RealTello>();
for (const [id, prefix] of FLEET) {
  const drone = droneFromEnv(id, prefix);
  if (drone) drones.set(id, drone);
}
const NO_DRONES = 'No drone configured: set TELLO_IP / RMTT_IP (with their serials) in .env.tello and restart the server.';
const DRONE_NAMES: Record<string, string> = {tello:'Black', rmtt:'Red'};
const label = (id: string) => DRONE_NAMES[id] ?? id;

// Pilots (src/pilots.ts): several people can use this server (the laptop page, phones on the
// link), each with a name. The person who takes off a drone flies it until it has landed;
// nobody else can command it, not even land it or cut its motors. A pilot gone for 15 s
// (page closed, phone asleep, name changed) gets the drone landed by the server.
const pilots = new Pilots({label});

// Ownership between laptops (src/claims.ts). Each laptop announces the drones it holds on
// UDP 18789; a drone another laptop holds never gets a packet from us. A landed one is handed
// over when someone here takes off with it; a flying one stays with the laptop that flies it.
// METOERA_PEERS (ip[:port],...) reaches laptops directly when the Wi-Fi blocks broadcasts.
const claimsPort = Number(process.env.METOERA_CLAIMS_PORT ?? CLAIMS_PORT);
let claims: Claims | null = null;
let claimsError: string | null = null;
function refusal(id: string): string | null {
  if (claims) return claims.refusal(id);
  return claimsError ?? 'Checking that no other laptop controls this drone';
}
// Packets may still leave while a drone is handed over (its video is stopped first).
function mayTalk(id: string): string | null {
  if (claims) return claims.mayTalk(id);
  return claimsError ?? 'Checking that no other laptop controls this drone';
}
const mine = () => [...drones.keys()].filter((id) => refusal(id) === null);
// Locked: flying, flown by someone here, or busy with a command. Only an unlocked drone is handed over.
function droneStatus(id: string) {
  const drone = drones.get(id)!;
  const s = drone.snapshot();
  const pilot = pilots.pilotOf(id);
  return {flight:s.flight, battery:s.battery, connected:s.connected, pilot, locked:s.flight === 'flying' || pilot !== null || drone.busy};
}
// When a lock changes (takeoff, landing), the other laptops hear it at once, not a second later.
let lockKey = '';
function lockChanged() {
  const key = JSON.stringify([...drones.keys()].map((id) => { const s = droneStatus(id); return [id, s.pilot, s.locked]; }));
  if (key === lockKey) return;
  lockKey = key;
  claims?.refresh();
}
try {
  const transport = await udpTransport({port:claimsPort, peers:parsePeers(process.env.METOERA_PEERS, claimsPort)});
  claims = new Claims({
    drones: FLEET.filter(([id]) => drones.has(id)).map(([id, prefix]) => {
      const serial = process.env[`${prefix}_SETUP_SERIAL`]?.trim().toUpperCase() ?? '';
      return {id, serial:/^[A-Z0-9]{8,}$/.test(serial) ? serial : null, address:process.env[`${prefix}_IP`]!.trim()};
    }),
    status: droneStatus,
    transport,
    label,
    // Before another laptop takes a landed drone: stop its video and close the link.
    onYield: (id) => drones.get(id)!.release(),
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
      const {flight, battery, connected, pilot, locked} = ownership.drone;
      views.push({...snapshot, flight, battery, connected, heightCm:null, heading:null, linkError:null, lastError:null, video:false, owner:{state:'other', name:ownership.owner, pilot, locked}});
    } else if (ownership?.state === 'lost') views.push({...snapshot, owner:{state:'lost', name:ownership.owner}});
    else if (ownership?.state === 'mine') views.push({...snapshot, owner:{state:'mine', conflict:ownership.conflict}});
    else if (ownership?.state === 'yielding') views.push({...snapshot, video:false, owner:{state:'yielding', name:ownership.to}});
    else if (ownership?.state === 'taking') views.push({...snapshot, owner:{state:'taking', name:ownership.from}});
    else views.push({...snapshot, owner:{state:ownership?.state ?? 'waiting', reason:refusal(id)}});
  }
  // Drones another laptop flies that this laptop does not list in .env.tello.
  for (const {owner, drone} of claims?.elsewhere() ?? []) {
    if (drones.has(drone.id) || views.some((v) => v.id === drone.id)) continue;
    views.push({id:drone.id, mode:'real', connected:drone.connected, verified:false, linkError:null, video:false, flight:drone.flight, battery:drone.battery, heightCm:null, heading:null, lastError:null, owner:{state:'other', name:owner, pilot:drone.pilot, locked:drone.locked}});
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
// Phones only trust the page (and allow the microphone) when the certificate chains to a
// trusted root. So the Mac makes a small local root ("Metoera local CA") once, valid 90 days and
// name-constrained to private LAN addresses, so it can never vouch for an internet site. Its
// public part is installed once on the phone (see the download page on PHONE_CERT_PORT); the
// server certificate for this IP is signed with it. Private keys stay in .phone/ (0600).
function openssl(args: string[]) { execFileSync('/usr/bin/openssl', args, {stdio:'ignore'}); }
async function localCertificate(ip: string) {
  const caPath = join(phoneDir, 'ca.pem');
  const caKeyPath = join(phoneDir, 'ca-key.pem');
  const caDerPath = join(phoneDir, 'metoera-ca.cer');
  if (!(await readFile(caPath).catch(() => null)) || !(await readFile(caKeyPath).catch(() => null))) {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90', '-sha256', '-subj', '/CN=Metoera local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', 'nameConstraints=critical,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0',
      '-keyout', caKeyPath, '-out', caPath]);
    await chmod(caKeyPath, 0o600);
    openssl(['x509', '-in', caPath, '-outform', 'der', '-out', caDerPath]);
  }
  const certPath = join(phoneDir, `cert-ca-${ip}.pem`);
  const keyPath = join(phoneDir, `tls-ca-${ip}.pem`);
  if (!(await readFile(certPath).catch(() => null)) || !(await readFile(keyPath).catch(() => null))) {
    const csrPath = join(phoneDir, `leaf-${ip}.csr`);
    const extPath = join(phoneDir, `leaf-${ip}.cnf`);
    await writeFile(extPath, `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${ip}\n`);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Metoera', '-keyout', keyPath, '-out', csrPath]);
    await chmod(keyPath, 0o600);
    openssl(['x509', '-req', '-in', csrPath, '-CA', caPath, '-CAkey', caKeyPath, '-CAcreateserial', '-days', '89', '-sha256', '-extfile', extPath, '-out', certPath]);
  }
  const ca = await readFile(caPath);
  return {cert:Buffer.concat([await readFile(certPath), ca]), certKey:await readFile(keyPath), caDer:await readFile(caDerPath)};
}
async function phoneSetup(): Promise<{key: string; cert: Buffer; certKey: Buffer; caDer: Buffer} | null> {
  if (!lanAddress || process.env.PHONE_ACCESS === 'off') return null;
  await mkdir(phoneDir, {recursive:true, mode:0o700});
  let key = (await readFile(join(phoneDir, 'key.txt'), 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{32}$/.test(key)) { key = randomBytes(16).toString('hex'); await writeFile(join(phoneDir, 'key.txt'), key, {mode:0o600}); }
  const {cert, certKey, caDer} = await localCertificate(lanAddress);
  allowedOrigins.add(`https://${lanAddress}:${phonePort}`);
  return {key, cert, certKey, caDer};
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
// Each browser is a session (cookie); its name is what the lock goes by (src/pilots.ts).
function sessionOf(req: http.IncomingMessage, res: http.ServerResponse, secure: boolean): string {
  let id = /(?:^|;\s*)metoera_pilot=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
  if (!id) {
    id = randomBytes(16).toString('hex');
    res.appendHeader('Set-Cookie', `metoera_pilot=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`);
  }
  pilots.seen(id);
  return id;
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
  const sid = sessionOf(req, res, remote);
  const photo = /^\/photos\/([a-z]+-[0-9TZ-]+\.jpg)$/.exec(path);
  if (req.method === 'GET' && photo) {
    try { res.writeHead(200, {'Content-Type':'image/jpeg'}).end(await readFile(join(photosDir, photo[1]))); }
    catch { res.writeHead(404).end(); }
    return;
  }
  const video = /^\/video\/([a-z]+)$/.exec(path);
  // Only this laptop's drones stream here; another laptop's drone sends its video to that laptop.
  if (req.method === 'GET' && video && drones.has(video[1]) && refusal(video[1]) === null) { await proxyVideo(video[1], res); return; }
  if (req.method === 'POST' && ['/session','/api/command','/api/emergency','/api/pilot','/api/nearest'].includes(path)) {
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) { json(res, 403, {error:'Unauthorized origin'}); return; }
    // Emergency buttons: they skip the command queue and cancel whatever is waiting in it.
    if (path === '/api/emergency') {
      try {
        // Applies at once to every drone this laptop holds that nobody else flies: the ones
        // this person flies and the ones without a pilot. Another person's drone and another
        // laptop's drone are never touched. `ok` and `error` sum them up; `drones` has each
        // result, `skipped` why a drone was left alone.
        const body = await readJson(req) as {kind?: unknown};
        const ids = mine().filter((id) => pilots.mayEmergency(sid, id));
        const skipped = Object.fromEntries(mine().filter((id) => !ids.includes(id)).map((id) => [id, `${label(id)} is flown by ${pilots.pilotOf(id)}`]));
        if (drones.size === 0) json(res, 200, {ok:false, mode:'real', error:NO_DRONES});
        else if (body?.kind !== 'land' && body?.kind !== 'motors') json(res, 400, {ok:false, mode:'real', error:'kind must be land or motors'});
        else if (mine().length === 0) json(res, 200, {ok:false, mode:'real', error:'This laptop flies no drone right now'});
        else if (ids.length === 0) json(res, 200, {ok:false, mode:'real', error:`${Object.values(skipped).join('; ')}: only the pilot can land it or cut its motors`, skipped});
        else {
          const results = await Promise.all(ids.map((id) => body.kind === 'land' ? drones.get(id)!.forceLand() : drones.get(id)!.killMotors()));
          const byDrone = Object.fromEntries(ids.map((id, i) => [id, results[i]]));
          // A drone that was never linked has nothing to land; it only counts if no drone is linked.
          const linked = results.filter((result) => result.ok || result.error !== 'The Tello is not connected yet');
          const failed = (linked.length ? linked : results).find((result) => !result.ok);
          json(res, 200, {ok:!failed, mode:'real', ...(failed && 'error' in failed ? {error:failed.error} : {}), drones:byDrone, skipped});
        }
      } catch { json(res, 400, {ok:false, mode:'real', error:'Invalid request'}); }
      return;
    }
    if (path === '/api/pilot') {
      try {
        // Changing the name mid-flight hands nothing over: the lock keeps the old name, and the
        // drone is landed once that name has been silent for 15 s.
        const body = await readJson(req) as {name?: unknown};
        const name = pilots.setName(sid, body?.name);
        if (!name) { json(res, 400, {ok:false, error:'Name required'}); return; }
        json(res, 200, {ok:true, name});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    // "Send the nearest drone there": picks the drone that can get to room point x,y soonest
    // (connected, this person may fly it, battery ≥ 25%), counting a takeoff as 100 cm extra,
    // and the spot 100 cm short of the target on the way in.
    if (path === '/api/nearest') {
      try {
        const body = await readJson(req) as {x?: unknown; y?: unknown; stopCm?: unknown};
        if (typeof body?.x !== 'number' || typeof body?.y !== 'number') { json(res, 400, {ok:false, error:'x and y required'}); return; }
        const tx = body.x, ty = body.y;
        const stopCm = typeof body.stopCm === 'number' && body.stopCm >= 50 && body.stopCm <= 300 ? body.stopCm : 100;
        const options = [...drones].flatMap(([id, drone]) => {
          const snap = drone.snapshot();
          const why = refusal(id) ?? pilots.check(sid, id, 'go_to') ?? (!snap.connected ? 'not connected' : (snap.battery ?? 0) < 25 ? `battery ${snap.battery ?? '?'}%` : null);
          const pose = drone.map().pose;
          const distance = Math.hypot(tx - pose.x, ty - pose.y);
          return [{id, why, distance:Math.round(distance), cost:distance + (snap.flight === 'flying' ? 0 : 100), flying:snap.flight === 'flying', pose}];
        });
        const usable = options.filter((o) => !o.why).sort((a, b) => a.cost - b.cost);
        const best = usable[0];
        if (!best) { json(res, 200, {ok:false, error:`No drone can go: ${options.map((o) => `${label(o.id)} ${o.why}`).join('; ') || 'none configured'}`}); return; }
        const k = best.distance > stopCm ? (best.distance - stopCm) / best.distance : 0;
        const stop = {x:Math.round(best.pose.x + (tx - best.pose.x) * k), y:Math.round(best.pose.y + (ty - best.pose.y) * k)};
        json(res, 200, {ok:true, drone:best.id, name:label(best.id), distanceCm:best.distance, flying:best.flying, stop, target:{x:tx, y:ty}, others:options.filter((o) => o.id !== best.id).map((o) => ({id:o.id, distanceCm:o.distance, why:o.why}))});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    if (path === '/api/command') {
      // Every command is timed: the server prints it and the result carries durationMs.
      const started = Date.now();
      let asked = {droneId:'?', action:'?'};
      const timed = (r: http.ServerResponse, status: number, value: unknown) => {
        const v = value as {ok?: boolean; error?: string};
        const ms = Date.now() - started;
        if (status === 200 && v && typeof v === 'object') {
          console.log(`${new Date().toLocaleTimeString()} ${label(asked.droneId)} · ${asked.action} ${v.ok ? 'ok' : `failed (${v.error ?? ''})`} ${(ms / 1000).toFixed(1)} s`);
          value = {...v, durationMs:ms};
        }
        json(r, status, value);
      };
      try {
        const body = await readJson(req) as {droneId?: unknown; action?: unknown};
        const id = typeof body?.droneId === 'string' ? body.droneId : '';
        asked = {droneId:id || '?', action:String(body?.action ?? '?')};
        const action = typeof body?.action === 'string' ? body.action : '';
        const plain = Object.keys(body).length === 2;
        const drone = drones.get(id);
        const elsewhere = claims?.elsewhere().find((e) => e.drone.id === id);
        const ownership = claims?.ownership(id) ?? null;
        const blocked = refusal(id);
        const person = pilots.check(sid, id, action);
        if (drones.size === 0 && !elsewhere) timed(res, 200, {ok:false, mode:'real', error:NO_DRONES});
        else if (!drone) timed(res, 200, {ok:false, mode:'real', error:elsewhere ? describeElsewhere(label(id), elsewhere.owner, elsewhere.drone) : 'Invalid droneId'});
        // Another laptop holds it: its battery and flight come from that laptop's announcements.
        else if (ownership?.state === 'other' && action === 'status' && plain) {
          const {flight, battery, connected} = ownership.drone;
          timed(res, 200, {ok:true, mode:'real', action:'status', drone:{...drone.snapshot(), flight, battery, connected, heightCm:null, heading:null}, note:blocked});
        }
        // Another laptop's drone (or one not yet confirmed as ours) gets nothing, emergency
        // included. Only a takeoff may ask for it: a landed, idle drone is then handed over.
        else if (blocked && !(TAKEOFF.has(action) && claims)) timed(res, 200, {ok:false, mode:'real', error:blocked});
        // Someone else here flies it: only status, look and photo.
        else if (person) timed(res, 200, {ok:false, mode:'real', error:person});
        else {
          // A takeoff makes this person the pilot before anything is sent, so a second takeoff
          // arriving meanwhile is refused.
          pilots.begin(sid, id, action, drone.snapshot().flight);
          lockChanged();
          try {
            const handover = blocked ? await claims!.request(id) : null;
            if (handover) timed(res, 200, {ok:false, mode:'real', error:handover});
            // stop must reach the drone while a move is still running, so it skips the queue.
            else if (action === 'stop' && plain) timed(res, 200, await drone.stop());
            else if (action === 'emergency' && plain) timed(res, 200, await drone.killMotors());
            else if (action === 'photo' && plain) timed(res, 200, await takePhoto(id));
            // A spoken "land" is always sent to the drone, whatever the server believes about its
            // state (a lost takeoff reply must never block a landing), and it skips the queue.
            else if (action === 'land' && plain) timed(res, 200, await drone.forceLand());
            else timed(res, 200, await drone.execute(body));
          } finally {
            pilots.end(id);
            pilots.settle(id, drone.snapshot().flight, drone.busy);
            lockChanged();
          }
        }
      }
      catch { timed(res, 400, {ok:false, mode:'real', error:'Invalid request'}); }
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
  // Top-down room map: every drone flown here, in the shared room frame.
  if (req.method === 'GET' && path === '/api/map') {
    json(res, 200, {frame:'cm; x = toward the wall both drones faced at the start, y = left', drones:[...drones].filter(([id]) => refusal(id) === null).map(([id, drone]) => ({id, ...drone.map()}))});
    return;
  }
  if (req.method === 'GET' && path === '/api/drones') { json(res, 200, {drones:droneViews().map((v) => {
    // The pilot here; another laptop's pilot is in owner.pilot.
    const pilot = drones.has(String(v.id)) ? pilots.pilotOf(String(v.id)) : null;
    return {...v, pilot:pilot ? {name:pilot, me:pilots.isPilot(sid, String(v.id))} : null};
  }), me:claims?.name ?? null, clients:claims?.clients() ?? [], claimsError, pilot:{name:pilots.nameOf(sid), online:pilots.online()}}); return; }
  if (req.method !== 'GET' || !files[path]) { res.writeHead(404).end(); return; }
  try { const file = files[path]; res.writeHead(200, {'Content-Type':types[extname(file)]}).end(await readFile(join(root,'public',file))); }
  catch { res.writeHead(500).end(); }
}
const server = http.createServer((req, res) => { void handle(req, res, false); });
// Plain HTTP page on the LAN that only hands out the public root certificate and the steps to
// trust it. Nothing else is served here (no drones, no key).
const certPort = Number(process.env.PHONE_CERT_PORT ?? port - 1);
if (phone) {
  const steps = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Metoera certificate</title><style>body{font:16px/1.5 -apple-system,Arial,sans-serif;margin:0;padding:24px 16px;max-width:560px;color:#222;background:#fff}a.button{display:block;text-align:center;background:#111;color:#fff;padding:14px;border-radius:12px;text-decoration:none;margin:18px 0}li{margin:8px 0}small{color:#777}</style></head><body><h1>Trust Metoera on this phone</h1><p>Once per phone, so Safari opens the drone page and allows the microphone.</p><a class="button" href="/metoera-ca.cer">1. Download the certificate</a><h2>iPhone</h2><ol><li>Tap <b>Allow</b> when asked to download a configuration profile.</li><li>Settings → <b>Profile Downloaded</b> → Install (passcode) → Install.</li><li>Settings → General → About → <b>Certificate Trust Settings</b> → turn on <b>Metoera local CA</b>.</li><li>Open the link with the key the Mac printed (https://${lanAddress}:${phonePort}/?key=…).</li></ol><h2>Android</h2><ol><li>Settings → Security → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b> → pick metoera-ca.cer.</li><li>Open the link with the key.</li></ol><p><small>The certificate only works for local network addresses (192.168.x.x, 10.x.x.x) and expires in 90 days. Remove it any time from the same settings.</small></p></body></html>`;
  http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/metoera-ca.cer') res.writeHead(200, {'Content-Type':'application/x-x509-ca-cert', 'Content-Disposition':'attachment; filename="metoera-ca.cer"'}).end(phone.caDer);
    else if (path === '/') res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(steps);
    else res.writeHead(404).end();
  }).listen(certPort, '0.0.0.0', () => console.log(`Phone certificate (once per phone): http://${lanAddress}:${certPort}/`));
  https.createServer({cert:phone.cert, key:phone.certKey}, (req, res) => { void handle(req, res, true); })
    .listen(phonePort, '0.0.0.0', () => console.log(`Phone (same Wi-Fi): https://${lanAddress}:${phonePort}/?key=${phone.key}\n  First time on a phone: open the certificate page (link above) and trust it.`));
}
server.listen(port, '127.0.0.1', () => console.log(`Metoera: http://localhost:${port} (${drones.size ? [...drones.keys()].map((id) => `${id} at ${process.env[`${id.toUpperCase()}_IP`]}`).join(', ') : NO_DRONES})${claims ? `\n  This laptop is "${claims.name}" to the others (UDP ${claimsPort}). A drone flown from another laptop stays see-only; a landed one moves here when someone takes off with it.` : ''}`));
// Check this laptop's drone links in the background so the page shows whether each one is
// connected before anyone gives a command. Read-only: command, sn?, streamon. A drone another
// laptop owns is skipped (and the link refuses to send to it anyway).
for (const [id, drone] of drones) {
  const check = () => { if (refusal(id) === null) void drone.probe(); };
  check();
  setInterval(check, 5000).unref();
}
// Every second: a drone back on the ground with nothing running is free again; one whose pilot
// has been gone for 15 s while it flies is landed by the server (retried every 5 s), because
// nobody else may land it.
const goneLanding = new Map<string, number>();
setInterval(() => {
  for (const [id, drone] of drones) {
    const {flight} = drone.snapshot();
    if (pilots.settle(id, flight, drone.busy)) { goneLanding.delete(id); continue; }
    if (flight !== 'flying' || !pilots.absent(id) || refusal(id) !== null) continue;
    if (Date.now() - (goneLanding.get(id) ?? 0) < 5000) continue;
    goneLanding.set(id, Date.now());
    console.log(`${pilots.pilotOf(id)} is gone: landing ${label(id)}`);
    void drone.forceLand();
  }
  lockChanged(); // telemetry also moves the lock (h above 20 cm: flying; on the ground for 2 s: landed)
}, 1000).unref();
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
