import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cropFor, imageRect } from '../src/core/crop.ts';
import type { ImagePaint } from '../src/core/model.ts';

const paint = (mode: ImagePaint['mode'], crop?: ImagePaint['crop']): ImagePaint => ({ type: 'image', asset: 'a', mode, visible: true, opacity: 1, crop });
const box = { x: 0, y: 0, w: 100, h: 100 };

test('where an image fill sits', () => {
  const meta = { w: 400, h: 200 };
  assert.deepEqual(imageRect(paint('fill'), box, meta), { x: -50, y: 0, w: 200, h: 100 });
  assert.deepEqual(imageRect(paint('fit'), box, meta), { x: 0, y: 25, w: 100, h: 50 });
  assert.deepEqual(imageRect(paint('stretch'), box, meta), box);
  // crop without a rectangle yet looks like fill
  assert.deepEqual(imageRect(paint('crop'), box, meta), { x: -50, y: 0, w: 200, h: 100 });
  assert.deepEqual(imageRect(paint('crop', { x: -0.5, y: 0.1, w: 2, h: 1.5 }), { x: 10, y: 20, w: 100, h: 50 }, meta), { x: -40, y: 25, w: 200, h: 75 });
  // unknown image size: the box
  assert.deepEqual(imageRect(paint('fill'), box, undefined), box);
});

test('crop rectangle round-trips, and follows the layer when it is resized', () => {
  const img = { x: -30, y: 10, w: 250, h: 120 }, frame = { x: 0, y: 0, w: 80, h: 60 };
  const crop = cropFor(img, frame);
  const back = imageRect(paint('crop', crop), frame);
  for (const k of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(back[k] - img[k]) < 1e-3, k);
  const twice = imageRect(paint('crop', crop), { x: 0, y: 0, w: 160, h: 120 });
  assert.ok(Math.abs(twice.w - 500) < 1e-3 && Math.abs(twice.x + 60) < 1e-3);
});
