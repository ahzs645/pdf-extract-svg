import initPathKit from 'pathkit-wasm';
import wasmUrl from 'pathkit-wasm/bin/pathkit.wasm?url';
import { SVG_NS, DRAWABLE_SELECTOR } from './geometry.js';

let kitPromise;
const getKit = () =>
  (kitPromise ||= initPathKit({ locateFile: () => wasmUrl }));
const tagName = (el) => el.tagName.replace(/^.*:/, '').toLowerCase();
const matrix = (m) => [m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1];
const num = (el, name, fallback = 0) =>
  parseFloat(el.getAttribute(name) ?? fallback);
const empty = (path) => !path.toCmds().length;
const bounds = (path) => {
  const b = path.computeTightBounds();
  return {
    x: b.fLeft,
    y: b.fTop,
    w: b.fRight - b.fLeft,
    h: b.fBottom - b.fTop,
  };
};
const contains = (a, b) =>
  b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const solid = (value) => value && value !== 'none' && !value.includes('url(');
const reference = (value) =>
  value?.match(/url\(["']?[^#)]*#([^)'"\s]+)["']?\)/)?.[1];

/** Physically trim supported SVG artwork, retaining complex effects unchanged. */
export async function trimSvg(root, assertActive = () => {}) {
  const k = await getKit();
  assertActive();
  const report = {
    removedObjects: 0,
    trimmedVectors: 0,
    croppedImages: 0,
    preservedObjects: 0,
  };
  const allocated = new Set();
  const keep = (path) => {
    if (path) allocated.add(path);
    return path;
  };
  const drop = (path) => {
    if (path) {
      allocated.delete(path);
      path.delete();
    }
  };
  const copy = (path) => keep(path.copy());
  const op = (one, two, operation) => {
    const result = one.op(two, operation);
    if (!result) throw new Error('Could not intersect SVG geometry');
    return one;
  };
  const rectangle = (b) => keep(k.NewPath().rect(b.x, b.y, b.w, b.h));
  const clipInfo = (path) => {
    const box = bounds(path),
      rect = rectangle(box),
      difference = copy(path);
    let isRect;
    try {
      op(difference, rect, k.PathOp.XOR);
      isRect = empty(difference);
    } finally {
      drop(rect);
      drop(difference);
    }
    return { path, box, rectangle: isRect, complete: true };
  };
  const holder = document.createElement('div');
  holder.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1000px;opacity:0;pointer-events:none';
  holder.appendChild(root);
  document.body.appendChild(holder);
  try {
    const vb = root.viewBox.baseVal;
    const crop = rectangle({ x: vb.x, y: vb.y, w: vb.width, h: vb.height });
    const rootInverse = DOMMatrix.fromMatrix(root.getScreenCTM()).inverse();
    const definitions = new Map(
      [...root.querySelectorAll('[id]')].map((el) => [el.id, el])
    );
    let clipId = 0;
    const transforms = new WeakMap(),
      clips = new WeakMap(),
      styles = new WeakMap();
    const toRoot = (el) => {
      if (!transforms.has(el))
        transforms.set(
          el,
          rootInverse.multiply(DOMMatrix.fromMatrix(el.getScreenCTM()))
        );
      return transforms.get(el);
    };
    const style = (el) => {
      if (!styles.has(el)) styles.set(el, getComputedStyle(el));
      return styles.get(el);
    };
    const transformAttr = (el) => {
      const value = el.transform?.baseVal.consolidate()?.matrix;
      return value ? DOMMatrix.fromMatrix(value) : new DOMMatrix();
    };

    function pathFor(el, seen = new Set()) {
      let path;
      switch (tagName(el)) {
        case 'path':
          path = k.FromSVGString(el.getAttribute('d') || '');
          break;
        case 'rect': {
          const x = num(el, 'x'),
            y = num(el, 'y'),
            w = num(el, 'width'),
            h = num(el, 'height');
          if (num(el, 'rx') || num(el, 'ry')) return null;
          path = k.NewPath().rect(x, y, w, h);
          break;
        }
        case 'circle':
        case 'ellipse': {
          const x = num(el, 'cx'),
            y = num(el, 'cy'),
            rx = num(el, tagName(el) === 'circle' ? 'r' : 'rx'),
            ry = num(el, tagName(el) === 'circle' ? 'r' : 'ry');
          path = k.FromSVGString(
            `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`
          );
          break;
        }
        case 'polygon':
        case 'polyline': {
          const points = (el.getAttribute('points') || '')
            .trim()
            .split(/[\s,]+/)
            .map(Number);
          if (
            points.length < 4 ||
            points.length % 2 ||
            !points.every(Number.isFinite)
          )
            return null;
          path = k.NewPath().moveTo(points[0], points[1]);
          for (let i = 2; i < points.length; i += 2)
            path.lineTo(points[i], points[i + 1]);
          if (tagName(el) === 'polygon') path.close();
          break;
        }
        case 'line':
          path = k
            .NewPath()
            .moveTo(num(el, 'x1'), num(el, 'y1'))
            .lineTo(num(el, 'x2'), num(el, 'y2'));
          break;
        case 'use': {
          const id = (
            el.getAttribute('href') ||
            el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
            ''
          ).slice(1);
          if (seen.has(id)) return null;
          const target = definitions.get(id);
          if (!target) return null;
          const next = new Set(seen);
          next.add(id);
          path = pathFor(target, next);
          if (!path) return null;
          path.transform(
            matrix(
              new DOMMatrix()
                .translate(num(el, 'x'), num(el, 'y'))
                .multiply(transformAttr(target))
            )
          );
          return path;
        }
        default:
          return null;
      }
      keep(path);
      if (path)
        path.setFillType(
          style(el).fillRule === 'evenodd'
            ? k.FillType.EVENODD
            : k.FillType.WINDING
        );
      return path;
    }

    function clipShape(definition, target) {
      if (
        style(definition).clipPath !== 'none' ||
        style(definition).mask !== 'none' ||
        style(definition).filter !== 'none'
      )
        return null;
      const shape = keep(k.NewPath());
      let transform = toRoot(target);
      if (definition.getAttribute('clipPathUnits') === 'objectBoundingBox') {
        const b = target.getBBox();
        transform = transform.multiply(
          new DOMMatrix([b.width, 0, 0, b.height, b.x, b.y])
        );
      }
      transform = transform.multiply(transformAttr(definition));
      function append(container, parentMatrix) {
        for (const el of container.children) {
          const m = parentMatrix.multiply(transformAttr(el));
          // Nested clip/mask/filter effects require their source semantics.
          if (
            style(el).clipPath !== 'none' ||
            style(el).mask !== 'none' ||
            style(el).filter !== 'none' ||
            style(el).display === 'none' ||
            style(el).visibility !== 'visible'
          )
            return false;
          if (tagName(el) === 'g') {
            if (!append(el, m)) return false;
            continue;
          }
          const child = pathFor(el);
          if (!child) return false;
          child.setFillType(
            style(el).clipRule === 'evenodd'
              ? k.FillType.EVENODD
              : k.FillType.WINDING
          );
          try {
            child.transform(matrix(m));
            op(shape, child, k.PathOp.UNION);
          } finally {
            drop(child);
          }
        }
        return true;
      }
      if (!append(definition, transform)) {
        drop(shape);
        return null;
      }
      return shape;
    }

    function clipFor(el) {
      if (clips.has(el)) return clips.get(el);
      const inherited =
        el === root ? clipInfo(crop) : clipFor(el.parentElement);
      let result = inherited;
      const id = reference(style(el).clipPath);
      if (id) {
        const definition = definitions.get(id);
        const shape =
          definition && tagName(definition) === 'clippath'
            ? clipShape(definition, el)
            : null;
        if (shape) {
          if (
            definition.getAttribute('clipPathUnits') === 'objectBoundingBox'
          ) {
            // Trimming changes the object's bounding box. Freeze the original
            // coordinate mapping or the same clip would shrink a second time.
            const b = el.getBBox();
            const frozen = definition.cloneNode(true);
            let id;
            do {
              id = `trim-clip-${clipId++}`;
            } while (definitions.has(id));
            frozen.id = id;
            for (const child of frozen.querySelectorAll('[id]'))
              child.removeAttribute('id');
            frozen.setAttribute('clipPathUnits', 'userSpaceOnUse');
            const m = new DOMMatrix([
              b.width,
              0,
              0,
              b.height,
              b.x,
              b.y,
            ]).multiply(transformAttr(definition));
            frozen.setAttribute(
              'transform',
              `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`
            );
            definition.parentElement.appendChild(frozen);
            definitions.set(id, frozen);
            el.style.setProperty('clip-path', `url(#${id})`, 'important');
          }
          const combined = copy(inherited.path);
          try {
            op(combined, shape, k.PathOp.INTERSECT);
          } finally {
            drop(shape);
          }
          result = { ...clipInfo(combined), complete: inherited.complete };
        } else result = { ...inherited, complete: false };
      } else if (style(el).clipPath !== 'none')
        result = { ...inherited, complete: false };
      clips.set(el, result);
      return result;
    }

    function effects(el) {
      for (
        let current = el;
        current && holder.contains(current);
        current = current.parentElement
      ) {
        if (current === holder) break;
        const s = style(current);
        if (
          s.filter !== 'none' ||
          s.mask !== 'none' ||
          s.mixBlendMode !== 'normal'
        )
          return true;
      }
      return false;
    }
    function opaque(el) {
      if (
        !/^rgb\([0-9.,%\s]+\)$/.test(style(el).fill) ||
        Number(style(el).fillOpacity) !== 1 ||
        style(el).visibility !== 'visible'
      )
        return false;
      for (
        let current = el;
        current && current !== holder;
        current = current.parentElement
      )
        if (
          Number(style(current).opacity) !== 1 ||
          style(current).display === 'none'
        )
          return false;
      return !effects(el) && clipFor(el).complete;
    }

    const nodes = [...root.querySelectorAll(DRAWABLE_SELECTOR)].filter(
      (el) => !el.closest('defs,clipPath,mask,pattern,marker,symbol')
    );
    // Only simple opaque fill shapes participate in occlusion removal. Their
    // painted area must prove complete coverage; bounding boxes are not enough.
    const covers = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i],
        tag = tagName(el);
      if (
        (tag !== 'rect' &&
          (tag !== 'path' || (el.getAttribute('d') || '').length > 160)) ||
        !opaque(el)
      )
        continue;
      const path = pathFor(el);
      if (!path) continue;
      const info = clipInfo(path);
      if (!info.rectangle) {
        drop(path);
        continue;
      }
      path.transform(matrix(toRoot(el)));
      op(path, clipFor(el).path, k.PathOp.INTERSECT);
      if (!empty(path)) covers.push({ index: i, path });
    }

    // Measure first, mutate later, so edits do not invalidate transforms or CSS.
    const plans = [];
    for (let i = 0; i < nodes.length; i++) {
      if (i % 250 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertActive();
      }
      const el = nodes[i],
        clip = clipFor(el),
        m = toRoot(el),
        s = style(el);
      if (effects(el)) {
        report.preservedObjects++;
        continue;
      }
      if (empty(clip.path)) {
        plans.push(() => el.remove());
        report.removedObjects++;
        continue;
      }
      if (tagName(el) === 'image') {
        const imageBox = {
          x: num(el, 'x'),
          y: num(el, 'y'),
          w: num(el, 'width'),
          h: num(el, 'height'),
        };
        const image = rectangle(imageBox);
        image.transform(matrix(m));
        const visible = copy(image);
        try {
          op(visible, clip.path, k.PathOp.INTERSECT);
          for (const cover of covers) {
            if (cover.index > i) op(visible, cover.path, k.PathOp.DIFFERENCE);
            if (empty(visible)) break;
          }
          if (empty(visible)) {
            plans.push(() => el.remove());
            report.removedObjects++;
            continue;
          }
          visible.transform(matrix(m.inverse()));
          const box = bounds(visible);
          const visibleInfo = clipInfo(visible);
          if (!clip.complete || !visibleInfo.rectangle) {
            report.preservedObjects++;
            continue;
          }
          const b = imageBox;
          if (contains(box, b)) continue;
          const cropped = await cropImage(el, b, box, assertActive);
          if (cropped) {
            plans.push(cropped);
            report.croppedImages++;
          } else report.preservedObjects++;
        } finally {
          drop(image);
          drop(visible);
        }
        continue;
      }
      const b = el.getBBox();
      // A rectangular clip that contains the geometry needs no path rewrite.
      const width =
        s.stroke !== 'none'
          ? (parseFloat(s.strokeWidth) *
              Math.max(1, parseFloat(s.strokeMiterlimit))) /
            2
          : 0;
      const boxPath = rectangle({
        x: b.x - width,
        y: b.y - width,
        w: b.width + width * 2,
        h: b.height + width * 2,
      });
      boxPath.transform(matrix(m));
      const box = bounds(boxPath);
      const hasMarkers = ['markerStart', 'markerMid', 'markerEnd'].some(
        (key) => s[key] && s[key] !== 'none'
      );
      const visibleBox = copy(boxPath);
      op(visibleBox, clip.path, k.PathOp.INTERSECT);
      const invisible = empty(visibleBox);
      drop(visibleBox);
      drop(boxPath);
      if (invisible && !hasMarkers) {
        plans.push(() => el.remove());
        report.removedObjects++;
        continue;
      }
      if (clip.complete && clip.rectangle && contains(clip.box, box)) continue;
      if (
        !clip.complete ||
        tagName(el) === 'text' ||
        (s.fill !== 'none' && !solid(s.fill)) ||
        (s.stroke !== 'none' &&
          (!solid(s.stroke) ||
            s.strokeDasharray !== 'none' ||
            s.vectorEffect !== 'none')) ||
        hasMarkers
      ) {
        report.preservedObjects++;
        continue;
      }
      const original = pathFor(el);
      if (!original) {
        report.preservedObjects++;
        continue;
      }
      const pieces = [];
      try {
        if (solid(s.fill)) {
          const fill = copy(original);
          fill.transform(matrix(m));
          op(fill, clip.path, k.PathOp.INTERSECT);
          if (!empty(fill))
            pieces.push({ path: fill, paint: s.fill, opacity: s.fillOpacity });
          else drop(fill);
        }
        if (solid(s.stroke) && parseFloat(s.strokeWidth) > 0) {
          const stroke = copy(original);
          if (
            !stroke.stroke({
              width: parseFloat(s.strokeWidth),
              miter_limit: parseFloat(s.strokeMiterlimit),
              cap: k.StrokeCap[s.strokeLinecap.toUpperCase()],
              join: k.StrokeJoin[s.strokeLinejoin.toUpperCase()],
            })
          ) {
            drop(stroke);
            report.preservedObjects++;
            continue;
          }
          stroke.transform(matrix(m));
          op(stroke, clip.path, k.PathOp.INTERSECT);
          if (!empty(stroke))
            pieces.push({
              path: stroke,
              paint: s.stroke,
              opacity: s.strokeOpacity,
            });
          else drop(stroke);
        }
        if (!pieces.length) {
          plans.push(() => el.remove());
          report.removedObjects++;
          continue;
        }
        const group = document.createElementNS(SVG_NS, 'g');
        for (const attr of el.attributes)
          group.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
        for (const name of [
          'd',
          'href',
          'xlink:href',
          'x',
          'y',
          'width',
          'height',
          'rx',
          'ry',
          'r',
          'cx',
          'cy',
          'points',
          'x1',
          'x2',
          'y1',
          'y2',
        ])
          group.removeAttribute(name);
        for (const { path, paint, opacity } of pieces) {
          path.transform(matrix(m.inverse()));
          const child = document.createElementNS(SVG_NS, 'path');
          child.setAttribute('d', path.toSVGString());
          child.style.fill = paint;
          child.style.fillOpacity = opacity;
          child.style.stroke = 'none';
          child.style.fillRule = path.getFillTypeString();
          group.appendChild(child);
        }
        plans.push(() => el.replaceWith(group));
        report.trimmedVectors++;
      } finally {
        drop(original);
        for (const piece of pieces) drop(piece.path);
      }
    }
    assertActive();
    for (const apply of plans) apply();
    if (!root.querySelector('text')) {
      for (const style of root.querySelectorAll('style')) {
        const css = style.textContent;
        if (
          /@font-face\b/.test(css) &&
          !css.replace(/@font-face\s*\{[^{}]*\}/g, '').trim()
        ) {
          style.remove();
        }
      }
    }
    return report;
  } finally {
    holder.remove();
    for (const path of allocated) path.delete();
  }
}

