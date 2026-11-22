import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  build: {
    outDir: '.temp/ui',
    assetsInlineLimit: (path) => path.endsWith('manrope-latin-wght-normal.woff2'),
    rolldownOptions: {
      output: { entryFileNames: 'overlay.js', assetFileNames: 'overlay[extname]' },
    },
  },
});
