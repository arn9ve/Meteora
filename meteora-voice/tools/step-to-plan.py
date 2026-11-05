"""Horizontal section of the STEP solids at a given height -> wall segments for a floor plan.
Usage: python3 -I tools/step-to-plan.py FILE.step OUT_DIR [HEIGHT_MM]
Writes OUT_DIR/floorplan.json (metres, origin at the building centre) and OUT_DIR/floorplan.svg."""
import json
import re
import sys

path, out_dir = sys.argv[1], sys.argv[2]
cut = float(sys.argv[3]) if len(sys.argv) > 3 else 1000.0
text = open(path, encoding='utf-8', errors='replace').read()
data = text.split('DATA;', 1)[1].rsplit('ENDSEC;', 1)[0]
ents = {}
for raw in data.split(';'):
    raw = ' '.join(raw.split())
    m = re.match(r'#(\d+)\s*=\s*([A-Z0-9_]*)\s*\((.*)\)\s*$', raw)
    if m:
        ents[int(m.group(1))] = (m.group(2), m.group(3))
refs = lambda s: [int(x) for x in re.findall(r'#(\d+)', s)]
points = {i: tuple(float(n) for n in re.findall(r'-?\d+\.?\d*(?:E[-+]?\d+)?', a.split('(', 1)[1])[:3])
          for i, (n, a) in ents.items() if n == 'CARTESIAN_POINT'}
vxyz = lambda v: points[refs(ents[v][1])[0]]

def loop_polygon(loop):
    """Ordered vertices of an edge loop."""
    poly = []
    for oe in refs(ents[loop][1]):
        n, a = ents[oe]
        if n != 'ORIENTED_EDGE':
            continue
        edge = refs(a)[0]
        forward = a.rstrip().endswith('.T.')
        v1, v2 = refs(ents[edge][1])[:2]
        start = v1 if forward else v2
        poly.append(vxyz(start))
    return poly

segments = []   # wall cuts at `cut`
footprints = [] # boxes of solids above the cut (mezzanines, roof) for dashed outlines
for i, (n, a) in ents.items():
    if n != 'MANIFOLD_SOLID_BREP':
        continue
    name = re.match(r"'([^']*)'", a).group(1)
    shell = refs(a)[0]
    zs_all = []
    for face in refs(ents[shell][1]):
        fa = ents[face][1]
        for b in refs(fa.split(')', 1)[0]):
            poly = loop_polygon(refs(ents[b][1])[0])
            zs_all += [p[2] for p in poly]
            hits = []
            for k in range(len(poly)):
                p, q = poly[k], poly[(k + 1) % len(poly)]
                if (p[2] - cut) * (q[2] - cut) < 0:
                    t = (cut - p[2]) / (q[2] - p[2])
                    hits.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
            if len(hits) >= 2:
                # Sort along the main direction and pair them up (works for non-convex faces too).
                dx = max(h[0] for h in hits) - min(h[0] for h in hits)
                dy = max(h[1] for h in hits) - min(h[1] for h in hits)
                hits.sort(key=(lambda h: h[0]) if dx >= dy else (lambda h: h[1]))
                for j in range(0, len(hits) - 1, 2):
                    segments.append({'solid': name, 'a': hits[j], 'b': hits[j + 1]})
    if zs_all and min(zs_all) > cut:
        xs, ys = [], []
        for face in refs(ents[shell][1]):
            for b in refs(ents[face][1].split(')', 1)[0]):
                for p in loop_polygon(refs(ents[b][1])[0]):
                    xs.append(p[0]); ys.append(p[1])
        footprints.append({'solid': name, 'min': [min(xs), min(ys)], 'max': [max(xs), max(ys)], 'z': min(zs_all)})

mm = lambda v: round(v / 1000, 3)
plan = {
    'units': 'm', 'cut_height_m': cut / 1000,
    'walls': [{'solid': s['solid'], 'a': [mm(s['a'][0]), mm(s['a'][1])], 'b': [mm(s['b'][0]), mm(s['b'][1])]} for s in segments],
    'above': [{'solid': f['solid'], 'min': [mm(v) for v in f['min']], 'max': [mm(v) for v in f['max']], 'z_m': mm(f['z'])} for f in footprints],
}
xs = [p for w in plan['walls'] for p in (w['a'][0], w['b'][0])]
ys = [p for w in plan['walls'] for p in (w['a'][1], w['b'][1])]
plan['bounds'] = {'min': [min(xs), min(ys)], 'max': [max(xs), max(ys)]}
json.dump(plan, open(f'{out_dir}/floorplan.json', 'w'), indent=1)

# SVG: x to the right, y up (drawn flipped), 1 m = 40 px.
S = 40
pad = 1.0
X0, Y0 = plan['bounds']['min'][0] - pad, plan['bounds']['min'][1] - pad
W = (plan['bounds']['max'][0] - plan['bounds']['min'][0] + 2 * pad) * S
H = (plan['bounds']['max'][1] - plan['bounds']['min'][1] + 2 * pad) * S
tx = lambda x: (x - X0) * S
ty = lambda y: H - (y - Y0) * S
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H + 30:.0f}" viewBox="0 0 {W:.0f} {H + 30:.0f}" font-family="Arial">',
       f'<rect width="100%" height="100%" fill="#fff"/>']
gx = int(X0)
while gx <= X0 + W / S:
    out.append(f'<line x1="{tx(gx):.1f}" y1="0" x2="{tx(gx):.1f}" y2="{H:.0f}" stroke="#eee"/>'); gx += 1
gy = int(Y0)
while gy <= Y0 + H / S:
    out.append(f'<line x1="0" y1="{ty(gy):.1f}" x2="{W:.0f}" y2="{ty(gy):.1f}" stroke="#eee"/>'); gy += 1
for f in plan['above']:
    if f['solid'] in ('Corpo4', 'Corpo16', 'Corpo17'):
        continue  # roof
    x, y = tx(f['min'][0]), ty(f['max'][1])
    w, h = (f['max'][0] - f['min'][0]) * S, (f['max'][1] - f['min'][1]) * S
    out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" fill="#1e88e5" fill-opacity=".06" stroke="#1e88e5" stroke-dasharray="6 4"/>')
    out.append(f'<text x="{x + 4:.1f}" y="{y + 14:.1f}" font-size="11" fill="#1e88e5">{f["solid"]} at {f["z_m"]:.2f} m</text>')
for w in plan['walls']:
    out.append(f'<line x1="{tx(w["a"][0]):.1f}" y1="{ty(w["a"][1]):.1f}" x2="{tx(w["b"][0]):.1f}" y2="{ty(w["b"][1]):.1f}" stroke="#111" stroke-width="2.5" stroke-linecap="round"/>')
out.append(f'<text x="8" y="{H + 20:.0f}" font-size="12" fill="#555">Section at {cut/1000:.1f} m · grid 1 m · {len(plan["walls"])} wall segments · dashed = above the cut (mezzanines)</text>')
out.append('</svg>')
open(f'{out_dir}/floorplan.svg', 'w').write('\n'.join(out))
b = plan['bounds']
print('walls', len(plan['walls']), 'bounds m', b, 'above', [(f['solid'], f['z_m']) for f in plan['above']])
