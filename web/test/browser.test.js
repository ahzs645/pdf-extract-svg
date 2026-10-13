import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync } from 'fflate';
import { fixturePdf } from './pdf-fixtures.js';

const fixture = {
  name: 'extraction-fixtures.pdf',
  mimeType: 'application/pdf',
  buffer: fixturePdf(),
};
let server, browser, base;

test.before(async () => {
  server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      ...(process.env.BROWSER_TEST_MODE === 'production' ? ['preview'] : []),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(Error(`Server did not start: ${output}`)),
      15000
    );
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) {
        base = match[0];
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}: ${output}`));
    });
  });
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const ended = once(server, 'exit');
    server.kill();
    await ended;
  }
});
async function app(t) {
  const page = await browser.newPage({
      viewport: { width: 1300, height: 1000 },
    }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) errors.push(msg.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  await page.route(
    /\/(?:src\/app\.js|assets\/index-[^/]+\.js)(?:\?.*)?$/,
    async (route) => {
      const response = await route.fetch(),
        body = await response.text();
      const instrumented =
        process.env.BROWSER_TEST_MODE === 'production'
          ? body.replace(
              /new ([\w$]+)\(\)\.init\(\)(?=\}\);)/,
              '(globalThis.testCropper = new $1()).init()'
            )
          : body.replace(
              'cropper.init();',
              'globalThis.testCropper = cropper; cropper.init();'
            );
      assert.notEqual(
        instrumented,
        body,
        'Application test hook must be installed'
      );
      await route.fulfill({ response, body: instrumented });
    }
  );
  await page.goto(base);
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'Browser should have no errors or warnings');
  });
  await page.locator('#file-input').setInputFiles(fixture);
  await page.waitForFunction(
    () =>
      testCropper.pdfDoc?.numPages === 4 &&
      !testCropper.pageRendering &&
      testCropper.pageImages.length === 1
  );
  return page;
}
async function go(page, num) {
  await page.locator('#page-input').fill(String(num));
  await page.locator('#page-input').press('Enter');
  await page.waitForFunction(
    (num) =>
      testCropper.pageNum === num &&
      !testCropper.pageRendering &&
      testCropper.pageInput.value === String(num),
    num
  );
}
async function clickImage(page, count) {
  await page.waitForFunction(() => testCropper.pageImages.length > 0);
  const box = await page.locator('.image-hotspot').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    (count) =>
      testCropper.selections.length === count &&
      testCropper.selections[count - 1].previewState === 'ready',
    count
  );
}
async function png(page, index, w, h, color) {
  const result = await page.evaluate(
    async ({ index, color }) => {
      const s = testCropper.selections[index],
        b = await createImageBitmap(s.blob),
        canvas = document.createElement('canvas');
      canvas.width = b.width;
      canvas.height = b.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(b, 0, 0);
      const pixels = ctx.getImageData(0, 0, b.width, b.height).data;
      let mismatches = 0;
      if (color)
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] !== color[0] ||
            pixels[i + 1] !== color[1] ||
            pixels[i + 2] !== color[2] ||
            pixels[i + 3] !== 255
          )
            mismatches++;
      return { width: b.width, height: b.height, mismatches, format: s.format };
    },
    { index, color }
  );
  assert.deepEqual(result, {
    width: w,
    height: h,
    mismatches: 0,
    format: 'png',
  });
}

test('native and inline images retain exact dimensions and colors; ZIP contains both', async (t) => {
  const page = await app(t);
  await clickImage(page, 1);
  await png(page, 0, 32, 24, [27, 135, 49]);
  await go(page, 2);
  await clickImage(page, 2);
  await png(page, 1, 2, 2, [45, 72, 190]);
  const downloading = page.waitForEvent('download');
  await page.locator('#export-all-btn').click();
  const download = await downloading;
  assert.equal(
    download.suggestedFilename(),
    'extraction-fixtures-selections.zip'
  );
  const bytes = await readFile(await download.path());
  const entries = unzipSync(bytes);
  assert.deepEqual(Object.keys(entries), [
    'page-1-selection-1.png',
    'page-2-selection-2.png',
  ]);
  assert.deepEqual(
    [...entries['page-1-selection-1.png'].slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  );
});

test('solid masks without image IDs crop the visible scan immediately', async (t) => {
  const page = await app(t);
  await go(page, 3);
  const start = Date.now();
  await clickImage(page, 1);
  assert.ok(Date.now() - start < 3000, 'No nonexistent-image timeout');
  const shape = await page.evaluate(() => {
    const s = testCropper.selections[0];
    return { id: s.objId, inline: s.inlineData };
  });
  assert.deepEqual(shape, { id: null, inline: null });
  await png(page, 0, 333, 250);
});

test('vector region, object filtering, editor deletion/undo and outlined text export', async (t) => {
  const page = await app(t);
  await go(page, 4);
  await page.evaluate(() =>
    testCropper.addSelection({ page: 4, x: 10, y: 15, w: 170, h: 130 })
  );
  await page.waitForFunction(
    () =>
      testCropper.selections[0].previewState === 'ready' &&
      testCropper.pageObjects.length >= 3
  );
  const text = await page.evaluate(() => testCropper.selections[0].svgString);
  assert.match(text, /<text/);
  assert.match(text, /Vector export/);
  await page.locator('#edit-btn').click();
  await page.waitForFunction(() => testCropper.editorItems.length >= 3);
  await page.evaluate(() => {
    const item = testCropper.editorItems.find((i) => i.type === 'vector');
    testCropper.setEditorSelection(item.id);
  });
  await page.locator('#editor-delete-btn').click();
  assert.equal(await page.evaluate(() => testCropper.editorDeleted.size), 1);
  await page.locator('#editor-undo-btn').click();
  assert.equal(await page.evaluate(() => testCropper.editorDeleted.size), 0);
  await page.locator('#editor-delete-btn').click();
  await page.locator('#editor-done-btn').click();
  await page.waitForFunction(
    () => testCropper.selections[0].previewState === 'ready'
  );
  assert.equal(
    await page.evaluate(() => testCropper.selections[0].deletedIds.length),
    1
  );
  await page.locator('#text-mode-toggle').check();
  await page.waitForFunction(
    () =>
      testCropper.selections[0].previewState === 'ready' &&
      !testCropper.selections[0].svgString.includes('<text')
  );
  await page.locator('#object-mode-btn').click();
  await page.waitForFunction(() => testCropper.pageObjects.length >= 3);
  await page.evaluate(() => {
    testCropper.clearLibrary();
    testCropper.toggleObjectInSelection(
      testCropper.pageObjects.find((o) => o.type === 'vector')
    );
  });
  await page.waitForFunction(
    () => testCropper.selections[0].previewState === 'ready'
  );
  const filtered = await page.evaluate(
    () => testCropper.selections[0].svgString
  );
  assert.doesNotMatch(filtered, /<text/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-btn').click();
  assert.match((await downloadPromise).suggestedFilename(), /\.svg$/);
});

test('switching PDF during an export cancels the old session and keeps the new app usable', async (t) => {
  const page = await app(t);
  await page.evaluate(() => {
    const c = testCropper;
    globalThis.oldSession = c.session;
    const original = c.rasterExporter.buildRaster.bind(c.rasterExporter);
    c.rasterExporter.buildRaster = async (s) => {
      await new Promise((resolve) => (globalThis.releaseOldExport = resolve));
      return original(s);
    };
    c.addSelection({ page: 1, source: 'image', ...c.pageImages[0] });
  });
  await page.waitForFunction(() => !!globalThis.releaseOldExport);
  await page
    .locator('#file-input')
    .setInputFiles({ ...fixture, name: 'replacement.pdf' });
  await page.waitForFunction(
    () =>
      testCropper.session !== oldSession &&
      testCropper.pdfDoc?.numPages === 4 &&
      !testCropper.pageRendering
  );
  await page.evaluate(() => releaseOldExport());
  await page.evaluate(() => oldSession.disposePromise);
  const cleanup = await page.evaluate(() => ({
    aborted: oldSession.signal.aborted,
    doc: oldSession.pdfDoc,
    bytes: oldSession.bytes,
    mu: oldSession.muDoc,
    selections: testCropper.selections.length,
  }));
  assert.deepEqual(cleanup, {
    aborted: true,
    doc: null,
    bytes: null,
    mu: null,
    selections: 0,
  });
  await clickImage(page, 1);
  await png(page, 0, 32, 24, [27, 135, 49]);
});

test('image object reads cancel promptly when their document closes', async (t) => {
  const page = await app(t);
  const result = await page.evaluate(async () => {
    const c = testCropper,
      old = c.session;
    const read = c.rasterExporter.getImageObject(
      { objs: { has: () => false, get() {} } },
      'missing'
    );
    const rejected = read.then(
      () => 'resolved',
      (error) => error.name
    );
    await old.dispose();
    return await rejected;
  });
  assert.equal(result, 'AbortError');
});

test('closed editors cannot remount a late SVG', async (t) => {
  const page = await app(t);
  await go(page, 4);
  const result = await page.evaluate(async () => {
    const c = testCropper,
      sel = { page: 4, x: 10, y: 10, w: 180, h: 140 };
    const build = c.buildSvgDom.bind(c);
    let release;
    c.buildSvgDom = async (s) => {
      await new Promise((resolve) => (release = resolve));
      return build(s);
    };
    const opening = c.openEditor(sel);
    c.closeEditor(false);
    release();
    await opening;
    return {
      root: c.editorRoot,
      children: c.editorStage.children.length,
      closed: c.editorOverlay.classList.contains('hidden'),
    };
  });
  assert.deepEqual(result, { root: null, children: 0, closed: true });
});

test('overlapping previews cannot serve different content than the visible preview', async (t) => {
  const page = await app(t);
  await go(page, 4);
  const result = await page.evaluate(async () => {
    const c = testCropper,
      releases = [];
    c.svgExporter.buildSvg = (s) =>
      new Promise((resolve) => releases.push({ resolve, x: s.x }));
    const selection = c.addSelection({ page: 4, x: 10, y: 10, w: 50, h: 50 });
    await Promise.resolve();
    await Promise.resolve();
    selection.x = 100;
    const latest = c.buildPreview(selection);
    await Promise.resolve();
    await Promise.resolve();
    const original = releases[0];
    const svg = (color) =>
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="50" height="50" fill="${color}"/></svg>`;
    releases[1].resolve(svg('blue'));
    await latest;
    original.resolve(svg('red'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      download: await selection.blob.text(),
      preview: await (await fetch(selection.previewUrl)).text(),
      positions: releases.map((r) => r.x),
      state: selection.previewState,
    };
  });
  assert.equal(result.download, result.preview);
  assert.match(result.download, /blue/);
  assert.deepEqual(result.positions, [10, 100]);
  assert.equal(result.state, 'ready');
});

