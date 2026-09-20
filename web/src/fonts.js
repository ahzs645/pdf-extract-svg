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

/**
 * Embedded-font support for SVG export.
 *
 * MuPDF's SVG writer keeps text as text, but it only *names* the font it drew
 * with -- `font-family="NNFDFE+Arial"` -- and a subset name like that matches
 * nothing on any machine, so every viewer silently falls back to a default
 * face. The glyphs are in the PDF; they just never make it into the SVG.
 *
 * This module carries them over. PDF.js has already parsed and repaired every
 * font on the page for its own rendering, handing back a valid OpenType file
 * per font, so the font program comes from there rather than from a second
 * parse of the PDF.
 *
 * One thing has to be fixed up first. PDF.js maps character codes onto private
 * -use code points (U+E000..) and builds the font's `cmap` around those, while
 * MuPDF writes real Unicode into the SVG. Looking up "A" in that font finds
 * nothing. `withUnicodeCmap` rewrites the `cmap` so the Unicode a reader would
 * copy out of the SVG reaches the same glyph, and leaves every other table
 * byte-for-byte alone.
 */

const HEAD_MAGIC_ADJUSTMENT = 0xb1b0afba;

/** Reads an sfnt table directory. */
function readTableDirectory(bytes) {
  if (bytes.length < 12) throw new Error('font is too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sfntVersion = dv.getUint32(0);
  // 'ttcf': a collection, which has no single table directory at offset 0.
  if (sfntVersion === 0x74746366) throw new Error('font collections are not supported');

  const numTables = dv.getUint16(4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const offset = dv.getUint32(rec + 8);
    const length = dv.getUint32(rec + 12);
    if (offset + length > bytes.length) throw new Error('truncated font table');
    tables.push({
      tag: String.fromCharCode(...bytes.subarray(rec, rec + 4)),
      data: bytes.subarray(offset, offset + length),
    });
  }
  return { sfntVersion, tables };
}

/** Reads one cmap subtable into a code point -> glyph id map. */
function readCmapSubtable(dv, base) {
  const map = new Map();
  const format = dv.getUint16(base);

  if (format === 0) {
    for (let code = 0; code < 256; code++) {
      const gid = dv.getUint8(base + 6 + code);
      if (gid) map.set(code, gid);
    }
  } else if (format === 4) {
    const segCount = dv.getUint16(base + 6) / 2;
    const endCodes = base + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let seg = 0; seg < segCount; seg++) {
      const end = dv.getUint16(endCodes + seg * 2);
      const start = dv.getUint16(startCodes + seg * 2);
      const delta = dv.getUint16(idDeltas + seg * 2);
      const rangeOffset = dv.getUint16(idRangeOffsets + seg * 2);
      if (start > end || start === 0xffff) continue;
      for (let code = start; code <= end; code++) {
        let gid;
        if (rangeOffset === 0) {
          gid = (code + delta) & 0xffff;
        } else {
          const at = idRangeOffsets + seg * 2 + rangeOffset + (code - start) * 2;
          if (at + 1 >= dv.byteLength) continue;
          gid = dv.getUint16(at);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) map.set(code, gid);
      }
    }
  } else if (format === 6) {
    const first = dv.getUint16(base + 6);
    const count = dv.getUint16(base + 8);
    for (let i = 0; i < count; i++) {
      const gid = dv.getUint16(base + 10 + i * 2);
      if (gid) map.set(first + i, gid);
    }
  } else if (format === 12) {
    const groups = dv.getUint32(base + 12);
    for (let i = 0; i < groups; i++) {
      const at = base + 16 + i * 12;
      const start = dv.getUint32(at);
      const end = dv.getUint32(at + 4);
      const startGid = dv.getUint32(at + 8);
      // Guard against a corrupt group claiming a huge range.
      for (let code = start; code <= end && code - start < 0x10000; code++) {
        map.set(code, startGid + (code - start));
      }
    }
  }
  return map;
}

