/** Search preparation adapter. Bound only at composition so Library applications do not import Search. */

import type { FilterDocument } from '@rezics/filter';
import { compileCurrentOwnerFilter } from '../../search/current-filter-plan.ts';
import { createSearchScopeForService, type SearchService } from '../../search/service-scope.ts';
import type { SearchPreparationCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
import type { WorkAllowance, WorkReceipt } from '../contract/work-dimensions.ts';

export function createSearchPreparationAdapter(search?: unknown): SearchPreparationCapability {
  return {
    async prepareScope(input) {
      const service = (input.search as SearchService | undefined) ?? search;
      if (!service) throw new TypeError('The registered Search service is not configured.');
      const scope = createSearchScopeForService(service, {
        access: input.access as Parameters<typeof createSearchScopeForService>[1]['access'],
        actor: input.actor as Parameters<typeof createSearchScopeForService>[1]['actor'],
        routeKey: input.routeKey,
        nativeT: input.nativeT as Parameters<typeof createSearchScopeForService>[1]['nativeT'],
        deadline: input.deadline,
      });
      const prepared = await scope.prepare(input.filter as FilterDocument, {
        releaseDigest: input.releaseDigest,
        order: { kind: 'id', source: input.identity as { digest: string } },
        allowance: input.allowance,
        readOnly: true,
      });
      const work = scope.work(prepared) as WorkReceipt;
      return { prepared, work, scope };
    },
    ownerFilterHasOwnerLeaf(filter: unknown) {
      return compileCurrentOwnerFilter(filter as FilterDocument).leaves.some((leaf) => leaf.kind === 'owner');
    },
  };
}

export type { LibraryActor, WorkAllowance };
