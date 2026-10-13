/** Small, generated PDFs exercise image formats and vectors without personal files. */
export function fixturePdf() {
  const objects = [];
  const add = (value) => {
    objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    return objects.length;
  };
  const stream = (dict, data) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`),
      data,
      Buffer.from('\nendstream'),
    ]);
  const catalog = add(''),
    pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const image = (w, h, data) =>
    add(
      stream(
        `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
        data
      )
    );
  const green = Buffer.from([27, 135, 49]),
    blue = Buffer.from([45, 72, 190]);
  const native = image(32, 24, Buffer.concat(Array(32 * 24).fill(green)));
  const inline = image(2, 2, Buffer.concat(Array(4).fill(blue)));
  const scan = Buffer.alloc(200 * 200 * 3, 255);
  for (let y = 50; y < 110; y++)
    for (let x = 40; x < 120; x++) green.copy(scan, (y * 200 + x) * 3);
  const scanned = image(200, 200, scan);
  const specs = [
    {
      image: native,
      content:
        'q 80 0 0 60 40 90 cm /Im0 Do Q\n1 0 0 rg 130 90 30 60 re f\nBT /F1 12 Tf 20 175 Td (Export fixture) Tj ET',
    },
    { image: inline, content: 'q 80 0 0 60 40 90 cm /Im0 Do Q' },
    {
      image: scanned,
      content:
        'q 200 0 0 200 0 0 cm /Im0 Do Q\nq /G0 gs 80 0 0 60 40 90 cm\nBI /W 1 /H 1 /IM true /BPC 1 ID\n\x00\nEI Q',
    },
    {
      content:
        '0.8 0.1 0.1 rg 20 80 60 60 re f\n0.1 0.2 0.8 rg 100 80 60 60 re f\nBT /F1 14 Tf 20 170 Td (Vector export) Tj ET',
    },
  ];
  const ids = specs.map((spec) => {
    const content = add(stream('', Buffer.from(spec.content, 'latin1')));
    return add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 ${font} 0 R >> /ExtGState << /G0 << /ca 0 >> >> ${spec.image ? `/XObject << /Im0 ${spec.image} 0 R >>` : ''} >> /Contents ${content} 0 R >>`
    );
  });
  objects[catalog - 1] = Buffer.from(
    `<< /Type /Catalog /Pages ${pages} 0 R >>`
  );
  objects[pages - 1] = Buffer.from(
    `<< /Type /Pages /Count ${ids.length} /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`
  );
  const chunks = [Buffer.from('%PDF-1.4\n')],
    offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((obj, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      obj,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join(
          ''
        )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`
    )
  );
  return Buffer.concat(chunks);
}
