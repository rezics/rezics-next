/** Search preparation adapter. Bound only at composition so Library applications do not import Search. */

import type { FilterDocument } from '@rezics/filter';
import { compileCurrentOwnerFilter } from '../../search/current-filter-plan.ts';
import { createSearchScopeForService, type SearchService } from '../../search/service-scope.ts';
import type { PreparedSearchScope, SearchPreparationCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import type { WorkAllowance } from '../contract/work-dimensions.ts';
import type { NativeSourceIdentity } from '../native-source-custody.ts';

export function createSearchPreparationAdapter(search?: unknown): SearchPreparationCapability {
  return {
    async prepareScope(input) {
      const service = (input.search as SearchService | undefined) ?? (search as SearchService | undefined);
      if (!service) throw new TypeError('The registered Search service is not configured.');
      const scope = createSearchScopeForService(service, {
        access: input.access,
        actor: input.actor,
        routeKey: input.routeKey,
        nativeT: input.nativeT,
        deadline: input.deadline,
      } as Parameters<typeof createSearchScopeForService>[1]);
      const identity = input.identity as NativeSourceIdentity | undefined;
      const prepared = await scope.prepare(input.filter as FilterDocument, {
        releaseDigest: input.releaseDigest,
        order: identity ? { kind: 'id', source: identity } : { kind: 'id' },
        allowance: input.allowance,
        readOnly: true,
      });
      return { prepared, work: scope.work(prepared), scope } as PreparedSearchScope;
    },
    ownerFilterHasOwnerLeaf(filter: unknown) {
      return compileCurrentOwnerFilter(filter as FilterDocument).leaves.some((leaf) => leaf.kind === 'owner');
    },
  };
}

export type { LibraryActor, WorkAllowance };
