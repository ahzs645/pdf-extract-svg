import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  // MuPDF ships an Emscripten bundle that locates its .wasm with
  // `new URL('mupdf-wasm.wasm', import.meta.url)`. Pre-bundling rewrites that
  // URL to the optimized-deps directory, where the binary does not exist, so
  // the fetch falls through to index.html and WebAssembly rejects the HTML.
  optimizeDeps: {
    exclude: ['mupdf'],
  },
});