/** Reads every subtable of a `cmap` table into one code point -> glyph map. */
function readCmap(cmapData) {
  const dv = new DataView(cmapData.buffer, cmapData.byteOffset, cmapData.byteLength);
  const numTables = dv.getUint16(2);
  const merged = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 4 + i * 8;
    const offset = dv.getUint32(rec + 4);
    if (offset >= cmapData.length) continue;
    for (const [code, gid] of readCmapSubtable(dv, offset)) {
      if (!merged.has(code)) merged.set(code, gid);
    }
  }
  return merged;
}

/** Splits a code point -> glyph map into format 4 segments. */
function toSegments(map) {
  const codes = [...map.keys()]
    .filter((code) => code >= 0 && code <= 0xffff)
    .sort((a, b) => a - b);

  const segments = [];
  for (const code of codes) {
    const gid = map.get(code);
    const delta = (gid - code) & 0xffff;
    const last = segments[segments.length - 1];
    if (last && last.delta === delta && code === last.end + 1) {
      last.end = code;
    } else {
      segments.push({ start: code, end: code, delta });
    }
  }
  // Format 4 requires a final segment ending at 0xFFFF.
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });
  return segments;
}

/**
 * Builds a `cmap` table with a single format 4 subtable, listed under both the
 * Windows BMP and the Unicode BMP encodings so that every shaper finds it.
 */
function buildCmap(map) {
  const segments = toSegments(map);
  const segCount = segments.length;
  const subtableLength = 16 + segCount * 8;
  const total = 4 + 8 * 2 + subtableLength;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const subtable = 4 + 8 * 2;

  dv.setUint16(0, 0); // version
  dv.setUint16(2, 2); // numTables
  dv.setUint16(4, 3); // Windows
  dv.setUint16(6, 1); // Unicode BMP
  dv.setUint32(8, subtable);
  dv.setUint16(12, 0); // Unicode
  dv.setUint16(14, 3); // BMP
  dv.setUint32(16, subtable);

  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  dv.setUint16(subtable, 4);
  dv.setUint16(subtable + 2, subtableLength);
  dv.setUint16(subtable + 4, 0); // language
  dv.setUint16(subtable + 6, segCount * 2);
  dv.setUint16(subtable + 8, searchRange);
  dv.setUint16(subtable + 10, entrySelector);
  dv.setUint16(subtable + 12, segCount * 2 - searchRange);

  const endCodes = subtable + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  segments.forEach((seg, i) => {
    dv.setUint16(endCodes + i * 2, seg.end);
    dv.setUint16(startCodes + i * 2, seg.start);
    dv.setUint16(idDeltas + i * 2, seg.delta);
    dv.setUint16(idRangeOffsets + i * 2, 0);
  });
  return out;
}

/** Sums a table as big-endian uint32s, the sfnt checksum. */
function tableChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum;
}

/** Reassembles an sfnt font from its tables, with checksums recomputed. */
function writeSfnt(sfntVersion, tables) {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  const directorySize = 12 + numTables * 16;
  const padded = sorted.map((t) => (4 - (t.data.length % 4)) % 4);
  const total = padded.reduce(
    (sum, pad, i) => sum + sorted[i].data.length + pad, directorySize);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  dv.setUint32(0, sfntVersion);
  dv.setUint16(4, numTables);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, numTables * 16 - searchRange);

  let offset = directorySize;
  let headOffset = -1;
  sorted.forEach((table, i) => {
    const rec = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[rec + c] = table.tag.charCodeAt(c);
    dv.setUint32(rec + 4, tableChecksum(table.data));
    dv.setUint32(rec + 8, offset);
    dv.setUint32(rec + 12, table.data.length);
    out.set(table.data, offset);
    if (table.tag === 'head') headOffset = offset;
    offset += table.data.length + padded[i];
  });

  if (headOffset >= 0) {
    // checkSumAdjustment is defined as the magic number minus the checksum of
    // the whole file computed with this field zeroed.
    dv.setUint32(headOffset + 8, 0);
    dv.setUint32(headOffset + 8, (HEAD_MAGIC_ADJUSTMENT - tableChecksum(out)) >>> 0);
  }
  return out;
}

/**
 * Returns a copy of an OpenType font whose `cmap` also maps real Unicode.
 *
 * `toFontChar` is PDF.js's character code -> font code table and `toUnicode`
 * its character code -> text table; together they say which Unicode belongs to
 * the glyph the font stores under each private-use code. The existing mappings
 * are kept, so the font still works for anything already addressing it the
 * PDF.js way.
 */