async function cropImage(el, imageBox, visibleBox, assertActive) {
  const href =
    el.getAttribute('href') ||
    el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  if (
    !href?.startsWith('data:image/') ||
    (el.getAttribute('preserveAspectRatio') &&
      el.getAttribute('preserveAspectRatio') !== 'none')
  )
    return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(await (await fetch(href)).blob());
    assertActive();
    if (!(imageBox.w > 0 && imageBox.h > 0)) return null;
    if (
      el.getAttribute('preserveAspectRatio') !== 'none' &&
      Math.abs(bitmap.width / bitmap.height - imageBox.w / imageBox.h) > 1e-6
    )
      return null;
    const sx = Math.max(
      0,
      Math.floor(((visibleBox.x - imageBox.x) * bitmap.width) / imageBox.w)
    );
    const sy = Math.max(
      0,
      Math.floor(((visibleBox.y - imageBox.y) * bitmap.height) / imageBox.h)
    );
    const ex = Math.min(
      bitmap.width,
      Math.ceil(
        ((visibleBox.x + visibleBox.w - imageBox.x) * bitmap.width) / imageBox.w
      )
    );
    const ey = Math.min(
      bitmap.height,
      Math.ceil(
        ((visibleBox.y + visibleBox.h - imageBox.y) * bitmap.height) /
          imageBox.h
      )
    );
    if (sx === 0 && sy === 0 && ex === bitmap.width && ey === bitmap.height)
      return null;
    const canvas = document.createElement('canvas');
    canvas.width = ex - sx;
    canvas.height = ey - sy;
    if (!canvas.width || !canvas.height) return null;
    canvas
      .getContext('2d')
      .drawImage(
        bitmap,
        sx,
        sy,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
    const data = canvas.toDataURL('image/png');
    const x = imageBox.x + (sx * imageBox.w) / bitmap.width,
      y = imageBox.y + (sy * imageBox.h) / bitmap.height;
    const width = (canvas.width * imageBox.w) / bitmap.width;
    const height = (canvas.height * imageBox.h) / bitmap.height;
    return () => {
      el.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
      el.setAttribute('href', data);
      el.setAttribute('x', x);
      el.setAttribute('y', y);
      el.setAttribute('width', width);
      el.setAttribute('height', height);
      el.setAttribute('preserveAspectRatio', 'none');
    };
  } finally {
    bitmap?.close();
  }
}
