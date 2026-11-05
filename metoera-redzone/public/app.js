/**
 * Metoera red-zone phone client (one of up to 3 slots).
 * Local COCO-SSD person detection; Mac console via heartbeat + JPEG snapshots.
 */
const LENS_KEY = 'metoera-redzone-lens';
const SENS_KEY = 'metoera-redzone-sens';
/** Default sensitivity 35 → confidence ~0.65 (stricter than old 0.45). */
const DEFAULT_SENSITIVITY = 35;
const DETECT_EVERY_MS = 280;
const DWELL_NEED_MS = 1000;
const DWELL_DECAY_PER_TICK = 420;
const MIN_BBOX_AREA = 0.035;
const MIN_BBOX_SIDE = 0.07;
const CLIENT_ALERT_GAP_MS = 2500;
const HEARTBEAT_MS = 1500;
/** ~4 fps small JPEGs for Mac MJPEG (phone keeps live <video>). */
const PREVIEW_MS = 250;

const $ = (id) => document.getElementById(id);
const joinGate = $('joinGate');
const joinMsg = $('joinMsg');
const appShell = $('appShell');
const slotLabel = $('slotLabel');
const video = $('video');
const overlay = $('overlay');
const previewCanvas = $('previewCanvas');
const camStatus = $('camStatus');
const message = $('message');
const lensInfo = $('lensInfo');
const logEl = $('log');
const armedBadge = $('armedBadge');
const detectBadge = $('detectBadge');
const modelBadge = $('modelBadge');
const linkBadge = $('linkBadge');
const armToggle = $('armToggle');
const flash = $('flash');
const btnStart = $('btnStart');
const btnClear = $('btnClear');
const btnTest = $('btnTest');
const sensSlider = $('sensSlider');
const sensValue = $('sensValue');
const dwellStatus = $('dwellStatus');
const lensButtons = {
  wide: $('camWide'),
  normal: $('camNormal'),
  tele: $('camTele'),
};

const octx = overlay.getContext('2d');
const pctx = previewCanvas.getContext('2d');

/** @typedef {'wide' | 'normal' | 'tele'} LensId */
/** @typedef {{ lens: LensId; label: string; deviceId: string; zoom: number | null; source: 'device' | 'zoom' }} LensOption */

let slotId = null;
let slotToken = null;
/** @type {{ x: number, y: number, w: number, h: number } | null} */
let roi = null;
/** @type {Partial<Record<LensId, LensOption>>} */
let lenses = {};
/** @type {LensId} */
let activeLens = 'normal';
/** @type {string | null} */
let activeDeviceId = null;
/** @type {MediaStream | null} */
let stream = null;
let model = null;
/** @type {{bbox: number[], score: number}[]} */
let lastPeople = [];
let lastPersonScore = null;
let lastError = null;
let discoveryNote = '';

let watching = false;
let detectTimer = 0;
let heartbeatTimer = 0;
let previewTimer = 0;
let drag = null;
let lastClientAlert = 0;
let modelReady = false;
let sensitivity = Number(localStorage.getItem(SENS_KEY) ?? DEFAULT_SENSITIVITY);
if (!Number.isFinite(sensitivity)) sensitivity = DEFAULT_SENSITIVITY;
sensitivity = Math.min(100, Math.max(0, Math.round(sensitivity)));
let dwellMs = 0;
let lastDetectAt = 0;

/** Map sensitivity 0–100 → COCO score threshold (0.85 … 0.45). Lower sens = higher bar. */
function scoreThreshold() {
  return 0.85 - (sensitivity / 100) * 0.4;
}

function setSensitivityUi(value, { announce = false } = {}) {
  sensitivity = Math.min(100, Math.max(0, Math.round(value)));
  localStorage.setItem(SENS_KEY, String(sensitivity));
  if (sensSlider) sensSlider.value = String(sensitivity);
  if (sensValue) sensValue.textContent = String(sensitivity);
  if (announce) setMessage(`Sensitivity ${sensitivity} · min score ${scoreThreshold().toFixed(2)}`);
}

