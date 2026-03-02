# PDF to SVG — Web App

A client-side web app for extracting regions from PDF files as SVG. Upload a
PDF, select a region, and download it as a vector SVG file. Everything runs in
the browser — no files are uploaded to any server.

## How it works

1. **PDF rendering** — [PDF.js](https://mozilla.github.io/pdf.js/) renders
   pages to a canvas for display.
2. **Region selection** — Draw a rectangle over the area you want to extract.
   You can move the selection by dragging inside it.
3. **SVG export** — The page is re-rendered through
   [canvas2svg](https://github.com/nicholaswmin/canvas2svg), which intercepts
   canvas drawing operations and records them as SVG elements. The SVG is then
   cropped to your selection and optimized with [SVGO](https://svgo.dev/).

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

## Known limitations

- **canvas2svg** does not implement every canvas 2D context method. Complex PDFs
  using advanced blend modes or transparency groups may not export perfectly.
- Text in some PDFs is rendered as paths rather than selectable text elements.
- The full page is rendered to SVG and then cropped via `viewBox` and
  `clipPath`. SVGO strips off-canvas paths, but some content outside the
  selection may remain in the SVG source.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Left arrow | Previous page |
| Right arrow | Next page |
| Escape | Clear selection |