test('a superseded page render cannot paint over the requested page', async (t) => {
  const page = await app(t);
  await page.evaluate(() => {
    const c = testCropper,
      render = c.session.render.bind(c.session);
    c.session.render = async (p, options) => {
      if (p.pageNumber === 2)
        await new Promise((resolve) => (globalThis.releasePage = resolve));
      return render(p, options);
    };
    const draw = c.ctx.drawImage.bind(c.ctx);
    globalThis.pageCommits = 0;
    c.ctx.drawImage = (...args) => {
      pageCommits++;
      draw(...args);
    };
    c.goToPage(2);
  });
  await page.waitForFunction(() => !!globalThis.releasePage);
  await page.evaluate(() => {
    testCropper.goToPage(4);
    releasePage();
  });
  await page.waitForFunction(
    () =>
      !testCropper.pageRendering &&
      testCropper.pageNum === 4 &&
      testCropper.pageInput.value === '4'
  );
  assert.equal(
    await page.evaluate(() => pageCommits),
    1,
    'Only the requested page should be committed'
  );
  const pixels = await page.evaluate(() => [
    ...testCropper.ctx.getImageData(45, 135, 1, 1).data,
  ]);
  assert.ok(
    pixels[0] > 150 && pixels[1] < 100 && pixels[2] < 100,
    `Expected page 4's red vector, got ${pixels}`
  );
});

