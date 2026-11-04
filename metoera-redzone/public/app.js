const ROI_KEY = 'metoera-redzone-roi';
const SAMPLE = 96;
const DIFF_THRESHOLD = 28;
const MOTION_RATIO = 0.045;

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const work = $('work');
const camStatus = $('camStatus');
const message = $('message');
const logEl = $('log');
const armedBadge = $('armedBadge');
const detectBadge = $('detectBadge');
const armToggle = $('armToggle');
const flash = $('flash');
const btnStart = $('btnStart');
const btnClear = $('btnClear');
const btnTest = $('btnTest');

const octx = overlay.getContext('2d');
const wctx = work.getContext('2d', { willReadFrequently: true });

/** @type {{ x: number, y: number, w: number, h: number } | null} */
let roi = null;
/** @type {Uint8ClampedArray | null} */
let prevGray = null;
let watching = false;
let raf = 0;
let drag = null;
let lastClientAlert = 0;

function loadRoi() {
  try {
    const raw = JSON.parse(localStorage.getItem(ROI_KEY) ?? '');
    if (
      raw &&
      typeof raw.x === 'number' &&
      typeof raw.y === 'number' &&
      typeof raw.w === 'number' &&
      typeof raw.h === 'number' &&
      raw.w > 0.02 &&
      raw.h > 0.02
    ) {
      roi = {
        x: clamp01(raw.x),
        y: clamp01(raw.y),
        w: clamp01(raw.w),
        h: clamp01(raw.h),
      };
    }
  } catch {
    roi = null;
  }
}

function saveRoi() {
  if (roi) localStorage.setItem(ROI_KEY, JSON.stringify(roi));
  else localStorage.removeItem(ROI_KEY);
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
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
    mode === 'watch' ? 'Watching' : mode === 'alert' ? 'Intrusion' : 'Idle';
}

function syncCanvasSize() {
  const rect = overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.max(1, Math.floor(rect.width * dpr));
  overlay.height = Math.max(1, Math.floor(rect.height * dpr));
  drawOverlay();
}

function drawOverlay(highlight = false) {
  const { width, height } = overlay;
  octx.clearRect(0, 0, width, height);
  if (!roi) return;
  const x = roi.x * width;
  const y = roi.y * height;
  const w = roi.w * width;
  const h = roi.h * height;
  octx.fillStyle = highlight ? 'rgba(194, 59, 42, 0.35)' : 'rgba(194, 59, 42, 0.22)';
  octx.fillRect(x, y, w, h);
  octx.strokeStyle = '#c23b2a';
  octx.lineWidth = Math.max(2, width * 0.006);
  octx.strokeRect(x, y, w, h);
  octx.fillStyle = '#f3ebe0';
  octx.font = `${Math.max(12, width * 0.035)}px sans-serif`;
  octx.fillText('RED ZONE', x + 8, Math.max(y - 8, 18));
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
    setMessage('Red zone saved on this phone.');
  }
  drawOverlay();
});

btnClear.addEventListener('click', () => {
  roi = null;
  prevGray = null;
  saveRoi();
  drawOverlay();
  setMessage('Zone cleared.');
});

async function startCamera() {
  camStatus.textContent = 'Asking for camera…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    video.srcObject = stream;
    await video.play();
    camStatus.textContent = 'Camera live — draw a red zone';
    syncCanvasSize();
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    camStatus.textContent = `Camera blocked (${name}). Use HTTPS link from the Mac terminal.`;
    setMessage('iOS Safari needs HTTPS (or localhost) for getUserMedia.', true);
  }
}

function sampleRoiGray() {
  if (!roi || video.readyState < 2) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const sx = Math.floor(roi.x * vw);
  const sy = Math.floor(roi.y * vh);
  const sw = Math.max(1, Math.floor(roi.w * vw));
  const sh = Math.max(1, Math.floor(roi.h * vh));

  work.width = SAMPLE;
  work.height = SAMPLE;
  wctx.drawImage(video, sx, sy, sw, sh, 0, 0, SAMPLE, SAMPLE);
  const { data } = wctx.getImageData(0, 0, SAMPLE, SAMPLE);
  const gray = new Uint8ClampedArray(SAMPLE * SAMPLE);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return gray;
}

function motionScore(curr) {
  if (!prevGray || prevGray.length !== curr.length) {
    prevGray = curr;
    return 0;
  }
  let changed = 0;
  for (let i = 0; i < curr.length; i += 1) {
    if (Math.abs(curr[i] - prevGray[i]) > DIFF_THRESHOLD) changed += 1;
  }
  prevGray = curr;
  return changed / curr.length;
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
  if (!force && now - lastClientAlert < 1500) return;
  lastClientAlert = now;

  setDetectUi('alert');
  visualAlert();
  beep();
  setMessage('Movement in red zone — alerting…', true);

  try {
    const response = await fetch('/api/intrusion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: typeof score === 'number' ? score : null,
        roi,
        note: note ?? 'motion',
        force,
      }),
    });
    const data = await response.json();
    if (data.debounced) {
      setMessage(`Logged locally; server debounce (${Math.ceil((data.retryAfterMs ?? 0) / 1000)}s).`);
    } else if (data.accepted) {
      const takeoff = data.event?.takeoff;
      if (takeoff?.reason === 'disarmed') {
        setMessage('Alert logged. Takeoff skipped (ARM OFF).');
      } else if (takeoff?.attempted) {
        const ok = takeoff.voice?.ok || takeoff.webhook?.ok;
        setMessage(ok ? 'Alert logged + takeoff hook fired.' : takeoff.note || 'Alert logged; takeoff hook stubbed.');
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

function loop() {
  if (!watching) return;
  const gray = sampleRoiGray();
  if (gray) {
    const score = motionScore(gray);
    if (score >= MOTION_RATIO) {
      void postIntrusion({ score });
    }
  }
  raf = requestAnimationFrame(loop);
}

btnStart.addEventListener('click', () => {
  if (watching) {
    watching = false;
    cancelAnimationFrame(raf);
    prevGray = null;
    btnStart.textContent = 'Start watching';
    setDetectUi('idle');
    setMessage('Watching paused.');
    return;
  }
  if (!roi) {
    setMessage('Draw a red zone first.', true);
    return;
  }
  watching = true;
  prevGray = null;
  btnStart.textContent = 'Pause watching';
  setDetectUi('watch');
  setMessage('Watching red zone…');
  raf = requestAnimationFrame(loop);
});

btnTest.addEventListener('click', () => {
  void postIntrusion({ score: 1, note: 'manual-test', force: true });
});

armToggle.addEventListener('change', async () => {
  const armed = armToggle.checked;
  if (armed) {
    const ok = window.confirm(
      'ARM will allow real drone takeoff on the next intrusion (if metoera-voice is running).\n\nIs a human standing next to the drone?',
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
    setMessage(data.armed ? 'ARMED — takeoff enabled on detect.' : 'Disarmed — alerts log only.', data.armed);
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
        const takeoff = event.takeoff?.reason === 'disarmed'
          ? 'takeoff skipped'
          : event.takeoff?.attempted
            ? 'takeoff hook'
            : '';
        li.innerHTML = `<strong>Intrusion</strong> ${when}${takeoff ? ` · ${takeoff}` : ''}`;
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

window.addEventListener('resize', syncCanvasSize);
loadRoi();
setDetectUi('idle');
void startCamera();
void syncState();
void refreshLog();
setInterval(() => void refreshLog(), 5000);
