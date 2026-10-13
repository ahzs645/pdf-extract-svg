const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).byteLength;
const VECTOR_TAGS = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'polygon',
  'polyline',
  'line',
  'use',
]);

/** Measure the original SVG bytes without reserializing or decoding its assets. */
export function analyzeSvgSize(svg) {
  const categories = [
    { id: 'vectors', label: 'Vectors', bytes: 0, count: 0 },
    { id: 'images', label: 'Images', bytes: 0, count: 0 },
    { id: 'text', label: 'Text', bytes: 0, count: 0 },
    { id: 'fonts', label: 'Fonts & styles', bytes: 0, count: 0 },
    { id: 'structure', label: 'SVG structure', bytes: 0, count: 0 },
  ];
  const groups = Object.fromEntries(
    categories.map((group) => [group.id, group])
  );
  const stack = [],
    images = [];
  const context = () => stack.at(-1) || { category: 'structure' };
  const add = (text, ctx = context()) => {
    const size = bytes(text);
    groups[ctx.category].bytes += size;
    if (ctx.image !== undefined) images[ctx.image].bytes += size;
  };
  const addText = (text) => {
    if (context().category === 'fonts')
      groups.fonts.count += countFontRules(text);
    add(text);
  };

  let offset = 0;
  while (offset < svg.length) {
    const start = svg.indexOf('<', offset);
    if (start === -1) {
      addText(svg.slice(offset));
      break;
    }
    addText(svg.slice(offset, start));
    let end;
    if (svg.startsWith('<!--', start)) {
      end = svg.indexOf('-->', start + 4);
      end = end === -1 ? svg.length : end + 3;
      add(svg.slice(start, end));
      offset = end;
      continue;
    }
    if (svg.startsWith('<![CDATA[', start)) {
      end = svg.indexOf(']]>', start + 9);
      end = end === -1 ? svg.length : end + 3;
      const content = svg.slice(start, end);
      if (context().category === 'fonts')
        groups.fonts.count += countFontRules(content);
      add(content);
      offset = end;
      continue;
    }
    // A '>' inside a quoted attribute does not finish the tag.
    let quote = null;
    for (end = start + 1; end < svg.length; end++) {
      const char = svg[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    end = Math.min(svg.length, end + 1);
    const token = svg.slice(start, end);
    const match = token.match(/^<\s*(\/?)\s*([\w:.-]+)/);
    if (!match) {
      add(token);
      offset = end;
      continue;
    }
    const closing = !!match[1],
      tag = match[2].split(':').at(-1).toLowerCase();
    if (closing) {
      add(token);
      stack.pop();
    } else {
      let ctx = context();
      if (tag === 'image') {
        const attrs = attributes(token);
        const href = attrs.href || attrs['xlink:href'] || '';
        const mime = href.match(/^data:([^;,]+)/i)?.[1] || null;
        ctx = { category: 'images', image: images.length };
        images.push({
          type: mime
            ? mime
                .replace(/^image\//i, '')
                .toUpperCase()
                .replace('JPG', 'JPEG')
            : 'Linked image',
          embedded: !!mime,
          bytes: 0,
        });
        groups.images.count++;
      } else if (tag === 'style') {
        ctx = { category: 'fonts' };
      } else if (tag === 'text') {
        ctx = { category: 'text' };
        groups.text.count++;
      } else if (VECTOR_TAGS.has(tag)) {
        ctx = { category: 'vectors' };
        groups.vectors.count++;
      }
      add(token, ctx);
      if (!/\/\s*>$/.test(token)) stack.push({ ...ctx, tag });
    }
    offset = end;
  }

  return { totalBytes: bytes(svg), categories, images };
}

function countFontRules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@font-face\b/g)]
    .length;
}

function attributes(token) {
  return Object.fromEntries(
    [...token.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((match) => [
      match[1].toLowerCase(),
      match[3],
    ])
  );
}

export function analyzeRasterSize(blob) {
  return {
    totalBytes: blob.size,
    categories: [
      { id: 'images', label: 'PNG image', bytes: blob.size, count: 1 },
    ],
    images: [],
  };
}

export function formatBytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024)
    return `${(size / 1024).toFixed(size < 1024 * 100 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
