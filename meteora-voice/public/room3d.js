// The room in 3D at its real size: walls 4.30 m high, the pillars, the mezzanines, tables, red
// zones on the floor, the phones at their height with what they see, the drones and the people.
// Plan metres (x right, y up on the plan) become three.js (x, height, -y).
import * as THREE from '/vendor/three.module.min.js';
import { OrbitControls } from '/vendor/OrbitControls.js';

const LENS_FOV = {wide:100, normal:68, tele:32};
const GREY = {floor:0xf3f3f2, wall:0xd7d7d6, pillar:0xc9c9c8, mezz:0xbdbdbc, table:0xdedede, edge:0x8a8a8a};
const ROOF = ['Corpo4', 'Corpo16', 'Corpo17'];
const v3 = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

// A tag above a thing: square, thin border, a dot in its colour, regular weight (the Meteora look).
// pick = [kind, id]: clicking the tag selects that thing in the settings.
function label(text, colour = '#333', pick = null) {
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  const font = '400 38px Arial, Helvetica, sans-serif'; g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 74; c.height = 64;
  g.font = font; g.fillStyle = 'rgba(255,255,255,.94)'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = pick ? '#cfcfcf' : '#e6e6e6'; g.lineWidth = 2; g.strokeRect(1, 1, c.width - 2, c.height - 2);
  g.fillStyle = colour; g.beginPath(); g.arc(30, 32, 8, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#202020'; g.textBaseline = 'middle'; g.fillText(text, 52, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c), depthTest:false, transparent:true}));
  s.scale.set(c.width / c.height * 0.46, 0.46, 1); s.renderOrder = 10;
  if (pick) s.userData.pick = pick;
  return s;
}
function box(w, h, d, colour, opacity = 1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({color:colour, transparent:opacity < 1, opacity}));
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({color:GREY.edge, transparent:true, opacity:0.5}));
  m.add(e); return m;
}
function clear(group) { for (const c of [...group.children]) { group.remove(c); c.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); }); } }

