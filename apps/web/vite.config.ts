import { viteNonceMarker } from './src/security/headers.ts';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

const configuredInspectorPort = process.env.WORKER_INSPECTOR_PORT;
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
  html: { cspNonce: viteNonceMarker },
  // Fonts must stay on the site origin; the page policy does not allow data: fonts.
  build: { assetsInlineLimit: 0 },
  optimizeDeps: {
    // Scan every browser route so its imported client components are pre-bundled before the first request.
    entries: ['src/routes/**/*.tsx'],
    include: ['@rezics/ui > @ark-ui/react/fieldset', '@rezics/ui > @ark-ui/react/select'],
  },
  plugins: [
    paraglideVitePlugin({ project: './project.inlang' }),
    tanstackStart(),
    react(),
    tailwindcss(),
    ...cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort }),
  ],
});
