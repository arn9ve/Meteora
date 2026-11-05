// Meteora pitch: slide navigation, the voice of Grok, the dot field and the Meteora Scan demo.
(() => {
  const deck = document.getElementById('deck');
  const slides = [...document.querySelectorAll('.slide')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pad = (n) => String(n).padStart(2, '0');
  let current = 0;

  // ---------- navigation: rail of dots, arrows, keys, hash, overview ----------
  const rail = document.getElementById('rail');
  const ovList = document.getElementById('ovList');
  slides.forEach((s, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', `${i + 1}. ${s.dataset.title}`);
    b.title = s.dataset.title;
    b.innerHTML = '<span></span>';
    b.addEventListener('click', () => go(i));
    rail.append(b);
    const li = document.createElement('li');
    const o = document.createElement('button');
    o.innerHTML = `<span>${pad(i + 1)}</span>`;
    o.append(document.createTextNode(s.dataset.title));
    o.addEventListener('click', () => { closeOverview(); go(i, false); });
    li.append(o);
    ovList.append(li);
  });
  const narrow = () => innerWidth <= 860;
  function go(i, smooth = true) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    slides[i].scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
    setActive(i);
  }
  function setActive(i) {
    if (i === current && rail.children[i]?.getAttribute('aria-current') === 'true') return;
    current = i;
    [...rail.children].forEach((b, k) => b.setAttribute('aria-current', String(k === i)));
    [...ovList.querySelectorAll('button')].forEach((b, k) => b.setAttribute('aria-current', String(k === i)));
    document.getElementById('count').textContent = `${pad(i + 1)} / ${pad(slides.length)}`;
    const id = slides[i].id;
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
    speak();
    document.body.classList.toggle('on-red', slides[i].classList.contains('red'));
    document.body.classList.toggle('on-green', slides[i].classList.contains('green'));
    slides.forEach((s, k) => s.classList.toggle('is-active', k === i));
    if (slides[i].id === 'talk') playChat();
    if (slides[i].id === 'nearest') effStart = performance.now();
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.55) setActive(slides.indexOf(e.target));
  }, { root: narrow() ? null : deck, threshold: [0.55] });
  slides.forEach((s) => io.observe(s));

  document.getElementById('prev').addEventListener('click', () => go(current - 1));
  document.getElementById('next').addEventListener('click', () => go(current + 1));
  const overview = document.getElementById('overview');
  const openOverview = () => { overview.hidden = false; ovList.querySelector('[aria-current="true"]')?.focus(); };
  const closeOverview = () => { overview.hidden = true; };
  document.getElementById('ovBtn').addEventListener('click', openOverview);
  document.getElementById('ovClose').addEventListener('click', closeOverview);
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!overview.hidden) { if (e.key === 'Escape' || e.key === 'g') closeOverview(); return; }
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(current + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); go(current - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
    else if (e.key === 'g' || e.key === 'o') openOverview();
    else if (e.key === 'f') document.documentElement.requestFullscreen?.().catch(() => {});
  });
  const fromHash = () => { const i = slides.findIndex((s) => s.id === location.hash.slice(1)); if (i >= 0) go(i, false); };
  addEventListener('hashchange', fromHash);

  // ---------- the voice of Grok: only the dots, a short pulse on each slide ----------
  let speakingUntil = 0;
  function speak() { speakingUntil = performance.now() + 1600; }

  // ---------- the dot field: small marks, a band that moves with the voice ----------
  const shapes = ['circle', 'diamond', 'triangle', 'square', 'circle'];
  function mark(g, kind, x, y, r) {
    g.beginPath();
    if (kind === 'circle') g.arc(x, y, r, 0, Math.PI * 2);
    else if (kind === 'diamond') { g.moveTo(x, y - r * 1.2); g.lineTo(x + r * 1.2, y); g.lineTo(x, y + r * 1.2); g.lineTo(x - r * 1.2, y); }
    else if (kind === 'triangle') { g.moveTo(x, y - r * 1.2); g.lineTo(x + r * 1.1, y + r * 0.9); g.lineTo(x - r * 1.1, y + r * 0.9); }
    else g.rect(x - r, y - r, r * 2, r * 2);
    g.fill();
  }
  function field(canvas, { spacing, size, band, live, white = false }) {
    const g = canvas.getContext('2d');
    let w = 0, h = 0;
    const fit = () => { const r = canvas.getBoundingClientRect(); const d = Math.min(2, devicePixelRatio || 1); w = r.width; h = r.height; canvas.width = w * d; canvas.height = h * d; g.setTransform(d, 0, 0, d, 0, 0); };
    fit(); new ResizeObserver(fit).observe(canvas);
    return (t) => {
      g.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / spacing) + 1, rows = Math.ceil(h / spacing) + 1;
      const hot = live();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = c * spacing + spacing / 2, y = r * spacing + spacing / 2;
        const middle = Math.exp(-(((c / cols - 0.5) * 3) ** 2));
        const centre = rows * band + Math.sin(c * 0.45 + t / 600) * (1 + middle * 2) * (hot ? 1 : 0.4);
        const on = Math.abs(r - centre) < 1 + middle * (hot ? 2.2 : 1) && (r + c + Math.floor(t / 220)) % 3 !== 0;
        const rd = white && document.body.classList.contains('on-red');
        g.fillStyle = on ? (hot ? (rd ? '#ffffff' : '#c62828') : (rd ? 'rgba(255,255,255,.8)' : '#5b5b5b')) : (rd ? 'rgba(255,255,255,.28)' : '#e4e4e4');
        mark(g, shapes[(r * 3 + c * 7) % shapes.length], x, y, size);
      }
    };
  }
  const cover = document.querySelector('#cover canvas.field');
  const drawCover = field(cover, { spacing: 30, size: 2.6, band: 0.55, live: () => current === 0 && performance.now() < speakingUntil });
  const drawVoice = field(document.getElementById('voiceDots'), { spacing: 12, size: 1.6, band: 0.5, live: () => performance.now() < speakingUntil || (talkingGrok && performance.now() < talkingUntil), white: true });

  // ---------- Meteora Scan: the plan builds itself as the phone walks ----------
  const scan = document.getElementById('scanCanvas');
  const sg = scan.getContext('2d');
  const scanState = document.getElementById('scanState'), scanPct = document.getElementById('scanPct');
  let sw = 0, sh = 0;
  const fitScan = () => { const r = scan.getBoundingClientRect(); const d = Math.min(2, devicePixelRatio || 1); sw = r.width; sh = r.height; scan.width = sw * d; scan.height = sh * d; sg.setTransform(d, 0, 0, d, 0, 0); };
  fitScan(); new ResizeObserver(fitScan).observe(scan);
  // The hall as seen from above, in metres (22.8 x 9.6), rotated to stand upright on the phone.
  const W = 9.6, H = 22.8;
  const pillars = [[4.8, 4.8], [4.8, 9.6], [4.8, 13.2], [4.8, 18]];
  const tables = [[2, 3], [7.4, 3.6], [2.4, 11.4], [7.2, 8.2], [7.4, 15], [2.2, 17.6]];
  const cams = [[0.6, 0.6, 45], [9, 11, 180], [0.6, 22.2, -45]];
  function drawScan(t) {
    const cycle = 9000, p = reduce ? 1 : Math.min(1, ((t % cycle) / cycle) * 1.25);
    const k = Math.min((sw - 24) / W, (sh - 24) / H), ox = (sw - W * k) / 2, oy = (sh - H * k) / 2;
    const X = (x) => ox + x * k, Y = (y) => oy + y * k;
    sg.clearRect(0, 0, sw, sh);
    const reach = p * H * 1.05;              // how far the walk has reached
    sg.save(); sg.beginPath(); sg.rect(0, 0, sw, Y(Math.min(H, reach))); sg.clip();
    sg.strokeStyle = '#202020'; sg.lineWidth = 2; sg.strokeRect(X(0), Y(0), W * k, H * k);
    sg.fillStyle = '#9b9b9b'; for (const [x, y] of pillars) sg.fillRect(X(x - 0.35), Y(y - 0.6), 0.7 * k, 1.2 * k);
    sg.strokeStyle = '#b5b5b5'; sg.lineWidth = 1; for (const [x, y] of tables) sg.strokeRect(X(x - 0.9), Y(y - 0.9), 1.8 * k, 1.8 * k);
    sg.restore();
    // the scan line and the walker
    if (p < 1) {
      const y = Y(Math.min(H, reach));
      sg.fillStyle = 'rgba(198,40,40,0.08)'; sg.fillRect(X(0), y - 26, W * k, 26);
      sg.strokeStyle = '#c62828'; sg.lineWidth = 1.5; sg.beginPath(); sg.moveTo(X(0), y); sg.lineTo(X(W), y); sg.stroke();
      sg.fillStyle = '#c62828'; sg.beginPath(); sg.arc(X(W / 2 + Math.sin(t / 500) * 2.5), y, 4, 0, Math.PI * 2); sg.fill();
    }
    // cameras appear once the walls are done, with their view cones
    if (p >= 0.85) {
      for (const [x, y, a] of cams) {
        const rad = (a * Math.PI) / 180, len = 4 * k;
        sg.fillStyle = 'rgba(32,32,32,0.06)'; sg.beginPath(); sg.moveTo(X(x), Y(y));
        sg.lineTo(X(x) + Math.cos(rad - 0.5) * len, Y(y) + Math.sin(rad - 0.5) * len);
        sg.lineTo(X(x) + Math.cos(rad + 0.5) * len, Y(y) + Math.sin(rad + 0.5) * len); sg.closePath(); sg.fill();
        sg.fillStyle = '#202020'; sg.fillRect(X(x) - 3, Y(y) - 3, 6, 6);
      }
      // a red zone, last
      sg.fillStyle = 'rgba(198,40,40,0.14)'; sg.strokeStyle = '#c62828'; sg.lineWidth = 1;
      sg.fillRect(X(5.6), Y(19.2), 3.4 * k, 3 * k); sg.strokeRect(X(5.6), Y(19.2), 3.4 * k, 3 * k);
    }
    const pct = Math.round(Math.min(1, p) * 100);
    scanPct.textContent = `${pct}%`;
    scanState.textContent = p < 0.85 ? 'Scanning walls, pillars, tables' : 'Cameras placed · zone ready';
  }


  // Draw a sprite icon on a canvas (paths, circles, rects of the symbol), centred at x,y.
  function drawIcon(g, id, x, y, size, color, width = 1.6) {
    const sym = document.getElementById(id); if (!sym) return;
    g.save(); g.translate(x - size / 2, y - size / 2); g.scale(size / 24, size / 24);
    g.strokeStyle = color; g.lineWidth = width * 24 / size * (size / 24); g.lineCap = 'round'; g.lineJoin = 'round';
    g.fillStyle = '#ffffff'; g.fillRect(2, 2, 20, 20);
    for (const el of sym.children) {
      const t = el.tagName.toLowerCase(); g.beginPath();
      if (t === 'path') { g.stroke(new Path2D(el.getAttribute('d'))); continue; }
      if (t === 'circle') g.arc(+el.getAttribute('cx'), +el.getAttribute('cy'), +el.getAttribute('r'), 0, Math.PI * 2);
      if (t === 'rect') g.rect(+el.getAttribute('x'), +el.getAttribute('y'), +el.getAttribute('width'), +el.getAttribute('height'));
      if (el.getAttribute('fill') === 'currentColor') { g.fillStyle = color; g.fill(); } else g.stroke();
    }
    g.restore();
  }

  // ---------- efficiency: an alarm, the nearest of three drones goes, reports, comes back ----------
  let effStart = performance.now();
  const eff = document.getElementById('effMap'), eg = eff.getContext('2d');
  let ew = 0, eh = 0;
  const fitEff = () => { const r = eff.getBoundingClientRect(); const d = Math.min(2, devicePixelRatio || 1); ew = r.width; eh = r.height; eff.width = ew * d; eff.height = eh * d; eg.setTransform(d, 0, 0, d, 0, 0); };
  fitEff(); new ResizeObserver(fitEff).observe(eff);
  const docks = [[0.12, 0.72], [0.5, 0.22], [0.86, 0.66]];
  const zones = [[0.62, 0.48, 0.2, 0.26], [0.08, 0.14, 0.18, 0.22]];
  const camsE = [[0.95, 0.08], [0.04, 0.94], [0.45, 0.95]];
  const lerp = (a, b, k) => a + (b - a) * k, ease = (k) => k < 0 ? 0 : k > 1 ? 1 : 1 - Math.pow(1 - k, 3);
  function drawEff(t) {
    const T = reduce ? 4200 : (t - effStart) % 11000;
    const X = (x) => 16 + x * (ew - 32), Y = (y) => 16 + y * (eh - 48);
    eg.clearRect(0, 0, ew, eh);
    eg.strokeStyle = '#202020'; eg.lineWidth = 2; eg.strokeRect(X(0), Y(0), X(1) - X(0), Y(1) - Y(0));
    eg.fillStyle = '#c9c9c9'; for (const x of [0.3, 0.5, 0.7]) eg.fillRect(X(x) - 5, Y(0.5) - 8, 10, 16);
    const z = zones[0], alarm = T > 900;
    zones.forEach((q, k) => { const hot = k === 0 && alarm; eg.fillStyle = hot ? `rgba(198,40,40,${0.12 + 0.1 * Math.abs(Math.sin(t / 300))})` : 'rgba(198,40,40,0.06)'; eg.strokeStyle = 'rgba(198,40,40,0.8)'; eg.lineWidth = 1; eg.fillRect(X(q[0]), Y(q[1]), X(q[0] + q[2]) - X(q[0]), Y(q[1] + q[3]) - Y(q[1])); eg.strokeRect(X(q[0]), Y(q[1]), X(q[0] + q[2]) - X(q[0]), Y(q[1] + q[3]) - Y(q[1])); });
    eg.fillStyle = '#c62828'; eg.font = '11px Arial'; eg.fillText(alarm ? 'ZONE 1 · PERSON' : 'ZONE 1', X(z[0]), Y(z[1]) - 6);
    eg.fillStyle = '#8b8b8b'; eg.fillText('ZONE 2', X(zones[1][0]), Y(zones[1][1]) - 6);
    for (const [x, y] of camsE) drawIcon(eg, 'i-cctv', X(x), Y(y), 20, '#8b8b8b');
    if (alarm) drawIcon(eg, 'i-person', X(z[0] + z[2] * 0.7), Y(z[1] + z[3] * 0.5), 26, '#c62828');
    // the nearest dock to the zone centre
    const zc = [z[0] + z[2] / 2, z[1] + z[3] / 2];
    const dist = docks.map(([x, y]) => Math.hypot(x - zc[0], (y - zc[1]) * 0.62));
    const best = dist.indexOf(Math.min(...dist));
    docks.forEach(([x, y], k) => {
      eg.strokeStyle = '#d0d0d0'; eg.lineWidth = 1; eg.strokeRect(X(x) - 16, Y(y) - 16, 32, 32);
      if (alarm && T < 2400) { eg.setLineDash([3, 4]); eg.strokeStyle = k === best ? '#c62828' : '#d0d0d0'; eg.beginPath(); eg.moveTo(X(x), Y(y)); eg.lineTo(X(zc[0]), Y(zc[1])); eg.stroke(); eg.setLineDash([]); eg.fillStyle = k === best ? '#c62828' : '#9b9b9b'; eg.fillText(`${(dist[k] * 40).toFixed(0)} m`, (X(x) + X(zc[0])) / 2 + 4, (Y(y) + Y(zc[1])) / 2 - 4); }
    });
    // drone path: out (2.4–5.4 s), hold and report (5.4–8 s), back (8–10.4 s)
    docks.forEach(([x, y], k) => {
      let dx = x, dy = y;
      if (k === best) { const out = ease((T - 2400) / 3000), back = ease((T - 8000) / 2400); const tx = zc[0] - 0.02, ty = zc[1]; dx = lerp(lerp(x, tx, out), x, back); dy = lerp(lerp(y, ty, out), y, back); }
      const flying = k === best && T > 2400 && T < 10400;
      if (flying) { eg.strokeStyle = 'rgba(17,17,17,.25)'; eg.beginPath(); eg.arc(X(dx), Y(dy), 20 + 2 * Math.sin(t / 90), 0, Math.PI * 2); eg.stroke(); }
      drawIcon(eg, 'i-drone', X(dx), Y(dy), flying ? 30 : 24, '#111111');
    });
    if (T > 5400 && T < 8200) { const bx = X(zc[0]) - 150, by = Y(z[1]) - 46; eg.fillStyle = '#ffffff'; eg.strokeStyle = '#202020'; eg.fillRect(bx, by, 140, 30); eg.strokeRect(bx, by, 140, 30); eg.fillStyle = '#202020'; eg.font = '12px Arial'; eg.fillText('Report: 1 person, door', bx + 8, by + 19); }
    const stage = !alarm ? 'Watching' : T < 2400 ? 'Alarm · picking the nearest drone' : T < 5400 ? 'Flying to Zone 1' : T < 8000 ? 'Reporting' : T < 10400 ? 'Back to its spot' : 'Watching';
    eg.fillStyle = '#8b8b8b'; eg.font = '11px Arial'; eg.fillText(stage.toUpperCase(), X(0) + 8, Y(0) + 18);
  }

  // ---------- voice: the conversation plays, and the steps Grok takes light up ----------
  const chat = document.getElementById('chat');
  const msgs = [...chat.querySelectorAll('.msg')];
  const think = document.querySelector('.think'), steps = [...document.querySelectorAll('#thinkSteps li')];
  msgs.forEach((m) => { const p = m.querySelector('p'); const words = p.textContent.split(' '); p.textContent = ''; words.forEach((w) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w + ' '; p.append(s); }); });
  let chatTimer = 0, talkingUntil = 0, talkingGrok = false;
  function playChat() {
    clearTimeout(chatTimer);
    if (reduce) return;
    think.classList.add('playing'); steps.forEach((x) => x.classList.remove('done', 'now'));
    msgs.forEach((m) => { m.classList.add('playing'); m.classList.remove('old'); m.querySelectorAll('.w').forEach((w) => w.classList.remove('on')); });
    let k = 0;
    const next = () => {
      if (k >= msgs.length) { steps.forEach((x) => { x.classList.remove('now'); x.classList.add('done'); }); chatTimer = setTimeout(playChat, 5000); return; }
      msgs.forEach((m, j) => m.classList.toggle('old', j < k - 1));
      const m = msgs[k], ws = [...m.querySelectorAll('.w')];
      talkingUntil = performance.now() + ws.length * 170 + 300; talkingGrok = m.classList.contains('grok');
      ws.forEach((w, j) => setTimeout(() => w.classList.add('on'), j * 170));
      const own = (m.dataset.steps || '').split(' ').filter(Boolean).map(Number);
      steps.forEach((x) => x.classList.remove('now'));
      own.forEach((n, j) => setTimeout(() => { steps.forEach((x) => x.classList.remove('now')); steps[n].classList.add('now', 'done'); }, j * 600));
      chatTimer = setTimeout(() => { m.classList.remove('playing'); k++; next(); }, Math.max(ws.length * 170, own.length * 600) + 900);
    };
    next();
  }
  const drawWave = () => {};

  // ---------- the phone camera: LiDAR points landing on the room ----------
  const lid = document.getElementById('lidar'), lg = lid.getContext('2d');
  let lw = 0, lh = 0;
  const fitLid = () => { const r = lid.getBoundingClientRect(); const d = Math.min(2, devicePixelRatio || 1); lw = r.width; lh = r.height; lid.width = lw * d; lid.height = lh * d; lg.setTransform(d, 0, 0, d, 0, 0); };
  fitLid(); new ResizeObserver(fitLid).observe(lid);
  function drawLidar(t) {
    const g = lg; g.clearRect(0, 0, lw, lh);
    const sweep = reduce ? 1 : (t / 3200) % 1.15;
    // a mesh of points on the real room: floor lines, wall lines, table edge
    for (let i = 0; i < 260; i++) {
      const u = ((i * 61) % 97) / 97, v = ((i * 37) % 89) / 89;
      const x = u * lw, y = lh * (0.18 + v * 0.8);
      if (x / lw > sweep) continue;
      const near = v > 0.62;
      g.fillStyle = near ? 'rgba(198,40,40,.95)' : 'rgba(255,255,255,.9)';
      g.fillRect(x, y, near ? 2.5 : 2, near ? 2.5 : 2);
    }
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
    const lines = [[0, 0.58, 1, 0.5], [0, 0.78, 0.55, 0.62], [0.55, 0.62, 1, 0.66], [0.55, 0.62, 0.55, 0.1]];
    for (const [a, b, c, d] of lines) { const e = Math.min(c, sweep); if (e <= a) continue; g.beginPath(); g.moveTo(a * lw, b * lh); g.lineTo(e * lw, (b + (d - b) * ((e - a) / (c - a || 1))) * lh); g.stroke(); }
    if (sweep < 1) { g.strokeStyle = 'rgba(198,40,40,.95)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(sweep * lw, 0); g.lineTo(sweep * lw, lh); g.stroke(); }
  }

  // ---------- one frame loop for everything that moves ----------
  function frame(t) {
    drawCover(t); drawVoice(t);
    drawScan(t); drawEff(t); drawWave(t); drawLidar(t);
    if (!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (location.hash) fromHash(); else setActive(0);
})();
