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
