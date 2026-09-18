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

import './app.css';
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { optimize as svgOptimize } from 'svgo/browser';
import { zip as zipAsync } from 'fflate';

// PDF.js ships an ES-module worker from v4 on. Letting Vite construct it as a
// module worker avoids "Cannot use import statement outside a module".
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

const DEFAULT_SCALE = 1.5;
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;
const MAX_OBJECTS = 4000;

/** Multiplies two PDF transform matrices, [a, b, c, d, e, f]. */
function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Applies a PDF transform matrix to a point. */
function applyMatrix(x, y, m) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
const OBJ_ATTR = 'data-obj-id';
const EDIT_ATTR = 'data-el-id';
const DRAWABLE_SELECTOR =
  'path, text, image, use, rect, circle, ellipse, polygon, polyline';

class PdfCropper {
  constructor() {
    // PDF state
    this.pdfDoc = null;
    this.pageNum = 1;
    this.pageRendering = false;
    this.pageNumPending = null;

    // Zoom state. `scale` is the display scale in CSS px per PDF point;
    // `renderedScale` is the scale the current canvas bitmap was drawn at.
    // They differ briefly during a pinch, while the bitmap is upscaled by the
    // browser for instant feedback before we re-render crisply.
    this.scale = DEFAULT_SCALE;
    this.renderedScale = DEFAULT_SCALE;
    this.rerenderTimer = null;
    this.pinchStartDist = 0;
    this.pinchStartScale = 0;
    this.pinchMid = null;

    // Selection state. Selections are stored in PDF points so that they are
    // independent of the current zoom level, and survive page navigation.
    this.selections = []; // [{id, page, x, y, w, h}] in PDF points
    this.activeId = null;
    this.nextId = 1;
    this.isDragging = false;
    this.isMoving = false;
    this.movingId = null;
    this.startX = 0;
    this.startY = 0;
    this.moveOffsetX = 0;
    this.moveOffsetY = 0;

    // Cache of full-page SVG renders, keyed by page number, so that several
    // selections on one page don't each re-render the page.
    this.pageSvgCache = new Map();

    // MuPDF is the SVG export engine, loaded on first export.
    this.pdfBytes = null;
    this.muPromise = null;
    this.muDocPromise = null;
    this.textAsOutlines = false;
    this.pdfName = 'document';

    // Vector editor
    this.editorSel = null;
    this.editorRoot = null;
    this.editorItems = [];
    this.editorDeleted = new Set();
    this.editorSelected = null;
    this.editorUndo = [];

    // Detected images, so a figure can be grabbed with a single click.
    this.imageCache = new Map();
    this.pageImages = [];
    this.showImages = true;

    // Per-page object index, for the objects panel and object mode.
    this.objectCache = new Map();
    this.pageObjects = [];
    this.mode = 'region';
  }

