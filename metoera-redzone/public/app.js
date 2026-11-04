/**
 * Metoera red-zone phone UI.
 * Person-only alerts via TensorFlow.js COCO-SSD (lite_mobilenet_v2).
 * Landscape-first + up to 3 cameras.
 */
const CAM_KEY = 'metoera-redzone-cam';
const PERSON_MIN_SCORE = 0.45;
const DETECT_EVERY_MS = 350;
const CLIENT_ALERT_GAP_MS = 1500;

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const camStatus = $('camStatus');
const message = $('message');
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
const camButtons = [0, 1, 2].map((i) => $(`cam${i}`));

const octx = overlay.getContext('2d');

/** @type {{ x: number, y: number, w: number, h: number } | null} */
let roi = null;
/** @type {MediaDeviceInfo[]} */
let videoInputs = [];
/** @type {string | null} */
let activeDeviceId = null;
/** @type {MediaStream | null} */
let stream = null;
/** @type {import('@tensorflow-models/coco-ssd').ObjectDetection | null} */
let model = null;
/** @type {{bbox: number[], score: number}[]} */
let lastPeople = [];

let watching = false;
let detectTimer = 0;
let drag = null;
let lastClientAlert = 0;
let modelReady = false;

function roiKey(deviceId) {
  return `metoera-redzone-roi:${deviceId || 'default'}`;
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function loadRoi() {
  try {
    const raw = JSON.parse(localStorage.getItem(roiKey(activeDeviceId)) ?? '');
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
  const key = roiKey(activeDeviceId);
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
    /* iOS Safari usually denies lock outside fullscreen */
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
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
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
    setMessage('Red zone saved for this camera.');
  }
  drawOverlay();
});

btnClear.addEventListener('click', () => {
  roi = null;
  saveRoi();
  drawOverlay();
  setMessage('Zone cleared.');
});

function stopStream() {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  video.srcObject = null;
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput').slice(0, 3);
}

function renderCamButtons() {
  for (let i = 0; i < 3; i += 1) {
    const btn = camButtons[i];
    const device = videoInputs[i];
    if (!device) {
      btn.disabled = true;
      btn.classList.remove('active');
      btn.title = 'No camera';
      continue;
    }
    btn.disabled = false;
    btn.title = device.label || `Camera ${i + 1}`;
    btn.classList.toggle('active', device.deviceId === activeDeviceId);
  }
}

async function startCamera(deviceId) {
  camStatus.textContent = 'Asking for camera…';
  stopStream();
  const constraints = {
    audio: false,
    video: deviceId
      ? {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        }
      : {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    activeDeviceId = track?.getSettings?.().deviceId || deviceId || null;
    if (activeDeviceId) localStorage.setItem(CAM_KEY, activeDeviceId);
    videoInputs = await listCameras();
    renderCamButtons();
    loadRoi();
    syncCanvasSize();
    const label = track?.label || 'Camera';
    camStatus.textContent = `${label} · draw red zone`;
    setMessage(videoInputs.length ? `${videoInputs.length} camera(s) available.` : 'Camera live.');
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    camStatus.textContent = `Camera blocked (${name}). Use the HTTPS link.`;
    setMessage('iOS Safari needs HTTPS for camera access.', true);
    throw error;
  }
}

async function switchCamera(slot) {
  const device = videoInputs[slot];
  if (!device) return;
  const wasWatching = watching;
  if (watching) stopWatching();
  try {
    await startCamera(device.deviceId);
    if (wasWatching) startWatching();
  } catch {
    /* message already set */
  }
}

for (const btn of camButtons) {
  btn.addEventListener('click', () => {
    const slot = Number(btn.dataset.slot);
    void switchCamera(slot);
  });
}

async function loadModel() {
  modelBadge.textContent = 'Model…';
  modelBadge.className = 'badge idle';
  if (typeof cocoSsd === 'undefined' || typeof tf === 'undefined') {
    modelBadge.textContent = 'No TF';
    setMessage('Could not load TensorFlow.js / COCO-SSD from CDN. Check network.', true);
    return;
  }
  try {
    // Prefer WebGL; fall back silently.
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
  const preferred = localStorage.getItem(CAM_KEY);
  try {
    // Permission first so device labels populate.
    await startCamera(preferred || undefined);
  } catch {
    /* already messaged */
  }
  void loadModel();
  void syncState();
  void refreshLog();
  setInterval(() => void refreshLog(), 5000);
  // Keep painting boxes while idle too (light).
  setInterval(() => {
    if (!watching && modelReady) void detectOnce();
  }, 800);
})();
