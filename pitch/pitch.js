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
    speak(slides[i].dataset.grok || '');
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

  // ---------- the voice of Grok: words light up as it "speaks" ----------
  const line = document.getElementById('voiceLine');
  let speakTimer = 0, speakingUntil = 0;
  function speak(text) {
    clearInterval(speakTimer);
    line.textContent = '';
    const words = text.split(' ').map((w) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w + ' '; line.append(s); return s; });
    if (reduce) { words.forEach((w) => w.classList.add('on')); return; }
    let k = 0;
    speakingUntil = performance.now() + words.length * 190 + 400;
    speakTimer = setInterval(() => { if (k < words.length) words[k++].classList.add('on'); else clearInterval(speakTimer); }, 190);
  }

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
  function field(canvas, { spacing, size, band, live }) {
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
        g.fillStyle = on ? (hot ? '#c62828' : '#5b5b5b') : '#e4e4e4';
        mark(g, shapes[(r * 3 + c * 7) % shapes.length], x, y, size);
      }
    };
  }
  const cover = document.querySelector('#cover canvas.field');
  const drawCover = field(cover, { spacing: 30, size: 2.6, band: 0.55, live: () => current === 0 && performance.now() < speakingUntil });
  const drawVoice = field(document.getElementById('voiceDots'), { spacing: 12, size: 1.6, band: 0.5, live: () => performance.now() < speakingUntil });

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

  // ---------- one frame loop for everything that moves ----------
  function frame(t) {
    drawCover(t); drawVoice(t);
    drawScan(t);
    if (!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (location.hash) fromHash(); else setActive(0);
})();
