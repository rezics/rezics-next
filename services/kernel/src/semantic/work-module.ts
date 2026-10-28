import { startRelays } from '../events/relays.ts';
import type { WorkModule } from '../work/registry.ts';
import { linkProjection } from './links.ts';

/** Native relation projection shares the worker pool and registered service lifecycle. */
export const semanticWorkModule: WorkModule = {
  name: 'semantic',
  register(context) {
    context.addService(() => startRelays(context.pool, [linkProjection(context.pool)]));
  },
};
