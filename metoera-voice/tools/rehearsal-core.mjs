// Rehearse an instruction in the simulator before a real flight. This runs the real voice page
// (public/app.js) in Node with a stand-in for the browser: Grok gets the page's own instructions
// and tools, its tool calls go through the page's own dispatch (drone queues, dispatch, the
// red-zone auto-send, the automatic drone updates), and the voice server flies the simulated
// drones. The person's lines go to Grok as text instead of speech.
//
//   1. python -m metoera_sim.serve venue                                        (metoera-sim)
//   2. python -m metoera_vision --port 18800 --drones tello=127.0.0.1:50001,rmtt=127.0.0.1:50002
//   3. node --env-file=../metoera-sim/sim.env server.ts                         (metoera-voice)
//   4. node --env-file=../metoera-sim/sim.env tools/rehearse.mjs "decolla black e vai al tavolo 1" --then "atterra black"
//      (with phones: node --env-file=../metoera-sim/sim.env server.mjs in metoera-redzone first)
//
// Options: --then "<line>" (after Grok and the drones went quiet), --wait S (keep watching S
// seconds after the last line, e.g. for a person to walk into a red zone), --autosend (the page's
// "send the nearest drone when a person enters a zone"), --quiet S (what counts as quiet, default
// 8), --pilot NAME (default Rehearsal), --verbose.
//
// The report: what Grok said and did, every command and result, the decision layer's steps
// (flights/ in METOERA_DATA_DIR), and from the simulator's flight log (metoera-sim/runs/): moves
// it refused ("would hit": nothing on the voice server stopped them), people coming within 30 cm,
// the smallest clearances, and whether every drone ended on the ground. Exit code 1 on a would-hit
// or a drone left flying.
//
// It only talks to the simulator's voice server (METOERA_PORT from sim.env), never to 18787.
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const voiceRoot = join(here, '..');

export async function readJsonl(dir, pick) {
  try {
    const files = (await readdir(dir)).filter(pick).sort();
    const rows = [];
    for (const f of files) for (const l of (await readFile(join(dir, f), 'utf8')).split('\n')) { try { if (l) rows.push(JSON.parse(l)); } catch { /* a line still being written */ } }
    return rows;
  } catch { return []; }
}

