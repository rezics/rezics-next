import type { OperationGate } from '../api/platform-access.ts';
import { idOf } from '../discover/scope.ts';
import type { SavedFilterApi } from '../saved-filter/api.ts';
import type { CommandResult, SavedFilter } from '../saved-filter/types.ts';

/** Public topic follows have their own tab identity; Saved Filters are an optional, separate capability. */
export async function followHomeTopic(api: SavedFilterApi, concept: string): Promise<CommandResult<{ tab: string }>> {
  const tab = idOf(concept);
  if (!tab) return { ok: false, failure: 'unavailable' };
  const followed = await api.followConcept(concept, true);
  return followed.ok ? { ok: true, data: { tab } } : followed;
}

/** Recheck at invocation so an open picker cannot send a write after the grant disappears. */
export const pinHomeFilter = (api: SavedFilterApi, filter: SavedFilter, operationOpen: OperationGate) =>
  operationOpen('getV1MeSaved-filters') && operationOpen('patchV1MeSaved-filtersById') ? api.update(filter, { pinned: true })
    : Promise.resolve({ ok: false, failure: 'closed' } as const);

export const saveHomeFilter = (api: SavedFilterApi, input: Parameters<SavedFilterApi['create']>[0], operationOpen: OperationGate) =>
  operationOpen('getV1MeSaved-filters') && operationOpen('postV1MeSaved-filters') ? api.create(input)
    : Promise.resolve({ ok: false, failure: 'closed' } as const);
