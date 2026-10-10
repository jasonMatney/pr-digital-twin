import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The site is static and served from a sub-path on GitHub Pages, so every URL is relative.
// SITE_DIR is a checkout of the gh-pages branch: its tiles/ and data/ are served in dev exactly as in production.
export default defineConfig({
  base: './',
  publicDir: process.env.SITE_DIR || '/home/claude/site',
  plugins: [preact()],
  build: { rollupOptions: { input: process.env.ENTRY || 'index.html' }, outDir: process.env.OUT_DIR || 'dist', copyPublicDir: false, target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { host: '127.0.0.1', strictPort: true, fs: { strict: false } },
});
