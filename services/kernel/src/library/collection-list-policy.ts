import { peekLibraryDomain } from './domain-binding.ts';
import { specializeCollectionList } from '../access/adapters/collection-policy.ts';
import type { CollectionListFilter } from './contract/index.ts';

export type { CollectionListFilter };

/** Bind the native full-view qualification or retain the indexed public floor as row data. */
export function specializeCollectionListPolicy(access: unknown, fullView: boolean): CollectionListFilter {
  const composed = peekLibraryDomain()?.authorization.specializeCollectionList;
  if (composed) return composed({ access, fullView });
  return specializeCollectionList({ access, fullView });
}
