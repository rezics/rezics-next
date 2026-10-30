import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const appRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(appRoot, '../..');
const mockRoot = resolve(appRoot, 'tests/fixtures/reaction-mocks');

/** A component-only Vite surface with write actions replaced by local fakes. */
export default defineConfig({
  root: appRoot,
  server: {
    fs: { allow: [workspaceRoot, realpathSync(resolve(workspaceRoot, 'node_modules'))] },
  },
  optimizeDeps: { entries: ['tests/fixtures/subject-reactions-phone.html'] },
  resolve: {
    alias: [
      { find: './composer', replacement: resolve(mockRoot, 'composer.ts') },
      { find: '../threads/composer', replacement: resolve(mockRoot, 'composer.ts') },
      { find: './reactions', replacement: resolve(mockRoot, 'reactions.ts') },
      { find: './reaction-request', replacement: resolve(mockRoot, 'reaction-request.ts') },
      { find: './actions', replacement: resolve(mockRoot, 'report-actions.ts') },
    ],
  },
  plugins: [react(), tailwindcss()],
});
