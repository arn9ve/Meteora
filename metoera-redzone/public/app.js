/**
 * Metoera red-zone phone UI.
 * Person-only alerts via TensorFlow.js COCO-SSD (lite_mobilenet_v2).
 * Landscape-first + back lenses only: Wide / Normal / Tele (no selfie).
 */
const LENS_KEY = 'metoera-redzone-lens';
const PERSON_MIN_SCORE = 0.45;
const DETECT_EVERY_MS = 350;
const CLIENT_ALERT_GAP_MS = 1500;

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const camStatus = $('camStatus');
const message = $('message');
const lensInfo = $('lensInfo');
const logEl = $('log');
const armedBadge = $('armedBadge');
const detectBadge = $('detectBadge');
const modelBadge = $('modelBadge');
const armToggle = $('armToggle');
const flash = $('flash');
const btnStart = $('btnStart');
const btnClear = $('btnClear');
const btnTest = $('btnTest');
const rotateHint = $('rotateHint');
const lensButtons = {
  wide: $('camWide'),
  normal: $('camNormal'),
  tele: $('camTele'),
};

const octx = overlay.getContext('2d');

/** @typedef {'wide' | 'normal' | 'tele'} LensId */
/** @typedef {{ lens: LensId; label: string; deviceId: string; zoom: number | null; source: 'device' | 'zoom' }} LensOption */

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
/** @type {import('@tensorflow-models/coco-ssd').ObjectDetection | null} */
let model = null;
/** @type {{bbox: number[], score: number}[]} */
let lastPeople = [];
/** @type {string} */
let discoveryNote = '';

let watching = false;
let detectTimer = 0;
let drag = null;
let lastClientAlert = 0;
let modelReady = false;