export function withUnicodeCmap(fontBytes, toFontChar, toUnicode) {
  const { sfntVersion, tables } = readTableDirectory(fontBytes);
  const cmap = tables.find((t) => t.tag === 'cmap');
  if (!cmap) throw new Error('font has no cmap table');

  const existing = readCmap(cmap.data);
  const merged = new Map(existing);
  let added = 0;

  for (const [code, text] of toUnicode) {
    const fontChar = toFontChar[code];
    if (fontChar === undefined) continue;
    const gid = existing.get(fontChar);
    if (!gid) continue;
    // Multi-character entries are ligatures; there is no single code point to
    // map, and the SVG spells them out as separate characters anyway.
    const points = [...text];
    if (points.length !== 1) continue;
    const unicode = points[0].codePointAt(0);
    if (unicode > 0xffff || merged.has(unicode)) continue;
    merged.set(unicode, gid);
    added++;
  }

  if (!added) return fontBytes;
  return writeSfnt(
    sfntVersion,
    tables.map((t) => (t.tag === 'cmap' ? { tag: 'cmap', data: buildCmap(merged) } : t)));
}

/** PDF.js hands `toUnicode` over the worker boundary as a plain object. */
export function toUnicodeEntries(toUnicode) {
  const entries = [];
  if (!toUnicode) return entries;
  const map = toUnicode._map ?? toUnicode.map;
  if (Array.isArray(map)) {
    map.forEach((text, code) => {
      if (typeof text === 'string' && text) entries.push([code, text]);
    });
  } else if (map && typeof map === 'object') {
    for (const [code, text] of Object.entries(map)) {
      if (typeof text === 'string' && text) entries.push([Number(code), text]);
    }
  } else if (typeof toUnicode.firstChar === 'number') {
    // An identity map: the character code is the code point.
    for (let code = toUnicode.firstChar; code <= toUnicode.lastChar; code++) {
      entries.push([code, String.fromCodePoint(code)]);
    }
  }
  return entries;
}

/**
 * Reduces a font name to a form the SVG and the PDF can be compared in:
 * lowercase, punctuation dropped, subset prefix kept. The prefix is what tells
 * two subsets of one typeface apart, so it stays.
 */
function normalizeFontName(name) {
  return String(name || '').replace(/^[/]/, '').toLowerCase().replace(/[^a-z0-9+]/g, '');
}

/** True when a PDF font name calls itself bold / italic, as MuPDF reads it. */
function styleFromFontName(name) {
  const lower = String(name || '').toLowerCase();
  return {
    bold: /bold|black|heavy/.test(lower),
    italic: /italic|oblique/.test(lower),
  };
}

/** Drops a `ABCDEF+` subset tag from a normalized name. */
function withoutSubsetTag(normalized) {
  const plus = normalized.indexOf('+');
  return plus >= 0 ? normalized.slice(plus + 1) : normalized;
}

/**
 * The faces MuPDF substitutes when a PDF embeds no font program, and what
 * each one stands in for. MuPDF draws a missing Helvetica with its own Nimbus
 * Sans and writes *that* name into the SVG, which no reader has and which the
 * PDF's own font name gives no way to guess. Naming what it replaced both
 * finds that font among the page's own and gives the export a stack any
 * machine can serve.
 */
const SUBSTITUTE_FAMILIES = [
  {
    match: /^nimbussans/,
    aliases: ['helvetica', 'arial'],
    stack: ['Helvetica', 'Arial'],
    generic: 'sans-serif',
  },
  {
    match: /^nimbusroman/,
    aliases: ['times', 'timesnewroman'],
    stack: ['Times New Roman', 'Times'],
    generic: 'serif',
  },
  {
    match: /^nimbusmono/,
    aliases: ['courier', 'couriernew'],
    stack: ['Courier New', 'Courier'],
    generic: 'monospace',
  },
  { match: /^standardsymbols/, aliases: ['symbol'], stack: [], generic: 'serif' },
  { match: /^dingbats/, aliases: ['zapfdingbats'], stack: [], generic: 'serif' },
];

