import { Generator, getConfig } from '@tanstack/router-generator';
import { fileURLToPath } from 'node:url';

export async function generateRoutes(app: string) {
  // Production uses tanstackStart() without options: its router paths and filename/parameter rules are
  // the generator defaults. Keep Start's public Register augmentation for the actual router/start entries.
  const config = getConfig(
    {
      target: 'react',
      tmpDir: fileURLToPath(new URL('../../../.temp/web-route-generation', import.meta.url)),
      routeTreeFileFooter: [
        "import type { getRouter } from './router.tsx'",
        "import type { startInstance } from './start.ts'",
        "declare module '@tanstack/react-start' {",
        '  interface Register {',
        '    ssr: true',
        '    router: Awaited<ReturnType<typeof getRouter>>',
        '    config: Awaited<ReturnType<typeof startInstance.getOptions>>',
        '  }',
        '}',
      ],
    },
    app,
  );
  // A single generator pass owns the output. It allocates no server or watcher, and failures must reject.
  const generator = new Generator({ config, root: app });
  await generator.run();
  return generator.getRoutesByFileMap();
}