export function mount(container, {onPick} = {}) {
  const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0xffffff, 0); // the page's dot grid shows around the building
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdddddd, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-8, 14, 6); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.495;
  const building = new THREE.Group(), live = new THREE.Group();
  scene.add(building, live);
  let built = '', running = true, framed = false;

  function build(plan) {
    const key = JSON.stringify([plan?.bounds, plan?.walls?.length, plan?.height_m]);
    if (key === built || !plan) return; built = key; clear(building);
    const H = plan.height_m || 4.3, b = plan.bounds;
    const W = b.max[0] - b.min[0], D = b.max[1] - b.min[1], cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshLambertMaterial({color:GREY.floor}));
    floor.rotation.x = -Math.PI / 2; floor.position.copy(v3(cx, cy, 0)); building.add(floor);
    const grid = new THREE.GridHelper(Math.ceil(Math.max(W, D)) + 2, Math.ceil(Math.max(W, D)) + 2, 0xe2e2e2, 0xebebeb);
    grid.position.copy(v3(Math.round(cx), Math.round(cy), 0.002)); building.add(grid);
    for (const w of plan.walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]); if (len < 0.02) continue;
      const pillar = String(w.solid).startsWith('pillar');
      const annex = w.solid === 'Corpo8';
      const h = annex ? 2.15 : H;
      const m = box(len, h, pillar ? 0.02 : 0.06, pillar ? GREY.pillar : GREY.wall, pillar ? 1 : 0.22);
      m.position.copy(v3((w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2, h / 2));
      m.rotation.y = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]);
      building.add(m);
    }
    for (const p of plan.pillars || []) { const m = box(p.w, H, p.d, GREY.pillar); m.position.copy(v3(p.x, p.y, H / 2)); building.add(m); }
    for (const a of plan.above || []) {
      if (ROOF.includes(a.solid)) continue;
      const m = box(a.max[0] - a.min[0], 0.12, a.max[1] - a.min[1], GREY.mezz, 0.28);
      m.position.copy(v3((a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, a.z_m)); building.add(m);
    }
    if (!framed) {
      framed = true;
      controls.target.copy(v3(cx, cy, 1));
      camera.position.copy(v3(cx, cy - D * 1.05, Math.max(W, D) * 0.95));
      controls.update();
    }
  }

  function update(state) {
    const {plan, room, live: map, slots = [], drones = []} = state;
    build(plan); clear(live);
    if (!room) return;
    for (const o of room.objects || []) {
      const h = o.heightM || 0.75;
      const m = box(o.w, h, o.d, GREY.table); m.position.copy(v3(o.x, o.y, h / 2)); m.rotation.y = (o.rotation || 0) * Math.PI / 180; live.add(m);
      const l = label(o.name, '#b5b5b5', ['object', o.id]); l.position.copy(v3(o.x, o.y, h + 0.3)); live.add(l);
    }
    for (const z of room.zones || []) {
      const occupied = map?.zones?.find((q) => q.id === z.id)?.occupied;
      const shape = new THREE.Shape(z.points.map(([x, y]) => new THREE.Vector2(x, y)));
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({color:0xc62828, transparent:true, opacity:occupied ? 0.35 : 0.14, side:THREE.DoubleSide, depthWrite:false}));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.01; live.add(m);
      const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length, cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length;
      const l = label(z.name + (occupied ? ' · person inside' : ''), '#c62828', ['zone', z.id]); l.position.copy(v3(cx, cy, 0.4)); live.add(l);
    }
    for (const [slot, c] of Object.entries(room.cameras || {})) {
      if (typeof c.x !== 'number') continue;
      const s = slots.find((q) => q.id === slot); const on = Boolean(s?.online);
      const z = typeof c.z === 'number' ? c.z : 1.2, tilt = (c.tilt ?? 0) * Math.PI / 180, h = (c.heading || 0) * Math.PI / 180;
      const hf = (LENS_FOV[s?.lens] || LENS_FOV.normal) * Math.PI / 180, vf = 2 * Math.atan(Math.tan(hf / 2) * 9 / 16);
      const at = v3(c.x, c.y, z);
      const phone = box(0.15, 0.075, 0.01, on ? 0x333333 : 0xbbbbbb);
      phone.position.copy(at); phone.rotation.order = 'YXZ'; phone.rotation.y = h + Math.PI / 2; phone.rotation.x = -tilt; live.add(phone);
      // What it sees: a pyramid to 6 m (cut at the floor), and a line down to the floor for the height.
      const F = [Math.cos(h), Math.sin(h)], R = [Math.sin(h), -Math.cos(h)];
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const ta = a * Math.tan(hf / 2), tb = b * Math.tan(vf / 2);
        const dir = [F[0] * Math.cos(tilt) + ta * R[0] - tb * F[0] * Math.sin(tilt), F[1] * Math.cos(tilt) + ta * R[1] - tb * F[1] * Math.sin(tilt), -Math.sin(tilt) - tb * Math.cos(tilt)];
        let s2 = 6 / Math.hypot(...dir); if (dir[2] < 0) s2 = Math.min(s2, z / -dir[2]);
        return v3(c.x + dir[0] * s2, c.y + dir[1] * s2, z + dir[2] * s2);
      });
      const pts = []; for (const k of corners) pts.push(at, k); for (let i = 0; i < 4; i++) pts.push(corners[i], corners[(i + 1) % 4]);
      live.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({color:on ? 0x666666 : 0xbbbbbb, transparent:true, opacity:0.7})));
      const face = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]), new THREE.MeshBasicMaterial({color:0x000000, transparent:true, opacity:s?.watching ? 0.07 : 0.035, side:THREE.DoubleSide, depthWrite:false}));
      live.add(face);
      const down = new THREE.Line(new THREE.BufferGeometry().setFromPoints([at, v3(c.x, c.y, 0)]), new THREE.LineDashedMaterial({color:0x999999, dashSize:0.08, gapSize:0.06}));
      down.computeLineDistances(); live.add(down);
      const l = label(`Phone ${slot}${on ? (s?.watching ? ' · watching' : '') : ' · offline'}`, on ? '#202020' : '#cccccc', ['phone', slot]); l.position.copy(v3(c.x, c.y, z + 0.35)); live.add(l);
    }
    for (const p of map?.people || []) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.7, 20), new THREE.MeshLambertMaterial({color:0x222222, transparent:Boolean(p.approx), opacity:p.approx ? 0.45 : 1}));
      m.position.copy(v3(p.x, p.y, 0.85)); live.add(m);
    }
    for (const d of map?.drones || []) {
      if (!d.placed && drones.find((q) => q.id === d.id)?.flight !== 'flying') continue;
      const colour = d.id === 'rmtt' ? 0xd32f2f : 0x111111, z = Math.max(0.05, (d.pose.zFloor ?? d.pose.z ?? 0) / 100);
      const m = box(0.1, 0.04, 0.1, colour); m.position.copy(v3(d.pose.x / 100, d.pose.y / 100, z)); m.rotation.y = d.pose.heading * Math.PI / 180; live.add(m);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.012, 8, 32), new THREE.MeshBasicMaterial({color:colour}));
      ring.rotation.x = Math.PI / 2; ring.position.copy(m.position); live.add(ring);
      const l = label(`${d.id === 'rmtt' ? 'Red' : 'Black'} · ${z.toFixed(1)} m`, d.id === 'rmtt' ? '#c62828' : '#111', ['drone', d.id]); l.position.copy(v3(d.pose.x / 100, d.pose.y / 100, z + 0.35)); live.add(l);
    }
  }

  function resize() { const w = container.clientWidth || 600, h = container.clientHeight || 400; renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; camera.aspect = w / h; camera.updateProjectionMatrix(); }
  // A click (not a drag) on a tag selects that thing.
  const ray = new THREE.Raycaster(); let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !onPick) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(live.children.filter((o) => o.userData.pick), false)[0];
    renderer.domElement.style.cursor = '';
    if (hit) onPick(...hit.object.userData.pick);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    renderer.domElement.style.cursor = ray.intersectObjects(live.children.filter((o) => o.userData.pick), false).length ? 'pointer' : '';
  });
  const ro = new ResizeObserver(resize); ro.observe(container); resize();
  (function loop() { if (!running) return; controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
  return {
    update,
    dispose() { running = false; ro.disconnect(); controls.dispose(); clear(live); clear(building); renderer.dispose(); renderer.domElement.remove(); },
  };
}