/** The face MuPDF stood in for, if this family is one of its substitutes. */
function substituteFor(family) {
  const normalized = normalizeFontName(family);
  return SUBSTITUTE_FAMILIES.find((s) => s.match.test(normalized)) || null;
}

/**
 * Scores how well a PDF font answers to the family an SVG text run asks for.
 * Lower is better; null means the names have nothing to do with each other.
 *
 * MuPDF writes the family it drew with into `font-family`, having cut the
 * style off the PDF's own name: `NNFDFE+Arial-BoldMT` is written as
 * `NNFDFE+Arial` plus `font-weight="bold"`, and `NewCenturySchoolbookBold` as
 * `NewCenturySchoolbook`. It only ever truncates, so the SVG's family is a
 * prefix of the PDF name -- a far safer test than guessing which words in a
 * font name are style names. Where several fonts share a prefix, the style
 * attributes on the element and then the closest-length name decide.
 */
function nameScore(font, family, bold, italic) {
  const wanted = normalizeFontName(family);
  const name = normalizeFontName(font.name);
  if (!wanted || !name) return null;

  const bare = withoutSubsetTag(name);
  const substitute = substituteFor(wanted);
  let score;
  if (name === wanted) score = 0;
  else if (name.startsWith(wanted)) score = 1;
  else if (bare === withoutSubsetTag(wanted)) score = 2;
  else if (bare.startsWith(withoutSubsetTag(wanted))) score = 3;
  else if (substitute?.aliases.some((alias) => bare.startsWith(alias))) score = 4;
  else return null;

  const style = styleFromFontName(font.name);
  if (style.bold !== !!bold) score += 8;
  if (style.italic !== !!italic) score += 4;
  // A mismatch on both style axes means the name only coincidentally lines up.
  if (score >= 12) return null;
  return score * 1000 + Math.min(name.length - wanted.length, 999);
}

/** The Unicode a font can actually draw, as PDF.js has it mapped. */
function drawableCharacters(font) {
  if (!coverageCache.has(font)) {
    const chars = new Set();
    for (const [code, text] of toUnicodeEntries(font.toUnicode)) {
      if (font.toFontChar?.[code] !== undefined) chars.add([...text][0]);
    }
    coverageCache.set(font, chars);
  }
  return coverageCache.get(font);
}
const coverageCache = new WeakMap();

/** The share of `text`'s distinct characters a font can draw. */
function coverage(font, text) {
  const wanted = new Set([...String(text)].filter((c) => !/\s/.test(c)));
  if (wanted.size < 3) return 0;
  const drawable = drawableCharacters(font);
  let hits = 0;
  for (const ch of wanted) if (drawable.has(ch)) hits++;
  return hits / wanted.size;
}

/**
 * Pairs every family the SVG asks for with the PDF font it was drawn with.
 *
 * Names are matched first, best pair first, so a family cannot be claimed by a
 * font some other family fits better. What is left over is matched on what it
 * has to draw: MuPDF does not always write a name the PDF would recognise --
 * it reports a Type 1 font's own family (`SFRM1000` as `Computer Modern`), and
 * where the PDF embedded nothing it names the face it substituted (`Helvetica`
 * as `Nimbus Sans`). A font that can supply every character of a run, when no
 * other unclaimed font can, is the one that drew it.
 */
export function matchFonts(usages, fonts) {
  const pairs = [];
  for (const usage of usages) {
    for (const font of fonts) {
      const score = nameScore(font, usage.family, usage.bold, usage.italic);
      if (score !== null) pairs.push({ usage, font, score });
    }
  }
  pairs.sort((a, b) => a.score - b.score);

  const matched = new Map();
  const claimed = new Set();
  for (const { usage, font } of pairs) {
    if (matched.has(usageKey(usage)) || claimed.has(font)) continue;
    matched.set(usageKey(usage), font);
    claimed.add(font);
  }

  for (const usage of usages) {
    if (matched.has(usageKey(usage)) || !usage.text) continue;
    let best = null;
    let bestScore = 0;
    for (const font of fonts) {
      if (claimed.has(font)) continue;
      const style = styleFromFontName(font.name);
      // Style agreement only breaks ties between fonts that both fit.
      const score = coverage(font, usage.text)
        - (style.bold !== !!usage.bold ? 0.01 : 0)
        - (style.italic !== !!usage.italic ? 0.01 : 0);
      if (score > bestScore) {
        best = font;
        bestScore = score;
      }
    }
    if (best && bestScore > 0.95) {
      matched.set(usageKey(usage), best);
      claimed.add(best);
    }
  }
  return matched;
}