function roiStorageKey() {
  const opt = lenses[activeLens];
  const id = opt ? `${slotId}:${opt.deviceId}:${opt.lens}` : `${slotId}:${activeLens}`;
  return `metoera-redzone-roi:${id}`;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function loadRoi() {
  try {
    const raw = JSON.parse(localStorage.getItem(roiStorageKey()) ?? '');
    if (raw && typeof raw.x === 'number' && raw.w > 0.02 && raw.h > 0.02) {
      roi = { x: clamp01(raw.x), y: clamp01(raw.y), w: clamp01(raw.w), h: clamp01(raw.h) };
      return;
    }
  } catch {
    /* ignore */
  }
  roi = null;
}

function saveRoi() {
  const key = roiStorageKey();
  if (roi) localStorage.setItem(key, JSON.stringify(roi));
  else localStorage.removeItem(key);
}

function setMessage(text, isAlert = false) {
  message.textContent = text;
  message.style.color = isAlert ? '#e05a48' : '';
}

function setArmedUi(armed) {
  armToggle.checked = armed;
  armedBadge.textContent = armed ? 'ARM ON' : 'ARM OFF';
  armedBadge.className = `badge ${armed ? 'on' : 'off'}`;
}

function setDetectUi(mode) {
  detectBadge.className = `badge ${mode}`;
  detectBadge.textContent =
    mode === 'watch' ? 'Watching' : mode === 'alert' ? 'Person!' : 'Idle';
}

function setLink(ok, text) {
  linkBadge.textContent = text;
  linkBadge.className = `badge ${ok ? 'ready' : 'idle'}`;
}

function syncCanvasSize() {
  const rect = overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.max(1, Math.floor(rect.width * dpr));
  overlay.height = Math.max(1, Math.floor(rect.height * dpr));
  drawOverlay();
}

function boxesOverlapNorm(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function drawOverlay() {
  const { width, height } = overlay;
  octx.clearRect(0, 0, width, height);
  if (roi) {
    const x = roi.x * width;
    const y = roi.y * height;
    const w = roi.w * width;
    const h = roi.h * height;
    octx.fillStyle = 'rgba(194, 59, 42, 0.22)';
    octx.fillRect(x, y, w, h);
    octx.strokeStyle = '#c23b2a';
    octx.lineWidth = Math.max(2, width * 0.005);
    octx.strokeRect(x, y, w, h);
    octx.fillStyle = '#f3ebe0';
    octx.font = `${Math.max(12, width * 0.028)}px sans-serif`;
    octx.fillText('RED ZONE', x + 8, Math.max(y - 8, 18));
  }
  for (const person of lastPeople) {
    const [bx, by, bw, bh] = person.bbox;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const x = (bx / vw) * width;
    const y = (by / vh) * height;
    const w = (bw / vw) * width;
    const h = (bh / vh) * height;
    const hits = roi && boxesOverlapNorm({ x: bx / vw, y: by / vh, w: bw / vw, h: bh / vh }, roi);
    octx.strokeStyle = hits ? '#e05a48' : '#3d8f6a';
    octx.lineWidth = Math.max(2, width * 0.004);
    octx.strokeRect(x, y, w, h);
  }
}

function pointerToNorm(e) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - rect.left) / rect.width),
    y: clamp01((e.clientY - rect.top) / rect.height),
  };
}

function normalizeRoi(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (w < 0.03 || h < 0.03) return null;
  return { x, y, w, h };
}

overlay.addEventListener('pointerdown', (e) => {
  overlay.setPointerCapture(e.pointerId);
  drag = { start: pointerToNorm(e), current: pointerToNorm(e) };
});
overlay.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.current = pointerToNorm(e);
  roi = normalizeRoi(drag.start, drag.current) ?? roi;
  drawOverlay();
});
overlay.addEventListener('pointerup', (e) => {
  if (!drag) return;
  drag.current = pointerToNorm(e);
  const next = normalizeRoi(drag.start, drag.current);
  drag = null;
  if (next) {
    roi = next;
    saveRoi();
    setMessage(`Red zone saved for ${activeLens}.`);
  }
  drawOverlay();
});