function roiStorageKey() {
  const opt = lenses[activeLens];
  const id = opt ? `${opt.deviceId}:${opt.lens}` : activeLens;
  return `metoera-redzone-roi:${id}`;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function loadRoi() {
  try {
    const raw = JSON.parse(localStorage.getItem(roiStorageKey()) ?? '');
    if (
      raw &&
      typeof raw.x === 'number' &&
      typeof raw.y === 'number' &&
      typeof raw.w === 'number' &&
      typeof raw.h === 'number' &&
      raw.w > 0.02 &&
      raw.h > 0.02
    ) {
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

function updateOrientationHint() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  rotateHint.hidden = !portrait;
  document.body.classList.toggle('force-rotate-hint', portrait);
  tryLockLandscape();
}

async function tryLockLandscape() {
  try {
    const orientation = screen.orientation;
    if (orientation && typeof orientation.lock === 'function') {
      await orientation.lock('landscape').catch(() => undefined);
    }
  } catch {
    /* iOS often denies outside fullscreen */
  }
}

function syncCanvasSize() {
  const rect = overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.max(1, Math.floor(rect.width * dpr));
  overlay.height = Math.max(1, Math.floor(rect.height * dpr));
  drawOverlay();
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
    const hits = roi && boxesOverlapNorm(
      { x: bx / vw, y: by / vh, w: bw / vw, h: bh / vh },
      roi,
    );
    octx.strokeStyle = hits ? '#e05a48' : '#3d8f6a';
    octx.lineWidth = Math.max(2, width * 0.004);
    octx.strokeRect(x, y, w, h);
    octx.fillStyle = hits ? '#e05a48' : '#3d8f6a';
    octx.font = `${Math.max(11, width * 0.024)}px sans-serif`;
    octx.fillText(`person ${(person.score * 100) | 0}%`, x + 4, Math.max(y - 4, 14));
  }
}

function boxesOverlapNorm(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
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

/** Classify a back-camera label into a lens slot when possible. */
function classifyBackLabel(label) {
  const l = label || '';
  if (/ultra\s*-?\s*wide|ultrawide/i.test(l)) return 'wide';
  if (/tele/i.test(l)) return 'tele';
  // "Back Dual Wide Camera" / "Back Camera" / "Back Triple Camera" → main
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

/**
 * Build Wide / Normal / Tele options from device labels and/or zoom.
 * Never includes front/selfie cameras.
 */
async function discoverLenses(probeTrack) {
  const all = await enumerateVideoInputs();
  const back = all.filter((d) => {
    const label = d.label || '';
    if (isFrontLabel(label)) return false;
    if (label && isBackLabel(label)) return true;
    // Unlabeled: keep for now; we already opened environment-facing stream.
    return !label;
  });

  /** @type {Partial<Record<LensId, LensOption>>} */
  const next = {};
  const labelSummary = all.map((d) => d.label || '(unnamed)').join(' · ') || '(none yet)';

  // 1) Prefer distinct back deviceIds with clear labels.
  for (const device of back) {
    const lens = classifyBackLabel(device.label);
    if (!lens || next[lens]) continue;
    next[lens] = {
      lens,
      label: device.label || lens,
      deviceId: device.deviceId,
      zoom: null,
      source: 'device',
    };
  }

  // 2) If we still lack slots and have a single (or dual) back device, try zoom.
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
    const min = zoomCap.min;
    const max = zoomCap.max;
    // Ultra-wide is usually zoom < 1 on iPhone multi-cam.
    if (!next.wide && min < 0.95) {
      next.wide = {
        lens: 'wide',
        label: `Ultra-wide (zoom ${min})`,
        deviceId: primaryId,
        zoom: min,
        source: 'zoom',
      };
    }
    if (!next.normal) {
      const normalZoom = Math.min(Math.max(1, min), max);
      next.normal = {
        lens: 'normal',
        label: `Main wide (zoom ${normalZoom})`,
        deviceId: primaryId,
        zoom: normalZoom,
        source: 'zoom',
      };
    }
    // Optical tele is typically available around 2x+ on Pro; require max >= 2
    // and a meaningful step above 1 so we don't fake tele with mild digital crop.
    if (!next.tele && max >= 2) {
      const teleZoom = Math.min(Math.max(2, min), max);
      next.tele = {
        lens: 'tele',
        label: `Tele (zoom ${teleZoom})`,
        deviceId: primaryId,
        zoom: teleZoom,
        source: 'zoom',
      };
    }
  }

  // 3) Ensure at least Normal from environment stream if nothing else mapped.
  if (!next.normal && primaryId) {
    next.normal = {
      lens: 'normal',
      label: backIds[0]?.label || 'Back camera',
      deviceId: primaryId,
      zoom: null,
      source: 'device',
    };
  }

  // Drop any option that accidentally reused a front deviceId after re-query.
  for (const id of /** @type {LensId[]} */ (['wide', 'normal', 'tele'])) {
    const opt = next[id];
    if (!opt) continue;
    const match = all.find((d) => d.deviceId === opt.deviceId);
    if (match && isFrontLabel(match.label)) delete next[id];
  }

  const enabled = /** @type {LensId[]} */ (['wide', 'normal', 'tele']).filter((id) => next[id]);
  discoveryNote =
    `Devices: ${labelSummary}. Enabled: ${enabled.join(', ') || 'none'}.` +
    (zoomCap
      ? ` Zoom ${zoomCap.min}–${zoomCap.max}.`
      : ' No zoom API on this track.') +
    ' Front/selfie excluded.';

  // Honest limit note when tele missing (iPhone 12 non-Pro has no tele lens).
  if (!next.tele) {
    discoveryNote +=
      ' Tele unavailable (Safari did not expose a tele device / ≥2× zoom). iPhone 12 non-Pro has no telephoto lens.';
  }
  if (!next.wide) {
    discoveryNote += ' Wide (ultra-wide) unavailable from labels/zoom.';
  }

  lenses = next;
  lensInfo.textContent = discoveryNote;
  renderLensButtons();
  return next;
}

function renderLensButtons() {
  for (const id of /** @type {LensId[]} */ (['wide', 'normal', 'tele'])) {
    const btn = lensButtons[id];
    const opt = lenses[id];
    if (!opt) {
      btn.disabled = true;
      btn.classList.remove('active');
      btn.title = 'Not available on this iPhone / Safari';
      continue;
    }
    btn.disabled = false;
    btn.title = `${opt.label} (${opt.source})`;
    btn.classList.toggle('active', id === activeLens);
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
      /* Safari may reject; keep stream anyway */
    }
  }
}

/**
 * Open a back camera only. Never requests facingMode:user.
 */
async function startLens(lensId) {
  const opt = lenses[lensId] || (lensId === 'normal' ? null : lenses.normal);
  camStatus.textContent = 'Opening back camera…';
  stopStream();

  /** @type {MediaStreamConstraints} */
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
    // Fallback if exact environment fails (rare): ideal environment, still not user.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  }

  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  // Guard: if Safari somehow gave us the front cam, abort and retry environment-only.
  if (settings.facingMode === 'user' || isFrontLabel(track?.label || '')) {
    stopStream();
    throw new Error('Got front/selfie camera — blocked. Use a back lens.');
  }

  if (opt?.zoom != null) await applyZoom(track, opt.zoom);

  video.srcObject = stream;
  await video.play();

  activeLens = lenses[lensId] ? lensId : 'normal';
  activeDeviceId = settings.deviceId || opt?.deviceId || null;
  localStorage.setItem(LENS_KEY, activeLens);

  await discoverLenses(track);
  // Re-apply zoom after rediscovery in case capabilities just appeared.
  const finalOpt = lenses[activeLens];
  if (finalOpt?.zoom != null) await applyZoom(track, finalOpt.zoom);

  loadRoi();
  syncCanvasSize();
  renderLensButtons();

  const zoomNow = track.getSettings?.().zoom;
  camStatus.textContent = `${finalOpt?.label || 'Back'} · ${activeLens}${
    zoomNow != null ? ` · z${zoomNow}` : ''
  }`;
  setMessage(`Using ${activeLens} (back only). Front camera excluded.`);
}

async function switchLens(lensId) {
  if (!lenses[lensId]) {
    setMessage(`${lensId} lens not available on this phone.`, true);
    return;
  }
  const wasWatching = watching;
  if (watching) stopWatching();
  try {
    await startLens(lensId);
    if (wasWatching) startWatching();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : String(error), true);
    camStatus.textContent = 'Camera error';
  }
}

for (const id of /** @type {LensId[]} */ (['wide', 'normal', 'tele'])) {
  lensButtons[id].addEventListener('click', () => void switchLens(id));
}

async function loadModel() {
  modelBadge.textContent = 'Model…';
  modelBadge.className = 'badge idle';
  if (typeof cocoSsd === 'undefined' || typeof tf === 'undefined') {
    modelBadge.textContent = 'No TF';
    setMessage('Could not load TensorFlow.js / COCO-SSD from CDN.', true);
    return;
  }
  try {
    await tf.ready();
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    modelReady = true;
    modelBadge.textContent = 'COCO-SSD';
    modelBadge.className = 'badge ready';
    setMessage('Person model ready (COCO-SSD lite).');
  } catch (error) {
    modelBadge.textContent = 'Fail';
    setMessage(`Model load failed: ${error instanceof Error ? error.message : error}`, true);
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

async function postIntrusion({ score, note, force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastClientAlert < CLIENT_ALERT_GAP_MS) return;
  lastClientAlert = now;

  setDetectUi('alert');
  visualAlert();
  beep();
  setMessage('Person in red zone — alerting…', true);

  try {
    const response = await fetch('/api/intrusion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: typeof score === 'number' ? score : null,
        roi,
        note: note ?? 'person',
        force,
        kind: 'person',
        cameraId: activeDeviceId,
        lens: activeLens,
      }),
    });
    const data = await response.json();
    if (data.debounced) {
      setMessage(`Server debounce (${Math.ceil((data.retryAfterMs ?? 0) / 1000)}s).`);
    } else if (data.accepted) {
      const takeoff = data.event?.takeoff;
      if (takeoff?.reason === 'disarmed') {
        setMessage('Alert logged. Takeoff skipped (ARM OFF).');
      } else if (takeoff?.attempted) {
        const ok = takeoff.voice?.ok || takeoff.webhook?.ok;
        setMessage(ok ? 'Alert logged + takeoff hook fired.' : takeoff.note || 'Alert logged; takeoff stubbed.');
      } else {
        setMessage('Alert logged.');
      }
      await refreshLog();
    }
  } catch (error) {
    setMessage(`Could not reach server: ${error instanceof Error ? error.message : error}`, true);
  }

  setTimeout(() => {
    if (watching) setDetectUi('watch');
    else setDetectUi('idle');
  }, 1200);
}

