const boards = document.getElementById('boards');
const logEl = document.getElementById('log');
const joinHint = document.getElementById('joinHint');

/** @type {Record<string, any>} */
let slots = {};

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${text}</span>`;
}

function panelHtml(slot) {
  const online = slot.online;
  const preview = online && slot.hasPreview
    ? `<img class="preview" alt="Phone ${slot.id} preview" src="/api/slots/${slot.id}/preview.jpg?t=${slot.previewAt || Date.now()}" />`
    : `<div class="preview missing">${online ? 'Waiting for snapshot…' : 'Offline — open phone URL'}</div>`;
  const lenses = slot.lensesAvailable || {};
  return `
    <article class="panel" data-slot="${slot.id}">
      <h2>${slot.name || `Phone ${slot.id}`}</h2>
      <div class="meta">
        ${badge(online ? 'Online' : 'Offline', online ? 'live' : 'off')}
        ${badge(slot.watching ? 'Watching' : 'Idle', slot.watching ? 'on' : 'off')}
        ${badge(slot.armed ? 'ARM ON' : 'ARM OFF', slot.armed ? 'armed' : 'off')}
        ${badge(`Lens ${slot.lens || '—'}`)}
      </div>
      ${preview}
      <p class="detail">
        ROI ${slot.roi ? 'set' : 'none'}
        · score ${slot.personScore == null ? '—' : slot.personScore.toFixed?.(2) ?? slot.personScore}
        ${slot.lastError ? `· ${slot.lastError}` : ''}
      </p>
      <div class="row">
        <button type="button" class="btn primary" data-act="watch-on" ${online ? '' : 'disabled'}>Start</button>
        <button type="button" class="btn" data-act="watch-off" ${online ? '' : 'disabled'}>Stop</button>
        <button type="button" class="btn danger" data-act="arm-on" ${online ? '' : 'disabled'}>ARM</button>
        <button type="button" class="btn" data-act="arm-off" ${online ? '' : 'disabled'}>Disarm</button>
      </div>
      <div class="row" role="group" aria-label="Lens">
        <button type="button" class="lens-btn ${slot.lens === 'wide' ? 'active' : ''}" data-act="lens-wide" ${lenses.wide && online ? '' : 'disabled'}>Wide</button>
        <button type="button" class="lens-btn ${slot.lens === 'normal' ? 'active' : ''}" data-act="lens-normal" ${lenses.normal !== false && online ? '' : 'disabled'}>Normal</button>
        <button type="button" class="lens-btn ${slot.lens === 'tele' ? 'active' : ''}" data-act="lens-tele" ${lenses.tele && online ? '' : 'disabled'}>Tele</button>
      </div>
    </article>
  `;
}

function render() {
  const list = ['1', '2', '3'].map((id) => slots[id] || { id, online: false, name: `Phone ${id}` });
  boards.innerHTML = list.map(panelHtml).join('');
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
  try {
    const health = await (await fetch('/api/health')).json();
    const base = health.lan && health.phonePort
      ? `https://${health.lan}:${health.phonePort}/?key=…`
      : 'https://<LAN>:<phonePort>/?key=…';
    joinHint.textContent =
      `Phones join: ${base}&slot=1  ·  &slot=2  ·  &slot=3  (or open without slot and pick). Snapshots ~1–2s — not full live video.`;
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

  void refreshEvents();
  setInterval(() => void refreshEvents(), 4000);
  // Refresh preview images even if SSE meta didn't change bytes
  setInterval(() => {
    if (Object.values(slots).some((s) => s?.online && s?.hasPreview)) render();
  }, 1500);
}

void boot();