btnClear.addEventListener('click', () => {
  roi = null;
  saveRoi();
  drawOverlay();
  setMessage('Zone cleared.');
});

function isFrontLabel(label) {
  return /front|selfie|facetime|\buser\b|true\s*depth/i.test(label || '');
}
function isBackLabel(label) {
  return /back|rear|environment|ultra|tele|dual|triple|wide/i.test(label || '');
}
function classifyBackLabel(label) {
  const l = label || '';
  if (/ultra\s*-?\s*wide|ultrawide/i.test(l)) return 'wide';
  if (/tele/i.test(l)) return 'tele';
  if (/dual|triple|back\s*camera|rear/i.test(l) || /\bwide\b/i.test(l)) return 'normal';
  return null;
}
function uniqueByDeviceId(devices) {
  const seen = new Set();
  const out = [];
  for (const d of devices) {
    if (!d.deviceId || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    out.push(d);
  }
  return out;
}

async function enumerateVideoInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return uniqueByDeviceId(devices.filter((d) => d.kind === 'videoinput'));
}

async function discoverLenses(probeTrack) {
  const all = await enumerateVideoInputs();
  const back = all.filter((d) => {
    const label = d.label || '';
    if (isFrontLabel(label)) return false;
    if (label && isBackLabel(label)) return true;
    return !label;
  });
  /** @type {Partial<Record<LensId, LensOption>>} */
  const next = {};
  for (const device of back) {
    const lens = classifyBackLabel(device.label);
    if (!lens || next[lens]) continue;
    next[lens] = { lens, label: device.label || lens, deviceId: device.deviceId, zoom: null, source: 'device' };
  }
  const track = probeTrack || stream?.getVideoTracks?.()[0];
  const caps = track?.getCapabilities?.() || {};
  const zoomCap = caps.zoom;
  const backIds = uniqueByDeviceId(back.length ? back : all.filter((d) => !isFrontLabel(d.label)));
  const primaryId =
    next.normal?.deviceId ||
    next.wide?.deviceId ||
    track?.getSettings?.().deviceId ||
    backIds[0]?.deviceId ||
    null;

  if (primaryId && zoomCap && typeof zoomCap.min === 'number' && typeof zoomCap.max === 'number') {
    const { min, max } = zoomCap;
    if (!next.wide && min < 0.95) {
      next.wide = { lens: 'wide', label: `Ultra-wide (z${min})`, deviceId: primaryId, zoom: min, source: 'zoom' };
    }
    if (!next.normal) {
      const z = Math.min(Math.max(1, min), max);
      next.normal = { lens: 'normal', label: `Main (z${z})`, deviceId: primaryId, zoom: z, source: 'zoom' };
    }
    if (!next.tele && max >= 2) {
      const z = Math.min(Math.max(2, min), max);
      next.tele = { lens: 'tele', label: `Tele (z${z})`, deviceId: primaryId, zoom: z, source: 'zoom' };
    }
  }
  if (!next.normal && primaryId) {
    next.normal = {
      lens: 'normal',
      label: backIds[0]?.label || 'Back camera',
      deviceId: primaryId,
      zoom: null,
      source: 'device',
    };
  }
  for (const id of /** @type {LensId[]} */ (['wide', 'normal', 'tele'])) {
    const opt = next[id];
    if (!opt) continue;
    const match = all.find((d) => d.deviceId === opt.deviceId);
    if (match && isFrontLabel(match.label)) delete next[id];
  }
  lenses = next;
  discoveryNote = `Back lenses: ${Object.keys(next).join(', ') || 'none'}. Front excluded.`;
  if (!next.tele) discoveryNote += ' Tele unavailable on this phone/Safari.';
  lensInfo.textContent = discoveryNote;
  renderLensButtons();
  return next;
}

function renderLensButtons() {
  for (const id of /** @type {LensId[]} */ (['wide', 'normal', 'tele'])) {
    const btn = lensButtons[id];
    const opt = lenses[id];
    btn.disabled = !opt;
    btn.classList.toggle('active', Boolean(opt) && id === activeLens);
    btn.title = opt ? `${opt.label} (${opt.source})` : 'Not available';
  }
}