async function detectOnce() {
  if (!model || !modelReady || video.readyState < 2) return;
  try {
    const preds = await model.detect(video, 20, PERSON_MIN_SCORE);
    const people = preds
      .filter((p) => p.class === 'person')
      .map((p) => ({ bbox: p.bbox, score: p.score }));
    lastPeople = people;
    drawOverlay();

    if (!watching || !roi) return;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    for (const person of people) {
      const [bx, by, bw, bh] = person.bbox;
      const box = { x: bx / vw, y: by / vh, w: bw / vw, h: bh / vh };
      if (boxesOverlapNorm(box, roi)) {
        void postIntrusion({ score: person.score, note: 'person-in-roi' });
        break;
      }
    }
  } catch (error) {
    camStatus.textContent = `Detect error: ${error instanceof Error ? error.message : error}`;
  }
}

function startWatching() {
  if (!roi) {
    setMessage('Draw a red zone first.', true);
    return;
  }
  if (!modelReady) {
    setMessage('Wait for the person model to finish loading.', true);
    return;
  }
  watching = true;
  btnStart.textContent = 'Pause watching';
  setDetectUi('watch');
  setMessage('Watching for people in the red zone…');
  void detectOnce();
  detectTimer = window.setInterval(() => void detectOnce(), DETECT_EVERY_MS);
}

