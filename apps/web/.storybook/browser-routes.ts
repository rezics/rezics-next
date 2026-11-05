import { tanStackRouterCodeSplitter } from '@tanstack/router-plugin/vite';
import { generateRoutes } from './route-generation.ts';

export async function browserRoutes(app: string) {
  // Start uses this public client-route transform to remove native HTTP handlers and their imports.
  // Keep UI components/loaders eager and the existing recorded server-function adapter in charge.
  return tanStackRouterCodeSplitter(
    {
      target: 'react',
      codeSplittingOptions: {
        deleteNodes: ['ssr', 'server', 'headers'],
        defaultBehavior: [],
        addHmr: false,
      },
      plugin: { vite: { environmentName: 'client' } },
    },
    { routesByFile: await generateRoutes(app) },
  );
}