function stopStream() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  video.srcObject = null;
}

async function applyZoom(track, zoom) {
  if (zoom == null || !track?.applyConstraints) return;
  try {
    await track.applyConstraints({ advanced: [{ zoom }] });
  } catch {
    try {
      await track.applyConstraints({ zoom });
    } catch {
      /* ignore */
    }
  }
}

async function ensureLiveVideoPlaying() {
  // Keep a continuous local live preview on the phone (Mac still uses JPEG snapshots).
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  video.autoplay = true;
  video.style.opacity = '1';
  video.style.visibility = 'visible';
  video.style.display = 'block';
  try {
    await video.play();
  } catch {
    // iOS sometimes needs a second attempt after metadata.
    await new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('loadedmetadata', done);
        resolve();
      };
      video.addEventListener('loadedmetadata', done);
      setTimeout(resolve, 400);
    });
    await video.play().catch(() => undefined);
  }
  syncCanvasSize();
  drawOverlay();
}

async function startLens(lensId) {
  const opt = lenses[lensId] || lenses.normal;
  camStatus.textContent = 'Opening back camera…';
  stopStream();
  const constraints = {
    audio: false,
    video: opt?.deviceId
      ? {
          deviceId: { exact: opt.deviceId },
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        }
      : {
          facingMode: { exact: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  }
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  if (settings.facingMode === 'user' || isFrontLabel(track?.label || '')) {
    stopStream();
    throw new Error('Front/selfie camera blocked — use a back lens.');
  }
  if (opt?.zoom != null) await applyZoom(track, opt.zoom);
  video.srcObject = stream;
  await ensureLiveVideoPlaying();
  activeLens = lenses[lensId] ? lensId : 'normal';
  activeDeviceId = settings.deviceId || opt?.deviceId || null;
  localStorage.setItem(LENS_KEY, activeLens);
  await discoverLenses(track);
  const finalOpt = lenses[activeLens];
  if (finalOpt?.zoom != null) await applyZoom(track, finalOpt.zoom);
  loadRoi();
  syncCanvasSize();
  drawOverlay();
  renderLensButtons();
  camStatus.textContent = `Live · ${finalOpt?.label || 'Back'} · ${activeLens}`;
}

async function switchLens(lensId) {
  if (!lenses[lensId]) {
    setMessage(`${lensId} not available.`, true);
    return;
  }
  const was = watching;
  if (watching) stopWatching(false);
  await startLens(lensId);
  if (was) startWatching(false);
}

for (const id of /** @type {LensId[]} */ (['wide', 'normal', 'tele'])) {
  lensButtons[id].addEventListener('click', () => void switchLens(id).catch((e) => setMessage(String(e.message || e), true)));
}

async function loadModel() {
  modelBadge.textContent = 'Model…';
  if (typeof cocoSsd === 'undefined' || typeof tf === 'undefined') {
    modelBadge.textContent = 'No TF';
    setMessage('COCO-SSD CDN failed to load.', true);
    return;
  }
  try {
    await tf.ready();
    // mobilenet_v2 is more accurate than lite (fewer non-person false positives).
    model = await cocoSsd.load({ base: 'mobilenet_v2' });
    modelReady = true;
    modelBadge.textContent = 'COCO-SSD';
    modelBadge.className = 'badge ready';
    setMessage(`Person model ready · min score ${scoreThreshold().toFixed(2)}`);
  } catch (error) {
    modelBadge.textContent = 'Fail';
    lastError = error instanceof Error ? error.message : String(error);
    setMessage(`Model failed: ${lastError}`, true);
  }
}

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* ignore */
  }
}

function visualAlert() {
  flash.hidden = false;
  flash.classList.remove('flash');
  void flash.offsetWidth;
  flash.classList.add('flash');
  document.querySelector('.stage')?.classList.add('alerting');
  setTimeout(() => {
    flash.hidden = true;
    document.querySelector('.stage')?.classList.remove('alerting');
  }, 900);
}