test('replacing a document releases an opened MuPDF document and its worker', async (t) => {
  const page = await app(t);
  await go(page, 4);
  await page.evaluate(async () => {
    const c = testCropper;
    globalThis.replacedSession = c.session;
    const doc = await c.session.getMuDoc(),
      destroy = doc.destroy.bind(doc);
    globalThis.muDestroyed = 0;
    doc.destroy = () => {
      muDestroyed++;
      destroy();
    };
    await c.loadPDF(new Uint8Array(await c.session.bytes.slice()), 'new-file');
  });
  await page.waitForFunction(
    () =>
      testCropper.pdfDoc?.numPages === 4 &&
      !testCropper.pageRendering &&
      testCropper.pageImages.length === 1
  );
  const cleanup = await page.evaluate(() => ({
    count: muDestroyed,
    oldMu: replacedSession.muDoc,
    oldBytes: replacedSession.bytes,
    caches: Object.values(replacedSession.caches).map((c) => c.size),
  }));
  assert.deepEqual(cleanup, {
    count: 1,
    oldMu: null,
    oldBytes: null,
    caches: [0, 0, 0, 0],
  });
  await clickImage(page, 1);
  await png(page, 0, 32, 24, [27, 135, 49]);
});

test('slow file reads cannot replace a more recently opened PDF', async (t) => {
  const page = await app(t);
  const result = await page.evaluate(async () => {
    const c = testCropper,
      bytes = c.session.bytes.slice();
    let release;
    const slow = c.loadFile({
      name: 'older.pdf',
      arrayBuffer: () => new Promise((resolve) => (release = resolve)),
    });
    await c.loadFile({
      name: 'latest.pdf',
      arrayBuffer: async () => bytes.slice().buffer,
    });
    release(bytes.slice().buffer);
    await slow;
    return {
      name: c.pdfName,
      pages: c.pdfDoc.numPages,
      rendering: c.pageRendering,
    };
  });
  assert.deepEqual(result, { name: 'latest', pages: 4, rendering: false });
  await clickImage(page, 1);
  await png(page, 0, 32, 24, [27, 135, 49]);
});

