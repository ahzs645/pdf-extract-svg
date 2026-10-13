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
import { DocumentSession, isCancelled } from './document-session.js';
import { RasterExporter } from './raster-export.js';
import { SvgExporter } from './svg-export.js';
import { PreviewStore } from './preview-store.js';
import { EDIT_ATTR } from './geometry.js';
import { analyzeSvgSize, analyzeRasterSize, formatBytes } from './export-size.js';
import { zip as zipAsync } from 'fflate';

const DEFAULT_SCALE = 1.5;
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const ZOOM_STEP = 1.25;

export class PdfCropper {
  constructor() {
    // PDF state
    this.session = null;
    this.loadRequest = 0;
    this.renderTask = null;
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

    this.textAsOutlines = false;
    this.pdfName = 'document';
    this.rasterExporter = null;
    this.svgExporter = null;
    this.previewStore = new PreviewStore({
      build: (sel) => this.buildExport(sel),
      isActive: (sel) => !!this.session && !this.session.signal.aborted &&
        this.selections.includes(sel),
      onChange: () => { this.renderLibrary(); this.updateDownloadButton(); },
    });

    // Vector editor
    this.editorSel = null;
    this.editorRoot = null;
    this.editorItems = [];
    this.editorDeleted = new Set();
    this.editorSelected = null;
    this.editorUndo = [];

    // Detected images, so a figure can be grabbed with a single click.
    this.pageImages = [];
    this.showImages = true;

    // Per-page object index, for the objects panel and object mode.
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
      if (e.key === 'Enter' && this.pdfDoc) {
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
      if (this.session) this.svgExporter = new SvgExporter(this.session, this.textAsOutlines);
      this.refreshObjectsIfNeeded();
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

  async loadFile(file) {
    const request = ++this.loadRequest;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (request !== this.loadRequest) return;
      await this.loadPDF(data, file.name.replace(/\.pdf$/i, '') || 'document', request);
    } catch (error) {
      if (request !== this.loadRequest) return;
      console.error('PDF load failed:', error);
      alert('Error loading PDF: ' + error.message);
    }
  }

  createDocumentSession(data) {
    return new DocumentSession(data, {
      createLoadingTask: (bytes) => {
        // Each document owns its worker; disposing it cannot stop the next PDF.
        const port = new PdfWorker();
        const worker = new pdfjsLib.PDFWorker({ port });
        try {
          return {
            loadingTask: pdfjsLib.getDocument({
              data: bytes, worker,
              isOffscreenCanvasSupported: false,
              fontExtraProperties: true,
            }),
            disposeWorker: () => { worker.destroy(); port.terminate(); },
          };
        } catch (error) {
          worker.destroy();
          port.terminate();
          throw error;
        }
      },
    });
  }

  async loadPDF(data, name = 'document', request = ++this.loadRequest) {
    const previous = this.session;
    const session = this.createDocumentSession(data);
    this.session = session;
    this.pdfName = name;
    this.rasterExporter = new RasterExporter(session);
    this.svgExporter = new SvgExporter(session, this.textAsOutlines);
    clearTimeout(this.rerenderTimer);
    this.closeEditor(false);
    this.clearLibrary();
    this.pageNum = 1;
    this.pageNumPending = null;
    this.pageImages = [];
    this.pageObjects = [];
    this.isDragging = false;
    this.isMoving = false;
    this.selectionBox.style.display = 'none';
    this.renderImageLayer();
    this.renderObjectLayer();
    this.prevBtn.disabled = true;
    this.nextBtn.disabled = true;
    this.pageInput.disabled = true;
    this.statusText.textContent = 'Loading PDF…';

    try {
      // Cancel old renders and let their canvas work finish before reuse.
      await previous?.dispose();
      if (this.session !== session || request !== this.loadRequest) return;
      const doc = await session.ready();
      if (this.session !== session || request !== this.loadRequest) return;
      this.dropZone.classList.add('hidden');
      this.app.classList.remove('hidden');
      this.pageCountSpan.textContent = doc.numPages;
      this.pageInput.max = doc.numPages;
      this.statusText.textContent = 'Drag to select a region';
      await this.renderPage(1);
      if (this.session !== session) return;
      this.pageInput.disabled = false;
      this.updateNav();
    } catch (error) {
      if (this.session !== session || isCancelled(error, session)) return;
      await session.dispose();
      this.session = null;
      this.statusText.textContent = 'Could not load PDF';
      throw error;
    }
  }

  // -------- Page rendering --------

  async renderPage(num) {
    const session = this.session;
    if (!session || session.signal.aborted) return;
    const job = {};
    this.renderTask = job;
    this.pageRendering = true;
    try {
      const page = await session.getPage(num);
      const viewport = page.getViewport({ scale: this.scale });
      const scale = this.scale;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      const drawImage = ctx.drawImage.bind(ctx);
      if (this.tintRasters) {
        ctx.drawImage = (...args) => {
          drawImage(...args);
          let dx, dy, dw, dh;
          if (args.length === 3) {
            [, dx, dy] = args;
            dw = args[0].width; dh = args[0].height;
          } else if (args.length === 5) {
            [, dx, dy, dw, dh] = args;
          } else if (args.length === 9) {
            [, , , , , dx, dy, dw, dh] = args;
          }
          if (dw && dh) {
            ctx.save();
            ctx.fillStyle = 'rgba(255, 140, 0, 0.25)';
            ctx.fillRect(dx, dy, dw, dh);
            ctx.restore();
          }
        };
      }
      try {
        await session.render(page, { canvasContext: ctx, viewport });
      } finally {
        ctx.drawImage = drawImage;
      }
      if (this.session !== session || this.renderTask !== job || num !== this.pageNum) return;
      this.canvas.width = canvas.width;
      this.canvas.height = canvas.height;
      this.ctx.drawImage(canvas, 0, 0);
      this.renderedScale = scale;
      this.applyDisplayScale();
      this.pageInput.value = num;
      this.renderSelectionLayer();
      this.refreshImageLayer();
      this.refreshObjectsIfNeeded();
    } catch (error) {
      if (this.session === session && !isCancelled(error, session)) {
        console.error('Render error:', error);
        this.statusText.textContent = 'Could not render page: ' + error.message;
      }
    } finally {
      if (this.renderTask === job) {
        this.pageRendering = false;
        this.renderTask = null;
        if (this.pageNumPending !== null && this.session === session) {
          const pending = this.pageNumPending;
          this.pageNumPending = null;
          this.renderPage(pending);
        }
      }
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
    const doc = this.pdfDoc;
    this.prevBtn.disabled = !doc || this.pageNum <= 1;
    this.nextBtn.disabled = !doc || this.pageNum >= doc.numPages;
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

  detectImages(pageNum) {
    return this.rasterExporter.detectImages(pageNum);
  }

  async refreshImageLayer() {
    if (!this.pdfDoc) return;
    const session = this.session;
    const exporter = this.rasterExporter;
    const pageNum = this.pageNum;
    let boxes = [];
    try {
      boxes = await exporter.detectImages(pageNum);
    } catch (err) {
      if (this.session !== session || isCancelled(err, session)) return;
      console.warn('Image detection failed:', err);
    }
    // The user may have paged away while detection was running.
    if (this.session !== session || pageNum !== this.pageNum) return;
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

  buildPageObjects(pageNum) {
    return this.svgExporter.buildPageObjects(pageNum);
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
    const session = this.session;
    const exporter = this.svgExporter;
    const pageNum = this.pageNum;
    let objects = [];
    try {
      objects = await exporter.buildPageObjects(pageNum);
    } catch (err) {
      if (this.session !== session || isCancelled(err, session)) return;
      console.warn('Object index failed:', err);
    }
    if (this.session !== session || this.svgExporter !== exporter ||
        pageNum !== this.pageNum || !this.objectsNeeded()) return;
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
    this.updateDownloadButton();
    this.updateEditButton();
    if (sel.source !== 'image') this.refreshObjects();
    else this.renderObjectsPanel();
    return sel;
  }

  removeSelection(id) {
    const idx = this.selections.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const [sel] = this.selections.splice(idx, 1);
    this.previewStore.remove(sel);
    if (this.activeId === id) this.activeId = null;
    this.updateDownloadButton();
    this.updateEditButton();
    this.renderSelectionLayer();
    this.renderLibrary();
  }

  setActive(id) {
    this.activeId = id;
    this.updateDownloadButton();
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

  // -------- Export and preview --------

  buildSvgDom(sel) {
    return this.svgExporter.buildSvgDom(sel);
  }

  async buildExport(sel, rasterExporter = this.rasterExporter, svgExporter = this.svgExporter) {
    // Capture the exporter before awaiting; a new PDF owns new exporters.
    if (sel.source === 'image') {
      const raster = await rasterExporter.buildRaster(sel);
      return { blob: raster.blob, format: 'png',
        pixelWidth: raster.width, pixelHeight: raster.height, sizeBreakdown: null };
    }
    const svgString = await svgExporter.buildSvg(sel);
    return { blob: new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }),
      format: 'svg', svgString, pixelWidth: undefined, pixelHeight: undefined, sizeBreakdown: null };
  }

  buildPreview(sel) {
    const raster = this.rasterExporter, svg = this.svgExporter;
    return this.previewStore.buildPreview(sel, (snapshot) => this.buildExport(snapshot, raster, svg));
  }

  get pdfDoc() { return this.session?.pdfDoc || null; }

  updateDownloadButton() {
    if (!this.downloadBtn) return;
    const sel = this.selections.find((s) => s.id === this.activeId);
    this.downloadBtn.disabled = !sel || sel.previewState !== 'ready';
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
    if (!this.selections.includes(sel) || sel.previewState !== 'ready' || !sel.blob) return;
    this.saveBlob(sel.blob, this.fileNameFor(sel));
  }

  async handleDownload() {
    const sel = this.selections.find((s) => s.id === this.activeId);
    const session = this.session;
    if (!sel || !session) return;
    const originalText = this.downloadBtn.textContent;
    this.downloadBtn.textContent = 'Generating...';
    this.downloadBtn.disabled = true;
    try {
      await this.previewStore.ensureReady(sel);
      if (this.session !== session || !this.selections.includes(sel)) return;
      this.downloadSelection(sel);
      this.statusText.textContent = `${sel.format.toUpperCase()} downloaded!`;
    } catch (error) {
      if (isCancelled(error, session)) return;
      console.error('Export failed:', error);
      alert('Error generating export: ' + error.message);
    } finally {
      this.downloadBtn.textContent = originalText;
      this.updateDownloadButton();
    }
  }

  async exportAll() {
    if (!this.selections.length) return;

    const session = this.session;
    const selections = this.selections.slice();
    const pdfName = this.pdfName;
    const originalText = this.exportAllBtn.textContent;
    this.exportAllBtn.disabled = true;
    try {
      // Make sure every selection has been built before packing anything.
      const files = {};
      const used = new Set();
      for (const sel of selections) {
        this.exportAllBtn.textContent =
          `Preparing ${selections.indexOf(sel) + 1}/${selections.length}...`;
        const blob = await this.previewStore.ensureReady(sel);
        session.assertActive();
        if (this.session !== session) return;

        // Keep names unique even if two selections would collide.
        let name = this.fileNameFor(sel);
        if (used.has(name)) {
          const dot = name.lastIndexOf('.');
          name = `${name.slice(0, dot)}-${sel.id}${name.slice(dot)}`;
        }
        used.add(name);
        files[name] = new Uint8Array(await blob.arrayBuffer());
      }

      session.assertActive();
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

      session.assertActive();
      if (this.session !== session) return;
      this.saveBlob(
        new Blob([zipped], { type: 'application/zip' }),
        `${pdfName}-selections.zip`);
      this.statusText.textContent =
        `Exported ${names.length} files as a zip`;
    } catch (err) {
      if (isCancelled(err, session)) return;
      console.error('Export all failed:', err);
      alert('Error exporting: ' + err.message);
    } finally {
      this.exportAllBtn.textContent = originalText;
      this.exportAllBtn.disabled = this.selections.length === 0;
    }
  }

  clearLibrary() {
    for (const sel of this.selections) {
      this.previewStore.remove(sel);
    }
    this.selections = [];
    this.activeId = null;
    this.nextId = 1;
    this.downloadBtn.disabled = true;
    this.updateEditButton();
    this.renderSelectionLayer();
    this.renderObjectsPanel();
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

    const session = this.session;
    const token = (this.editorToken || 0) + 1;
    this.editorToken = token;
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
      if (this.editorToken !== token || this.session !== session || isCancelled(err, session)) return;
      this.editorTitle.textContent = 'Could not open: ' + err.message;
      return;
    }

    if (this.editorToken !== token || this.session !== session || this.editorSel !== sel) return;

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
    this.editorToken = (this.editorToken || 0) + 1;
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
    return formatBytes(bytes);
  }

  renderSizeBreakdown(sel) {
    const details = document.createElement('details');
    details.className = 'size-breakdown';
    details.open = !!sel.showSizeBreakdown;
    const summary = document.createElement('summary');
    summary.textContent = 'Size breakdown';
    summary.addEventListener('click', () => {
      sel.showSizeBreakdown = !details.open;
    });
    details.appendChild(summary);
    // Opening this control should not select the card or rebuild the Library.
    details.addEventListener('click', (event) => event.stopPropagation());

    const populate = () => {
      if (details.children.length > 1) return;
      // Analyze only when requested, and reuse it until the export changes.
      sel.sizeBreakdown ||= sel.format === 'svg'
        ? analyzeSvgSize(sel.svgString) : analyzeRasterSize(sel.blob);
      const { categories, totalBytes, images } = sel.sizeBreakdown;
      const table = document.createElement('table');
      table.className = 'size-table';
      const caption = document.createElement('caption');
      caption.textContent = `Export size: ${formatBytes(totalBytes)}`;
      table.appendChild(caption);
      const head = document.createElement('thead');
      const header = document.createElement('tr');
      for (const label of ['Type', 'Size', 'Share']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = label;
        header.appendChild(cell);
      }
      head.appendChild(header);
      table.appendChild(head);
      const body = document.createElement('tbody');
      for (const group of categories) {
        const row = document.createElement('tr');
        row.dataset.sizeType = group.id;
        const label = document.createElement('th');
        label.scope = 'row';
        label.textContent = group.label;
        const size = document.createElement('td');
        size.textContent = formatBytes(group.bytes);
        const share = document.createElement('td');
        share.textContent = `${totalBytes ? (100 * group.bytes / totalBytes).toFixed(1) : '0.0'}%`;
        row.append(label, size, share);
        body.appendChild(row);
      }
      table.appendChild(body);
      details.appendChild(table);
      const counts = document.createElement('p');
      counts.className = 'size-note';
      counts.textContent = categories.filter((group) => group.count > 0)
        .map((group) => `${group.count.toLocaleString()} ${
          { vectors: 'shapes', images: 'images', text: 'text runs', fonts: 'font rules' }[group.id] || group.label
        }`).join(' · ');
      details.appendChild(counts);
      if (images.length) {
        const list = document.createElement('ul');
        list.className = 'size-images';
        images.forEach((image, index) => {
          const item = document.createElement('li');
          item.textContent = `${index + 1}. ${image.type}: ${formatBytes(image.bytes)}`;
          list.appendChild(item);
        });
        details.appendChild(list);
      }
      const note = document.createElement('p');
      note.className = 'size-note';
      note.textContent = sel.format === 'svg'
        ? 'Includes embedded data and content hidden by clipping. Text outlines count as vectors.'
        : 'Size of the complete PNG file.';
      details.appendChild(note);
    };
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      sel.showSizeBreakdown = details.open;
      if (details.open) populate();
    });
    if (details.open) populate();
    return details;
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
        this.setActive(sel.id);
        if (sel.page !== this.pageNum) {
          this.goToPage(sel.page);
        } else {
          this.renderSelectionLayer();
        }
        this.renderLibrary();
      });

      item.appendChild(thumb);
      item.appendChild(meta);
      if (sel.previewState === 'ready') item.appendChild(this.renderSizeBreakdown(sel));
      this.libraryList.appendChild(item);
    });
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const cropper = new PdfCropper();
  cropper.init();
});