// Where people are in the picture (normalized boxes), at most twice a second. The Mac maps the
// feet of each box onto the room plan with this camera's calibration.
let lastPeoplePost = 0;
async function postPeople(people, vw, vh) {
  const now = Date.now();
  if (!slotToken || now - lastPeoplePost < 500) return;
  lastPeoplePost = now;
  const boxes = people.slice(0, 12).map((p) => ({ x: p.bbox[0] / vw, y: p.bbox[1] / vh, w: p.bbox[2] / vw, h: p.bbox[3] / vh, score: p.score }));
  try {
    await fetch(`/api/slots/${slotId}/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slot-Token': slotToken },
      body: JSON.stringify({ token: slotToken, boxes }),
    });
  } catch {
    /* the next detection tries again */
  }
}

async function postIntrusion({ score, note, force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastClientAlert < CLIENT_ALERT_GAP_MS) return;
  lastClientAlert = now;
  setDetectUi('alert');
  visualAlert();
  beep();
  setMessage('Person in red zone — alerting…', true);
  try {
    const response = await fetch(`/api/slots/${slotId}/intrusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slot-Token': slotToken },
      body: JSON.stringify({
        token: slotToken,
        score: typeof score === 'number' ? score : null,
        roi,
        note: note ?? 'person',
        force,
        lens: activeLens,
      }),
    });
    const data = await response.json();
    if (data.debounced) setMessage(`Server debounce (${Math.ceil((data.retryAfterMs ?? 0) / 1000)}s).`);
    else if (data.accepted) {
      const takeoff = data.event?.takeoff;
      if (takeoff?.reason === 'disarmed') setMessage('Alert logged. Takeoff skipped (ARM OFF).');
      else setMessage(takeoff?.note || 'Alert logged.');
      await refreshLog();
    }
  } catch (error) {
    setMessage(`Server error: ${error instanceof Error ? error.message : error}`, true);
  }
  setTimeout(() => setDetectUi(watching ? 'watch' : 'idle'), 1200);
}

function isPlausiblePerson(bbox, score, vw, vh) {
  if (score < scoreThreshold()) return false;
  const [, , bw, bh] = bbox;
  const area = (bw / vw) * (bh / vh);
  const minSide = Math.min(bw / vw, bh / vh);
  // Tiny boxes are usually noise / distant clutter.
  if (area < MIN_BBOX_AREA || minSide < MIN_BBOX_SIDE) return false;
  // Extreme aspect ratios are rarely upright people in this demo framing.
  const aspect = bw / Math.max(bh, 1);
  if (aspect > 2.4 || aspect < 0.22) return false;
  return true;
}

