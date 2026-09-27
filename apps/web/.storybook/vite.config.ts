import { defineConfig } from 'vite';

// Storybook's base Vite config. Without it Storybook would load apps/web/vite.config.ts,
// whose vinext, React Server and Workers plugins have no place in the browser-only
// component runtime. main.ts viteFinal adds what stories need, for Vitest as well.
export default defineConfig({});
