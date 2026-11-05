const boards = document.getElementById('boards');
const logEl = document.getElementById('log');
const joinHint = document.getElementById('joinHint');

/** @type {Record<string, any>} */
let slots = {};
let panelsReady = false;

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${text}</span>`;
}

function ensurePanels() {
  if (panelsReady) return;
  boards.innerHTML = ['1', '2', '3']
    .map(
      (id) => `
    <article class="panel" data-slot="${id}">
      <h2 class="slot-title">Phone ${id}</h2>
      <div class="meta" data-meta></div>
      <img class="preview" alt="Phone ${id} live preview" data-preview src="/api/slots/${id}/preview.mjpeg" />
      <div class="preview missing" data-missing hidden>Offline — open phone URL</div>
      <p class="detail" data-detail></p>
      <div class="row">
        <button type="button" class="btn primary" data-act="watch-on">Start</button>
        <button type="button" class="btn" data-act="watch-off">Stop</button>
        <button type="button" class="btn danger" data-act="arm-on">ARM</button>
        <button type="button" class="btn" data-act="arm-off">Disarm</button>
      </div>
      <div class="row" role="group" aria-label="Lens">
        <button type="button" class="lens-btn" data-act="lens-wide">Wide</button>
        <button type="button" class="lens-btn" data-act="lens-normal">Normal</button>
        <button type="button" class="lens-btn" data-act="lens-tele">Tele</button>
      </div>
      <label class="sens">
        <span>Sensitivity <strong data-sens-val>35</strong></span>
        <input type="range" min="0" max="100" value="35" data-sens />
      </label>
    </article>`,
    )
    .join('');
  panelsReady = true;
}

function updatePanel(slot) {
  const panel = boards.querySelector(`[data-slot="${slot.id}"]`);
  if (!panel) return;
  const online = Boolean(slot.online);
  const lenses = slot.lensesAvailable || {};
  panel.querySelector('.slot-title').textContent = slot.name || `Phone ${slot.id}`;
  panel.querySelector('[data-meta]').innerHTML = [
    badge(online ? 'Online' : 'Offline', online ? 'live' : 'off'),
    badge(slot.watching ? 'Watching' : 'Idle', slot.watching ? 'on' : 'off'),
    badge(slot.armed ? 'ARM ON' : 'ARM OFF', slot.armed ? 'armed' : 'off'),
    badge(`Lens ${slot.lens || '—'}`),
    badge(`Sens ${slot.sensitivity ?? 35}`),
  ].join('');

  const img = panel.querySelector('[data-preview]');
  const missing = panel.querySelector('[data-missing]');
  if (online) {
    img.hidden = false;
    missing.hidden = true;
    // Keep stable MJPEG URL — don't thrash src (that caused freezes).
    if (!img.dataset.mjpeg) {
      img.src = `/api/slots/${slot.id}/preview.mjpeg`;
      img.dataset.mjpeg = '1';
    }
  } else {
    img.hidden = true;
    missing.hidden = false;
  }

  const dwell = typeof slot.dwellMs === 'number' ? Math.min(100, Math.round((slot.dwellMs / 1000) * 100)) : 0;
  const s = slot.sensors;
  const sensorBits = s
    ? [
        s.headingDeg != null ? `compass ${Number(s.headingDeg).toFixed(0)}°` : null,
        s.tiltDeg != null ? `tilt↓ ${Number(s.tiltDeg).toFixed(0)}°` : null,
        s.depthM != null ? `depth~ ${Number(s.depthM).toFixed(1)} m` : 'depth —',
        slot.sensorsLive ? 'live' : 'cached',
      ].filter(Boolean).join(' · ')
    : 'sensors off';
  const est = Array.isArray(slot.personEstimates) ? slot.personEstimates.length : 0;
  panel.querySelector('[data-detail]').textContent =
    `ROI ${slot.roi ? 'set' : 'none'} · score ${
      slot.personScore == null ? '—' : Number(slot.personScore).toFixed(2)
    } · dwell ${dwell}% · ${sensorBits}${est ? ` · ${est} mapped` : ''}${slot.lastError ? ` · ${slot.lastError}` : ''}`;

  for (const btn of panel.querySelectorAll('[data-act]')) {
    const act = btn.getAttribute('data-act');
    let enabled = online;
    if (act === 'lens-wide') enabled = online && Boolean(lenses.wide);
    if (act === 'lens-normal') enabled = online && lenses.normal !== false;
    if (act === 'lens-tele') enabled = online && Boolean(lenses.tele);
    btn.disabled = !enabled;
    btn.classList.toggle('active', act === `lens-${slot.lens}`);
  }

  const sens = panel.querySelector('[data-sens]');
  const sensVal = panel.querySelector('[data-sens-val]');
  if (sens && document.activeElement !== sens) {
    sens.value = String(slot.sensitivity ?? 35);
    sens.disabled = !online;
  }
  if (sensVal) sensVal.textContent = String(slot.sensitivity ?? 35);
}

function render() {
  ensurePanels();
  for (const id of ['1', '2', '3']) {
    updatePanel(slots[id] || { id, online: false, name: `Phone ${id}` });
  }
}

async function sendCommand(slotId, command) {
  await fetch(`/api/slots/${slotId}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  });
}

