// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as pdfjsLib from 'pdfjs-dist';
import { isCancelled } from './document-session.js';
import { mulMatrix, applyMatrix } from './geometry.js';

export class RasterExporter {
  constructor(session) {
    this.session = session;
    this.imageCache = session.caches.images;
  }

  /**
   * Walks a page's operator list, tracking the current transform, and returns
   * the bounding box of every image it paints. Boxes come back in the same
   * PDF-point space that selections use, so one can become the other directly.
   */
  async detectImages(pageNum) {
    if (this.imageCache.has(pageNum)) return this.imageCache.get(pageNum);

    const job = (async () => {
      const page = await this.session.getPage(pageNum);
      const opList = await page.getOperatorList();
      this.session.assertActive();
      const viewport = page.getViewport({ scale: 1.0 });
      const base = viewport.transform;

      const OPS = pdfjsLib.OPS;
      // Stencil masks paint the current fill colour through a 1-bit shape
      // instead of carrying colour of their own.
      const MASK_OPS = new Set([
        OPS.paintImageMaskXObject,
        OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintSolidColorImageMask,
      ]);
      const IMAGE_OPS = new Set([
        OPS.paintImageXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintInlineImageXObject,
        OPS.paintInlineImageXObjectGroup,
        OPS.paintImageMaskXObject,
        OPS.paintImageMaskXObjectGroup,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintSolidColorImageMask,
      ]);

      let ctm = base;
      const stack = [];
      const boxes = [];

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];

        if (fn === OPS.save) {
          stack.push(ctm);
        } else if (fn === OPS.restore) {
          ctm = stack.pop() || base;
        } else if (fn === OPS.transform) {
          ctm = mulMatrix(ctm, args);
        } else if (fn === OPS.paintFormXObjectBegin) {
          stack.push(ctm);
          if (args && args[0]) ctm = mulMatrix(ctm, args[0]);
        } else if (fn === OPS.paintFormXObjectEnd) {
          ctm = stack.pop() || base;
        } else if (IMAGE_OPS.has(fn)) {
          // A PDF image always occupies the unit square in its own space.
          const corners = [[0, 0], [1, 0], [0, 1], [1, 1]]
            .map(([ux, uy]) => applyMatrix(ux, uy, ctm));
          const xs = corners.map((c) => c[0]);
          const ys = corners.map((c) => c[1]);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const y0 = Math.min(...ys);
          const y1 = Math.max(...ys);
          // An XObject names its decoded image in an object store. A stencil mask
          // passes an object whose `data` is that name, not the pixels. Only a
          // true inline image carries its samples in the argument itself.
          // A solid-color mask has no arguments or decoded image; keep its
          // box so clicking it can export the visible page region instead.
          const ref = args && args[0];
          let objId = null;
          let inlineData = null;
          if (typeof ref === 'string') {
            objId = ref;
          } else if (ref && typeof ref.data === 'string') {
            objId = ref.data;
          } else if (ref && typeof ref === 'object') {
            inlineData = ref;
          }

          boxes.push({
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            w: Math.abs(x1 - x0),
            h: Math.abs(y1 - y0),
            objId,
            inlineData,
            isMask: MASK_OPS.has(fn),
          });
        }
      }

      return this.dedupeBoxes(boxes, viewport.width, viewport.height);
    })();

    this.imageCache.set(pageNum, job);
    return job;
  }

  /** Drops slivers, page backgrounds and near-duplicates from the raw pass. */
  dedupeBoxes(boxes, pageWidth, pageHeight) {
    const MIN_SIDE = 12; // pt; smaller than this is a rule, bullet or artifact
    // An image that fills the page is the page itself -- a scan, or a
    // background. Clicking it would select everything, which is never what
    // the click was for, so it is not offered as a target.
    const MAX_COVERAGE = 0.9;
    const pageArea = pageWidth * pageHeight;

    const kept = [];
    for (const b of boxes) {
      if (b.w < MIN_SIDE || b.h < MIN_SIDE) continue;
      if (pageArea > 0 && (b.w * b.h) / pageArea >= MAX_COVERAGE) continue;
      const dup = kept.some((k) =>
        Math.abs(k.x - b.x) < 1 && Math.abs(k.y - b.y) < 1 &&
        Math.abs(k.w - b.w) < 1 && Math.abs(k.h - b.h) < 1);
      if (!dup) kept.push(b);
    }
    // Largest first: the hit test walks backwards, so it meets the smallest
    // (most specific) box first and a figure wins over the page background.
    return kept.sort((a, b) => b.w * b.h - a.w * a.h);
  }

  /**
   * Resolves a decoded image from a page's object store. Images land there
   * while the operator list is built, but may not have arrived yet.
   */
  getImageObject(page, objId, timeout = 15000) {
    this.session.assertActive();
    if (typeof objId !== 'string' || !objId) {
      return Promise.reject(new Error('Image has no object ID'));
    }
    const objects = objId.startsWith('g_') ? page.commonObjs : page.objs;
    const signal = this.session.signal;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      try {
        if (objects.has(objId)) {
          resolve(objects.get(objId));
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out reading image ${objId}`));
        }, timeout);
        objects.get(objId, (img) => {
          cleanup();
          resolve(img);
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  /**
   * Paints a decoded PDF image onto a canvas at its native pixel size.
   * PDF.js hands back either an ImageBitmap or raw samples in one of a few
   * pixel layouts, so each has to be expanded to RGBA by hand.
   */
  imageToCanvas(img, isMask = false) {
    const width = img.width;
    const height = img.height;
    if (!width || !height) throw new Error('Image has no dimensions');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (img.bitmap && !isMask) {
      ctx.drawImage(img.bitmap, 0, 0);
      return canvas;
    }

    const src = img.data;
    if (!src) throw new Error('Image has no pixel data');

    const out = ctx.createImageData(width, height);
    const dst = out.data;
    const ImageKind = pdfjsLib.ImageKind || {
      GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3,
    };

    if (isMask) {
      // A stencil paints where the bit is clear and leaves the rest alone, so
      // it exports as black artwork on transparency rather than on white.
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const o = (y * width + x) * 4;
          dst[o] = dst[o + 1] = dst[o + 2] = 0;
          dst[o + 3] = bit ? 0 : 255;
        }
      }
    } else if (img.kind === ImageKind.RGBA_32BPP) {
      dst.set(src.subarray(0, dst.length));
    } else if (img.kind === ImageKind.RGB_24BPP) {
      for (let i = 0, j = 0; i < width * height; i++, j += 3) {
        dst[i * 4] = src[j];
        dst[i * 4 + 1] = src[j + 1];
        dst[i * 4 + 2] = src[j + 2];
        dst[i * 4 + 3] = 255;
      }
    } else {
      // GRAYSCALE_1BPP: one bit per pixel, rows padded to whole bytes, and
      // a set bit means black.
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 0 : 255;
          const o = (y * width + x) * 4;
          dst[o] = dst[o + 1] = dst[o + 2] = v;
          dst[o + 3] = 255;
        }
      }
    }

    ctx.putImageData(out, 0, 0);
    return canvas;
  }

  canvasToBlob(canvas, type = 'image/png') {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))),
        type);
    });
  }

  /**
   * Falls back to cropping a high-resolution render of the page, used when the
   * decoded image itself cannot be reached.
   */
  async rasterizeRegion(sel, targetScale) {
    const page = await this.session.getPage(sel.page);
    const viewport = page.getViewport({ scale: targetScale });
    const full = document.createElement('canvas');
    full.width = Math.ceil(viewport.width);
    full.height = Math.ceil(viewport.height);
    await this.session.render(page, { canvasContext: full.getContext('2d'), viewport });

    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(sel.w * targetScale));
    crop.height = Math.max(1, Math.round(sel.h * targetScale));
    crop.getContext('2d').drawImage(
      full,
      Math.round(sel.x * targetScale), Math.round(sel.y * targetScale),
      crop.width, crop.height,
      0, 0, crop.width, crop.height);
    return crop;
  }

  /** Builds the PNG for an image selection, at the image's own resolution. */
  async buildRaster(sel) {
    const scale = 300 / 72;
    let canvas = null;

    if (!sel.inlineData && !sel.objId) {
      // PDF.js optimizes a one-pixel stencil to paintSolidColorImageMask,
      // which has neither samples nor an object ID. On scanned PDFs these
      // boxes can mark artwork in the page image, so render the region at
      // 300 DPI immediately rather than waiting for a nonexistent object.
      canvas = await this.rasterizeRegion(sel, scale);
    } else {
      try {
        const img = sel.inlineData || await this.getImageObject(
          await this.session.getPage(sel.page), sel.objId);
        canvas = this.imageToCanvas(img, !!sel.isMask);
      } catch (err) {
        if (isCancelled(err, this.session)) throw err;
        console.warn('Native image read failed, rendering the region instead:', err);
        canvas = await this.rasterizeRegion(sel, scale);
      }
    }

    const blob = await this.canvasToBlob(canvas, 'image/png');
    this.session.assertActive();
    return { blob, width: canvas.width, height: canvas.height };
  }

}
