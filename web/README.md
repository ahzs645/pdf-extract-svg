# PDF to SVG — Web App

A client-side web app for extracting regions from PDF files as SVG. Upload a
PDF, select a region, and download it as a vector SVG file. Everything runs in
the browser — no files are uploaded to any server.

## How it works

1. **PDF rendering** — [PDF.js](https://mozilla.github.io/pdf.js/) renders
   pages to a canvas for display.
2. **Region selection** — Draw a rectangle over the area you want to extract.
   The drag may start in the margin around the page; it is clamped to the page
   edge. You can move a selection by dragging inside it, and make as many as
   you like across as many pages as you like.
3. **Image detection** — The page's operator list is walked while tracking the
   current transform, which yields the bounding box of every image on the page.
   Those are outlined, and clicking one selects it whole — no dragging needed.
4. **Object mode** — Switch the toolbar from Region to Object to click
   individual objects (paths, text runs, images) instead of dragging. Each page
   is indexed once from its SVG render, giving every object a bounding box in
   PDF points.
5. **Objects panel** — With a selection active, the panel lists the objects it
   contains. Hovering a row highlights it on the page, and the dot toggles its
   visibility. Hidden objects are dropped from the export, so you can strip a
   watermark, a rule or a stray label out of a figure before saving it.
6. **Vector editor** — "Edit vectors" opens the selection as a live, editable
   SVG. Clicking a shape on the canvas selects it — the browser does the hit
   testing, so there is no bounding-box guesswork — and the Layers list beside
   it names every shape with its type, fill and size. Delete a shape from
   either side, undo with Ctrl/Cmd Z, and Cancel discards the lot. Deletions
   are remembered per selection and applied on every later export.
7. **Library** — Every selection is listed in the side panel with a preview of
   what it will export, its size and its file size. Export them one at a time,
   or use "Export all" to get the lot as a single zip named after the PDF. SVG
   is deflated in the archive; PNG is stored, since it is already compressed.
   Exporting all of a single selection just gives you that file, not an
   archive.
8. **Export** — A region exports as SVG written by
   [MuPDF](https://mupdf.com/) via its WebAssembly build. MuPDF writes the page
   with the SVG viewport set to the selection, and the content translated so the
   selection lands on it; [SVGO](https://svgo.dev/) then prunes what falls
   outside and compresses the rest. An image grabbed by clicking it exports as a
   PNG at the image's own pixel dimensions instead, since wrapping a raster in
   SVG gains nothing.

## Why PDF.js is held at 4.x

PDF.js renders the viewer, and the version is pinned deliberately:

| pdfjs-dist | Renders CCITT stencil masks |
|------------|------------------------------|
| 3.11.174   | yes                          |
| **4.10.38**| **yes** (what we use)        |
| 5.7.284    | no                           |
| 6.3.289    | no                           |

From 5.0 on, CCITT stencil image masks silently stop rendering: `monocult.pdf`
loses both cover illustrations and its crest, dropping from 12.94% to 7.39% ink
on page 1 against a poppler reference of 11.79%. 4.10.38 is the newest release
that still draws them, and it is already past the
[GHSA-wgrm-67xf-hhpq](https://github.com/advisories/GHSA-wgrm-67xf-hhpq) fix,
so pinning there costs nothing in security.

## Why MuPDF for export

PDF.js renders the viewer, but no longer exports SVG: its `SVGGraphics` back end
was deprecated in 2.15.349 and removed outright in v4, with no replacement API.
Staying on the last version that had it (3.11.174) meant being stuck on
[GHSA-wgrm-67xf-hhpq](https://github.com/advisories/GHSA-wgrm-67xf-hhpq), a
high-severity flaw that allows arbitrary JavaScript execution when opening a
malicious PDF — for an app whose whole job is opening PDFs from elsewhere.

Exporting through MuPDF instead frees PDF.js to track its current release, and
produces far smaller files, mostly because it can write text as real `<text>`
runs rather than embedding font programs. For one region of our test document:

| Engine | Bytes |
|--------|-------|
| PDF.js `SVGGraphics` | 2,074,038 |
| MuPDF | 15,374 |

The cost is MuPDF's ~10 MB WebAssembly payload. It is loaded lazily on the first
export, so viewing a PDF never pays for it.

## Run locally

```sh
cd web
npm install
npm run dev
```

This starts a Vite dev server (default port 3000). Open the printed URL in your
browser.

## Build for production

```sh
npm run build
```

The output is in `dist/`. You can preview it with:

```sh
npm run preview
```

## Deploy to GitHub Pages

Build the app, then deploy the `dist/` directory. If using GitHub Actions, point
the pages source at the build output.

## Text in exported SVGs

By default text is exported as real `<text>` runs: small files, selectable and
editable, but rendered with whatever font the viewer can find. Tick **Text as
outlines** to export glyph outlines instead, which render identically anywhere
at the cost of a larger file and no selectable text. On one text block here that
is 15 KB selectable against 43 KB outlined.

## Why the editor lists so many shapes

MuPDF writes the whole page and the viewport is set to your selection, so the
document holds shapes that fall outside the crop. SVGO prunes them on export,
but the editor works on the un-optimized document, so "Only shapes in the crop"
is on by default and the count says how many were filtered out. What remains is
genuinely in your selection — detailed artwork really can be eighty small paths.

## Known limitations

- Text in some PDFs is rendered as paths rather than selectable text elements.
- Object mode only sees what the PDF draws as objects. On a scanned page the
  whole sheet is one image, so there is nothing to pick apart; use a region
  drag, or click the image to get it as PNG.
- A region cropped from a scanned page still embeds the part of the scan that
  the crop covers, since that raster is the content. Clicking the image to get a
  PNG is usually the better route for scans.
- Text exported as `<text>` names its fonts rather than embedding them. Use
  "Text as outlines" when the file has to render identically elsewhere.
- The editor deletes shapes; it does not move, recolour or reshape them. For
  that, export the SVG and open it in Inkscape or Illustrator.
- Shape ids are positional, so switching between text and outline mode after
  editing will not line the deletions up with the same shapes.
- The full page is rendered to SVG and then cropped via `viewBox`. SVGO strips
  off-canvas paths, but some content outside the selection may remain in the
  SVG source, so file sizes are dominated by the page rather than the crop.
- "Highlight rasters" tints every raster image so you can see what will not
  export as vector. It is off by default, because the tint is painted into the
  page and makes a scanned page look discoloured.
- A stencil mask exports as black artwork on transparency, since the PDF paints
  it with whatever fill colour is current rather than storing colour itself.
- Image detection finds images, not vector figures. A chart drawn as paths has
  no image to click, so select it by dragging.

## Zooming

Pinch on a trackpad or touchscreen to zoom, or hold Ctrl/Cmd and scroll. The
view responds immediately by scaling the existing bitmap, then re-renders the
page crisply once the gesture settles. The point under the cursor stays put as
you zoom. Selections are stored in PDF points, so they track the page exactly
at any zoom level.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Left arrow | Previous page |
| Right arrow | Next page |
| Escape | Deselect, or close the vector editor |
| Delete / Backspace | Remove the selected region, or the selected shape in the editor |
| Ctrl/Cmd + Z | Undo a delete in the vector editor |
| Ctrl/Cmd + `=` | Zoom in |
| Ctrl/Cmd + `-` | Zoom out |
| Ctrl/Cmd + `0` | Reset zoom |
