import assert from 'node:assert/strict';
import test from 'node:test';
import { homography, project, calibrationError, inside, feet } from '../src/room.ts';

// A phone looking at the floor at an angle: the far side of the picture is squeezed.
// Floor square 0..4 m x 0..3 m seen as a trapezoid in the image.
const img = [[0.1, 0.9], [0.9, 0.9], [0.7, 0.3], [0.3, 0.3]];
const plan = [[0, 0], [4, 0], [4, 3], [0, 3]];

test('four clicks give a calibration that maps them back exactly', () => {
  const h = homography(img, plan);
  assert.ok(h);
  assert.ok(calibrationError(h, img, plan) < 1e-6);
  // The middle of the bottom edge of the picture is the middle of the near side of the floor.
  const [x, y] = project(h, 0.5, 0.9);
  assert.ok(Math.abs(x - 2) < 1e-6 && Math.abs(y) < 1e-6, `${x},${y}`);
});

test('a person box maps its feet onto the floor and into a zone', () => {
  const h = homography(img, plan);
  const box = { x: 0.45, y: 0.4, w: 0.1, h: 0.3 }; // standing near the middle of the picture
  const [u, v] = feet(box);
  assert.deepEqual([u, v], [0.5, 0.7]);
  const p = project(h, u, v);
  assert.ok(p[0] > 1.5 && p[0] < 2.5 && p[1] > 0.5 && p[1] < 1.5, JSON.stringify(p));
  const zone = [[1, 0.5], [3, 0.5], [3, 2], [1, 2]];
  assert.equal(inside(p, zone), true);
  assert.equal(inside([3.5, 2.5], zone), false);
});

test('points in a line cannot calibrate', () => {
  assert.equal(homography([[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.25]], plan), null);
  assert.equal(homography(img.slice(0, 3), plan.slice(0, 3)), null);
});

test('a phone placed on the plan but not calibrated still places a person roughly', async () => {
  const { estimateFromPose } = await import('../src/room.ts');
  // Phone at the origin looking along +x; a person filling ~40% of the picture height, centred.
  const p = estimateFromPose({ x: 0, y: 0, heading: 0 }, { x: 0.45, y: 0.3, w: 0.1, h: 0.4 });
  assert.ok(p[0] > 3 && p[0] < 7 && Math.abs(p[1]) < 0.01, JSON.stringify(p));
  // Same person on the right of the picture: turned clockwise, so y goes negative.
  const r = estimateFromPose({ x: 0, y: 0, heading: 0 }, { x: 0.8, y: 0.3, w: 0.1, h: 0.4 });
  assert.ok(r[1] < -1, JSON.stringify(r));
  // Heading 90: in front is +y.
  const up = estimateFromPose({ x: 1, y: 1, heading: 90 }, { x: 0.45, y: 0.3, w: 0.1, h: 0.4 });
  assert.ok(Math.abs(up[0] - 1) < 0.01 && up[1] > 4, JSON.stringify(up));
});

test('tables: corners, a stop point next to them, and "go to tavolo 1" with a climb over a taller object', async () => {
  const { objectCorners, approachPoint, resolveObjectPlace, sanitizeObjects, parseVisionJson } = await import('../src/room.ts');
  const t = { id: 't1', name: 'table 1', kind: 'table', x: 5, y: 2, w: 2, d: 1, rotation: 0, heightM: 0.75 };
  const c = objectCorners(t);
  assert.deepEqual(c.map((p) => p.map((v) => Math.round(v * 100) / 100)), [[4, 1.5], [6, 1.5], [6, 2.5], [4, 2.5]]);
  const r90 = objectCorners({ ...t, rotation: 90 }).map((p) => p.map((v) => Math.round(v * 100) / 100));
  assert.deepEqual(r90, [[5.5, 1], [5.5, 3], [4.5, 3], [4.5, 1]]);
  // From the left: stops 0.6 m before the left edge (x = 4), on the line to the centre.
  const a = approachPoint(t, [0, 2]);
  assert.ok(Math.abs(a[0] - 3.4) < 1e-9 && Math.abs(a[1] - 2) < 1e-9, JSON.stringify(a));
  const shelf = { id: 's', name: 'shelf', kind: 'shelf', x: 2, y: 2, w: 0.5, d: 3, rotation: 0, heightM: 1.2 };
  const go = resolveObjectPlace([t, shelf], 'Tavolo 1', { x: 0, y: 200 });
  assert.deepEqual(go, { x: 340, y: 200, minHeightCm: 170 });
  assert.equal(resolveObjectPlace([t], 'table 9', { x: 0, y: 0 }), null);
  assert.equal(resolveObjectPlace([t], 'table 1', { x: 0, y: 0 }).minHeightCm, undefined);
  assert.equal(sanitizeObjects([{ x: 1, y: 1, w: 99, d: 0, rotation: 0, kind: 'sofa' }])[0].w, 30);
  assert.equal(sanitizeObjects([{ x: 'a' }]).length, 0);
  assert.deepEqual(parseVisionJson('```json\n{"people": 2, "summary": "two people sitting"}\n```'), { people: 2, summary: 'two people sitting' });
  assert.equal(parseVisionJson('no idea'), null);
});

test('a phone 2 m up, tilted 45° down: feet at the picture centre are 2 m ahead on the floor', async () => {
  const { floorFromMount } = await import('../src/room.ts');
  const cam = { x: 1, y: 1, heading: 0, z: 2, tilt: 45 };
  const centre = floorFromMount(cam, { x: 0.45, y: 0.3, w: 0.1, h: 0.2 });
  assert.ok(Math.abs(centre[0] - 3) < 1e-9 && Math.abs(centre[1] - 1) < 1e-9, JSON.stringify(centre));
  // Lower in the picture = nearer; right in the picture = to the right of the heading (y down).
  const near = floorFromMount(cam, { x: 0.45, y: 0.5, w: 0.1, h: 0.3 });
  assert.ok(near[0] < 3 && near[0] > 1, JSON.stringify(near));
  const right = floorFromMount(cam, { x: 0.8, y: 0.3, w: 0.1, h: 0.2 });
  assert.ok(right[1] < 1, JSON.stringify(right));
  // Looking up at the horizon: no floor hit.
  assert.equal(floorFromMount({ ...cam, tilt: 0 }, { x: 0.45, y: 0.1, w: 0.1, h: 0.3 }), null);
  assert.equal(floorFromMount({ ...cam, z: 0 }, { x: 0.45, y: 0.3, w: 0.1, h: 0.2 }), null);
});
