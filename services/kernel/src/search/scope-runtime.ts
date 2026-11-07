import type { WorkContext } from '../work/registry.ts';
import type { ScopeRuntime } from './service-scope.ts';

export const collectionPublicationScopeRuntimes = new WeakMap<WorkContext, ScopeRuntime>();

/** The Library consumer borrows this worker's existing Search client and rated source for a guarded step. */
export function collectionPublicationScopeRuntime(context: WeakKey): ScopeRuntime | undefined {
  return collectionPublicationScopeRuntimes.get(context as WorkContext);
}
