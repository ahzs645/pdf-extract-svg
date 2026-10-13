import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeSvgSize,
  analyzeRasterSize,
  formatBytes,
} from '../src/export-size.js';

const size = (text) => Buffer.byteLength(text, 'utf8');
const groups = (report) =>
  Object.fromEntries(report.categories.map((group) => [group.id, group]));
const exactTotal = (report, svg) => {
  assert.equal(report.totalBytes, size(svg));
  assert.equal(
    report.categories.reduce((sum, group) => sum + group.bytes, 0),
    size(svg)
  );
};

test('breakdown accounts for the actual UTF-8 bytes of every export type', () => {
  const vector = '<path d="M0 0h10v10z"/>',
    image =
      '<image href="data:image/png;base64,AAAA" width="200" height="200"/>',
    text = '<text x="2"><tspan>British Columbia — 🌲</tspan></text>',
    fonts =
      '<style>@font-face{font-family:Demo;src:url("data:font/otf;base64,AAAA")}</style>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${fonts}</defs><g>${vector}${image}${text}</g></svg>`;
  const report = analyzeSvgSize(svg),
    byType = groups(report);
  exactTotal(report, svg);
  assert.equal(byType.vectors.bytes, size(vector));
  assert.equal(byType.images.bytes, size(image));
  assert.equal(byType.text.bytes, size(text));
  assert.equal(byType.fonts.bytes, size(fonts));
  assert.equal(byType.fonts.count, 1);
  assert.equal(byType.vectors.count, 1);
  assert.equal(byType.text.count, 1);
  assert.deepEqual(report.images, [
    { type: 'PNG', embedded: true, bytes: size(image) },
  ]);
});

test('includes full embedded images and vector definitions even when clipped or off canvas', () => {
  const image =
    '<image x="-500" y="-500" width="700" height="700" xlink:href="data:image/jpeg;base64,' +
    'A'.repeat(10000) +
    '"/>';
  const svg = `<svg viewBox="0 0 20 20"><defs><clipPath id="crop"><path d="M0 0h20v20z"/></clipPath></defs><g clip-path="url(#crop)">${image}<path d="M300 300h100v100z"/></g></svg>`;
  const report = analyzeSvgSize(svg);
  exactTotal(report, svg);
  assert.equal(groups(report).images.bytes, size(image));
  assert.equal(groups(report).vectors.count, 2);
  assert.equal(report.images[0].type, 'JPEG');
});

test('comments, quoted greater-than signs, namespaces and CDATA do not confuse type counts', () => {
  const svg = `<?xml version="1.0"?><s:svg xmlns:s="http://www.w3.org/2000/svg"><!-- <image href="fake"/> --><s:path aria-label="a > b" d="M1 1L2 2"/><s:style><![CDATA[/* @font-face fake */ @font-face{src:url("data:font/otf;base64,AAAA")}]]></s:style><s:text>été &amp; 🌲</s:text></s:svg>`;
  const report = analyzeSvgSize(svg);
  exactTotal(report, svg);
  assert.equal(groups(report).images.count, 0);
  assert.equal(groups(report).vectors.count, 1);
  assert.equal(groups(report).fonts.count, 1);
  assert.equal(groups(report).text.count, 1);
});

test('non-self-closing image bytes are counted once, including child metadata', () => {
  const image =
    '<image href="https://example.invalid/photo.jpg"><title>Photo</title></image>';
  const svg = '<svg>' + image + '</svg>',
    report = analyzeSvgSize(svg);
  exactTotal(report, svg);
  assert.equal(groups(report).images.bytes, size(image));
  assert.deepEqual(report.images, [
    { type: 'Linked image', embedded: false, bytes: size(image) },
  ]);
});

test('PNG breakdown equals the complete file size and sizes are readable above one megabyte', () => {
  const blob = new Blob([new Uint8Array(4000)], { type: 'image/png' }),
    report = analyzeRasterSize(blob);
  assert.equal(report.totalBytes, blob.size);
  assert.equal(report.categories[0].bytes, blob.size);
  assert.equal(report.categories[0].count, 1);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.00 MB');
  assert.equal(formatBytes(undefined), '');
});
