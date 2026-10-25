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
  optimizeDeps: {
    include: [
      '@ark-ui/react',
      '@ark-ui/react/menu',
      '@ark-ui/react/select',
      '@ark-ui/react/dialog',
      '@ark-ui/react/locale',
      'lucide-react',
      '@rezics/ui/menu',
      '@rezics/ui/select',
      '@rezics/ui/button',
    ],
  },
  plugins: [
    paraglideVitePlugin({ project: './project.inlang' }),
    tanstackStart(),
    react(),
    tailwindcss(),
    ...cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort }),
  ],
});