test('zoom and raster highlighting preserve the native export', async (t) => {
  const page = await app(t);
  await clickImage(page, 1);
  const before = await page.evaluate(() => ({
    x: testCropper.selections[0].x,
    y: testCropper.selections[0].y,
    w: testCropper.selections[0].w,
    h: testCropper.selections[0].h,
  }));
  // Read through a small test canvas so polling does not change the viewer's
  // GPU-backed canvas behavior or trigger Chromium's readback warning.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    globalThis.viewerPixel = (x, y) => {
      ctx.drawImage(testCropper.canvas, x, y, 1, 1, 0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data;
    };
  });
  await page.locator('#tint-toggle').check();
  await page.waitForFunction(
    () => !testCropper.pageRendering && viewerPixel(120, 120)[0] > 50
  );
  await page.evaluate(() => testCropper.zoomBy(2));
  await page.waitForFunction(
    () =>
      !testCropper.pageRendering &&
      testCropper.canvas.width === 600 &&
      testCropper.renderedScale === 3
  );
  const after = await page.evaluate(() => ({
    x: testCropper.selections[0].x,
    y: testCropper.selections[0].y,
    w: testCropper.selections[0].w,
    h: testCropper.selections[0].h,
  }));
  assert.deepEqual(after, before);
  await png(page, 0, 32, 24, [27, 135, 49]);
  await page.locator('#tint-toggle').uncheck();
  await page.waitForFunction(
    () => !testCropper.pageRendering && viewerPixel(240, 240)[0] === 27
  );
});

