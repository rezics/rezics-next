import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const headers = fileURLToPath(new URL('./next-headers.ts', import.meta.url));
const net = fileURLToPath(new URL('./node-net.ts', import.meta.url));

// Storybook's base Vite config. Without it Storybook would load apps/web/vite.config.ts,
// whose vinext, React Server and Workers plugins have no place in the browser-only
// component runtime. main.ts viteFinal adds what the dev server needs.
// `next/headers` stays here for that dev server. Vitest does not load this file;
// apps/web/vitest.config.ts repeats the alias for the story project.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^next\/headers$/, replacement: headers },
      { find: 'node:net', replacement: net },
    ],
  },
});