async function detectOnce() {
  if (!model || !modelReady || video.readyState < 2) return;
  const now = performance.now();
  const dt = lastDetectAt ? Math.min(500, now - lastDetectAt) : DETECT_EVERY_MS;
  lastDetectAt = now;
  try {
    const minScore = scoreThreshold();
    const preds = await model.detect(video, 12, Math.max(0.4, minScore - 0.05));
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const people = preds
      .filter((p) => p.class === 'person' && isPlausiblePerson(p.bbox, p.score, vw, vh))
      .map((p) => ({ bbox: p.bbox, score: p.score }));
    lastPeople = people;
    lastPersonScore = people[0]?.score ?? null;
    drawOverlay();
    void postPeople(people, vw, vh);

    let inZone = false;
    let best = null;
    if (watching && roi) {
      for (const person of people) {
        const [bx, by, bw, bh] = person.bbox;
        const box = { x: bx / vw, y: by / vh, w: bw / vw, h: bh / vh };
        if (boxesOverlapNorm(box, roi)) {
          inZone = true;
          if (!best || person.score > best.score) best = person;
        }
      }
    }

    if (watching && inZone) {
      dwellMs = Math.min(DWELL_NEED_MS + 250, dwellMs + dt);
    } else {
      dwellMs = Math.max(0, dwellMs - DWELL_DECAY_PER_TICK * (dt / DETECT_EVERY_MS));
    }

    const pct = Math.min(100, Math.round((dwellMs / DWELL_NEED_MS) * 100));
    if (dwellStatus) {
      dwellStatus.textContent = watching
        ? `Dwell ${pct}% · need ~1s in zone · score≥${minScore.toFixed(2)}`
        : `Dwell idle · score≥${minScore.toFixed(2)}`;
    }

    if (watching && inZone && dwellMs >= DWELL_NEED_MS && best) {
      dwellMs = 0;
      void postIntrusion({ score: best.score, note: 'person-in-roi-1s' });
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
}

function startWatching(announce = true) {
  if (!roi) {
    setMessage('Draw a red zone first.', true);
    return;
  }
  if (!modelReady) {
    setMessage('Wait for person model.', true);
    return;
  }
  watching = true;
  btnStart.textContent = 'Pause watching';
  setDetectUi('watch');
  if (announce) setMessage('Watching for people…');
  void detectOnce();
  window.clearInterval(detectTimer);
  detectTimer = window.setInterval(() => void detectOnce(), DETECT_EVERY_MS);
}

function stopWatching(announce = true) {
  watching = false;
  window.clearInterval(detectTimer);
  detectTimer = 0;
  dwellMs = 0;
  btnStart.textContent = 'Start watching';
  setDetectUi('idle');
  if (dwellStatus) dwellStatus.textContent = `Dwell idle · score≥${scoreThreshold().toFixed(2)}`;
  if (announce) setMessage('Watching paused.');
}

btnStart.addEventListener('click', () => {
  if (watching) stopWatching();
  else startWatching();
});
btnTest.addEventListener('click', () => void postIntrusion({ score: 1, note: 'manual-test', force: true }));

armToggle.addEventListener('change', async () => {
  const armed = armToggle.checked;
  if (false && armed) { // ARM is on by default now: no question
    armToggle.checked = false;
    return;
  }
  setArmedUi(armed);
  // Also tell server via command path so console stays in sync
  try {
    await fetch(`/api/slots/${slotId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { type: 'arm', armed } }),
    });
  } catch {
    /* heartbeat will still report */
  }
});

async function applyRemoteCommands(commands) {
  for (const cmd of commands || []) {
    if (cmd.type === 'watch') {
      if (cmd.watching) startWatching();
      else stopWatching();
    } else if (cmd.type === 'arm') {
      setArmedUi(Boolean(cmd.armed));
    } else if (cmd.type === 'lens' && cmd.lens) {
      await switchLens(cmd.lens).catch((e) => {
        lastError = String(e.message || e);
      });
    } else if (cmd.type === 'sensitivity' && typeof cmd.sensitivity === 'number') {
      setSensitivityUi(cmd.sensitivity, { announce: true });
    } else if (cmd.type === 'roi' && cmd.roi) {
      roi = cmd.roi;
      saveRoi();
      drawOverlay();
    } else if (cmd.type === 'clearRoi') {
      roi = null;
      saveRoi();
      drawOverlay();
    }
  }
}

async function heartbeat() {
  if (!slotId || !slotToken) return;
  try {
    const response = await fetch(`/api/slots/${slotId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slot-Token': slotToken },
      body: JSON.stringify({
        token: slotToken,
        watching,
        armed: armToggle.checked,
        lens: activeLens,
        sensitivity,
        dwellMs,
        lensesAvailable: {
          wide: Boolean(lenses.wide),
          normal: Boolean(lenses.normal),
          tele: Boolean(lenses.tele),
        },
        roi,
        personScore: lastPersonScore,
        error: lastError,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setLink(false, 'Auth?');
      return;
    }
    setLink(true, `P${slotId} ok`);
    if (data.commands?.length) await applyRemoteCommands(data.commands);
  } catch {
    setLink(false, 'Offline');
  }
}

async function sendPreview() {
  if (!slotId || !slotToken || video.readyState < 2) return;
  try {
    // Small + frequent for smooth Mac MJPEG (not meant as phone live view).
    const w = 240;
    const h = Math.max(135, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * w));
    previewCanvas.width = w;
    previewCanvas.height = h;
    pctx.drawImage(video, 0, 0, w, h);
    if (roi) {
      pctx.strokeStyle = '#c23b2a';
      pctx.lineWidth = 2;
      pctx.strokeRect(roi.x * w, roi.y * h, roi.w * w, roi.h * h);
    }
    if (dwellMs > 0) {
      pctx.fillStyle = 'rgba(194,59,42,0.85)';
      pctx.fillRect(0, 0, Math.round((dwellMs / DWELL_NEED_MS) * w), 4);
    }
    const jpeg = previewCanvas.toDataURL('image/jpeg', 0.42);
    await fetch(`/api/slots/${slotId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slot-Token': slotToken },
      body: JSON.stringify({ token: slotToken, jpeg }),
    });
  } catch {
    /* ignore preview failures */
  }
}

async function refreshLog() {
  try {
    const response = await fetch('/api/events?limit=12');
    const data = await response.json();
    logEl.innerHTML = '';
    for (const event of data.events ?? []) {
      if (event.slotId && event.slotId !== slotId) continue;
      const li = document.createElement('li');
      const when = event.at ? new Date(event.at).toLocaleTimeString() : '';
      li.innerHTML = `<strong>${event.type}</strong> ${when}`;
      logEl.appendChild(li);
    }
  } catch {
    /* ignore */
  }
}

async function joinSlot(id) {
  joinMsg.textContent = `Joining Phone ${id}…`;
  const response = await fetch(`/api/slots/${id}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Phone ${id}` }),
  });
  const data = await response.json();
  if (!response.ok || !data.token) throw new Error(data.error || 'Join failed');
  slotId = id;
  slotToken = data.token;
  localStorage.setItem('metoera-redzone-slot', id);
  joinGate.hidden = true;
  appShell.hidden = false;
  slotLabel.textContent = `Phone ${id} · live preview · person only`;
  setArmedUi(false);
  setDetectUi('idle');
  setSensitivityUi(sensitivity);
  setLink(true, `P${id}`);

  // Show shell first so <video> has layout, then open the live camera stream.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  syncCanvasSize();

  const preferred = localStorage.getItem(LENS_KEY);
  await startLens(preferred === 'wide' || preferred === 'tele' ? preferred : 'normal');
  void loadModel();
  void refreshLog();
  window.clearInterval(heartbeatTimer);
  window.clearInterval(previewTimer);
  heartbeatTimer = window.setInterval(() => void heartbeat(), HEARTBEAT_MS);
  // Snapshots are for the Mac console only — phone keeps continuous <video>.
  previewTimer = window.setInterval(() => void sendPreview(), PREVIEW_MS);
  void heartbeat();
  void sendPreview();
  setInterval(() => {
    if (!watching && modelReady) void detectOnce();
  }, 800);
}

sensSlider?.addEventListener('input', () => {
  setSensitivityUi(Number(sensSlider.value));
});
sensSlider?.addEventListener('change', () => {
  setSensitivityUi(Number(sensSlider.value), { announce: true });
  if (!slotId) return;
  void fetch(`/api/slots/${slotId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: { type: 'sensitivity', sensitivity } }),
  });
});

for (const btn of joinGate.querySelectorAll('[data-join]')) {
  btn.addEventListener('click', () => {
    void joinSlot(btn.getAttribute('data-join')).catch((error) => {
      joinMsg.textContent = error instanceof Error ? error.message : String(error);
    });
  });
}

setSensitivityUi(sensitivity);

window.addEventListener('resize', syncCanvasSize);
window.addEventListener('orientationchange', () => setTimeout(syncCanvasSize, 250));

// Auto-join from ?slot=1|2|3
const params = new URLSearchParams(location.search);
const preset = params.get('slot') || localStorage.getItem('metoera-redzone-slot');
if (preset === '1' || preset === '2' || preset === '3') {
  void joinSlot(preset).catch((error) => {
    joinMsg.textContent = error instanceof Error ? error.message : String(error);
    joinGate.hidden = false;
    appShell.hidden = true;
  });
}