test('size breakdown opens on demand, reports SVG and image types, and refreshes after edits', async (t) => {
  const page = await app(t);
  await page.evaluate(() =>
    testCropper.addSelection({ page: 1, x: 10, y: 10, w: 180, h: 170 })
  );
  await page.waitForFunction(
    () => testCropper.selections[0].previewState === 'ready'
  );
  assert.equal(
    await page.evaluate(() => testCropper.selections[0].sizeBreakdown),
    null,
    'Analysis should be deferred until requested'
  );
  await page.locator('.size-breakdown summary').click();
  await page.waitForFunction(() => !!testCropper.selections[0].sizeBreakdown);
  const report = await page.evaluate(() => ({
    report: testCropper.selections[0].sizeBreakdown,
    blobSize: testCropper.selections[0].blob.size,
    id: testCropper.activeId,
  }));
  assert.equal(report.report.totalBytes, report.blobSize);
  assert.equal(
    report.report.categories.reduce((sum, g) => sum + g.bytes, 0),
    report.blobSize
  );
  assert.ok(report.report.categories.find((g) => g.id === 'vectors').count > 0);
  assert.ok(report.report.categories.find((g) => g.id === 'images').count > 0);
  assert.ok(report.report.categories.find((g) => g.id === 'text').count > 0);
  await page.evaluate(() => testCropper.renderLibrary());
  assert.equal(await page.locator('.size-breakdown').getAttribute('open'), '');
  assert.equal(await page.evaluate(() => testCropper.activeId), report.id);
  const previous = await page.evaluate(
    () => testCropper.selections[0].sizeBreakdown
  );
  await page.locator('#text-mode-toggle').check();
  await page.waitForFunction(
    () =>
      testCropper.selections[0].previewState === 'ready' &&
      testCropper.selections[0].sizeBreakdown?.categories.find(
        (g) => g.id === 'text'
      ).count === 0
  );
  const updated = await page.evaluate(
    () => testCropper.selections[0].sizeBreakdown
  );
  assert.notDeepEqual(updated, previous);
  assert.ok(
    updated.categories.find((g) => g.id === 'vectors').count >
      previous.categories.find((g) => g.id === 'vectors').count
  );
  assert.equal(await page.locator('.size-breakdown').getAttribute('open'), '');
});

test('PNG selections show their actual compressed file size', async (t) => {
  const page = await app(t);
  await clickImage(page, 1);
  await page.locator('.size-breakdown summary').click();
  await page.waitForFunction(() => !!testCropper.selections[0].sizeBreakdown);
  const result = await page.evaluate(() => ({
    report: testCropper.selections[0].sizeBreakdown,
    bytes: testCropper.selections[0].blob.size,
  }));
  assert.equal(result.report.totalBytes, result.bytes);
  assert.equal(result.report.categories.length, 1);
  assert.equal(result.report.categories[0].label, 'PNG image');
  assert.match(
    await page.locator('[data-size-type="images"]').innerText(),
    /100.0%/
  );
  await page.locator('.size-breakdown summary').click();
  assert.equal(
    await page.locator('.size-breakdown').getAttribute('open'),
    null
  );
});

test('Trim hidden content crops image pixels and can be turned off again', async (t) => {
  const page = await app(t);
  await page.evaluate(() =>
    testCropper.addSelection({ page: 1, x: 60, y: 65, w: 40, h: 30 })
  );
  await page.waitForFunction(
    () => testCropper.selections[0].previewState === 'ready'
  );
  const before = await page.evaluate(() => testCropper.selections[0].svgString);
  await page.locator('#trim-hidden-toggle').check();
  await page.waitForFunction(
    () =>
      testCropper.selections[0].previewState === 'ready' &&
      !!testCropper.selections[0].trimReport
  );
  const result = await page.evaluate(async () => {
    const sel = testCropper.selections[0],
      doc = new DOMParser().parseFromString(sel.svgString, 'image/svg+xml');
    const el = doc.querySelector('image');
    const bitmap = await createImageBitmap(
      await (await fetch(el.getAttribute('href'))).blob()
    );
    const dimensions = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return { dimensions, report: sel.trimReport, svg: sel.svgString };
  });
  assert.deepEqual(result.dimensions, { w: 16, h: 12 });
  assert.equal(result.report.croppedImages, 1);
  assert.doesNotMatch(result.svg, /Infinity|NaN/);
  await page.locator('.size-breakdown summary').click();
  await page.waitForFunction(() => !!document.querySelector('.trim-report'));
  assert.match(
    await page.locator('.trim-report').innerText(),
    /1 images cropped/
  );
  await page.locator('#trim-hidden-toggle').uncheck();
  await page.waitForFunction(
    () =>
      testCropper.selections[0].previewState === 'ready' &&
      !testCropper.selections[0].trimReport
  );
  assert.equal(
    await page.evaluate(() => testCropper.selections[0].svgString),
    before
  );
});

