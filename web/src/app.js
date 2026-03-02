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
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { optimize as svgOptimize } from 'svgo/browser';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

class PdfCropper {
  constructor() {
    // PDF state
    this.pdfDoc = null;
    this.pageNum = 1;
    this.pageRendering = false;
    this.pageNumPending = null;
    this.scale = 1.5;

    // Selection state
    this.isDragging = false;
    this.isMoving = false;
    this.startX = 0;
    this.startY = 0;
    this.moveOffsetX = 0;
    this.moveOffsetY = 0;
    this.selectionRect = null; // {x, y, w, h} in canvas pixels
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
    this.selectionBox = document.getElementById('selection-box');

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

    // Download
    this.downloadBtn.addEventListener('click', () => this.handleDownload());

    // Selection (mouse)
    this.container.addEventListener('mousedown', (e) => this.onPointerDown(e));
    window.addEventListener('mousemove', (e) => this.onPointerMove(e));
    window.addEventListener('mouseup', (e) => this.onPointerUp(e));

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!this.pdfDoc) return;
      if (document.activeElement === this.pageInput) return;

      if (e.key === 'ArrowLeft') {
        this.goToPage(this.pageNum - 1);
      } else if (e.key === 'ArrowRight') {
        this.goToPage(this.pageNum + 1);
      } else if (e.key === 'Escape') {
        this.clearSelection();
      }
    });
  }

  // -------- File loading --------

  loadFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const data = new Uint8Array(event.target.result);
      this.loadPDF(data);
    };
    reader.readAsArrayBuffer(file);
  }

  async loadPDF(data) {
    try {
      this.pdfDoc = await pdfjsLib.getDocument(data).promise;
      this.pageNum = 1;

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
    this.clearSelection();

    try {
      const page = await this.pdfDoc.getPage(num);
      const viewport = page.getViewport({ scale: this.scale });

      this.canvas.width = viewport.width;
      this.canvas.height = viewport.height;

      await page.render({ canvasContext: this.ctx, viewport }).promise;

      this.pageRendering = false;
      this.pageInput.value = num;

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

  // -------- Selection --------

  getContainerPos(e) {
    const rect = this.container.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  isInsideSelection(px, py) {
    if (!this.selectionRect) return false;
    const { x, y, w, h } = this.selectionRect;
    return px >= x && px <= x + w && py >= y && py <= y + h;
  }

  onPointerDown(e) {
    if (!this.pdfDoc || e.button !== 0) return;
    const pos = this.getContainerPos(e);

    // If clicking inside an existing selection, start moving it
    if (this.isInsideSelection(pos.x, pos.y)) {
      this.isMoving = true;
      this.moveOffsetX = pos.x - this.selectionRect.x;
      this.moveOffsetY = pos.y - this.selectionRect.y;
      this.container.style.cursor = 'move';
      e.preventDefault();
      return;
    }

    // Otherwise, start a new selection
    this.isDragging = true;
    this.startX = pos.x;
    this.startY = pos.y;

    this.selectionBox.style.left = pos.x + 'px';
    this.selectionBox.style.top = pos.y + 'px';
    this.selectionBox.style.width = '0px';
    this.selectionBox.style.height = '0px';
    this.selectionBox.style.display = 'block';
    this.downloadBtn.disabled = true;
    e.preventDefault();
  }

  onPointerMove(e) {
    if (this.isMoving && this.selectionRect) {
      const pos = this.getContainerPos(e);
      let newX = pos.x - this.moveOffsetX;
      let newY = pos.y - this.moveOffsetY;

      // Constrain to canvas bounds
      newX = Math.max(0, Math.min(newX, this.canvas.width - this.selectionRect.w));
      newY = Math.max(0, Math.min(newY, this.canvas.height - this.selectionRect.h));

      this.selectionRect.x = newX;
      this.selectionRect.y = newY;
      this.updateSelectionBox();
      return;
    }

    if (!this.isDragging) {
      if (this.selectionRect) {
        const pos = this.getContainerPos(e);
        this.container.style.cursor = this.isInsideSelection(pos.x, pos.y) ? 'move' : 'crosshair';
      }
      return;
    }

    const pos = this.getContainerPos(e);
    const width = Math.abs(pos.x - this.startX);
    const height = Math.abs(pos.y - this.startY);
    const left = Math.min(this.startX, pos.x);
    const top = Math.min(this.startY, pos.y);

    this.selectionBox.style.left = left + 'px';
    this.selectionBox.style.top = top + 'px';
    this.selectionBox.style.width = width + 'px';
    this.selectionBox.style.height = height + 'px';
  }

  onPointerUp(e) {
    if (this.isMoving) {
      this.isMoving = false;
      this.container.style.cursor = 'crosshair';
      return;
    }

    if (!this.isDragging) return;
    this.isDragging = false;

    const style = window.getComputedStyle(this.selectionBox);
    const w = parseFloat(style.width);
    const h = parseFloat(style.height);
    const x = parseFloat(style.left);
    const y = parseFloat(style.top);

    if (w > 5 && h > 5) {
      this.selectionRect = { x, y, w, h };
      this.downloadBtn.disabled = false;
      this.statusText.textContent =
        `Selected ${Math.round(w / this.scale)} x ${Math.round(h / this.scale)} pt`;
    } else {
      this.clearSelection();
    }
  }

  updateSelectionBox() {
    if (!this.selectionRect) return;
    this.selectionBox.style.left = this.selectionRect.x + 'px';
    this.selectionBox.style.top = this.selectionRect.y + 'px';
    this.selectionBox.style.width = this.selectionRect.w + 'px';
    this.selectionBox.style.height = this.selectionRect.h + 'px';
    this.selectionBox.style.display = 'block';
  }

  clearSelection() {
    this.selectionRect = null;
    this.selectionBox.style.display = 'none';
    this.downloadBtn.disabled = true;
    this.statusText.textContent = 'Drag to select a region';
  }

  // -------- SVG export via PDF.js SVGGraphics --------

  async handleDownload() {
    if (!this.selectionRect || !this.pdfDoc) return;

    const originalText = this.downloadBtn.textContent;
    this.downloadBtn.textContent = 'Generating SVG...';
    this.downloadBtn.disabled = true;

    try {
      const page = await this.pdfDoc.getPage(this.pageNum);

      // Get the operator list (raw PDF drawing commands)
      const operatorList = await page.getOperatorList();

      // Render full page to SVG using PDF.js SVGGraphics
      const svgGraphics = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
      svgGraphics.embedFonts = true;
      const pdfViewport = page.getViewport({ scale: 1.0 });
      const svgElement = await svgGraphics.getSVG(operatorList, pdfViewport);

      // Convert selection from display pixels to PDF points
      const pdfX = this.selectionRect.x / this.scale;
      const pdfY = this.selectionRect.y / this.scale;
      const pdfW = this.selectionRect.w / this.scale;
      const pdfH = this.selectionRect.h / this.scale;

      // Crop via viewBox
      svgElement.setAttribute('viewBox', `${pdfX} ${pdfY} ${pdfW} ${pdfH}`);
      svgElement.setAttribute('width', pdfW + 'pt');
      svgElement.setAttribute('height', pdfH + 'pt');

      // Serialize
      const serializer = new XMLSerializer();
      let svgString = serializer.serializeToString(svgElement);

      // Optimize with SVGO
      try {
        const result = svgOptimize(svgString, {
          plugins: [
            'preset-default',
            'removeOffCanvasPaths',
          ],
        });
        svgString = result.data;
      } catch (svgoErr) {
        console.warn('SVGO optimization failed, using raw SVG:', svgoErr);
      }

      // Download
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `page-${this.pageNum}-selection.svg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      this.statusText.textContent = 'SVG downloaded!';
    } catch (err) {
      console.error('SVG export error:', err);
      alert('Error generating SVG: ' + err.message);
    } finally {
      this.downloadBtn.textContent = originalText;
      this.downloadBtn.disabled = false;
    }
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const cropper = new PdfCropper();
  cropper.init();
});