/** Fly `lines` through the real voice page against the simulator's voice server. */
export async function rehearse({ lines, pilot = 'Rehearsal', quietMs = 8000, waitMs = 0, autosend = false, verbose = false, port = Number(process.env.METOERA_PORT ?? 18787), log = console.log } = {}) {
  if (!lines?.length) throw new Error('rehearse needs at least one line');
  if (port === 18787) throw new Error('Rehearsals fly the simulated drones only: run with --env-file=../metoera-sim/sim.env.');
  const server = `http://localhost:${port}`;
  const started = Date.now();
  const out = (text) => log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${text}`);

// ---- a stand-in for the browser
function anything() {
  const f = function () { return anything(); };
  return new Proxy(f, {
    get(_, k) { return k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : anything(); },
    set() { return true; },
  });
}
function element() {
  const state = {
    hidden: false, disabled: false, open: false, checked: false, value: '', textContent: '', innerHTML: '', className: '', title: '',
    width: 0, height: 0, clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0,
    children: [], childNodes: [], files: [], options: [], dataset: {}, handlers: {},
    style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  };
  const kids = new Map();
  const methods = {
    addEventListener(name, fn) { state.handlers[name] = fn; }, removeEventListener() {},
    querySelector(selector) { if (!kids.has(selector)) kids.set(selector, element()); return kids.get(selector); },
    querySelectorAll: () => [], showModal() { state.open = true; }, show() { state.open = true; }, close() { state.open = false; },
    getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600, x: 0, y: 0 }),
    getContext: () => anything(), click() { return state.handlers.click?.({ target: self }); },
  };
  const self = new Proxy({}, {
    get(_, k) { if (k in methods) return methods[k]; if (k in state) return state[k]; return typeof k === 'symbol' || k === 'then' ? undefined : anything(); },
    set(_, k, v) { state[k] = v; return true; },
  });
  return self;
}
const elements = new Map();
const $ = (selector) => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
const store = new Map([['metoera_name', pilot], ...(autosend ? [['metoera_autosend', '1']] : [])]);

// The page's requests go to the simulator's voice server, with its cookie (the pilot name).
let cookie = '';
const commands = [];
let inFlight = 0, lastActivity = Date.now();
async function pageFetch(url, options = {}) {
  const { cache, ...rest } = options; // Node's fetch has no HTTP cache
  const target = String(url).startsWith('/') ? server + url : String(url);
  const command = String(url) === '/api/command' ? JSON.parse(options.body) : null;
  if (command) { inFlight += 1; lastActivity = Date.now(); out(`→ ${command.droneId} ${command.action} ${JSON.stringify(Object.fromEntries(Object.entries(command).filter(([k]) => !['droneId', 'action'].includes(k))))}`); }
  try {
    const response = await fetch(target, { ...rest, headers: { ...(rest.headers ?? {}), Origin: server, Cookie: cookie } });
    for (const c of response.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const name = kv.split('=')[0];
      cookie = [...cookie.split('; ').filter((x) => x && !x.startsWith(`${name}=`)), kv].join('; ');
    }
    if (!command) return response;
    const result = await response.clone().json().catch(() => ({}));
    commands.push({ drone: command.droneId, action: command.action, args: command, ok: result.ok, error: result.error, note: result.note, ms: result.durationMs });
    out(`${result.ok ? '✓' : '✗'} ${command.droneId} ${command.action}${result.ok ? '' : `: ${result.error}`}${result.note ? ` (${result.note})` : ''}`);
    return response;
  } finally { if (command) { inFlight -= 1; lastActivity = Date.now(); } }
}
const guard = (fn) => (...a) => { try { const r = fn(...a); r?.catch?.((e) => verbose && out(`(page error: ${e?.message ?? e})`)); } catch (e) { if (verbose) out(`(page error: ${e?.message ?? e})`); } };

// Grok's side of the conversation, as the page's socket gets it.
let socket = null, speech = '';
class PageSocket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    socket = this;
    this.addEventListener('message', (message) => {
      const e = JSON.parse(message.data);
      lastActivity = Date.now();
      if (e.type === 'response.output_audio_transcript.delta' || e.type === 'response.audio_transcript.delta' || e.type === 'response.output_text.delta') speech += e.delta;
      if (e.type === 'response.function_call_arguments.done') out(`Grok calls ${e.name} ${e.arguments}`);
      if (e.type === 'response.done') { if (speech.trim()) out(`Grok: ${speech.trim()}`); speech = ''; }
      if (e.type === 'error') out(`xAI error: ${e.error?.message ?? JSON.stringify(e)}`);
    });
  }
  send(text) {
    const m = JSON.parse(text);
    const said = m.type === 'conversation.item.create' && m.item?.type === 'message' ? m.item.content?.[0]?.text : null;
    if (said?.startsWith('(automatic drone update')) out(`page → Grok: ${said.replace(/^\(automatic drone update[^)]*\)\s*/, '').slice(0, 220)}`);
    super.send(text);
  }
}
class AudioContext {
  constructor() { this.sampleRate = 24000; this.destination = {}; this.currentTime = 0; }
  async resume() {} close() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, frequencyBinCount: 0, getByteTimeDomainData() {}, getByteFrequencyData() {}, connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {} }; }
  createBuffer(_, length) { return { duration: length / 24000, getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
}
const page = vm.createContext({
  document: { cookie: '', querySelector: $, querySelectorAll: () => [], createElement: () => element(), addEventListener() {}, body: element(), documentElement: element() },
  window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800 },
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, location: { href: server, origin: server, search: '', pathname: '/' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), getComputedStyle: () => anything(),
  Image: class { set src(_) {} }, confirm: () => false, alert() {}, addEventListener() {}, removeEventListener() {},
  navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  AudioContext, WebSocket: PageSocket, fetch: pageFetch,
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  setInterval: (fn, ms) => setInterval(guard(fn), ms), clearInterval, setTimeout: (fn, ms) => setTimeout(guard(fn), ms), clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, ResizeObserver: class { observe() {} disconnect() {} }, CustomEvent: class {}, Event: class {},
  atob, btoa, encodeURIComponent, decodeURIComponent, URL, URLSearchParams, AbortSignal, performance, structuredClone,
  console: { log: (...a) => verbose && out(`(page) ${a.join(' ')}`), warn() {}, error: (...a) => verbose && out(`(page) ${a.join(' ')}`), info() {}, debug() {} },
});
vm.runInContext(await readFile(join(voiceRoot, 'public', 'app.js'), 'utf8'), page, { filename: 'app.js' });
const inPage = (code) => vm.runInContext(code, page);
inPage("for (const d of [mapDialog, droneDialog, camerasDialog]) d?.close?.()"); // no drawing
const until = async (test, ms, what) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 200)); } };

// ---- run it
await until(() => inPage('nameDecided && Boolean(myName)'), 10000, 'the voice server (is it running with sim.env?)');
const before = inPage('drones.map((d) => `${d.id} ${d.flight ?? "?"} ${d.battery ?? "?"}%${d.pilot && !d.pilot.me ? ` flown by ${d.pilot.name}` : ""}`).join(", ")');
out(`page ready as ${pilot}; drones: ${before || 'none'}${autosend ? '; auto-send on' : ''}`);
inPage('start()');
await until(() => socket?.readyState === 1 && inPage("$('#startVoice').disabled === false"), 20000, 'the xAI voice session');
const quiet = () => !inPage('responding || pending.length > 0') && inFlight === 0 && Date.now() - lastActivity >= quietMs;
for (const line of lines) {
  out(`${pilot}: ${line}`);
  inPage(`send(${JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] } })}); requestResponse();`);
  lastActivity = Date.now();
  await until(quiet, 15 * 60 * 1000, 'Grok and the drones to finish');
}
if (waitMs) { out(`watching ${waitMs / 1000} s more`); const end = Date.now() + waitMs; await until(() => Date.now() >= end && quiet(), waitMs + 15 * 60 * 1000, 'the drones'); }
inPage('disconnect()');

// ---- report
const end = Date.now();
await new Promise((r) => setTimeout(r, 1500)); // the last telemetry and log lines
const finalDrones = inPage('drones.map((d) => ({id: d.id, flight: d.flight}))');
const sim = (await readJsonl(join(voiceRoot, '..', 'metoera-sim', 'runs'), (f) => f.endsWith('.jsonl'))).filter((e) => e.t * 1000 >= started && e.t * 1000 <= end + 2000);
const dataDir = process.env.METOERA_DATA_DIR ? resolve(process.env.METOERA_DATA_DIR) : voiceRoot;
const flights = (await readJsonl(join(dataDir, 'flights'), (f) => f.endsWith('.jsonl') && !f.startsWith('calibration'))).filter((e) => Date.parse(e.at) >= started);
const decisions = flights.filter((e) => e.event === 'decision');
const wouldHit = sim.filter((e) => e.kind === 'would_hit');
const near = sim.filter((e) => e.kind === 'near_person');
const minOf = (key) => { const v = sim.filter((e) => e.kind === 'state' && e.flying && e[key] != null).map((e) => e[key]); return v.length ? `${Math.min(...v)} cm` : sim.length ? 'not flown' : 'no simulator log found'; };
const flying = finalDrones.filter((d) => d.flight === 'flying').map((d) => d.id);
const refused = commands.filter((c) => !c.ok);
const commandsLog = flights.filter((e) => e.event === 'command');
const selfLanded = !commandsLog.some((e) => e.sdk === 'land') && sim.some((e) => e.kind === 'state' && e.flying === false) && commands.some((c) => c.action === 'takeoff' && c.ok);
return { started, end, commands, decisions, flights, sim, wouldHit, near, flying, refused, minOf, selfLanded, ok: wouldHit.length === 0 && flying.length === 0 && !selfLanded };
}

export function printReport(report, log = console.log) {
  const { commands, refused, decisions, wouldHit, near, flying, minOf } = report;
  log('\n---- report');
  log(`commands: ${commands.length} (${commands.map((c) => `${c.drone} ${c.action}${c.ok ? '' : ' ✗'}`).join(', ') || 'none'})`);
  if (refused.length) log(`refused or failed: ${refused.map((c) => `${c.drone} ${c.action}: ${c.error}`).join('; ')}`);
  if (decisions.length) {
    const count = (key) => Object.entries(decisions.reduce((n, d) => ({ ...n, [key(d)]: (n[key(d)] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');
    const overruled = decisions.filter((d) => d.overruled).map((d) => d.overruled);
    log(`decision layer: ${decisions.length} steps (${count((d) => d.did?.action ?? '?')}; chosen by ${count((d) => d.by)})${overruled.length ? `; overruled: ${[...new Set(overruled)].join('; ')}` : ''}`);
  }
  log(`would hit (nothing stopped it; the simulator refused it): ${wouldHit.length}${wouldHit.length ? ` (${wouldHit.map((e) => `${e.drone}: ${e.text}`).join('; ')})` : ''}`);
  log(`people within 30 cm of a flying drone: ${near.length}${near.length ? ` (${near.map((e) => `${e.drone}: ${e.text}`).join('; ')})` : ''}`);
  log(`smallest clearance in flight: walls and furniture ${minOf('clearance_cm')}, people ${minOf('person_clearance_cm')}`);
  log(`still flying: ${flying.length ? flying.join(', ') : 'none'}`);
}
