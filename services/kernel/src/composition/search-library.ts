/** Concrete binding for Search's consumer-owned scoped Collection capability. */

import type { Access } from '../request/access.ts';
import type { Pool } from 'pg';
import {
  createMembersWorkDefinitionApplication,
  createOrderedCollectionSourceApplication,
} from '../library/application/index.ts';
import type { MembersPreparationWorkContext, MembersPreparationWorkDefinition } from '../library/adapters/index.ts';
import { createSearchLibraryScopePort as createSearchLibraryOperations } from '../search/adapters/index.ts';
import type { SearchCollectionSourceDeps, SearchLibraryScopePort, SearchScopeWorkOptions } from '../search/index.ts';

export { createNativeLibraryScopeWork } from '../search/adapters/index.ts';

/** Installed root: application facades over constructed Library operations, limits and receiving costs. */
export function createSearchLibraryScopePort(): SearchLibraryScopePort {
  const operations = createSearchLibraryOperations();
  const membersDefinition = createMembersWorkDefinitionApplication<MembersPreparationWorkDefinition>({
    readWorkDefinition: (input) =>
      operations.members.readWorkDefinition(input.work as MembersPreparationWorkContext, {
        pool: input.pool as Pool,
        access: input.access as Access,
        deadline: input.deadline,
      }),
  });
  const source = operations.source;
  const members = operations.members;
  return Object.freeze({
    source: Object.freeze({
      open: (deps: SearchCollectionSourceDeps) => createOrderedCollectionSourceApplication(source.open(deps)),
      readWorkState: source.readWorkState,
      readWorkGroup: source.readWorkGroup,
      limits: source.limits,
    }),
    members: Object.freeze({
      createWork: members.createWork,
      readWorkDefinition: (work: MembersPreparationWorkContext, options: SearchScopeWorkOptions) =>
        membersDefinition.readWorkDefinition({
          work,
          pool: options.pool,
          access: options.access,
          deadline: options.deadline,
        }),
    }),
  });
}