test('physical vector cuts, nested clips, strokes and opaque occlusion preserve visible pixels', async (t) => {
  const page = await app(t);
  const results = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 20;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, 20, 20);
    const image = canvas.toDataURL();
    const cases = [
      {
        name: 'filled boundary',
        body: '<path fill="red" d="M-10 -10H30V30H-10Z"/>',
        cut: 1,
      },
      {
        name: 'stroke boundary',
        body: '<path fill="none" stroke="blue" stroke-width="4" stroke-linecap="round" d="M-10 10H30"/>',
        cut: 1,
      },
      {
        name: 'transformed clip with hole',
        body: '<defs><clipPath id="cut"><path clip-rule="evenodd" d="M0 0H20V20H0Z M5 5V15H15V5Z"/></clipPath></defs><g transform="translate(2 2)" clip-path="url(#cut)"><path fill="red" d="M-10 -10H30V30H-10Z"/></g>',
        cut: 1,
      },
      {
        name: 'bounding-box clip',
        body: '<defs><clipPath id="box" clipPathUnits="objectBoundingBox"><rect width=".5" height="1"/></clipPath></defs><path clip-path="url(#box)" transform="translate(2 2)" fill="red" d="M0 0H16V16H0Z"/>',
        cut: 1,
      },
      {
        name: 'partially clipped text',
        body: '<text x="2" y="12" font-size="12">A long text run</text>',
        preserved: 1,
      },
      {
        name: 'covered image',
        body: `<image width="20" height="20" href="${image}"/><rect width="20" height="20" fill="red"/>`,
        removed: 1,
      },
      {
        name: 'partially covered image',
        body: `<image width="20" height="20" href="${image}"/><rect width="10" height="20" fill="red"/>`,
        cropped: 1,
      },
      {
        name: 'transparent overlay',
        body: `<image width="20" height="20" href="${image}"/><rect width="20" height="20" fill="red" opacity=".5"/>`,
        removed: 0,
      },
      {
        name: 'invisible overlay',
        body: `<image width="20" height="20" href="${image}"/><g style="display:none"><rect width="20" height="20" fill="red"/></g>`,
        removed: 0,
      },
      {
        name: 'nested effect inside clip definition',
        body: `<defs><clipPath id="inner"><rect width="10" height="20"/></clipPath><clipPath id="outer"><g clip-path="url(#inner)"><rect width="20" height="20"/></g></clipPath></defs><g clip-path="url(#outer)"><image width="20" height="20" href="${image}"/></g>`,
        preserved: 1,
      },
      {
        name: 'empty clip',
        body: `<defs><clipPath id="empty"/></defs><g clip-path="url(#empty)"><image width="20" height="20" href="${image}"/></g>`,
        removed: 1,
      },
      {
        name: 'curved image clip',
        body: `<defs><clipPath id="circle"><circle cx="10" cy="10" r="8"/></clipPath></defs><g clip-path="url(#circle)"><image width="20" height="20" href="${image}"/></g>`,
        preserved: 1,
      },
      {
        name: 'gradient boundary',
        body: '<defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><path fill="url(#paint)" d="M-10 -10H30V30H-10Z"/>',
        preserved: 1,
      },
    ];
    const exporter = testCropper.svgExporter,
      original = exporter.buildSvgDom.bind(exporter);
    async function pixels(svg) {
      const url = URL.createObjectURL(
        new Blob([svg], { type: 'image/svg+xml' })
      );
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 80;
        const context = c.getContext('2d');
        context.drawImage(img, 0, 0, 80, 80);
        return context.getImageData(0, 0, 80, 80).data;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const results = [];
    try {
      for (const item of cases) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${item.body}</svg>`;
        exporter.buildSvgDom = async () =>
          new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        const before = await exporter.buildSvg({ page: 1 });
        let report;
        const after = await exporter.buildSvg(
          { page: 1 },
          { trimHidden: true, onTrim: (r) => (report = r) }
        );
        const a = await pixels(before),
          b = await pixels(after);
        let changed = 0,
          maxDifference = 0;
        for (let i = 0; i < a.length; i += 4) {
          let difference = 0;
          for (let j = 0; j < 4; j++)
            difference = Math.max(difference, Math.abs(a[i + j] - b[i + j]));
          if (difference > 1) changed++;
          maxDifference = Math.max(maxDifference, difference);
        }
        results.push({
          ...item,
          body: undefined,
          report,
          changed,
          maxDifference,
          hasImage: after.includes('<image'),
          before,
          after,
        });
      }
    } finally {
      exporter.buildSvgDom = original;
    }
    return results;
  });
  for (const result of results) {
    assert.equal(
      result.changed,
      0,
      `${result.name}: visible pixels changed (max ${result.maxDifference})`
    );
    if (result.cut !== undefined)
      assert.equal(result.report.trimmedVectors, result.cut, result.name);
    if (result.removed !== undefined)
      assert.equal(result.report.removedObjects, result.removed, result.name);
    if (result.cropped !== undefined)
      assert.equal(result.report.croppedImages, result.cropped, result.name);
    if (result.preserved !== undefined)
      assert.equal(
        result.report.preservedObjects,
        result.preserved,
        result.name
      );
    if (result.name === 'covered image' || result.name === 'empty clip')
      assert.equal(result.hasImage, false, result.name);
    assert.doesNotMatch(result.after, /Infinity|NaN/);
  }
});

test('unused definition chains are removed while live nested definitions survive', async (t) => {
  const page = await app(t);
  const result = await page.evaluate(() => {
    const root = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="live"><defs><path id="nested" d="M0 0h10v10z"/></defs></g><g id="dead-a"><use href="#dead-b"/></g><g id="dead-b"><use href="#dead-a"/></g></defs><use href="#nested"/></svg>`,
      'image/svg+xml'
    ).documentElement;
    const removed = testCropper.svgExporter.pruneUnusedDefs(root);
    return {
      removed,
      ids: [...root.querySelectorAll('[id]')].map((el) => el.id),
    };
  });
  assert.deepEqual(result, { removed: 2, ids: ['live', 'nested'] });
});