function stopWatching() {
  watching = false;
  window.clearInterval(detectTimer);
  detectTimer = 0;
  btnStart.textContent = 'Start watching';
  setDetectUi('idle');
  setMessage('Watching paused.');
}

btnStart.addEventListener('click', () => {
  if (watching) stopWatching();
  else startWatching();
});

btnTest.addEventListener('click', () => {
  void postIntrusion({ score: 1, note: 'manual-test', force: true });
});

armToggle.addEventListener('change', async () => {
  const armed = armToggle.checked;
  if (armed) {
    const ok = window.confirm(
      'ARM will allow real drone takeoff on the next person intrusion (if metoera-voice is running).\n\nIs a human standing next to the drone?',
    );
    if (!ok) {
      armToggle.checked = false;
      return;
    }
  }
  try {
    const response = await fetch('/api/arm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed }),
    });
    const data = await response.json();
    setArmedUi(Boolean(data.armed));
    setMessage(data.armed ? 'ARMED — takeoff enabled on person detect.' : 'Disarmed — alerts log only.', data.armed);
    await refreshLog();
  } catch {
    armToggle.checked = !armed;
    setMessage('Could not update ARM state.', true);
  }
});

async function refreshLog() {
  try {
    const response = await fetch('/api/events?limit=12');
    const data = await response.json();
    logEl.innerHTML = '';
    for (const event of data.events ?? []) {
      const li = document.createElement('li');
      const when = event.at ? new Date(event.at).toLocaleTimeString() : '';
      if (event.type === 'intrusion') {
        const takeoff =
          event.takeoff?.reason === 'disarmed'
            ? 'takeoff skipped'
            : event.takeoff?.attempted
              ? 'takeoff hook'
              : '';
        li.innerHTML = `<strong>Person / intrusion</strong> ${when}${takeoff ? ` · ${takeoff}` : ''}`;
      } else if (event.type === 'arm') {
        li.innerHTML = `<strong>ARM ${event.armed ? 'ON' : 'OFF'}</strong> ${when}`;
      } else {
        li.textContent = `${event.type ?? 'event'} ${when}`;
      }
      logEl.appendChild(li);
    }
  } catch {
    /* ignore */
  }
}

async function syncState() {
  try {
    const response = await fetch('/api/state');
    const data = await response.json();
    setArmedUi(Boolean(data.armed));
  } catch {
    setArmedUi(false);
  }
}

window.addEventListener('resize', () => {
  updateOrientationHint();
  syncCanvasSize();
});
window.addEventListener('orientationchange', () => {
  updateOrientationHint();
  setTimeout(syncCanvasSize, 250);
});

updateOrientationHint();
setDetectUi('idle');
void (async () => {
  const preferred = /** @type {LensId | null} */ (localStorage.getItem(LENS_KEY));
  try {
    // Open environment first so labels + zoom capabilities appear, then map lenses.
    await startLens(preferred === 'wide' || preferred === 'tele' || preferred === 'normal' ? preferred : 'normal');
    // If preferred lens became available after discovery, switch to it.
    if (preferred && lenses[preferred] && preferred !== activeLens) {
      await startLens(preferred);
    }
  } catch (error) {
    camStatus.textContent = 'Camera blocked';
    setMessage(
      `Back camera failed (${error instanceof Error ? error.message : error}). Use the HTTPS link and allow camera.`,
      true,
    );
  }
  void loadModel();
  void syncState();
  void refreshLog();
  setInterval(() => void refreshLog(), 5000);
  setInterval(() => {
    if (!watching && modelReady) void detectOnce();
  }, 800);
})();
