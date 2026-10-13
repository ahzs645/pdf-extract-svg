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
import { optimize as svgOptimize } from 'svgo/browser';
import { buildFontCss, usageKey } from './fonts.js';
import { isCancelled } from './document-session.js';
import { SVG_NS, OBJ_ATTR, EDIT_ATTR, DRAWABLE_SELECTOR } from './geometry.js';

const MAX_OBJECTS = 4000;

export class SvgExporter {
  constructor(session, textAsOutlines = false) {
    this.session = session;
    this.textAsOutlines = textAsOutlines;
    this.pageSvgCache = session.caches.svg;
    this.pageFontCache = session.caches.fonts;
    this.objectCache = session.caches.objects;
  }

  /**
   * Builds the list of drawable objects on a page, each with its bounds in PDF
   * points. Elements are tagged in the cached page SVG first, so a clone made
   * later at export time can resolve the very same objects by id.
   */
  async buildPageObjects(pageNum) {
    const key = `${pageNum}:${this.textAsOutlines}`;
    if (this.objectCache.has(key)) return this.objectCache.get(key);

    const job = (async () => {
      const pageSvg = await this.getPageSvg(pageNum);
      const page = await this.session.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });

      // Tag first, then clone, so ids survive into every later copy.
      const source = pageSvg.querySelectorAll(DRAWABLE_SELECTOR);
      source.forEach((el, i) => el.setAttribute(OBJ_ATTR, String(i)));

      const probe = pageSvg.cloneNode(true);
      probe.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`);
      probe.setAttribute('width', String(viewport.width));
      probe.setAttribute('height', String(viewport.height));

      const holder = document.createElement('div');
      holder.style.cssText =
        'position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none';
      holder.appendChild(probe);
      document.body.appendChild(holder);

      const objects = [];
      try {
        const rootCTM = probe.getScreenCTM();
        if (!rootCTM) return [];
        const inv = rootCTM.inverse();

        for (const el of probe.querySelectorAll(DRAWABLE_SELECTOR)) {
          if (objects.length >= MAX_OBJECTS) break;

          let box;
          try {
            const bbox = el.getBBox();
            if (!bbox.width && !bbox.height) continue;
            const ctm = el.getScreenCTM();
            if (!ctm) continue;
            // element local -> screen -> page user units, which are points
            const m = inv.multiply(ctm);
            const corners = [
              [bbox.x, bbox.y],
              [bbox.x + bbox.width, bbox.y],
              [bbox.x, bbox.y + bbox.height],
              [bbox.x + bbox.width, bbox.y + bbox.height],
            ].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
            const xs = corners.map((p) => p.x);
            const ys = corners.map((p) => p.y);
            box = {
              x: Math.min(...xs), y: Math.min(...ys),
              w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys),
            };
          } catch (err) {
            continue;
          }

          if (box.w < 0.5 && box.h < 0.5) continue;

          const id = Number(el.getAttribute(OBJ_ATTR));
          if (!Number.isFinite(id)) continue;

          const tag = el.tagName.replace(/^svg:/, '').toLowerCase();
          const type = tag === 'text' ? 'text' : tag === 'image' ? 'image' : 'vector';
          const label = type === 'text'
            ? ((el.textContent || '').trim().slice(0, 40) || 'Text')
            : type === 'image'
              ? `Image ${Math.round(box.w)} x ${Math.round(box.h)} pt`
              : tag.charAt(0).toUpperCase() + tag.slice(1);

          objects.push({ id, type, label, ...box });
        }
      } finally {
        holder.remove();
      }
      return objects;
    })();

    this.objectCache.set(key, job);
    return job;
  }

  /**
   * Loads MuPDF on first use. It carries a ~10 MB WebAssembly payload, so it is
   * imported lazily: viewing a PDF never pays for it, only exporting does.
   */
  getMu() { return this.session.getMu(); }

  getMuDoc() { return this.session.getMuDoc(); }

  /**
   * MuPDF's SVG writer options. Keeping text as text produces a far smaller
   * file with real, selectable <text> runs; outlines are larger but render
   * identically anywhere, because they do not depend on the viewer's fonts.
   */
  svgWriterOptions() {
    return this.textAsOutlines ? 'text=path' : 'text=text';
  }

  /**
   * Writes a region straight out of MuPDF. Unlike a viewBox window, this emits
   * only what falls inside the box, so a crop costs what the crop contains.
   * Coordinates are PDF points with a top-left origin, matching selections.
   */
  async muSvg(pageNum, box) {
    const mupdf = await this.getMu();
    const doc = await this.getMuDoc();
    this.session.assertActive();

    let page = null;
    let writer = null;
    let device = null;
    const out = new mupdf.Buffer();
    try {
      page = doc.loadPage(pageNum - 1);
      const rect = box || page.getBounds();
      writer = new mupdf.DocumentWriter(out, 'svg', this.svgWriterOptions());
      device = writer.beginPage(rect);
      // beginPage sets the viewport to "0 0 w h" but the page still draws in
      // page coordinates, so the content has to be shifted to meet it.
      // Without this, every crop shows the top-left corner of the page.
      page.run(device, [1, 0, 0, 1, -rect[0], -rect[1]]);
      device.close();
      writer.endPage();
      writer.close();
      return new TextDecoder().decode(out.asUint8Array());
    } finally {
      // WASM memory is not garbage collected for us.
      for (const obj of [device, writer, page, out]) {
        try { obj?.destroy?.(); } catch (err) { /* already gone */ }
      }
    }
  }

  /**
   * Renders a whole page to SVG once and caches it as a DOM element. This backs
   * the object index and any export that has to filter individual objects.
   */
  getPageSvg(pageNum) {
    const key = `${pageNum}:${this.textAsOutlines}`;
    if (!this.pageSvgCache.has(key)) {
      const job = (async () => {
        const text = await this.muSvg(pageNum, null);
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const root = doc.documentElement;
        if (!root || root.tagName === 'parsererror') {
          throw new Error('Could not parse the page SVG');
        }
        return root;
      })();
      this.pageSvgCache.set(key, job);
    }
    return this.pageSvgCache.get(key);
  }

  /**
   * Drops content that falls entirely outside the crop. MuPDF writes the whole
   * page and lets the viewport do the cropping, so without this every crop
   * carries the rest of the page: each image as a base64 payload, every line
   * of text as a run that pulls its font in with it, and, with text as
   * outlines, every glyph on the page as a path. SVGO's own off-canvas pass
   * gives up on anything carrying a transform, which is all of it.
   *
   * Geometry is compared in screen space, which is the one coordinate system
   * both the root's viewBox mapping and each element's transform chain agree
   * on. The element must be in the document for the browser to resolve those.
   * Only content that misses the crop outright goes: a stroke can paint well
   * outside its own geometry, so the box grows by the stroke before the test,
   * and anything that cannot be measured stays.
   */
  pruneOffCanvas(svgElement, crop, selector = 'image, text, path, use') {
    const candidates = svgElement.querySelectorAll(selector);
    if (!candidates.length) return 0;

    const holder = document.createElement('div');
    holder.style.cssText =
      'position:fixed;left:-20000px;top:0;width:1000px;height:1000px;opacity:0;pointer-events:none';
    holder.appendChild(svgElement);
    document.body.appendChild(holder);

    let removed = 0;
    try {
      const rootCTM = svgElement.getScreenCTM();
      if (!rootCTM) return 0;

      const toScreen = (m, x, y) => ({
        x: m.a * x + m.c * y + m.e,
        y: m.b * x + m.d * y + m.f,
      });

      // The crop rectangle, in screen space.
      const c0 = toScreen(rootCTM, crop.x, crop.y);
      const c1 = toScreen(rootCTM, crop.x + crop.w, crop.y + crop.h);
      const cropBox = {
        x0: Math.min(c0.x, c1.x), x1: Math.max(c0.x, c1.x),
        y0: Math.min(c0.y, c1.y), y1: Math.max(c0.y, c1.y),
      };

      for (const el of [...candidates]) {
        // Definitions are referenced from elsewhere, so where they sit says
        // nothing about where they paint.
        if (el.closest('defs, clipPath, mask, pattern, marker, symbol')) continue;

        let box;
        try {
          const bbox = el.getBBox();
          const ctm = el.getScreenCTM();
          if (!ctm) continue;
          // A stroke is centred on the path, so it reaches half its width
          // past the geometry on every side. Both properties inherit, so the
          // value that applies may sit on an ancestor.
          const stroke = el.closest('[stroke]')?.getAttribute('stroke');
          const width = parseFloat(
            el.closest('[stroke-width]')?.getAttribute('stroke-width') ?? '1');
          const pad = stroke && stroke !== 'none'
            ? (Number.isFinite(width) ? width : 1) / 2
            : 0;
          if ((!bbox.width || !bbox.height) && !pad) continue;
          const pts = [
            toScreen(ctm, bbox.x - pad, bbox.y - pad),
            toScreen(ctm, bbox.x + bbox.width + pad, bbox.y - pad),
            toScreen(ctm, bbox.x - pad, bbox.y + bbox.height + pad),
            toScreen(ctm, bbox.x + bbox.width + pad, bbox.y + bbox.height + pad),
          ];
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          box = {
            x0: Math.min(...xs), x1: Math.max(...xs),
            y0: Math.min(...ys), y1: Math.max(...ys),
          };
        } catch (err) {
          continue; // Un-measurable: keep it rather than risk losing content.
        }

        const disjoint =
          box.x1 <= cropBox.x0 || box.x0 >= cropBox.x1 ||
          box.y1 <= cropBox.y0 || box.y0 >= cropBox.y1;
        if (disjoint) {
          el.remove();
          removed++;
        }
      }
      if (removed) removed += this.pruneUnusedDefs(svgElement);
    } finally {
      holder.remove();
    }
    return removed;
  }

  /**
   * Drops definitions nothing refers to any more. With text as outlines MuPDF
   * defines every glyph on the page once and draws it with <use>, so pruning
   * the draws leaves the shapes behind unless they go too.
   */
  pruneUnusedDefs(svgElement) {
    const definitions = [...svgElement.querySelectorAll('defs')]
      .filter((defs) => !defs.parentElement?.closest('defs'))
      .flatMap((defs) => [...defs.children]);
    const owners = new Map();
    for (const definition of definitions) {
      for (const node of [definition, ...definition.querySelectorAll('[id]')]) {
        if (node.id) owners.set(node.id, definition);
      }
    }
    const referenced = (node) => {
      const ids = [];
      for (const attr of node.attributes) {
        for (const match of attr.value.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) ids.push(match[1]);
        if (attr.localName === 'href' && attr.value.startsWith('#')) ids.push(attr.value.slice(1));
      }
      if (node.tagName.toLowerCase() === 'style') {
        for (const match of node.textContent.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) ids.push(match[1]);
      }
      return ids;
    };
    const queue = [];
    for (const node of [svgElement, ...svgElement.querySelectorAll('*')]) {
      if (!node.closest('defs')) queue.push(...referenced(node));
    }
    const live = new Set();
    // Styles have global effect even when they are inside <defs>.
    for (const definition of definitions) {
      if (definition.matches('style') || definition.querySelector('style')) {
        live.add(definition);
        for (const node of [definition, ...definition.querySelectorAll('*')]) queue.push(...referenced(node));
      }
    }
    while (queue.length) {
      const owner = owners.get(queue.pop());
      if (!owner || live.has(owner)) continue;
      live.add(owner);
      for (const node of [owner, ...owner.querySelectorAll('*')]) queue.push(...referenced(node));
    }
    let removed = 0;
    for (const definition of definitions) {
      if (!live.has(definition)) { definition.remove(); removed++; }
    }
    return removed;
  }

  /**
   * The fonts PDF.js parsed for a page, as font objects carrying the repaired
   * OpenType program plus the character-code tables that go with it.
   *
   * PDF.js builds these to render the page and hands them over the worker
   * boundary; asking for the operator list is what makes them arrive, and it
   * is cached, so a page already on screen costs nothing here.
   */
  getPageFonts(pageNum) {
    if (!this.pageFontCache.has(pageNum)) {
      const job = (async () => {
        const page = await this.session.getPage(pageNum);
        const ops = await page.getOperatorList();
        this.session.assertActive();
        const names = new Set();
        ops.fnArray.forEach((fn, i) => {
          if (fn === pdfjsLib.OPS.setFont) names.add(ops.argsArray[i][0]);
        });

        const fonts = [];
        for (const name of names) {
          if (!page.commonObjs.has(name)) continue;
          const font = page.commonObjs.get(name);
          // Type 3 fonts are drawing procedures, not font programs.
          if (font && !font.isType3Font) fonts.push(font);
        }
        return fonts;
      })().catch((err) => {
        if (isCancelled(err, this.session)) throw err;
        console.warn(`Could not read the fonts on page ${pageNum}:`, err);
        return [];
      });
      this.pageFontCache.set(pageNum, job);
    }
    return this.pageFontCache.get(pageNum);
  }

  /**
   * Carries the PDF's fonts into the SVG.
   *
   * MuPDF names the font each text run was drawn with but cannot embed it, and
   * a subset name like `NNFDFE+Arial` matches nothing anywhere, so on its own
   * the export falls back to whatever the viewer feels like. Matching those
   * names back to the page's fonts and writing them in as `@font-face` rules
   * makes the text render in the typeface it was set in, while staying text
   * that can be selected, searched and edited.
   */
  async embedFonts(root, pageNum) {
    const texts = [...root.querySelectorAll('text')];
    if (!texts.length) return 0;

    // The family an element asks for, reading past a stack this may have
    // already been run on.
    const askedFor = (el) => {
      const family = (el.getAttribute('font-family') || '')
        .split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (!family) return null;
      return {
        family,
        bold: /bold|^[6-9]00$/.test(el.getAttribute('font-weight') || ''),
        italic: /italic|oblique/.test(el.getAttribute('font-style') || ''),
      };
    };

    const usages = new Map();
    for (const el of texts) {
      const usage = askedFor(el);
      if (!usage) continue;
      const seen = usages.get(usageKey(usage));
      // What a run spells out is what identifies its font when the name does
      // not; a few hundred characters are plenty to tell the fonts apart.
      if (!seen) usages.set(usageKey(usage), { ...usage, text: el.textContent });
      else if (seen.text.length < 2000) seen.text += el.textContent;
    }
    if (!usages.size) return 0;

    const fonts = await this.getPageFonts(pageNum);
    if (!fonts.length) return 0;

    const { css, stacks, embedded } = buildFontCss([...usages.values()], fonts);
    for (const el of texts) {
      const usage = askedFor(el);
      const stack = usage && stacks.get(usageKey(usage));
      if (stack) el.setAttribute('font-family', stack);
    }

    if (css) {
      const style = root.ownerDocument.createElementNS(SVG_NS, 'style');
      style.textContent = css;
      root.insertBefore(style, root.firstChild);
    }
    return embedded;
  }

  /** Builds the SVG string for one selection, cropped and optimized. */
  /** Builds the SVG string for one selection, cropped and optimized. */
  /**
   * Builds the DOM for a selection, with every drawable tagged. The editor and
   * the exporter both go through here, so an element the user deletes in the
   * editor is the same element the exporter drops.
   */
  async buildSvgDom(sel) {
    const filtering = !!(sel.objectIds || (sel.hiddenIds && sel.hiddenIds.length));

    let root;
    if (!filtering) {
      const raw = await this.muSvg(
        sel.page, [sel.x, sel.y, sel.x + sel.w, sel.y + sel.h]);
      const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
      root = doc.documentElement;
      if (!root || root.tagName === 'parsererror') {
        throw new Error('Could not parse the exported SVG');
      }
    } else {
      // Individual objects are being excluded, which means working from the
      // indexed whole-page render and windowing it afterwards.
      const pageSvg = await this.getPageSvg(sel.page);
      await this.buildPageObjects(sel.page);
      root = pageSvg.cloneNode(true);

      if (sel.objectIds) {
        const keep = new Set(sel.objectIds.map(String));
        for (const el of [...root.querySelectorAll(`[${OBJ_ATTR}]`)]) {
          if (!keep.has(el.getAttribute(OBJ_ATTR))) el.remove();
        }
      }
      for (const id of sel.hiddenIds || []) {
        const el = root.querySelector(`[${OBJ_ATTR}="${id}"]`);
        if (el) el.remove();
      }
      for (const el of root.querySelectorAll(`[${OBJ_ATTR}]`)) {
        el.removeAttribute(OBJ_ATTR);
      }

      root.setAttribute('viewBox', `${sel.x} ${sel.y} ${sel.w} ${sel.h}`);
      root.setAttribute('width', sel.w + 'pt');
      root.setAttribute('height', sel.h + 'pt');
    }

    // A MuPDF crop draws in its own coordinates, a windowed page render in the
    // page's; the viewBox is what says which, and is the crop either way.
    const viewBox = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const crop = viewBox.length === 4 && viewBox.every(Number.isFinite)
      ? { x: viewBox[0], y: viewBox[1], w: viewBox[2], h: viewBox[3] }
      : sel;
    this.pruneOffCanvas(root, crop);
    await this.embedFonts(root, sel.page);
    this.session.assertActive();

    // Tag in document order. Generation is deterministic for a given page,
    // box and text mode, so these ids are stable across rebuilds.
    root.querySelectorAll(DRAWABLE_SELECTOR)
      .forEach((el, i) => el.setAttribute(EDIT_ATTR, String(i)));
    return root;
  }

  /** Builds the SVG string for one selection, with edits applied. */
  async buildSvg(sel, options = {}) {
    const root = await this.buildSvgDom(sel);

    for (const id of sel.deletedIds || []) {
      const el = root.querySelector(`[${EDIT_ATTR}="${id}"]`);
      if (el) el.remove();
    }
    for (const el of root.querySelectorAll(`[${EDIT_ATTR}]`)) {
      el.removeAttribute(EDIT_ATTR);
    }

    if (options.trimHidden) {
      const { trimSvg } = await import('./svg-trim.js');
      const report = await trimSvg(root, () => {
        this.session.assertActive();
        options.assertCurrent?.();
      });
      this.pruneUnusedDefs(root);
      options.onTrim?.(report);
    }

    let svgString = new XMLSerializer().serializeToString(root);
    try {
      svgString = svgOptimize(svgString, {
        plugins: [
          {
            name: 'preset-default',
            params: {
              overrides: {
                // The @font-face rules carry the embedded fonts. Inlining
                // turns rules into presentation attributes, which an at-rule
                // cannot become, and minifying re-parses a megabyte of base64
                // for nothing.
                inlineStyles: false,
                minifyStyles: false,
              },
            },
          },
          // Our geometry pass already prunes off-crop objects with transforms
          // and strokes accounted for. SVGO's pass can drop a crossing stroke
          // when both endpoints lie outside the viewport.
        ],
      }).data;
    } catch (svgoErr) {
      console.warn('SVGO optimization failed, using raw SVG:', svgoErr);
    }
    this.session.assertActive();
    return svgString;
  }

}