test('superseding a trim export releases its temporary SVG and commits the latest settings', async (t) => {
  const page = await app(t);
  const result = await page.evaluate(async () => {
    const c = testCropper;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">${'<path fill="red" d="M-10 -10H30V30H-10Z"/>'.repeat(600)}</svg>`;
    c.svgExporter.buildSvgDom = async () =>
      new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
    const sel = c.addSelection({ page: 1, x: 10, y: 10, w: 20, h: 20 });
    await c.previewStore.ensureReady(sel);
    c.trimHidden = true;
    const older = c.buildPreview(sel);
    await new Promise((resolve) => setTimeout(resolve, 20));
    c.trimHidden = false;
    const latest = c.buildPreview(sel);
    await Promise.all([older, latest]);
    return {
      state: sel.previewState,
      trim: sel.trimReport,
      pending: c.previewStore.jobs.size,
      holders: document.querySelectorAll('body > div[style*="-20000px"]')
        .length,
    };
  });
  assert.deepEqual(result, {
    state: 'ready',
    trim: null,
    pending: 0,
    holders: 0,
  });
});

test(
  'last-page logo in supplied PDF exports without warnings',
  { skip: !process.env.PDF_REGRESSION_PATH },
  async (t) => {
    const page = await app(t);
    await page
      .locator('#file-input')
      .setInputFiles(process.env.PDF_REGRESSION_PATH);
    await page.waitForFunction(
      () => testCropper.pdfDoc?.numPages === 97 && !testCropper.pageRendering
    );
    await go(page, 97);
    await page.waitForFunction(() => testCropper.pageImages.length === 3);
    const start = Date.now();
    await clickImage(page, 1);
    assert.ok(Date.now() - start < 3000);
    await png(page, 0, 644, 468);
    const expected = process.env.PDF_REGRESSION_PNG
      ? await readFile(process.env.PDF_REGRESSION_PNG)
      : null;
    const downloading = page.waitForEvent('download');
    await page.locator('#download-btn').click();
    const actual = await readFile(await (await downloading).path());
    if (expected) assert.deepEqual(actual, expected);
  }
);