boards.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  const panel = e.target.closest('[data-slot]');
  if (!btn || !panel) return;
  const slotId = panel.getAttribute('data-slot');
  const act = btn.getAttribute('data-act');
  const map = {
    'watch-on': { type: 'watch', watching: true },
    'watch-off': { type: 'watch', watching: false },
    'arm-on': { type: 'arm', armed: true },
    'arm-off': { type: 'arm', armed: false },
    'lens-wide': { type: 'lens', lens: 'wide' },
    'lens-normal': { type: 'lens', lens: 'normal' },
    'lens-tele': { type: 'lens', lens: 'tele' },
  };
  const command = map[act];
  if (!command) return;
  if (command.type === 'arm' && command.armed) {
    const ok = window.confirm(`ARM Phone ${slotId} for real takeoff? Human must be next to the drone.`);
    if (!ok) return;
  }
  void sendCommand(slotId, command);
});

boards.addEventListener('change', (e) => {
  const input = e.target.closest('[data-sens]');
  const panel = e.target.closest('[data-slot]');
  if (!input || !panel) return;
  const slotId = panel.getAttribute('data-slot');
  const sensitivity = Number(input.value);
  panel.querySelector('[data-sens-val]').textContent = String(sensitivity);
  void sendCommand(slotId, { type: 'sensitivity', sensitivity });
});

boards.addEventListener('input', (e) => {
  const input = e.target.closest('[data-sens]');
  const panel = e.target.closest('[data-slot]');
  if (!input || !panel) return;
  panel.querySelector('[data-sens-val]').textContent = String(input.value);
});

async function refreshEvents() {
  try {
    const data = await (await fetch('/api/events?limit=20')).json();
    logEl.innerHTML = '';
    for (const event of data.events ?? []) {
      const li = document.createElement('li');
      const when = event.at ? new Date(event.at).toLocaleTimeString() : '';
      const slot = event.slotId ? `P${event.slotId}` : '';
      li.textContent = `${when} ${slot} ${event.type}${event.armed != null ? ` armed=${event.armed}` : ''}${
        event.note ? ` ${event.note}` : ''
      }`;
      logEl.appendChild(li);
    }
  } catch {
    /* ignore */
  }
}

async function boot() {
  ensurePanels();
  try {
    const health = await (await fetch('/api/health')).json();
    const base =
      health.lan && health.phonePort
        ? `https://${health.lan}:${health.phonePort}/?key=…`
        : 'https://<LAN>:<phonePort>/?key=…';
    joinHint.textContent =
      `Phones: ${base}&slot=1|2|3. Mac preview is MJPEG ~4fps (small JPEGs). Person alert needs ~1s in zone. ARM default OFF.`;
    const data = await (await fetch('/api/slots')).json();
    slots = Object.fromEntries((data.slots || []).map((s) => [s.id, s]));
    render();
  } catch {
    joinHint.textContent = 'Cannot reach redzone API.';
  }

  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'slots') {
        slots = Object.fromEntries((msg.slots || []).map((s) => [s.id, s]));
        render();
      }
    } catch {
      /* ignore */
    }
  };

  // Light status poll (MJPEG handles video; this keeps badges fresh without DOM rebuild thrash)
  setInterval(async () => {
    try {
      const data = await (await fetch('/api/slots')).json();
      slots = Object.fromEntries((data.slots || []).map((s) => [s.id, s]));
      render();
    } catch {
      /* ignore */
    }
  }, 2000);

  void refreshEvents();
  setInterval(() => void refreshEvents(), 5000);
}

void boot();