/**
 * A readable family name for the fallback stack: the PDF's name without the
 * subset tag. `NNFDFE+Arial-BoldMT` -> `Arial`, which a viewer that ignores
 * the embedded font can still serve from the system.
 */
function displayFamily(name) {
  const withoutSubset = String(name || '').replace(/^[/]/, '').replace(/^[A-Z]{6}\+/, '');
  const base = withoutSubset.split(/[-,]/)[0].replace(/(MT|PS|Std|Pro)$/, '');
  return base.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/** Quotes a family name for CSS when it is not a bare identifier. */
function cssFamily(name) {
  return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(name) ? name : `'${name.replace(/['\\]/g, '')}'`;
}

/** The generic family to end a fallback stack with. */
function genericFamily(font) {
  if (font?.fallbackName) return font.fallbackName;
  if (font?.isMonospace) return 'monospace';
  if (font?.isSerifFont) return 'serif';
  return 'sans-serif';
}

// Preparing and encoding a font costs real time on a page full of text, and
// the same font comes back for every crop on the page, so the result is kept
// against PDF.js's own font object.
const dataUriCache = new WeakMap();

/** The `src` for one font, prepared once per font. */
function fontDataUri(font) {
  if (dataUriCache.has(font)) return dataUriCache.get(font);

  let uri = null;
  try {
    const bytes = withUnicodeCmap(font.data, font.toFontChar, toUnicodeEntries(font.toUnicode));
    uri = `data:${font.mimetype || 'font/opentype'};base64,${base64(bytes)}`;
  } catch (err) {
    console.warn(`Could not prepare ${font.name} for embedding:`, err);
  }
  dataUriCache.set(font, uri);
  return uri;
}

/**
 * Turns the fonts a crop's text uses into `@font-face` rules and the font-family
 * stack each `<text>` should carry.
 *
 * `usages` are the distinct `{family, bold, italic}` triples read off the SVG;
 * `fonts` are PDF.js's font objects for the page. The rules reuse the family
 * name already in the SVG, so nothing has to be renamed for the embedded font
 * to win, and the weight and style descriptors let one family cover the
 * regular, bold and italic cuts the way MuPDF writes them. What follows in the
 * stack is for viewers that ignore embedded fonts: the typeface's real name
 * with the subset tag stripped, then a generic family.
 */
export function buildFontCss(usages, fonts) {
  const rules = [];
  const stacks = new Map();
  const seen = new Set();
  const matched = matchFonts(usages, fonts);

  for (const usage of usages) {
    const font = matched.get(usageKey(usage));
    const substitute = substituteFor(usage.family);
    const stack = [cssFamily(usage.family)];
    const display = font ? displayFamily(font.name) : '';
    if (display && normalizeFontName(display) !== normalizeFontName(usage.family)) {
      stack.push(cssFamily(display));
    }
    for (const name of substitute?.stack ?? []) {
      if (!stack.includes(name)) stack.push(name);
    }
    stack.push(substitute?.generic ?? genericFamily(font));
    stacks.set(usageKey(usage), stack.join(', '));

    if (!font?.data) continue;
    const key = `${normalizeFontName(usage.family)}|${usage.bold}|${usage.italic}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const source = fontDataUri(font);
    if (!source) continue;
    rules.push(
      `@font-face{font-family:${cssFamily(usage.family)};` +
      `font-weight:${usage.bold ? 'bold' : 'normal'};` +
      `font-style:${usage.italic ? 'italic' : 'normal'};` +
      `src:url("${source}")}`);
  }

  return { css: rules.join('\n'), stacks, embedded: rules.length };
}

/** Identifies one distinct way the SVG asks for a font. */
export function usageKey(usage) {
  return `${usage.family}|${usage.bold ? 'b' : ''}${usage.italic ? 'i' : ''}`;
}

/** Base64-encodes bytes in chunks, since `btoa` takes a string. */
function base64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