  init() {
    // DOM elements
    this.dropZone = document.getElementById('drop-zone');
    this.app = document.getElementById('app');
    this.fileInput = document.getElementById('file-input');
    this.openBtn = document.getElementById('open-btn');
    this.prevBtn = document.getElementById('prev-btn');
    this.nextBtn = document.getElementById('next-btn');
    this.downloadBtn = document.getElementById('download-btn');
    this.pageInput = document.getElementById('page-input');
    this.pageCountSpan = document.getElementById('page-count');
    this.statusText = document.getElementById('status-text');
    this.canvas = document.getElementById('pdf-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.container = document.getElementById('pdf-container');
    this.viewport = document.getElementById('pdf-viewport');
    this.zoomInBtn = document.getElementById('zoom-in-btn');
    this.zoomOutBtn = document.getElementById('zoom-out-btn');
    this.zoomResetBtn = document.getElementById('zoom-reset-btn');
    this.selectionBox = document.getElementById('selection-box');
    this.selectionLayer = document.getElementById('selection-layer');
    this.imageLayer = document.getElementById('image-layer');
    this.imagesToggle = document.getElementById('images-toggle');
    this.objectLayer = document.getElementById('object-layer');
    this.objectsPanel = document.getElementById('objects-panel');
    this.objectsList = document.getElementById('objects-list');
    this.objectsCount = document.getElementById('objects-count');
    this.showAllBtn = document.getElementById('show-all-btn');
    this.dropRastersBtn = document.getElementById('drop-rasters-btn');
    this.objectsSummary = document.getElementById('objects-summary');
    this.textModeToggle = document.getElementById('text-mode-toggle');
    this.editorOverlay = document.getElementById('editor-overlay');
    this.editorStage = document.getElementById('editor-stage');
    this.editorList = document.getElementById('editor-list');
    this.editorTitle = document.getElementById('editor-title');
    this.editorCount = document.getElementById('editor-count');
    this.editorDoneBtn = document.getElementById('editor-done-btn');
    this.editorCancelBtn = document.getElementById('editor-cancel-btn');
    this.editorUndoBtn = document.getElementById('editor-undo-btn');
    this.editorDeleteBtn = document.getElementById('editor-delete-btn');
    this.editBtn = document.getElementById('edit-btn');
    this.editorInViewToggle = document.getElementById('editor-inview-toggle');
    this.editorOnlyInView = true;
    this.regionModeBtn = document.getElementById('region-mode-btn');
    this.objectModeBtn = document.getElementById('object-mode-btn');
    this.libraryList = document.getElementById('library-list');
    this.libraryCount = document.getElementById('library-count');
    this.libraryEmpty = document.getElementById('library-empty');
    this.exportAllBtn = document.getElementById('export-all-btn');
    this.clearAllBtn = document.getElementById('clear-all-btn');
    this.tintToggle = document.getElementById('tint-toggle');
    this.tintRasters = false;

    this.updateZoomLabel();
    this.bindEvents();
  }

  isPdf(file) {
    return file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf');
  }

  bindEvents() {
    // Drop zone
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.dropZone.classList.add('dragover');
    });
    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('dragover');
    });
    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && this.isPdf(file)) {
        this.loadFile(file);
      }
    });

    // File input (shared between drop zone and "Open PDF" button)
    this.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.loadFile(file);
      }
    });

    // Open button re-triggers file input
    this.openBtn.addEventListener('click', () => {
      this.fileInput.value = '';
      this.fileInput.click();
    });

    // Page navigation
    this.prevBtn.addEventListener('click', () => this.goToPage(this.pageNum - 1));
    this.nextBtn.addEventListener('click', () => this.goToPage(this.pageNum + 1));
    this.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const num = parseInt(this.pageInput.value, 10);
        if (num >= 1 && num <= this.pdfDoc.numPages) {
          this.goToPage(num);
        } else {
          this.pageInput.value = this.pageNum;
        }
      }
    });

    // Tint toggle — re-render the current page when changed
    this.tintToggle.addEventListener('change', () => {
      this.tintRasters = this.tintToggle.checked;
      if (this.pdfDoc) {
        this.renderPage(this.pageNum);
      }
    });

    // Zoom buttons
    this.zoomInBtn.addEventListener('click', () => this.zoomBy(ZOOM_STEP));
    this.zoomOutBtn.addEventListener('click', () => this.zoomBy(1 / ZOOM_STEP));
    this.zoomResetBtn.addEventListener('click', () => this.setZoom(DEFAULT_SCALE));

    // Zoom: trackpad pinch and ctrl/cmd + wheel.
    // A macOS trackpad pinch is delivered as a wheel event with ctrlKey set,
    // so the same handler covers both gestures.
    this.viewport.addEventListener('wheel', (e) => {
      if (!this.pdfDoc || (!e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
    }, { passive: false });

    // Safari reports a trackpad pinch as non-standard gesture events instead.
    let gestureStartScale = DEFAULT_SCALE;
    this.viewport.addEventListener('gesturestart', (e) => {
      if (!this.pdfDoc) return;
      e.preventDefault();
      gestureStartScale = this.scale;
    });
    this.viewport.addEventListener('gesturechange', (e) => {
      if (!this.pdfDoc) return;
      e.preventDefault();
      this.setZoom(gestureStartScale * e.scale, e.clientX, e.clientY);
    });
    this.viewport.addEventListener('gestureend', (e) => e.preventDefault());

    // Two-finger pinch on a touchscreen
    this.container.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    this.container.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    this.container.addEventListener('touchend', (e) => this.onTouchEnd(e));
    this.container.addEventListener('touchcancel', (e) => this.onTouchEnd(e));

    // Selection mode
    this.regionModeBtn.addEventListener('click', () => this.setMode('region'));
    this.objectModeBtn.addEventListener('click', () => this.setMode('object'));
    this.showAllBtn.addEventListener('click', () => this.showAllObjects());
    this.dropRastersBtn.addEventListener('click', () => this.hideByKind('image'));

    // Text as real <text> or as outlines changes every subsequent export.
    this.textModeToggle.addEventListener('change', () => {
      this.textAsOutlines = this.textModeToggle.checked;
      this.pageSvgCache.clear();
      this.objectCache.clear();
      this.rebuildAllPreviews();
    });

    // Detected-image outlines
    this.imagesToggle.addEventListener('change', () => {
      this.showImages = this.imagesToggle.checked;
      this.renderImageLayer();
    });

    // Vector editor
    this.editBtn.addEventListener('click', () => {
      const sel = this.selections.find((s) => s.id === this.activeId);
      if (sel) this.openEditor(sel);
    });
    this.editorDoneBtn.addEventListener('click', () => this.closeEditor(true));
    this.editorCancelBtn.addEventListener('click', () => this.closeEditor(false));
    this.editorUndoBtn.addEventListener('click', () => this.undoEditorDelete());
    this.editorInViewToggle.addEventListener('change', () => {
      this.editorOnlyInView = this.editorInViewToggle.checked;
      this.renderEditorList();
    });
    this.editorDeleteBtn.addEventListener('click', () => {
      if (this.editorSelected !== null) this.toggleEditorDeleted(this.editorSelected);
    });

    // Clicking a shape on the stage selects it; the browser does the hit test.
    this.editorStage.addEventListener('click', (e) => {
      const hit = e.target.closest(`[${EDIT_ATTR}]`);
      this.setEditorSelection(hit ? hit.getAttribute(EDIT_ATTR) : null);
    });

    // Library
    this.exportAllBtn.addEventListener('click', () => this.exportAll());
    this.clearAllBtn.addEventListener('click', () => this.clearLibrary());

    // Download the active selection
    this.downloadBtn.addEventListener('click', () => this.handleDownload());

    // Selection (mouse)
    this.viewport.addEventListener('mousedown', (e) => this.onPointerDown(e));
    window.addEventListener('mousemove', (e) => this.onPointerMove(e));
    window.addEventListener('mouseup', (e) => this.onPointerUp(e));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!this.pdfDoc) return;

      // The editor takes over the keyboard while it is open.
      if (!this.editorOverlay.classList.contains('hidden')) {
        if (e.key === 'Escape') {
          this.closeEditor(false);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') &&
                   this.editorSelected !== null) {
          e.preventDefault();
          this.toggleEditorDeleted(this.editorSelected);
        } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
          e.preventDefault();
          this.undoEditorDelete();
        }
        return;
      }

      if (document.activeElement === this.pageInput) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          this.zoomBy(ZOOM_STEP);
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          this.zoomBy(1 / ZOOM_STEP);
        } else if (e.key === '0') {
          e.preventDefault();
          this.setZoom(DEFAULT_SCALE);
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        this.goToPage(this.pageNum - 1);
      } else if (e.key === 'ArrowRight') {
        this.goToPage(this.pageNum + 1);
      } else if (e.key === 'Escape') {
        this.setActive(null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.activeId !== null) {
          e.preventDefault();
          this.removeSelection(this.activeId);
        }
      }
    });
  }

  // -------- File loading --------

  loadFile(file) {
    this.pdfName = file.name.replace(/\.pdf$/i, '') || 'document';
    const reader = new FileReader();
    reader.onload = (event) => {
      const data = new Uint8Array(event.target.result);
      // PDF.js transfers (and detaches) the buffer it is given, so MuPDF needs
      // its own copy taken before that happens.
      this.pdfBytes = data.slice();
      this.loadPDF(data);
    };
    reader.readAsArrayBuffer(file);
  }

  async loadPDF(data) {
    try {
      this.pdfDoc = await pdfjsLib.getDocument({
        data,
        // Decode images to plain typed arrays rather than ImageBitmaps, which
        // is what the native-format PNG extraction reads.
        isOffscreenCanvasSupported: false,
        // NOTE: pdfjs-dist is held at 4.x deliberately. From 5.0 on, CCITT
        // stencil image masks stop rendering -- monocult.pdf loses both of its
        // cover illustrations. 4.10.38 is the newest release that draws them,
        // and it is already past the GHSA-wgrm-67xf-hhpq fix.
      }).promise;
      this.pageNum = 1;
      this.clearLibrary();
      this.pageSvgCache.clear();
      this.imageCache.clear();
      this.pageImages = [];
      this.objectCache.clear();
      this.pageObjects = [];
      this.muDocPromise = null;

      // Show the app, hide drop zone
      this.dropZone.classList.add('hidden');
      this.app.classList.remove('hidden');

      this.pageCountSpan.textContent = this.pdfDoc.numPages;
      this.pageInput.max = this.pdfDoc.numPages;
      this.statusText.textContent = 'Drag to select a region';

      this.renderPage(this.pageNum);
      this.updateNav();
    } catch (err) {
      console.error(err);
      alert('Error loading PDF: ' + err.message);
    }
  }

  // -------- Page rendering --------

  async renderPage(num) {
    this.pageRendering = true;

    try {
      const page = await this.pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale: this.scale });

      this.canvas.width = Math.round(viewport.width);
      this.canvas.height = Math.round(viewport.height);
      this.renderedScale = this.scale;
      this.applyDisplayScale();

      // Wrap drawImage to tint raster images so the user can see what
      // won't export as vector SVG.
      const origDrawImage = this.ctx.drawImage.bind(this.ctx);
      const tintDrawImage = (...args) => {
        origDrawImage(...args);

        // Determine the destination rectangle
        let dx, dy, dw, dh;
        if (args.length === 3) {
          [, dx, dy] = args;
          dw = args[0].width;
          dh = args[0].height;
        } else if (args.length === 5) {
          [, dx, dy, dw, dh] = args;
        } else if (args.length === 9) {
          [, , , , , dx, dy, dw, dh] = args;
        }

        if (dw && dh) {
          this.ctx.save();
          this.ctx.fillStyle = 'rgba(255, 140, 0, 0.25)';
          this.ctx.fillRect(dx, dy, dw, dh);
          this.ctx.restore();
        }
      };

      if (this.tintRasters) {
        this.ctx.drawImage = tintDrawImage;
      }

      await page.render({ canvasContext: this.ctx, viewport }).promise;

      // Restore original drawImage
      this.ctx.drawImage = origDrawImage;

      this.pageRendering = false;
      this.pageInput.value = num;
      this.renderSelectionLayer();
      this.refreshImageLayer();
      this.refreshObjectsIfNeeded();

      if (this.pageNumPending !== null) {
        const pending = this.pageNumPending;
        this.pageNumPending = null;
        this.renderPage(pending);
      }
    } catch (err) {
      this.pageRendering = false;
      console.error('Render error:', err);
    }
  }

  goToPage(num) {
    if (!this.pdfDoc) return;
    if (num < 1 || num > this.pdfDoc.numPages) return;
    this.pageNum = num;
    if (this.pageRendering) {
      this.pageNumPending = num;
    } else {
      this.renderPage(num);
    }
    this.updateNav();
  }

  updateNav() {
    this.prevBtn.disabled = this.pageNum <= 1;
    this.nextBtn.disabled = this.pageNum >= this.pdfDoc.numPages;
  }

  // -------- Zoom --------

  /** Displayed size of one PDF point, in CSS pixels. */
  ptToPx(v) {
    return v * this.scale;
  }

  pxToPt(v) {
    return v / this.scale;
  }

  /**
   * Stretches the current bitmap to the display scale. Until the debounced
   * re-render lands this is a plain browser upscale, which keeps a pinch
   * responsive on pages that are slow to rasterize.
   */
  applyDisplayScale() {
    const factor = this.scale / this.renderedScale;
    this.canvas.style.width = (this.canvas.width * factor) + 'px';
    this.canvas.style.height = (this.canvas.height * factor) + 'px';
  }

  zoomBy(factor, clientX, clientY) {
    this.setZoom(this.scale * factor, clientX, clientY);
  }

  /**
   * Zooms to `newScale`, keeping the page point under (clientX, clientY)
   * pinned in place. Falls back to the viewport centre when no anchor is given.
   */
  setZoom(newScale, clientX, clientY) {
    if (!this.pdfDoc) return;
    newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const ratio = newScale / this.scale;
    if (Math.abs(ratio - 1) < 0.0005) return;

    if (clientX === undefined || clientY === undefined) {
      const vpRect = this.viewport.getBoundingClientRect();
      clientX = vpRect.left + vpRect.width / 2;
      clientY = vpRect.top + vpRect.height / 2;
    }

    // Where the anchor sits inside the page, measured before the resize.
    const before = this.container.getBoundingClientRect();
    const anchorX = clientX - before.left;
    const anchorY = clientY - before.top;

    this.scale = newScale;
    this.applyDisplayScale();
    this.renderSelectionLayer();
    this.renderImageLayer();
    this.renderObjectLayer();

    // The container has moved and/or resized; scroll so the anchor point ends
    // up back under the cursor.
    const after = this.container.getBoundingClientRect();
    this.viewport.scrollLeft += (after.left + anchorX * ratio) - clientX;
    this.viewport.scrollTop += (after.top + anchorY * ratio) - clientY;

    this.updateZoomLabel();
    this.scheduleRerender();
  }

  /** Re-rasterizes at the new scale once the gesture settles. */
  scheduleRerender() {
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = setTimeout(() => {
      if (!this.pdfDoc) return;
      if (this.pageRendering) {
        this.scheduleRerender();
        return;
      }
      if (this.renderedScale !== this.scale) {
        this.renderPage(this.pageNum);
      }
    }, 180);
  }

  updateZoomLabel() {
    if (this.zoomResetBtn) {
      this.zoomResetBtn.textContent = Math.round(this.scale * 100) + '%';
    }
  }

  // -------- Touch pinch --------

  touchMid(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  onTouchStart(e) {
    if (!this.pdfDoc || e.touches.length !== 2) return;
    e.preventDefault();
    // A second finger cancels any selection drag started by the first.
    this.isDragging = false;
    this.isMoving = false;
    this.selectionBox.style.display = 'none';
    this.pinchStartDist = this.touchDist(e.touches);
    this.pinchStartScale = this.scale;
    this.pinchMid = this.touchMid(e.touches);
  }

  onTouchMove(e) {
    if (!this.pdfDoc || e.touches.length !== 2 || !this.pinchStartDist) return;
    e.preventDefault();

    const mid = this.touchMid(e.touches);
    // Two fingers also pan, so follow the midpoint as it moves.
    this.viewport.scrollLeft -= mid.x - this.pinchMid.x;
    this.viewport.scrollTop -= mid.y - this.pinchMid.y;
    this.pinchMid = mid;

    const dist = this.touchDist(e.touches);
    this.setZoom(this.pinchStartScale * (dist / this.pinchStartDist), mid.x, mid.y);
  }

  onTouchEnd(e) {
    if (e.touches.length < 2) {
      this.pinchStartDist = 0;
      this.pinchMid = null;
    }
  }

  // -------- Image detection --------

  /**
   * Walks a page's operator list, tracking the current transform, and returns
   * the bounding box of every image it paints. Boxes come back in the same
   * PDF-point space that selections use, so one can become the other directly.
   */
  async detectImages(pageNum) {
    if (this.imageCache.has(pageNum)) return this.imageCache.get(pageNum);

    const job = (async () => {
      const page = await this.pdfDoc.getPage(pageNum);
      const opList = await page.getOperatorList();
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
          // An XObject names its decoded image in page.objs. A stencil mask
          // passes an object whose `data` is that name, not the pixels. Only a
          // true inline image carries its samples in the argument itself.
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

  async refreshImageLayer() {
    if (!this.pdfDoc) return;
    const pageNum = this.pageNum;
    let boxes = [];
    try {
      boxes = await this.detectImages(pageNum);
    } catch (err) {
      console.warn('Image detection failed:', err);
    }
    // The user may have paged away while detection was running.
    if (pageNum !== this.pageNum) return;
    this.pageImages = boxes;
    this.renderImageLayer();
  }

  renderImageLayer() {
    if (!this.imageLayer) return;
    this.imageLayer.innerHTML = '';
    this.imageLayer.classList.toggle('hidden', !this.showImages);
    if (!this.showImages) return;

    for (const box of this.pageImages) {
      const el = document.createElement('div');
      el.className = 'image-hotspot';
      el.style.left = this.ptToPx(box.x) + 'px';
      el.style.top = this.ptToPx(box.y) + 'px';
      el.style.width = this.ptToPx(box.w) + 'px';
      el.style.height = this.ptToPx(box.h) + 'px';
      this.imageLayer.appendChild(el);
    }
  }

  /** Smallest detected image containing the point, or null. Point is in px. */
  imageHitTest(px, py) {
    if (!this.showImages) return null;
    for (let i = this.pageImages.length - 1; i >= 0; i--) {
      const b = this.pageImages[i];
      const x = this.ptToPx(b.x);
      const y = this.ptToPx(b.y);
      const w = this.ptToPx(b.w);
      const h = this.ptToPx(b.h);
      if (px >= x && px <= x + w && py >= y && py <= y + h) return { box: b, index: i };
    }
    return null;
  }

  highlightHotspot(index) {
    if (!this.imageLayer) return;
    const els = this.imageLayer.children;
    for (let i = 0; i < els.length; i++) {
      els[i].classList.toggle('hot', i === index);
    }
  }

  // -------- Object index --------

  /**
   * Builds the list of drawable objects on a page, each with its bounds in PDF
   * points. Elements are tagged in the cached page SVG first, so a clone made
   * later at export time can resolve the very same objects by id.
   */
  async buildPageObjects(pageNum) {
    if (this.objectCache.has(pageNum)) return this.objectCache.get(pageNum);

    const job = (async () => {
      const pageSvg = await this.getPageSvg(pageNum);
      const page = await this.pdfDoc.getPage(pageNum);
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

    this.objectCache.set(pageNum, job);
    return job;
  }

  /** Objects whose bounds intersect a selection. */
  objectsInSelection(sel, objects) {
    return objects.filter((o) =>
      o.x < sel.x + sel.w && o.x + o.w > sel.x &&
      o.y < sel.y + sel.h && o.y + o.h > sel.y);
  }

  /**
   * Whether the object index is actually being looked at. Building it renders
   * the page through MuPDF and measures every drawable, which is far too much
   * work to spend on a page the user is only paging past.
   */
  objectsNeeded() {
    if (this.mode === 'object') return true;
    const sel = this.selections.find((s) => s.id === this.activeId);
    return !!sel && sel.source !== 'image' && sel.page === this.pageNum;
  }

  /** Indexes the page only if something is showing the result. */
  refreshObjectsIfNeeded() {
    if (this.objectsNeeded()) {
      this.refreshObjects();
      return;
    }
    this.pageObjects = [];
    this.renderObjectLayer();
    this.renderObjectsPanel();
  }

  async refreshObjects() {
    if (!this.pdfDoc) return;
    const pageNum = this.pageNum;
    let objects = [];
    try {
      objects = await this.buildPageObjects(pageNum);
    } catch (err) {
      console.warn('Object index failed:', err);
    }
    if (pageNum !== this.pageNum) return;
    this.pageObjects = objects;
    this.renderObjectLayer();
    this.renderObjectsPanel();
  }

  /**
   * Smallest object under a point, in display pixels. Rules and underlines are
   * zero-height, so every object gets a few pixels of slack to stay clickable.
   */
  objectHitTest(px, py) {
    const SLACK = 3;
    let best = null;
    for (const o of this.pageObjects) {
      const x = this.ptToPx(o.x) - SLACK;
      const y = this.ptToPx(o.y) - SLACK;
      const w = this.ptToPx(o.w) + SLACK * 2;
      const h = this.ptToPx(o.h) + SLACK * 2;
      if (px >= x && px <= x + w && py >= y && py <= y + h) {
        const area = w * h;
        if (!best || area < best.area) best = { obj: o, area };
      }
    }
    return best ? best.obj : null;
  }

  renderObjectLayer() {
    if (!this.objectLayer) return;
    this.objectLayer.innerHTML = '';
    this.objectLayer.classList.toggle('hidden', this.mode !== 'object');
    if (this.mode !== 'object') return;

    const sel = this.selections.find((s) => s.id === this.activeId);
    const chosen = sel && sel.objectIds ? new Set(sel.objectIds) : new Set();

    for (const o of this.pageObjects) {
      const el = document.createElement('div');
      el.className = 'object-outline';
      if (chosen.has(o.id)) el.classList.add('chosen');
      if (sel && sel.hiddenIds && sel.hiddenIds.includes(o.id)) {
        el.classList.add('object-hidden');
      }
      el.dataset.objId = o.id;
      el.style.left = this.ptToPx(o.x) + 'px';
      el.style.top = this.ptToPx(o.y) + 'px';
      el.style.width = this.ptToPx(o.w) + 'px';
      el.style.height = this.ptToPx(o.h) + 'px';
      this.objectLayer.appendChild(el);
    }
  }

  highlightObject(objId) {
    if (!this.objectLayer) return;
    for (const el of this.objectLayer.children) {
      el.classList.toggle('hot', Number(el.dataset.objId) === objId);
    }
  }

  // -------- Objects panel --------

  /** The editor only makes sense for a vector selection. */
  updateEditButton() {
    const sel = this.selections.find((s) => s.id === this.activeId);
    this.editBtn.disabled = !sel || sel.source === 'image';
  }

  /** Objects belonging to the active selection, in page order. */
  activeSelectionObjects() {
    const sel = this.selections.find((s) => s.id === this.activeId);
    if (!sel || sel.source === 'image') return { sel: sel || null, objects: [] };
    if (sel.objectIds) {
      const byId = new Map(this.pageObjects.map((o) => [o.id, o]));
      return { sel, objects: sel.objectIds.map((id) => byId.get(id)).filter(Boolean) };
    }
    if (sel.page !== this.pageNum) return { sel, objects: [] };
    return { sel, objects: this.objectsInSelection(sel, this.pageObjects) };
  }

  renderObjectsPanel() {
    if (!this.objectsPanel) return;

    const { sel, objects } = this.activeSelectionObjects();
    const show = !!sel && sel.source !== 'image';
    this.objectsPanel.classList.toggle('hidden', !show);
    if (!show) return;

    this.objectsCount.textContent = objects.length;

    const hiddenSet = new Set(sel.hiddenIds || []);
    const tally = { vector: 0, text: 0, image: 0 };
    for (const o of objects) tally[o.type] = (tally[o.type] || 0) + 1;

    const parts = [];
    if (tally.vector) parts.push(`${tally.vector} vector`);
    if (tally.text) parts.push(`${tally.text} text`);
    if (tally.image) parts.push(`${tally.image} raster`);
    if (hiddenSet.size) parts.push(`${hiddenSet.size} hidden`);
    this.objectsSummary.textContent = parts.join(' \u00b7 ') || 'Nothing here';
    // Rasters are the things that will not scale losslessly, so offer to drop
    // them only when there are some left to drop.
    const droppable = objects.some((o) => o.type === 'image' && !hiddenSet.has(o.id));
    this.dropRastersBtn.disabled = !droppable;
    this.showAllBtn.disabled = hiddenSet.size === 0;

    this.objectsList.innerHTML = '';

    if (!objects.length) {
      const empty = document.createElement('p');
      empty.className = 'library-hint';
      empty.textContent = sel.page !== this.pageNum
        ? 'Go to this selection’s page to inspect its objects.'
        : 'No vector objects here — this part of the page is a raster image.';
      this.objectsList.appendChild(empty);
      return;
    }

    const hidden = new Set(sel.hiddenIds || []);

    for (const o of objects) {
      const row = document.createElement('div');
      row.className = 'object-row';
      if (hidden.has(o.id)) row.classList.add('is-hidden');

      const eye = document.createElement('button');
      eye.className = 'eye-btn';
      eye.title = hidden.has(o.id) ? 'Show this object' : 'Hide this object';
      eye.textContent = hidden.has(o.id) ? '○' : '●';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleObjectHidden(sel, o.id);
      });

      const kind = document.createElement('span');
      kind.className = `object-kind kind-${o.type}`;
      kind.textContent = o.type;

      const label = document.createElement('span');
      label.className = 'object-label';
      label.textContent = o.label;

      row.appendChild(eye);
      row.appendChild(kind);
      row.appendChild(label);

      // Hovering a row highlights the object on the page.
      row.addEventListener('mouseenter', () => this.highlightObject(o.id));
      row.addEventListener('mouseleave', () => this.highlightObject(-1));

      this.objectsList.appendChild(row);
    }
  }

  toggleObjectHidden(sel, objId) {
    const hidden = new Set(sel.hiddenIds || []);
    if (hidden.has(objId)) hidden.delete(objId);
    else hidden.add(objId);
    sel.hiddenIds = [...hidden];
    this.renderObjectsPanel();
    this.renderObjectLayer();
    this.buildPreview(sel); // re-export without the hidden objects
  }

  /** Hides every object of one kind in the active selection. */
  hideByKind(kind) {
    const { sel, objects } = this.activeSelectionObjects();
    if (!sel) return;
    const hidden = new Set(sel.hiddenIds || []);
    let changed = false;
    for (const o of objects) {
      if (o.type === kind && !hidden.has(o.id)) {
        hidden.add(o.id);
        changed = true;
      }
    }
    if (!changed) return;
    sel.hiddenIds = [...hidden];
    this.renderObjectsPanel();
    this.renderObjectLayer();
    this.buildPreview(sel);
  }

  /** Re-exports everything, e.g. after the text mode changed. */
  rebuildAllPreviews() {
    for (const sel of this.selections) {
      if (sel.source !== 'image') this.buildPreview(sel);
    }
  }

  showAllObjects() {
    const sel = this.selections.find((s) => s.id === this.activeId);
    if (!sel || !sel.hiddenIds || !sel.hiddenIds.length) return;
    sel.hiddenIds = [];
    this.renderObjectsPanel();
    this.renderObjectLayer();
    this.buildPreview(sel);
  }

  setMode(mode) {
    this.mode = mode;
    this.regionModeBtn.classList.toggle('active', mode === 'region');
    this.objectModeBtn.classList.toggle('active', mode === 'object');
    this.statusText.textContent = mode === 'object'
      ? 'Click objects to add them to a selection'
      : 'Drag to select a region';
    this.renderObjectLayer();
    if (mode === 'object') this.refreshObjects();
  }

  /** In object mode, clicking an object adds or removes it from the selection. */
  toggleObjectInSelection(obj) {
    let sel = this.selections.find((s) => s.id === this.activeId);

    if (!sel || !sel.objectIds || sel.page !== this.pageNum) {
      sel = this.addSelection({
        page: this.pageNum,
        ...obj,
        source: 'objects',
        objectIds: [obj.id],
      });
      return;
    }

    const ids = new Set(sel.objectIds);
    if (ids.has(obj.id)) ids.delete(obj.id);
    else ids.add(obj.id);

    if (!ids.size) {
      this.removeSelection(sel.id);
      return;
    }

    sel.objectIds = [...ids];
    const chosen = this.pageObjects.filter((o) => ids.has(o.id));
    const x0 = Math.min(...chosen.map((o) => o.x));
    const y0 = Math.min(...chosen.map((o) => o.y));
    const x1 = Math.max(...chosen.map((o) => o.x + o.w));
    const y1 = Math.max(...chosen.map((o) => o.y + o.h));
    sel.x = x0; sel.y = y0; sel.w = x1 - x0; sel.h = y1 - y0;

    this.renderSelectionLayer();
    this.renderObjectLayer();
    this.renderObjectsPanel();
    this.renderLibrary();
    this.buildPreview(sel);
  }

  // -------- Selection --------

  getContainerPos(e) {
    const rect = this.container.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  /**
   * Clamps a container-relative point to the page, so a drag that begins in
   * the margin around the page still produces a region on the page itself.
   */
  clampToPage(pos) {
    return {
      x: Math.max(0, Math.min(pos.x, this.canvas.clientWidth)),
      y: Math.max(0, Math.min(pos.y, this.canvas.clientHeight)),
    };
  }

  /** Selections on the current page, in display pixels. */
  pageSelections() {
    return this.selections.filter((s) => s.page === this.pageNum);
  }

  /** Topmost selection containing the given point, or null. Point is in px. */
  hitTest(px, py) {
    const here = this.pageSelections();
    for (let i = here.length - 1; i >= 0; i--) {
      const s = here[i];
      const x = this.ptToPx(s.x);
      const y = this.ptToPx(s.y);
      const w = this.ptToPx(s.w);
      const h = this.ptToPx(s.h);
      if (px >= x && px <= x + w && py >= y && py <= y + h) return s;
    }
    return null;
  }

  onPointerDown(e) {
    if (!this.pdfDoc || e.button !== 0) return;

    // Ignore presses on the viewport's own scrollbars, which sit outside its
    // client box but inside its border box.
    const vpRect = this.viewport.getBoundingClientRect();
    if (e.clientX - vpRect.left >= this.viewport.clientWidth ||
        e.clientY - vpRect.top >= this.viewport.clientHeight) {
      return;
    }

    const raw = this.getContainerPos(e);
    const pos = this.clampToPage(raw);

    // Clicking an existing selection picks it up and moves it.
    const hit = this.hitTest(raw.x, raw.y);
    if (hit) {
      this.setActive(hit.id);
      this.isMoving = true;
      this.movingId = hit.id;
      this.moveOffsetX = pos.x - this.ptToPx(hit.x);
      this.moveOffsetY = pos.y - this.ptToPx(hit.y);
      this.container.style.cursor = 'move';
      e.preventDefault();
      return;
    }

    // Otherwise drag out a new one.
    this.isDragging = true;
    this.startX = pos.x;
    this.startY = pos.y;

    this.selectionBox.style.left = pos.x + 'px';
    this.selectionBox.style.top = pos.y + 'px';
    this.selectionBox.style.width = '0px';
    this.selectionBox.style.height = '0px';
    this.selectionBox.style.display = 'block';
    e.preventDefault();
  }

  onPointerMove(e) {
    if (this.isMoving && this.movingId !== null) {
      const sel = this.selections.find((s) => s.id === this.movingId);
      if (!sel) return;
      const pos = this.getContainerPos(e);
      const maxX = this.canvas.clientWidth - this.ptToPx(sel.w);
      const maxY = this.canvas.clientHeight - this.ptToPx(sel.h);
      const newX = Math.max(0, Math.min(pos.x - this.moveOffsetX, maxX));
      const newY = Math.max(0, Math.min(pos.y - this.moveOffsetY, maxY));
      sel.x = this.pxToPt(newX);
      sel.y = this.pxToPt(newY);
      this.renderSelectionLayer();
      return;
    }

    if (!this.isDragging) {
      const pos = this.getContainerPos(e);

      if (this.mode === 'object') {
        const obj = this.objectHitTest(pos.x, pos.y);
        this.container.style.cursor = obj ? 'pointer' : 'crosshair';
        this.highlightObject(obj ? obj.id : -1);
        return;
      }

      if (this.hitTest(pos.x, pos.y)) {
        this.container.style.cursor = 'move';
        this.highlightHotspot(-1);
      } else {
        const img = this.imageHitTest(pos.x, pos.y);
        this.container.style.cursor = img ? 'pointer' : 'crosshair';
        this.highlightHotspot(img ? img.index : -1);
      }
      return;
    }

    const pos = this.clampToPage(this.getContainerPos(e));
    this.selectionBox.style.left = Math.min(this.startX, pos.x) + 'px';
    this.selectionBox.style.top = Math.min(this.startY, pos.y) + 'px';
    this.selectionBox.style.width = Math.abs(pos.x - this.startX) + 'px';
    this.selectionBox.style.height = Math.abs(pos.y - this.startY) + 'px';
  }

  onPointerUp() {
    if (this.isMoving) {
      this.isMoving = false;
      this.movingId = null;
      this.container.style.cursor = 'crosshair';
      this.refreshSelection(this.activeId);
      return;
    }

    if (!this.isDragging) return;
    this.isDragging = false;
    this.selectionBox.style.display = 'none';

    const style = window.getComputedStyle(this.selectionBox);
    const w = parseFloat(style.width);
    const h = parseFloat(style.height);
    const x = parseFloat(style.left);
    const y = parseFloat(style.top);

    if (w > 5 && h > 5) {
      this.addSelection({
        page: this.pageNum,
        x: this.pxToPt(x),
        y: this.pxToPt(y),
        w: this.pxToPt(w),
        h: this.pxToPt(h),
      });
      return;
    }

    // Too small to be a drag, so treat it as a click.
    if (this.mode === 'object') {
      const obj = this.objectHitTest(this.startX, this.startY);
      if (obj) this.toggleObjectInSelection(obj);
      return;
    }

    // In region mode a click on a detected image grabs that image.
    const img = this.imageHitTest(this.startX, this.startY);
    if (img) {
      const { x, y, w, h, objId, inlineData, isMask } = img.box;
      // Selections made by clicking an image export as that image, not as a
      // vector wrapper around it.
      this.addSelection({
        page: this.pageNum, x, y, w, h,
        source: 'image',
        objId,
        inlineData,
        isMask,
      });
    }
  }

  addSelection(rect) {
    const sel = { id: this.nextId++, ...rect };
    this.selections.push(sel);
    this.activeId = sel.id;
    this.renderSelectionLayer();
    this.renderLibrary();
    this.renderObjectLayer();
    this.buildPreview(sel);
    this.downloadBtn.disabled = false;
    this.updateEditButton();
    if (sel.source !== 'image') this.refreshObjects();
    else this.renderObjectsPanel();
    return sel;
  }

  removeSelection(id) {
    const idx = this.selections.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const [sel] = this.selections.splice(idx, 1);
    if (sel.previewUrl) URL.revokeObjectURL(sel.previewUrl);
    if (this.activeId === id) this.activeId = null;
    this.downloadBtn.disabled = this.activeId === null;
    this.renderSelectionLayer();
    this.renderLibrary();
  }

  setActive(id) {
    this.activeId = id;
    this.downloadBtn.disabled = id === null;
    this.updateEditButton();
    this.renderSelectionLayer();
    this.renderLibrary();
    this.renderObjectLayer();
    this.refreshObjectsIfNeeded();
  }

  /** Re-exports a selection after it was moved. */
  refreshSelection(id) {
    const sel = this.selections.find((s) => s.id === id);
    if (!sel) return;
    this.renderLibrary();
    this.buildPreview(sel);
  }

  renderSelectionLayer() {
    if (!this.selectionLayer) return;
    this.selectionLayer.innerHTML = '';

    this.selections.forEach((sel, i) => {
      if (sel.page !== this.pageNum) return;
      const el = document.createElement('div');
      el.className = 'selection-rect';
      if (sel.id === this.activeId) el.classList.add('active');
      el.style.left = this.ptToPx(sel.x) + 'px';
      el.style.top = this.ptToPx(sel.y) + 'px';
      el.style.width = this.ptToPx(sel.w) + 'px';
      el.style.height = this.ptToPx(sel.h) + 'px';

      const tag = document.createElement('span');
      tag.className = 'selection-tag';
      tag.textContent = i + 1;
      el.appendChild(tag);

      this.selectionLayer.appendChild(el);
    });

    const active = this.selections.find((s) => s.id === this.activeId);
    if (active) {
      this.statusText.textContent =
        `Selection ${this.selections.indexOf(active) + 1}: ` +
        `${Math.round(active.w)} x ${Math.round(active.h)} pt`;
    } else if (this.selections.length) {
      this.statusText.textContent =
        `${this.selections.length} selection${this.selections.length > 1 ? 's' : ''}`;
    } else {
      this.statusText.textContent = 'Drag to select a region';
    }
  }

  // -------- SVG export via MuPDF --------

  /**
   * Loads MuPDF on first use. It carries a ~10 MB WebAssembly payload, so it is
   * imported lazily: viewing a PDF never pays for it, only exporting does.
   */
  getMu() {
    if (!this.muPromise) {
      this.muPromise = import('mupdf');
    }
    return this.muPromise;
  }

  async getMuDoc() {
    if (!this.muDocPromise) {
      this.muDocPromise = (async () => {
        const mupdf = await this.getMu();
        return mupdf.Document.openDocument(this.pdfBytes, 'application/pdf');
      })();
    }
    return this.muDocPromise;
  }

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

  // -------- Raster export (for images clicked on the page) --------

  /**
   * Resolves a decoded image from a page's object store. Images land there
   * while the operator list is built, but may not have arrived yet.
   */
  getImageObject(page, objId) {
    return new Promise((resolve, reject) => {
      try {
        if (page.objs.has(objId)) {
          resolve(page.objs.get(objId));
          return;
        }
        page.objs.get(objId, resolve);
        setTimeout(() => reject(new Error(`Timed out reading image ${objId}`)), 15000);
      } catch (err) {
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
    const page = await this.pdfDoc.getPage(sel.page);
    const viewport = page.getViewport({ scale: targetScale });
    const full = document.createElement('canvas');
    full.width = Math.ceil(viewport.width);
    full.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;

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
    const page = await this.pdfDoc.getPage(sel.page);

    let canvas = null;
    try {
      const img = sel.inlineData
        ? sel.inlineData
        : await this.getImageObject(page, sel.objId);
      canvas = this.imageToCanvas(img, !!sel.isMask);
    } catch (err) {
      console.warn('Native image read failed, rendering the region instead:', err);
      // Render at the image's own pixel density so nothing is thrown away.
      const scale = Math.min(8, Math.max(2, 300 / 72));
      canvas = await this.rasterizeRegion(sel, scale);
    }

    const blob = await this.canvasToBlob(canvas, 'image/png');
    return { blob, width: canvas.width, height: canvas.height };
  }

  /**
   * Renders a whole page to SVG once and caches it as a DOM element. This backs
   * the object index and any export that has to filter individual objects.
   */
  getPageSvg(pageNum) {
    if (!this.pageSvgCache.has(pageNum)) {
      const job = (async () => {
        const text = await this.muSvg(pageNum, null);
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const root = doc.documentElement;
        if (!root || root.tagName === 'parsererror') {
          throw new Error('Could not parse the page SVG');
        }
        return root;
      })();
      this.pageSvgCache.set(pageNum, job);
    }
    return this.pageSvgCache.get(pageNum);
  }

  /**
   * Drops embedded rasters that fall entirely outside the crop. PDF.js renders
   * the whole page, and with data: URIs every image on the page would other-
   * wise ride along in each crop as a base64 payload.
   *
   * Geometry is compared in screen space, which is the one coordinate system
   * both the root's viewBox mapping and each element's transform chain agree
   * on. The element must be in the document for the browser to resolve those.
   */
  pruneOffCanvasImages(svgElement, crop) {
    const images = svgElement.querySelectorAll('image');
    if (!images.length) return 0;

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

      for (const el of [...images]) {
        let box;
        try {
          const bbox = el.getBBox();
          const ctm = el.getScreenCTM();
          if (!ctm || !bbox.width || !bbox.height) continue;
          const pts = [
            toScreen(ctm, bbox.x, bbox.y),
            toScreen(ctm, bbox.x + bbox.width, bbox.y),
            toScreen(ctm, bbox.x, bbox.y + bbox.height),
            toScreen(ctm, bbox.x + bbox.width, bbox.y + bbox.height),
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
    } finally {
      holder.remove();
    }
    return removed;
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
      this.pruneOffCanvasImages(root, sel);
    }

    // Tag in document order. Generation is deterministic for a given page,
    // box and text mode, so these ids are stable across rebuilds.
    root.querySelectorAll(DRAWABLE_SELECTOR)
      .forEach((el, i) => el.setAttribute(EDIT_ATTR, String(i)));
    return root;
  }

  /** Builds the SVG string for one selection, with edits applied. */
  async buildSvg(sel) {
    const root = await this.buildSvgDom(sel);

    for (const id of sel.deletedIds || []) {
      const el = root.querySelector(`[${EDIT_ATTR}="${id}"]`);
      if (el) el.remove();
    }
    for (const el of root.querySelectorAll(`[${EDIT_ATTR}]`)) {
      el.removeAttribute(EDIT_ATTR);
    }

    let svgString = new XMLSerializer().serializeToString(root);
    try {
      svgString = svgOptimize(svgString, {
        plugins: ['preset-default', 'removeOffCanvasPaths'],
      }).data;
    } catch (svgoErr) {
      console.warn('SVGO optimization failed, using raw SVG:', svgoErr);
    }
    return svgString;
  }

  /**
   * Generates the export for a selection and stores it on the selection so the
   * library shows the real SVG rather than a raster approximation.
   */
  async buildPreview(sel) {
    const token = (sel.previewToken || 0) + 1;
    sel.previewToken = token;
    sel.previewState = 'pending';
    this.renderLibrary();

    try {
      let blob;
      if (sel.source === 'image') {
        const raster = await this.buildRaster(sel);
        blob = raster.blob;
        sel.format = 'png';
        sel.pixelWidth = raster.width;
        sel.pixelHeight = raster.height;
        sel.blob = blob;
      } else {
        const svgString = await this.buildSvg(sel);
        blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        sel.format = 'svg';
        sel.svgString = svgString;
        sel.blob = blob;
      }
      // A newer build started while this one was running.
      if (sel.previewToken !== token) return;

      if (sel.previewUrl) URL.revokeObjectURL(sel.previewUrl);
      sel.previewUrl = URL.createObjectURL(blob);
      sel.byteSize = blob.size;
      sel.previewState = 'ready';
    } catch (err) {
      console.error('Preview failed:', err);
      if (sel.previewToken !== token) return;
      sel.previewState = 'error';
      sel.previewError = err.message;
    }
    this.renderLibrary();
  }

  fileNameFor(sel) {
    const ext = sel.format === 'png' ? 'png' : 'svg';
    return `page-${sel.page}-selection-${this.selections.indexOf(sel) + 1}.${ext}`;
  }

  saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  downloadSelection(sel) {
    if (!sel.blob) return;
    this.saveBlob(sel.blob, this.fileNameFor(sel));
  }

  async handleDownload() {
    const sel = this.selections.find((s) => s.id === this.activeId);
    if (!sel) return;

    const originalText = this.downloadBtn.textContent;
    this.downloadBtn.textContent = 'Generating...';
    this.downloadBtn.disabled = true;
    try {
      if (!sel.blob) await this.buildPreview(sel);
      this.downloadSelection(sel);
      this.statusText.textContent =
        `${(sel.format || 'svg').toUpperCase()} downloaded!`;
    } catch (err) {
      console.error('SVG export error:', err);
      alert('Error generating SVG: ' + err.message);
    } finally {
      this.downloadBtn.textContent = originalText;
      this.downloadBtn.disabled = false;
    }
  }

  async exportAll() {
    if (!this.selections.length) return;

    const originalText = this.exportAllBtn.textContent;
    this.exportAllBtn.disabled = true;
    try {
      // Make sure every selection has been built before packing anything.
      const files = {};
      const used = new Set();
      for (const sel of this.selections) {
        this.exportAllBtn.textContent =
          `Preparing ${this.selections.indexOf(sel) + 1}/${this.selections.length}...`;
        if (!sel.blob) await this.buildPreview(sel);
        if (!sel.blob) continue;

        // Keep names unique even if two selections would collide.
        let name = this.fileNameFor(sel);
        if (used.has(name)) {
          const dot = name.lastIndexOf('.');
          name = `${name.slice(0, dot)}-${sel.id}${name.slice(dot)}`;
        }
        used.add(name);
        files[name] = new Uint8Array(await sel.blob.arrayBuffer());
      }

      const names = Object.keys(files);
      if (!names.length) return;

      // A single file is more useful on its own than wrapped in an archive.
      if (names.length === 1) {
        this.saveBlob(new Blob([files[names[0]]]), names[0]);
        this.statusText.textContent = 'Exported 1 file';
        return;
      }

      this.exportAllBtn.textContent = 'Zipping...';
      const zipped = await new Promise((resolve, reject) => {
        // SVG is text and compresses well; PNG is already deflated, so asking
        // for more than level 0 on it would only cost time.
        const opts = {};
        for (const name of names) {
          opts[name] = [files[name], { level: name.endsWith('.png') ? 0 : 6 }];
        }
        zipAsync(opts, (err, data) => (err ? reject(err) : resolve(data)));
      });

      this.saveBlob(
        new Blob([zipped], { type: 'application/zip' }),
        `${this.pdfName}-selections.zip`);
      this.statusText.textContent =
        `Exported ${names.length} files as a zip`;
    } catch (err) {
      console.error('Export all failed:', err);
      alert('Error exporting: ' + err.message);
    } finally {
      this.exportAllBtn.textContent = originalText;
      this.exportAllBtn.disabled = false;
    }
  }

  clearLibrary() {
    for (const sel of this.selections) {
      if (sel.previewUrl) URL.revokeObjectURL(sel.previewUrl);
    }
    this.selections = [];
    this.activeId = null;
    this.nextId = 1;
    this.downloadBtn.disabled = true;
    this.renderSelectionLayer();
    this.renderLibrary();
  }

  // -------- Vector editor --------

  /**
   * Opens the selection in an editable view. The exported SVG is mounted live,
   * so the browser does the hit testing: clicking a shape selects that shape,
   * with no bounding-box arithmetic in between.
   */
  async openEditor(sel) {
    if (!sel || sel.source === 'image') return;

    this.editorSel = sel;
    this.editorDeleted = new Set(sel.deletedIds || []);
    this.editorSelected = null;
    this.editorUndo = [];

    this.editorOverlay.classList.remove('hidden');
    this.editorStage.innerHTML = '';
    this.editorList.innerHTML = '';
    this.editorTitle.textContent = 'Preparing…';

    let root;
    try {
      root = await this.buildSvgDom(sel);
    } catch (err) {
      this.editorTitle.textContent = 'Could not open: ' + err.message;
      return;
    }

    // Fit the stage rather than the original point size.
    root.removeAttribute('width');
    root.removeAttribute('height');
    root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    root.classList.add('editor-svg');

    this.editorRoot = root;
    this.editorStage.appendChild(root);
    this.editorTitle.textContent =
      `Page ${sel.page} · ${Math.round(sel.w)} × ${Math.round(sel.h)} pt`;

    this.editorItems = this.collectEditorItems(root);
    this.editorOnlyInView = this.editorInViewToggle.checked;
    this.applyEditorDeletions();
    this.renderEditorList();
  }

  /**
   * Describes every editable element in the mounted SVG, including whether it
   * actually falls inside the crop. MuPDF writes the whole page, so most of
   * what is in the document is off-canvas clutter the export discards anyway.
   */
  collectEditorItems(root) {
    const items = [];

    // The crop, in the root's own user units.
    const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const view = vb.length === 4 && vb.every(Number.isFinite)
      ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }
      : null;
    const rootCTM = root.getScreenCTM();
    const inv = rootCTM ? rootCTM.inverse() : null;

    for (const el of root.querySelectorAll(`[${EDIT_ATTR}]`)) {
      const id = el.getAttribute(EDIT_ATTR);

      let box = null;
      let inView = true;
      try {
        const bb = el.getBBox();
        const ctm = el.getScreenCTM();
        if (inv && ctm && (bb.width || bb.height)) {
          const m = inv.multiply(ctm);
          const pts = [
            [bb.x, bb.y], [bb.x + bb.width, bb.y],
            [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height],
          ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
          const xs = pts.map((q) => q[0]);
          const ys = pts.map((q) => q[1]);
          box = {
            x: Math.min(...xs), y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
          };
          if (view) {
            inView = box.x < view.x + view.w && box.x + box.w > view.x &&
                     box.y < view.y + view.h && box.y + box.h > view.y;
          }
        }
      } catch (err) {
        // Un-measurable: treat it as visible rather than hiding it from view.
      }
      const tag = el.tagName.replace(/^svg:/, '').toLowerCase();
      const type = tag === 'text' ? 'text' : tag === 'image' ? 'image' : 'vector';
      let label;
      if (type === 'text') {
        label = (el.textContent || '').trim().slice(0, 44) || 'Text';
      } else if (type === 'image') {
        label = `Image ${el.getAttribute('width') || '?'}×${el.getAttribute('height') || '?'}`;
      } else {
        const fill = el.getAttribute('fill');
        label = tag.charAt(0).toUpperCase() + tag.slice(1) +
          (fill && fill !== 'none' ? ` ${fill}` : '');
      }
      if (box && (box.w >= 1 || box.h >= 1)) {
        label += `  ${Math.round(box.w)}\u00d7${Math.round(box.h)}`;
      }
      items.push({ id, el, type, label, inView });
    }
    return items;
  }

  /** Items shown in the layer list, honouring the in-crop filter. */
  visibleEditorItems() {
    return this.editorOnlyInView
      ? this.editorItems.filter((i) => i.inView)
      : this.editorItems;
  }

  applyEditorDeletions() {
    for (const item of this.editorItems) {
      item.el.style.display = this.editorDeleted.has(item.id) ? 'none' : '';
    }
  }

  setEditorSelection(id) {
    this.editorSelected = id;
    for (const item of this.editorItems) {
      item.el.classList.toggle('is-selected', item.id === id);
    }
    for (const row of this.editorList.children) {
      row.classList.toggle('active', row.dataset.id === id);
    }
    const active = this.editorList.querySelector('.editor-row.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
    this.editorDeleteBtn.disabled = id === null;
  }

  toggleEditorDeleted(id) {
    if (this.editorDeleted.has(id)) {
      this.editorDeleted.delete(id);
    } else {
      this.editorDeleted.add(id);
      this.editorUndo.push(id);
    }
    this.applyEditorDeletions();
    this.renderEditorList();
  }

  undoEditorDelete() {
    const id = this.editorUndo.pop();
    if (id === undefined) return;
    this.editorDeleted.delete(id);
    this.applyEditorDeletions();
    this.renderEditorList();
  }

  renderEditorList() {
    this.editorList.innerHTML = '';
    const shown = this.visibleEditorItems();
    const live = shown.filter((i) => !this.editorDeleted.has(i.id));
    const hiddenByFilter = this.editorItems.length - shown.length;
    this.editorCount.textContent =
      `${live.length} of ${shown.length}` +
      (hiddenByFilter ? ` \u00b7 ${hiddenByFilter} off-crop` : '');
    this.editorUndoBtn.disabled = this.editorUndo.length === 0;

    for (const item of shown) {
      const gone = this.editorDeleted.has(item.id);
      const row = document.createElement('div');
      row.className = 'editor-row';
      row.dataset.id = item.id;
      if (gone) row.classList.add('is-deleted');
      if (item.id === this.editorSelected) row.classList.add('active');

      const kind = document.createElement('span');
      kind.className = `object-kind kind-${item.type}`;
      kind.textContent = item.type;

      const label = document.createElement('span');
      label.className = 'object-label';
      label.textContent = item.label;

      const del = document.createElement('button');
      del.className = 'link-btn' + (gone ? '' : ' danger');
      del.textContent = gone ? 'Restore' : 'Delete';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleEditorDeleted(item.id);
      });

      row.appendChild(kind);
      row.appendChild(label);
      row.appendChild(del);
      row.addEventListener('click', () => this.setEditorSelection(item.id));
      row.addEventListener('mouseenter', () => item.el.classList.add('is-hot'));
      row.addEventListener('mouseleave', () => item.el.classList.remove('is-hot'));
      this.editorList.appendChild(row);
    }

    this.setEditorSelection(this.editorSelected);
  }

  /** Commits the edits back onto the selection and re-exports. */
  closeEditor(save) {
    this.editorOverlay.classList.add('hidden');
    const sel = this.editorSel;
    this.editorSel = null;
    this.editorRoot = null;
    this.editorItems = [];
    this.editorStage.innerHTML = '';
    if (!save || !sel) return;

    sel.deletedIds = [...this.editorDeleted];
    this.renderLibrary();
    this.buildPreview(sel);
  }

  // -------- Library panel --------

  formatSize(bytes) {
    if (bytes === undefined) return '';
    return bytes < 1024
      ? `${bytes} B`
      : `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`;
  }

  renderLibrary() {
    if (!this.libraryList) return;

    this.libraryCount.textContent = this.selections.length;
    this.libraryEmpty.classList.toggle('hidden', this.selections.length > 0);
    this.exportAllBtn.disabled = this.selections.length === 0;
    this.clearAllBtn.disabled = this.selections.length === 0;

    this.libraryList.innerHTML = '';

    this.selections.forEach((sel, i) => {
      const item = document.createElement('div');
      item.className = 'library-item';
      if (sel.id === this.activeId) item.classList.add('active');

      const thumb = document.createElement('div');
      thumb.className = 'library-thumb';
      if (sel.previewState === 'ready') {
        const img = document.createElement('img');
        img.src = sel.previewUrl;
        img.alt = `Selection ${i + 1} preview`;
        thumb.appendChild(img);
      } else if (sel.previewState === 'error') {
        thumb.classList.add('thumb-error');
        thumb.textContent = 'Preview failed';
      } else {
        thumb.classList.add('thumb-pending');
        thumb.textContent = 'Rendering...';
      }

      const meta = document.createElement('div');
      meta.className = 'library-meta';
      const title = document.createElement('div');
      title.className = 'library-title';
      title.textContent = `${i + 1}. Page ${sel.page}`;
      const dims = document.createElement('div');
      dims.className = 'library-dims';
      dims.textContent =
        sel.pixelWidth
          ? `${sel.pixelWidth} x ${sel.pixelHeight} px`
          : `${Math.round(sel.w)} x ${Math.round(sel.h)} pt`;

      const kindLine = document.createElement('div');
      kindLine.className = 'library-dims';
      const kind = sel.source === 'image' ? 'PNG image' : 'SVG region';
      kindLine.textContent =
        kind + (sel.byteSize !== undefined ? ` - ${this.formatSize(sel.byteSize)}` : '');

      meta.appendChild(title);
      meta.appendChild(dims);
      meta.appendChild(kindLine);

      const actions = document.createElement('div');
      actions.className = 'library-actions';

      const dlBtn = document.createElement('button');
      dlBtn.className = 'link-btn';
      dlBtn.textContent = sel.source === 'image' ? 'PNG' : 'SVG';
      dlBtn.title = sel.source === 'image'
        ? 'Download this image at its native resolution'
        : 'Download this region as SVG';
      dlBtn.disabled = sel.previewState !== 'ready';
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadSelection(sel);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'link-btn danger';
      delBtn.textContent = 'Remove';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeSelection(sel.id);
      });

      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);
      meta.appendChild(actions);

      // Clicking an entry selects it, jumping to its page if needed.
      item.addEventListener('click', () => {
        this.activeId = sel.id;
        this.downloadBtn.disabled = false;
        if (sel.page !== this.pageNum) {
          this.goToPage(sel.page);
        } else {
          this.renderSelectionLayer();
        }
        this.renderLibrary();
      });

      item.appendChild(thumb);
      item.appendChild(meta);
      this.libraryList.appendChild(item);
    });
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const cropper = new PdfCropper();
  cropper.init();
});
