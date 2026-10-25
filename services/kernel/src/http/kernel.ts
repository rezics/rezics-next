import { definitionRoutes } from '../semantic/http/definitions.ts';
import { createApp } from './app.ts';
import { subjectRoutes } from './subjects.ts';

export type KernelDependencies = Parameters<typeof createApp>[0] & { routeKey: Uint8Array };

/** The route key must stay the same across restarts, or retries lose their receipts. */
export function createKernel(dependencies: KernelDependencies) {
  return definitionRoutes(subjectRoutes(createApp(dependencies), dependencies), dependencies);
}

/** The app's type is the Eden contract. */
export type Kernel = ReturnType<typeof createKernel>;
