import type { WorkContext } from '../work/registry.ts';
import type { ScopeRuntime } from './service-scope.ts';

export const collectionPublicationScopeRuntimes = new WeakMap<WorkContext['pool'], ScopeRuntime>();

/** Worker modules have separate registration contexts around the same pool. */
export function collectionPublicationScopeRuntime(context: Pick<WorkContext, 'pool'>): ScopeRuntime | undefined {
  return collectionPublicationScopeRuntimes.get(context.pool);
}
