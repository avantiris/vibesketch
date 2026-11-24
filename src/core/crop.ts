import type { Box, ImagePaint } from './model.ts';

// Where an image fill sits relative to the box of its layer. "crop" keeps the image at a
// fixed rectangle (in fractions of the box, so resizing the layer scales it along); the box
// shows whatever part of it lies inside.

export type CropRect = { x: number; y: number; w: number; h: number };

/** the rectangle (in the layer's own coordinates) the whole image covers */
export function imageRect(p: ImagePaint, box: Box, meta?: { w?: number; h?: number }): Box {
  if (p.mode === 'crop' && p.crop) return { x: box.x + p.crop.x * box.w, y: box.y + p.crop.y * box.h, w: p.crop.w * box.w, h: p.crop.h * box.h };
  if (p.mode === 'stretch') return { ...box };
  const iw = meta?.w && meta.w > 0 ? meta.w : box.w, ih = meta?.h && meta.h > 0 ? meta.h : box.h;
  if (!(iw > 0 && ih > 0 && box.w > 0 && box.h > 0)) return { ...box };
  const s = p.mode === 'fit' ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih);
  const w = iw * s, h = ih * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** the crop that puts the image at `img` for a layer whose box is `box` */
export function cropFor(img: Box, box: Box): CropRect {
  const r = (v: number) => Math.round(v * 1e9) / 1e9;
  return { x: r((img.x - box.x) / box.w), y: r((img.y - box.y) / box.h), w: r(img.w / box.w), h: r(img.h / box.h) };
}
