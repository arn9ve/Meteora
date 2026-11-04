import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
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
async function readVision(): Promise<Detections | null> {
  try {
    const response = await fetch(`${visionUrl}/detections`, {signal:AbortSignal.timeout(1000)});
    if (!response.ok) return null;
    const data = await response.json() as Detections;
    return Array.isArray(data.objects) ? data : null;
  } catch { return null; }
}
// The real Tello is enabled only when TELLO_IP is set (in .env or .env.tello).
// TELLO_PORT, TELLO_LOCAL_PORT and TELLO_STATE_PORT are only for local tests against a fake drone.
const tello = process.env.TELLO_IP
  ? new RealTello({host:process.env.TELLO_IP, expectedSerial:process.env.TELLO_SETUP_SERIAL, port:Number(process.env.TELLO_PORT ?? 8889), localPort:Number(process.env.TELLO_LOCAL_PORT ?? 8889), statePort:Number(process.env.TELLO_STATE_PORT ?? 8890), maxMoveCm:process.env.TELLO_MAX_MOVE_CM ? Number(process.env.TELLO_MAX_MOVE_CM) : undefined, vision:readVision})
  : null;
const files: Record<string, string> = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
const types: Record<string, string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
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
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const path = req.url ?? '';
  if (req.method === 'POST' && ['/session','/api/command','/api/emergency'].includes(path)) {
    if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) { json(res, 403, {error:'Unauthorized origin'}); return; }
    // Emergency buttons: they skip the command queue and cancel whatever is waiting in it.
    if (path === '/api/emergency') {
      try {
        const body = await readJson(req) as {kind?: unknown};
        if (!tello) json(res, 200, {ok:false, mode:'real', error:'The Tello is not configured.'});
        else if (body?.kind === 'land') json(res, 200, await tello.forceLand());
        else if (body?.kind === 'motors') json(res, 200, await tello.killMotors());
        else json(res, 400, {ok:false, mode:'real', error:'kind must be land or motors'});
      } catch { json(res, 400, {ok:false, mode:'real', error:'Invalid request'}); }
      return;
    }
    if (path === '/api/command') {
      try {
        const body = await readJson(req) as {droneId?: unknown; action?: unknown};
        if (!tello) json(res, 200, {ok:false, mode:'real', error:'The Tello is not configured. Set TELLO_IP in .env.tello and restart the server.'});
        else if (body?.droneId !== 'tello') json(res, 200, {ok:false, mode:'real', error:'Invalid droneId'});
        // stop must reach the drone while a move is still running, so it skips the queue.
        else if (body.action === 'stop' && Object.keys(body).length === 2) json(res, 200, await tello.stop());
        else if (body.action === 'emergency' && Object.keys(body).length === 2) json(res, 200, await tello.killMotors());
        else json(res, 200, await tello.execute(body));
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
  if (req.method === 'GET' && path === '/api/drones') { json(res, 200, {drone:tello?.snapshot() ?? null}); return; }
  if (req.method !== 'GET' || !files[path]) { res.writeHead(404).end(); return; }
  try { const file = files[path]; res.writeHead(200, {'Content-Type':types[extname(file)]}).end(await readFile(join(root,'public',file))); }
  catch { res.writeHead(500).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Metoera: http://localhost:${port} (${tello ? `Tello at ${process.env.TELLO_IP}` : 'no Tello configured: set TELLO_IP in .env.tello'})`));
// Check the drone link in the background so the page can show whether it is connected
// before anyone gives a command. Read-only: command, sn?, streamon.
if (tello) { void tello.probe(); setInterval(() => { void tello.probe(); }, 5000).unref(); }
// If the server stops while the real drone is flying, land it first.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    if (tello?.snapshot().flight === 'flying') { console.log('Landing the Tello before exit…'); await tello.forceLand(); }
    tello?.close();
    process.exit(0);
  });
}
