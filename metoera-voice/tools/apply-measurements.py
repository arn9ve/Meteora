"""Apply the measured room sizes (drawing of 5 Nov 2026) to the plan made from the STEP file.
Usage: python3 -I tools/apply-measurements.py room/capannone-gragnani.json
- Pillars: 4, each 1.20 m (along the room) x 0.70 m, 3.60 m apart and 3.60 m from the end walls,
  centred on the room's length (the STEP room is 22.92 m inside, the measured one 22.80 m).
- Ceiling height 4.30 m."""
import json
import sys

path = sys.argv[1]
plan = json.load(open(path))
PILLARS = ('Corpo9', 'Corpo10', 'Corpo11', 'Corpo12')
plan['walls'] = [w for w in plan['walls'] if w.get('solid') not in PILLARS]
inner_x = (-11.42, 11.50)  # inside faces of the end walls in the STEP plan
mid = (inner_x[0] + inner_x[1]) / 2
L, W, GAP = 1.20, 0.70, 3.60
yc = 0.937  # pillar line in the STEP plan
pillars = []
for k in range(4):
    cx = round(mid + (k - 1.5) * (L + GAP), 3)
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, yc - W / 2, yc + W / 2
    pillars.append({'id': f'pillar-{k + 1}', 'x': cx, 'y': yc, 'w': L, 'd': W})
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        plan['walls'].append({'solid': f'pillar-{k + 1}', 'a': [round(a[0], 3), round(a[1], 3)], 'b': [round(b[0], 3), round(b[1], 3)]})
plan['pillars'] = pillars
plan['height_m'] = 4.30
plan['measured'] = 'Pillars 1.20 x 0.70 m, 3.60 m apart; inside length 22.80 m; height 4.30 m (drawing of 5 Nov 2026).'
json.dump(plan, open(path, 'w'), indent=1)
print('pillar centres x:', [p['x'] for p in pillars], 'y:', yc)
