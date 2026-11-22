import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [tailwindcss()],
  build: { outDir: '.temp/app/renderer', assetsInlineLimit: 0 },
});
