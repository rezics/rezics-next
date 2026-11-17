import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare, getLocalWorkerdCompatibilityDate } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { messageImports } from '../web/scripts/message-imports.ts';
import { viteNonceMarker } from './src/security/headers.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerPersistence } from '../../scripts/worker-persistence.ts';

const appRoot = dirname(fileURLToPath(import.meta.url));
const generatedMessages = normalizePath(resolve(appRoot, 'src/paraglide'));

export default defineConfig(async (context) => {
  const { command } = context;
  const testServe = command === 'serve' && process.env.REZICS_TEST_RUNTIME === '1';
  const preparedMessages = testServe && process.env.REZICS_AUTH_PREPARED_MESSAGES === '1';
  const messages = preparedMessages
    ? []
    : [
        (await import('@inlang/paraglide-js')).paraglideVitePlugin({
          project: './project.inlang',
          outputStructure: 'message-modules',
        }),
      ];
  const persistence = createWorkerPersistence('auth', context, appRoot);
  return {
    base: command === 'serve' ? '/' : '/auth-assets/',
    html: { cspNonce: viteNonceMarker },
    // Fonts stay on the page origin under default-src 'self'.
    build: { assetsInlineLimit: 0 },
    server: {
      cors: false,
      allowedHosts: ['rezics.com'],
      // The finite test runtime serves a fixed catalogue. Rewriting its generated files can
      // queue a Worker entry reload per message while the browser waits for the login document.
      watch: process.env.REZICS_TEST_RUNTIME === '1' ? { ignored: `${generatedMessages}/**` } : undefined,
    },
    optimizeDeps: {
      // Discover lazy route dependencies before a person starts entering credentials.
      // A late optimizer reload replaces the document and retires the mounted journey.
      entries: ['src/routes/**/*.tsx'],
      holdUntilCrawlEnd: true,
    },
    ssr: {
      optimizeDeps: {
        include: ['@inlang/paraglide-js/urlpattern-polyfill'],
      },
    },
    define: {
      'import.meta.env.PUBLIC_ORIGIN': JSON.stringify(process.env.PUBLIC_ORIGIN ?? 'https://rezics.com'),
      __AUTH_ORIGIN__: JSON.stringify(command === 'serve' ? (process.env.AUTH_ORIGIN ?? '') : ''),
    },
    plugins: [
      // The native harness owns the generated catalogue before this Worker is launched.
      ...messages,
      messageImports(appRoot),
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
