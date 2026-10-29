import { viteNonceMarker } from './src/security/headers.ts';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

const configuredInspectorPort = process.env.WORKER_INSPECTOR_PORT;
const testStateDirectory = process.env.WEB_TEST_STATE_DIR;
let inspectorPort: number | false = false;
if (configuredInspectorPort !== undefined) {
  const parsedInspectorPort = Number(configuredInspectorPort);
  if (
    !/^\d+$/.test(configuredInspectorPort) ||
    !Number.isInteger(parsedInspectorPort) ||
    parsedInspectorPort < 1 ||
    parsedInspectorPort > 65535
  ) {
    throw new Error(
      `WORKER_INSPECTOR_PORT must be an integer from 1 to 65535; received ${JSON.stringify(configuredInspectorPort)}`,
    );
  }
  inspectorPort = parsedInspectorPort;
}

export default defineConfig({
  server: {
    // The native stack binds 127.0.0.1 in an isolated network; publication tests prove a foreign Host never reaches page URLs.
    allowedHosts: process.env.WEB_DEV_ALLOW_ANY_HOST === '1' ? true : undefined,
  },
  html: { cspNonce: viteNonceMarker },
  // Fonts must stay on the site origin; the page policy does not allow data: fonts.
  build: { assetsInlineLimit: 0 },
  optimizeDeps: {
    // Scan the complete route graph up front so a local Worker browser check never discovers a route dependency
    // after the first page has loaded.
    entries: ['src/routes/**/*.tsx'],
    holdUntilCrawlEnd: true,
  },
  ssr: {
    optimizeDeps: {
      include: ['@inlang/paraglide-js/urlpattern-polyfill'],
    },
  },
  plugins: [
    {
      name: 'generate-localization',
      async config(_config, { command }) {
        // Create generated localization modules before Vite scans the browser routes.
        if (command === 'serve') await import('./scripts/generate.ts');
      },
    },
    paraglideVitePlugin({ project: './project.inlang' }),
    tanstackStart(),
    react(),
    tailwindcss(),
    ...cloudflare({
      viteEnvironment: { name: 'ssr' },
      inspectorPort,
      ...(testStateDirectory ? { persistState: { path: testStateDirectory } } : {}),
    }),
  ],
});
