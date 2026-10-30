import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare, getLocalWorkerdCompatibilityDate } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { viteNonceMarker } from './src/security/headers.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';

const appRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig((context) => {
  const { command } = context;
  const persistence = createWorkerPersistence('auth', context, appRoot);
  return {
    base: command === 'serve' ? '/' : '/auth-assets/',
    html: { cspNonce: viteNonceMarker },
    // Fonts stay on the page origin under default-src 'self'.
    build: { assetsInlineLimit: 0 },
    server: { cors: false },
    define: {
      __AUTH_ORIGIN__: JSON.stringify(command === 'serve' ? (process.env.AUTH_ORIGIN ?? '') : ''),
    },
    plugins: [
      paraglideVitePlugin({ project: './project.inlang' }),
      tanstackStart({ router: { basepath: '/' } }),
      react(),
      tailwindcss(),
      ...cloudflare({
        viteEnvironment: { name: 'ssr' },
        // The production bundle must also run in the installed workerd during preview.
        config: { compatibilityDate: getLocalWorkerdCompatibilityDate().date },
        ...(persistence.directory ? { persistState: { path: persistence.directory } } : {}),
      }),
      ...(persistence.cleanupPlugin ? [persistence.cleanupPlugin] : []),
    ],
  };
});
