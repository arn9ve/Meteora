import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import { readFile, writeFile, mkdir, chmod, appendFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { RealTello, type Detections, type DepthView } from './src/tello.ts';
import { loadPlan, loadConfig, saveConfig, estimateFromPose, floorFromMount, homography, calibrationError, project, inside, feet, sanitizeObjects, resolveObjectPlace, parseVisionJson, surfaceHeightAt, planRoute, type Point, type RoomConfig } from './src/room.ts';
import { missionGoTo } from './src/mission.ts';
import { runCalibration, summary as calibrationSummary, type CalibrationReport } from './src/calibration.ts';
import { landmarksOf, expectedInView, bearingOfX, solvePose, localizePrompt, parseSeen } from './src/landmarks.ts';
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
// The room (src/room.ts): floor plan from ROOM_PLAN (default room/capannone-gragnani.json) and
// where drones, phones and red zones are, in .room.json (git-ignored, set on the Room panel).
// When a drone is placed on the plan, that spot is its start; otherwise TELLO_START / RMTT_START.
const planPath = process.env.ROOM_PLAN ?? join(dirname(fileURLToPath(import.meta.url)), 'room', 'capannone-gragnani.json');
const roomPath = join(dirname(fileURLToPath(import.meta.url)), '.room.json');
const plan = await loadPlan(planPath);
const room: RoomConfig = await loadConfig(roomPath);
function startOf(prefix: string): {x: number; y: number; heading: number} {
  const placed = room.drones[prefix === 'RMTT' ? 'rmtt' : 'tello'];
  if (placed) return {x:placed.x * 100, y:placed.y * 100, heading:placed.heading};
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
// How each drone's telemetry reads (units and axes, learned in flight; see src/odometry.ts), kept
// across restarts so the next flight is tracked from its first second.
const odometryPath = join(root, '.odometry.json');
const odometryFits: Record<string, unknown> = await readFile(odometryPath, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => ({}));
function saveOdometryFit(id: string, fit: unknown) { odometryFits[id] = fit; void writeFile(odometryPath, JSON.stringify(odometryFits, null, 2)).catch(() => undefined); }
// Flight log: every telemetry sample and command, one JSON line each, in flights/<drone>-<day>.jsonl.
const flightsDir = join(root, 'flights');
const flightBuffers = new Map<string, string[]>();
function flightLog(id: string, event: Record<string, unknown>) {
  const lines = flightBuffers.get(id) ?? []; lines.push(JSON.stringify({at:new Date().toISOString(), ...event})); flightBuffers.set(id, lines);
}
setInterval(() => {
  for (const [id, lines] of flightBuffers) {
    if (!lines.length) continue;
    const text = lines.splice(0).join('\n') + '\n';
    void mkdir(flightsDir, {recursive:true}).then(() => appendFile(join(flightsDir, `${id}-${new Date().toISOString().slice(0, 10)}.jsonl`), text)).catch(() => undefined);
  }
}, 1000).unref();
// The decision model: a fast Grok call, text only, that picks the next step of a flight (src/decision.ts).
const decisionModel = process.env.DECISION_MODEL ?? visionModel;
const decisionOn = process.env.DECISION_MODE !== '0';
async function askDecision(prompt: string): Promise<string | null> {
  if (!process.env.XAI_API_KEY) return null;
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method:'POST', signal:AbortSignal.timeout(5000),
      headers:{Authorization:`Bearer ${process.env.XAI_API_KEY}`, 'Content-Type':'application/json'},
      body:JSON.stringify({model:decisionModel, max_tokens:80, temperature:0, messages:[{role:'user', content:prompt}]}),
    });
    if (!response.ok) return null;
    const data = await response.json() as {choices?: {message?: {content?: string}}[]};
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}
// The last decision of each drone, for the live map.
const decisionsLive = new Map<string, {step: number; action: string; reason: string; by: string; overruled: string | null; ms: number; at: number}>();
// Calibration tests: the latest report of each drone (also saved in flights/), and its progress live.
const calibrations = new Map<string, CalibrationReport>();
const calibrationRunning = new Map<string, string[]>();
async function calibrate(id: string, drone: RealTello, body: Record<string, unknown>) {
  const lines: string[] = []; calibrationRunning.set(id, lines);
  try {
    const report = await runCalibration(id, drone, {sizeCm:typeof body.sizeCm === 'number' ? body.sizeCm : 50, photo:body.photo === true, onNote:(l) => { lines.push(l); console.log(`${label(id)} calibration · ${l}`); }});
    calibrations.set(id, report);
    await saveCalibration(report);
    return {ok:report.ok, mode:'real', action:'calibrate', ...(report.error ? {error:report.error} : {}), summary:calibrationSummary(report), report};
  } finally { calibrationRunning.delete(id); }
}
async function saveCalibration(r: CalibrationReport) {
  await mkdir(flightsDir, {recursive:true}).catch(() => undefined);
  await writeFile(join(flightsDir, `calibration-${r.drone}-${r.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(r, null, 2)).catch(() => undefined);
}

/** go_to in the air: a mission decided step by step (model + rules), along the route of the plan. */
async function decidedGoTo(id: string, drone: RealTello, body: Record<string, unknown>) {
  const routed = routeGoTo(drone, body);
  if ('error' in routed) return {ok:false, mode:'real', error:routed.error};
  const map = drone.map() as {places: Record<string, {x: number; y: number}>};
  const name = typeof routed.place === 'string' ? routed.place.trim().toLowerCase() : null;
  const to = name ? map.places[name] : typeof routed.x === 'number' && typeof routed.y === 'number' ? {x:routed.x, y:routed.y} : null;
  if (!to || !plan) return drone.execute(routed);
  const result = await missionGoTo(id, drone, {x:to.x, y:to.y, name:typeof body.place === 'string' ? body.place : `(${to.x}, ${to.y})`}, {
    plan, objects:room.objects, people:() => redzone.people, decide:process.env.XAI_API_KEY ? askDecision : null,
    log:(event) => flightLog(id, event),
    onStep:(info) => { decisionsLive.set(id, {...info, at:Date.now()}); console.log(`${new Date().toLocaleTimeString()} ${label(id)} · step ${info.step}: ${info.action} (${info.by}${info.overruled ? `, overruled: ${info.overruled}` : ''}) ${info.reason} ${info.ms} ms`); },
  });
  return {mode:'real', ...result, drone:drone.snapshot()};
}

/**
 * Where is the drone really: one photo, the pillars and tables of the plan that should be in view
 * from the estimated pose, Grok vision saying which it sees and where in the picture, the depth
 * model (when running) for how far. Pose and result in room cm.
 */
async function localizeFrom(id: string, pose: {x: number; y: number; heading: number}) {
  const image = await readFrame(id);
  if (!image) return {ok:false as const, error:'No photo from the camera (is metoera-vision running?)'};
  const expected = expectedInView(landmarksOf(plan, room.objects), {x:pose.x / 100, y:pose.y / 100, heading:pose.heading}).slice(0, 8);
  if (!expected.length) return {ok:false as const, error:'From here no pillar or table of the plan should be in view: turn toward the room and try again'};
  const answer = await askVision([image], localizePrompt(expected));
  const seen = parseSeen(answer, expected);
  if (!seen) return {ok:false as const, error:'Grok vision did not answer'};
  const note = /"note"\s*:\s*"([^"]{0,160})"/.exec(answer ?? '')?.[1] ?? '';
  const depth = await readDepth(id);
  const obs = seen.filter((s) => s.confidence >= 0.5).flatMap((s) => {
    const l = expected.find((e) => e.id === s.id)!;
    const bearing = bearingOfX(s.x);
    if (Math.abs(bearing - l.bearingDeg) > 25) return []; // too far from where it should be: likely another one
    const col = depth?.columns?.length ? depth.columns.reduce((a, c) => (Math.abs(c.bearing_deg - bearing) < Math.abs(a.bearing_deg - bearing) ? c : a)) : null;
    // The depth is to the near face; the plan has the centre.
    const distanceM = col && col.depth_m > 0.3 ? col.depth_m + Math.min(l.w, l.d) / 2 : null;
    return [{x:l.x, y:l.y, bearingDeg:bearing, distanceM, id:l.id}];
  });
  const sol = solvePose(pose.heading, obs);
  if (!sol) return {ok:false as const, error:obs.length ? `Saw only ${obs[0].id} and no distance: not enough to tell the position` : `Grok vision saw none of the expected pillars or tables${note ? ` (${note})` : ''}`};
  if (sol.residualM > 0.6) return {ok:false as const, error:'What Grok saw does not fit together: position unchanged'};
  return {ok:true as const, x:Math.round(sol.x * 100), y:Math.round(sol.y * 100), seen:obs.map((o) => o.id), residualCm:Math.round(sol.residualM * 100), note};
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
  return new RealTello({id, host, expectedSerial:process.env[`${prefix}_SETUP_SERIAL`], port:Number(process.env[`${prefix}_PORT`] ?? 8889), localPort:Number(process.env.TELLO_LOCAL_PORT ?? 8889), statePort:Number(process.env[`${prefix}_STATE_PORT`] ?? process.env.TELLO_STATE_PORT ?? 8890), maxMoveCm:process.env.TELLO_MAX_MOVE_CM ? Number(process.env.TELLO_MAX_MOVE_CM) : undefined, vision:() => readVision(id), frame:() => readFrame(id), askVision, start:startOf(prefix), depth:() => readDepth(id), mayTalk:() => mayTalk(id), surfaceAt:(x, y) => surfaceHeightAt(room.objects, x / 100, y / 100), odometryFit:odometryFits[id], onOdometryFit:(fit) => saveOdometryFit(id, fit), flightLog:(event) => flightLog(id, event), cameraAlwaysOn:process.env.CAMERA_ALWAYS_ON === '1', localize:(pose) => localizeFrom(id, pose)});
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
const files: Record<string, string> = {'/':'index.html','/app.js':'app.js','/style.css':'style.css','/room3d.js':'room3d.js','/vendor/three.module.min.js':'vendor/three.module.min.js','/vendor/OrbitControls.js':'vendor/OrbitControls.js'};
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
    await drones.get(id)?.ensureCamera(); // the camera is off by default
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
  // The camera is off by default: on while somebody watches.
  const release = drones.get(id)?.holdCamera();
  res.on('close', () => release?.());
  await proxyStream(`${visionUrl}/stream?drone=${encodeURIComponent(id)}`, res);
}
async function proxyStream(source: string, res: http.ServerResponse) {
  try {
    const upstream = await fetch(source);
    if (!upstream.ok || !upstream.body) { res.writeHead(503).end(); return; }
    res.writeHead(200, {'Content-Type':upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace', 'Cache-Control':'no-store'});
    const reader = upstream.body.getReader();
    res.on('close', () => { void reader.cancel().catch(() => undefined); });
    for (;;) { const {done, value} = await reader.read(); if (done) break; if (!res.write(value)) await new Promise((r) => res.once('drain', r)); }
    res.end();
  } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
}
// ---- Phone cameras (metoera-redzone, Masoud) on the room plan ----
// The server reads the phones every second. A calibrated phone (4 clicks on the Room panel)
// turns the feet of every person it sees into a spot on the plan; a person inside a red zone drawn
// on the plan becomes an event (once on entering, then not again for 30 s), which the pages tell
// Grok about and, with auto-send on, use to send the nearest drone to that person.
const redzoneUrl = (process.env.REDZONE_URL ?? 'http://127.0.0.1:18791').replace(/\/$/, '');
const redzonePhonePort = Number(process.env.REDZONE_PHONE_PORT ?? 18792);
type RedzoneSlot = {id: string; name?: string; online: boolean; watching: boolean; armed: boolean; personScore?: number | null; lastIntrusionAt: number | null; hasPreview: boolean; joined: boolean; lens?: string; people?: {x: number; y: number; w: number; h: number; score: number | null}[]};
type Person = {slot: string; x: number; y: number; score: number | null; approx?: boolean};
type ZoneEvent = {id: string; zone: string; name: string; at: number; x: number; y: number; claimedBy: string | null};
const redzone = {available:false, slots:[] as RedzoneSlot[], people:[] as Person[], events:[] as ZoneEvent[]};
const zoneState = new Map<string, {occupied: boolean; lastEventAt: number}>();
const ZONE_REPEAT_MS = 30_000;
async function pollRedzone() {
  try {
    const response = await fetch(`${redzoneUrl}/api/slots`, {signal:AbortSignal.timeout(1500)});
    const data = await response.json() as {slots?: RedzoneSlot[]};
    if (!Array.isArray(data.slots)) throw new Error('bad slots');
    redzone.available = true;
    redzone.slots = data.slots;
  } catch { redzone.available = false; redzone.slots = []; }
  // People on the plan from every connected phone: exact with a calibration (4 clicks), otherwise
  // estimated from where the phone stands and faces on the plan and how big the person looks.
  const people: Person[] = [];
  for (const slot of redzone.slots) {
    const cam = room.cameras[slot.id];
    if (!cam || !slot.online) continue;
    const placed = typeof cam.x === 'number' && typeof cam.y === 'number' && typeof cam.heading === 'number';
    if (!cam.h && !placed) continue;
    for (const box of slot.people ?? []) {
      const [u, v] = feet(box);
      const mounted = placed && typeof cam.z === 'number' && cam.z > 0 && typeof cam.tilt === 'number';
      const p = cam.h ? project(cam.h, u, v) : (mounted ? floorFromMount({x:cam.x!, y:cam.y!, heading:cam.heading!, z:cam.z!, tilt:cam.tilt!}, box, slot.lens) : null) ?? estimateFromPose({x:cam.x!, y:cam.y!, heading:cam.heading!}, box, slot.lens);
      if (p && plan && p[0] > plan.bounds.min[0] - 2 && p[0] < plan.bounds.max[0] + 2 && p[1] > plan.bounds.min[1] - 2 && p[1] < plan.bounds.max[1] + 2) {
        people.push({slot:slot.id, x:Math.round(p[0] * 100) / 100, y:Math.round(p[1] * 100) / 100, score:box.score, ...(cam.h ? {} : {approx:true})});
      }
    }
  }
  redzone.people = people;
  for (const zone of room.zones) {
    const who = people.find((p) => inside([p.x, p.y], zone.points));
    const state = zoneState.get(zone.id) ?? {occupied:false, lastEventAt:0};
    if (who && !state.occupied && Date.now() - state.lastEventAt > ZONE_REPEAT_MS) {
      state.lastEventAt = Date.now();
      redzone.events.push({id:`${zone.id}-${state.lastEventAt}`, zone:zone.id, name:zone.name, at:state.lastEventAt, x:who.x, y:who.y, claimedBy:null});
      if (redzone.events.length > 20) redzone.events.shift();
      console.log(`${new Date().toLocaleTimeString()} ${zone.name}: person at (${who.x.toFixed(2)}, ${who.y.toFixed(2)}) m, seen by phone ${who.slot}${who.approx ? ' (estimate, phone not calibrated)' : ''}`);
    }
    state.occupied = Boolean(who);
    zoneState.set(zone.id, state);
  }
}
void pollRedzone();
setInterval(() => { void pollRedzone(); }, 1000).unref();
async function redzonePhoneLink(slot: string): Promise<string | null> {
  const key = (await readFile(join(root, '..', 'metoera-redzone', '.phone', 'key.txt'), 'utf8').catch(() => '')).trim();
  return key && lanAddress ? `https://${lanAddress}:${redzonePhonePort}/?key=${key}&slot=${slot}` : null;
}
/** Latest pad-nav mission state from metoera-redzone (cam1 → Black hop). */
let padNavState: unknown = null;
async function pollPadNav() {
  try {
    const response = await fetch(`${redzoneUrl}/api/pad-nav`, {signal:AbortSignal.timeout(1500)});
    if (!response.ok) { padNavState = null; return; }
    padNavState = await response.json();
  } catch { padNavState = null; }
}
void pollPadNav();
setInterval(() => { void pollPadNav(); }, 1000).unref();

// One Grok vision call per phone every 5 s at most; pages asking at the same time share it.
const phoneAIs = new Map<string, {at: number; result: Promise<unknown>}>();
function phoneAI(slot: string): Promise<unknown> {
  const cached = phoneAIs.get(slot);
  if (cached && Date.now() - cached.at < 5000) return cached.result;
  const result = (async () => {
    const s = redzone.slots.find((x) => x.id === slot);
    if (!s?.online || !s.hasPreview) return {ok:false, error:'Phone offline'};
    let image: Buffer;
    try {
      const upstream = await fetch(`${redzoneUrl}/api/slots/${slot}/preview.jpg`, {signal:AbortSignal.timeout(3000)});
      if (!upstream.ok) return {ok:false, error:'Phone offline'};
      image = Buffer.from(await upstream.arrayBuffer());
    } catch { return {ok:false, error:'Phone offline'}; }
    const answer = await askVision([image], 'This is a security camera picture of a room. Reply with ONLY JSON, no other text: {"people": <number of people visible>, "summary": "<at most 20 words: how many people, what they are doing, where in the picture>"}');
    const parsed = parseVisionJson(answer);
    return parsed ? {ok:true, ...parsed, at:Date.now()} : {ok:false, error:'Vision unavailable'};
  })();
  phoneAIs.set(slot, {at:Date.now(), result});
  return result;
}

/**
 * go_to by name or coordinates becomes a route around tables, pillars and walls: the server knows
 * the room, the drone only follows waypoints (`via`). A table name is resolved to a spot next to it.
 * A target above a table (home, when it took off from one) also gets a safe height over it.
 */
function routeGoTo(drone: RealTello, body: Record<string, unknown>): Record<string, unknown> | {error: string} {
  const placed = room.drones[String(body.droneId)];
  if (plan && placed && !placed.facingConfirmed) return {error:`${DRONE_NAMES[String(body.droneId)] ?? 'The drone'} does not know which way it faces in the room: set the direction of its camera on the plan (Room, select the drone, turn the arrow) and confirm it. Short moves like "forward 1 metre" still work.`};
  let command: Record<string, unknown> = body;
  const map = drone.map() as {pose: {x: number; y: number}; places: Record<string, {x: number; y: number}>};
  if (typeof body.place === 'string' && !drone.hasPlace(body.place)) {
    const target = resolveObjectPlace(room.objects, body.place, map.pose);
    if (target) { const {place: _place, ...rest} = body; command = {...rest, ...target}; }
  }
  if (!plan) return command;
  const name = typeof command.place === 'string' ? command.place.trim().toLowerCase() : null;
  const to = name ? map.places[name] : typeof command.x === 'number' && typeof command.y === 'number' ? {x:command.x, y:command.y} : null;
  if (!to) return command;
  const route = planRoute(plan, room.objects, [map.pose.x / 100, map.pose.y / 100], [to.x / 100, to.y / 100]);
  if (route === null) return {error:'No safe way there: tables, pillars or walls block every path'};
  const via = route.slice(0, -1).map(([x, y]) => [Math.round(x * 100), Math.round(y * 100)]);
  const under = surfaceHeightAt(room.objects, to.x / 100, to.y / 100);
  const minHeight = typeof under === 'number' && under > 0 ? Math.min(250, under + 50) : undefined;
  // The route already goes around tables, so no climb over them; only over a table it ends above.
  const {minHeightCm: _straightLineClimb, ...rest} = command;
  return {...rest, ...(via.length ? {via} : {}), ...(minHeight ? {minHeightCm:minHeight} : {})};
}

async function redzoneView() {
  const slotIds = ['1', '2', '3'];
  const pad = padNavState as {state?: unknown; missions?: {cam1?: unknown}} | null;
  return {
    available:redzone.available, console:`${redzoneUrl}/console`,
    slots:await Promise.all(slotIds.map(async (id) => {
      const s = redzone.slots.find((x) => x.id === id);
      return {...(s ?? {id, online:false}), people:undefined, peopleCount:s?.people?.length ?? 0, calibrated:Boolean(room.cameras[id]?.h), link:await redzonePhoneLink(id)};
    })),
    people:redzone.people,
    events:redzone.events.slice(-10).map((e) => ({...e, claimed:e.claimedBy !== null})),
    padNav: pad ? {missions:pad.missions ?? null, state:pad.state ?? null} : null,
  };
}

async function redzonePadNav(path: string, body: unknown) {
  try {
    const response = await fetch(`${redzoneUrl}${path}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body ?? {}),
      signal:AbortSignal.timeout(5000),
    });
    return await response.json() as unknown;
  } catch { return {ok:false, error:'Camera service unreachable'}; }
}
// Camera commands from the Mac (watch on/off, lens, sensitivity, ARM), passed to the phone.
async function redzoneCommand(slot: string, command: unknown) {
  try {
    const response = await fetch(`${redzoneUrl}/api/slots/${slot}/command`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command}), signal:AbortSignal.timeout(3000)});
    return await response.json() as unknown;
  } catch { return {ok:false, error:'Camera service unreachable'}; }
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
// The display name, shared by every tab. Separate from the session id: a new tab can arrive
// without metoera_pilot and must not be asked again.
function nameFromCookie(req: http.IncomingMessage): string {
  const raw = /(?:^|;\s*)metoera_name=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return ''; }
}
function rememberNameCookie(res: http.ServerResponse, name: string, secure: boolean) {
  res.appendHeader('Set-Cookie', `metoera_name=${encodeURIComponent(name)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`);
}
// Each browser is a session (cookie); its name is what the lock goes by (src/pilots.ts).
function sessionOf(req: http.IncomingMessage, res: http.ServerResponse, secure: boolean): string {
  let id = /(?:^|;\s*)metoera_pilot=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
  if (!id) {
    id = randomBytes(16).toString('hex');
    // Lax so a new tab opened from another page still sends it. Strict would omit it, and this
    // response would replace the old session with an empty one.
    res.appendHeader('Set-Cookie', `metoera_pilot=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
  }
  pilots.seen(id);
  if (!pilots.nameOf(id)) {
    const named = nameFromCookie(req);
    if (named) pilots.setName(id, named);
  }
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
  const camera = /^\/cameras\/([123])\.mjpeg$/.exec(path);
  if (req.method === 'GET' && camera) { await proxyStream(`${redzoneUrl}/api/slots/${camera[1]}/preview.mjpeg`, res); return; }
  // One still picture of a phone, for the calibration clicks.
  const still = /^\/cameras\/([123])\.jpg$/.exec(path);
  if (req.method === 'GET' && still) {
    try {
      const upstream = await fetch(`${redzoneUrl}/api/slots/${still[1]}/preview.jpg`, {signal:AbortSignal.timeout(3000)});
      if (!upstream.ok) { res.writeHead(404).end(); return; }
      res.writeHead(200, {'Content-Type':'image/jpeg', 'Cache-Control':'no-store'}).end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(503).end(); }
    return;
  }
  // The drones live, 10 times a second, for the map (server-sent events).
  if (req.method === 'GET' && path === '/api/live') {
    res.writeHead(200, {'Content-Type':'text/event-stream', 'Cache-Control':'no-store', Connection:'keep-alive'});
    const send = () => res.write(`data: ${JSON.stringify({t:Date.now(), drones:[...drones].filter(([id]) => refusal(id) === null).map(([id, d]) => ({...d.live(), decision:decisionsLive.get(id) ?? null}))})}\n\n`);
    send();
    const timer = setInterval(send, 100);
    req.on('close', () => clearInterval(timer));
    return;
  }
  // The latest calibration test of a drone, and its progress while it runs.
  if (req.method === 'GET' && path === '/api/calibration') {
    const id = url.searchParams.get('drone') ?? '';
    const r = calibrations.get(id) ?? null;
    json(res, 200, {running:calibrationRunning.get(id) ?? null, report:r, summary:r ? calibrationSummary(r) : null});
    return;
  }
  // Preview of the way a drone would fly to a table or place (nothing moves).
  if (req.method === 'GET' && path === '/api/route') {
    const droneId = url.searchParams.get('drone') ?? '', drone = drones.get(droneId);
    if (!drone) { json(res, 400, {ok:false, error:'drone required'}); return; }
    const cmd = routeGoTo(drone, {droneId, action:'go_to', place:url.searchParams.get('place') ?? ''});
    if ('error' in cmd) { json(res, 200, {ok:false, error:cmd.error}); return; }
    const pose = (drone.map() as {pose: {x: number; y: number}}).pose;
    const end = typeof cmd.x === 'number' ? [cmd.x, cmd.y] : null;
    json(res, 200, {ok:true, from:[pose.x, pose.y], via:cmd.via ?? [], to:end, minHeightCm:cmd.minHeightCm ?? null});
    return;
  }
  // What a phone sees, in words (Grok vision on its still picture), only when the page asks.
  const ai = /^\/api\/cameras\/([123])\/ai$/.exec(path);
  if (req.method === 'GET' && ai) { json(res, 200, await phoneAI(ai[1])); return; }
  const video = /^\/video\/([a-z]+)$/.exec(path);
  // Only this laptop's drones stream here; another laptop's drone sends its video to that laptop.
  if (req.method === 'GET' && video && drones.has(video[1]) && refusal(video[1]) === null) { await proxyVideo(video[1], res); return; }
  if (req.method === 'POST' && ['/session','/api/command','/api/emergency','/api/pilot','/api/nearest','/api/room/drone','/api/room/camera','/api/room/zones','/api/room/objects','/api/cameras/command','/api/redzone/claim','/api/pad-nav/claim','/api/pad-nav/phase','/api/calibration/measured'].includes(path)) {
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
        rememberNameCookie(res, name, remote);
        json(res, 200, {ok:true, name});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    // "Send the nearest drone there": picks the drone that can get to room point x,y soonest
    // (connected, this person may fly it, battery ≥ 25%), counting a takeoff as 100 cm extra,
    // and the spot 100 cm short of the target on the way in.
    // ---- Room panel: place drones and phones, calibrate phones, draw zones ----
    if (path === '/api/room/drone') {
      try {
        const body = await readJson(req) as {id?: unknown; x?: unknown; y?: unknown; heading?: unknown; remove?: unknown; facingConfirmed?: unknown};
        const id = String(body?.id ?? '');
        const drone = drones.get(id);
        if (body.remove === true && drone) {
          if (drone.snapshot().flight === 'flying' || drone.busy) { json(res, 200, {ok:false, error:'Land the drone before moving it on the plan'}); return; }
          delete room.drones[id]; await saveConfig(roomPath, room); json(res, 200, {ok:true}); return;
        }
        if (!drone || typeof body.x !== 'number' || typeof body.y !== 'number') { json(res, 400, {ok:false, error:'id, x, y (m) required'}); return; }
        const heading = typeof body.heading === 'number' ? body.heading : room.drones[id]?.heading ?? 90;
        const refused = drone.placeAt({x:body.x * 100, y:body.y * 100, heading});
        if (refused) { json(res, 200, {ok:false, error:refused}); return; }
        // Which way the camera looks must be confirmed by a person: it turns every "right" and "left".
        const before = room.drones[id];
        const facingConfirmed = body.facingConfirmed === true || (Boolean(before?.facingConfirmed) && before?.heading === Math.round(heading));
        room.drones[id] = {x:Math.round(body.x * 100) / 100, y:Math.round(body.y * 100) / 100, heading:Math.round(heading), facingConfirmed};
        await saveConfig(roomPath, room);
        json(res, 200, {ok:true, drone:room.drones[id]});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    if (path === '/api/room/camera') {
      try {
        const body = await readJson(req) as {slot?: unknown; x?: unknown; y?: unknown; heading?: unknown; img?: unknown; plan?: unknown; clear?: unknown; remove?: unknown; z?: unknown; tilt?: unknown};
        const slot = String(body?.slot ?? '');
        if (!/^[123]$/.test(slot)) { json(res, 400, {ok:false, error:'slot must be 1, 2 or 3'}); return; }
        if (body.remove === true) { delete room.cameras[slot]; await saveConfig(roomPath, room); json(res, 200, {ok:true}); return; }
        const cam = room.cameras[slot] ?? {};
        if (typeof body.x === 'number' && typeof body.y === 'number') { cam.x = body.x; cam.y = body.y; }
        if (typeof body.heading === 'number') cam.heading = body.heading;
        // Height above the floor (m) and tilt down from level (degrees) of a phone on a stand or wall.
        if (typeof body.z === 'number' && Number.isFinite(body.z)) cam.z = Math.min(6, Math.max(0, Math.round(body.z * 100) / 100));
        if (typeof body.tilt === 'number' && Number.isFinite(body.tilt)) cam.tilt = Math.min(90, Math.max(-30, Math.round(body.tilt)));
        if (body.clear === true) { delete cam.img; delete cam.plan; cam.h = null; }
        const pts = (v: unknown) => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) ? v as Point[] : null;
        const img = pts(body.img), planPts = pts(body.plan);
        let error: number | null = null;
        if (img && planPts) {
          const h = homography(img, planPts);
          if (!h) { json(res, 200, {ok:false, error:'Those points do not work: use 4 points spread out, not in a line'}); return; }
          error = calibrationError(h, img, planPts);
          cam.img = img; cam.plan = planPts; cam.h = h;
        }
        room.cameras[slot] = cam;
        await saveConfig(roomPath, room);
        json(res, 200, {ok:true, camera:{...cam, h:undefined, calibrated:Boolean(cam.h)}, errorM:error});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    if (path === '/api/room/objects') {
      try {
        const body = await readJson(req) as {objects?: unknown};
        if (!Array.isArray(body?.objects)) { json(res, 400, {ok:false, error:'objects required'}); return; }
        room.objects = sanitizeObjects(body.objects);
        await saveConfig(roomPath, room);
        json(res, 200, {ok:true, objects:room.objects});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    if (path === '/api/room/zones') {
      try {
        const body = await readJson(req) as {zones?: unknown};
        const zones = Array.isArray(body?.zones) ? body.zones.slice(0, 12).flatMap((z: unknown, i: number) => {
          const zone = z as {id?: unknown; name?: unknown; points?: unknown};
          const points = Array.isArray(zone?.points) ? zone.points.filter((p): p is Point => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))) : [];
          return points.length >= 3 ? [{id:typeof zone.id === 'string' ? zone.id.slice(0, 20) : `z${i + 1}`, name:typeof zone.name === 'string' && zone.name.trim() ? zone.name.trim().slice(0, 40) : `Zone ${i + 1}`, points:points.slice(0, 40)}] : [];
        }) : null;
        if (!zones) { json(res, 400, {ok:false, error:'zones required'}); return; }
        room.zones = zones;
        await saveConfig(roomPath, room);
        json(res, 200, {ok:true, zones});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    if (path === '/api/cameras/command') {
      try {
        const body = await readJson(req) as {slot?: unknown; command?: unknown};
        const slot = String(body?.slot ?? '');
        const command = body?.command as {type?: unknown} | undefined;
        const allowed = ['watch', 'lens', 'sensitivity', 'arm'];
        if (!/^[123]$/.test(slot) || !command || typeof command.type !== 'string' || !allowed.includes(command.type)) { json(res, 400, {ok:false, error:'slot and command (watch, lens, sensitivity, arm) required'}); return; }
        json(res, 200, await redzoneCommand(slot, command));
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    // The person measured how far from its take-off spot the drone landed after a calibration test.
    if (path === '/api/calibration/measured') {
      try {
        const body = await readJson(req) as {drone?: unknown; cm?: unknown};
        const r = calibrations.get(String(body?.drone ?? ''));
        if (!r) { json(res, 200, {ok:false, error:'No calibration test to complete'}); return; }
        if (typeof body.cm !== 'number' || !Number.isFinite(body.cm) || body.cm < 0 || body.cm > 1000) { json(res, 400, {ok:false, error:'cm: 0 to 1000'}); return; }
        r.measuredLandingCm = Math.round(body.cm);
        await saveCalibration(r);
        json(res, 200, {ok:true, summary:calibrationSummary(r), report:r});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    // Pad-nav: voice UI claims cam1→Black mission and reports Grok describe / phase.
    if (path === '/api/pad-nav/claim') {
      try {
        const body = await readJson(req) as {claimedBy?: unknown; eventId?: unknown};
        const claimedBy = typeof body?.claimedBy === 'string' && body.claimedBy.trim()
          ? body.claimedBy.trim()
          : (pilots.nameOf(sid) || 'voice-ui');
        json(res, 200, await redzonePadNav('/api/pad-nav/claim', {claimedBy, eventId:body?.eventId}));
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    if (path === '/api/pad-nav/phase') {
      try {
        const body = await readJson(req);
        json(res, 200, await redzonePadNav('/api/pad-nav/phase', body));
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
    // Several pages can be open: only the first one to claim an intrusion sends a drone.
    if (path === '/api/redzone/claim') {
      try {
        const body = await readJson(req) as {id?: unknown};
        const event = redzone.events.find((e) => e.id === body?.id);
        if (!event) { json(res, 404, {ok:false, error:'No such event'}); return; }
        if (event.claimedBy && event.claimedBy !== sid) { json(res, 200, {ok:false, error:'Another page is already sending a drone'}); return; }
        event.claimedBy = sid;
        json(res, 200, {ok:true, x:event.x, y:event.y});
      } catch { json(res, 400, {ok:false, error:'Invalid request'}); }
      return;
    }
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
        const body = await readJson(req) as {droneId?: unknown; action?: unknown; place?: unknown};
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
            else if (action === 'calibrate') timed(res, 200, await calibrate(id, drone, body as Record<string, unknown>));
            // A spoken "land" is always sent to the drone, whatever the server believes about its
            // state (a lost takeoff reply must never block a landing), and it skips the queue.
            else if (action === 'land' && plain) timed(res, 200, await drone.forceLand());
            else {
              if (action === 'go_to' && decisionOn && drone.snapshot().flight === 'flying') timed(res, 200, await decidedGoTo(id, drone, body));
              else {
                const command = action === 'go_to' ? routeGoTo(drone, body) : body;
                if ('error' in command) timed(res, 200, {ok:false, mode:'real', error:command.error});
                else timed(res, 200, await drone.execute(command));
              }
            }
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
  // The floor plan and the room setup (drones, phones, zones), for the Room panel.
  if (req.method === 'GET' && path === '/api/room') {
    json(res, 200, {plan, objects:room.objects, note:`Room objects (cm, room frame): ${room.objects.map((o) => `${o.name} at (${Math.round(o.x * 100)}, ${Math.round(o.y * 100)}) ${o.w}x${o.d} m`).join('; ') || 'none'}.`, room:{...room, cameras:Object.fromEntries(Object.entries(room.cameras).map(([k, c]) => [k, {...c, h:undefined, calibrated:Boolean(c.h)}]))}});
    return;
  }
  // Top-down room map: every drone flown here, in the shared room frame.
  if (req.method === 'GET' && path === '/api/map') {
    json(res, 200, {frame:'cm; x = toward the wall both drones faced at the start, y = left', drones:[...drones].filter(([id]) => refusal(id) === null).map(([id, drone]) => ({id, ...drone.map(), placed:Boolean(room.drones[id])})), objects:room.objects, zones:room.zones.map((z) => ({...z, occupied:zoneState.get(z.id)?.occupied ?? false})), people:redzone.people, cameras:Object.fromEntries(Object.entries(room.cameras).map(([k, c]) => [k, {x:c.x, y:c.y, heading:c.heading, calibrated:Boolean(c.h)}]))});
    return;
  }
  if (req.method === 'GET' && path === '/api/drones') { json(res, 200, {drones:droneViews().map((v) => {
    // The pilot here; another laptop's pilot is in owner.pilot.
    const pilot = drones.has(String(v.id)) ? pilots.pilotOf(String(v.id)) : null;
    return {...v, pilot:pilot ? {name:pilot, me:pilots.isPilot(sid, String(v.id))} : null};
  }), me:claims?.name ?? null, clients:claims?.clients() ?? [], claimsError, pilot:{name:pilots.nameOf(sid), online:pilots.online()}, redzone:await redzoneView()}); return; }
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
