/** Concrete Collection Source operations for scoped Search. Bound at composition, never at module load. */

import type { Pool } from 'pg';
import type { Bound } from '@rezics/bounds';
import type { Access } from '../../request/access.ts';
import { currentOperationalResources } from '../../command/operational.ts';
import { createCollectionSource } from '../collection-source.ts';
import { NativeCollectionWork } from '../collection-native-work.ts';
import { nativeCollectionOrdinalPageBound } from '../collection-source-native.ts';
import { readCollectionSourceWorkGroup, readCollectionSourceWorkState } from '../collection-source-work-native.ts';
import { createMembersPreparation } from '../members-preparation.ts';
import { CANONICAL_SOURCE_RECEIVING_COST } from '../canonical-source-bounds.ts';
import { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from '../contract/source.ts';
import type {
  CanonicalSourceReceivingCost,
  CollectionSource,
  CollectionSourceLimits,
  CollectionSourceRawKey,
  WorkAllowance,
  WorkDimensions,
} from '../contract/index.ts';
import type { MembersPreparationWorkContext, ScopeWorkContext } from './preparation-work.ts';
import type { CollectionSourceWorkState } from '../collection-source-work-native.ts';

function workOf(bound: Bound): WorkDimensions {
  return Object.freeze({
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
  });
}

export type ScopedCollectionSourceDeps = Readonly<{
  pool: Pool;
  access: Access;
  clock?: () => Date;
}>;

export type ScopedCollectionSourceWorkGroup = Awaited<ReturnType<typeof readCollectionSourceWorkGroup>>;

export type ScopedSearchLibraryOperations = Readonly<{
  source: Readonly<{
    open: (deps: ScopedCollectionSourceDeps) => CollectionSource;
    readWorkState: (
      pool: Pool,
      work: ScopeWorkContext,
      options: Readonly<{ access: Access; deadline: number }>,
    ) => Promise<CollectionSourceWorkState>;
    readWorkGroup: (
      work: ScopeWorkContext,
      state: CollectionSourceWorkState,
      subjectId: string,
      after: CollectionSourceRawKey | null,
      limit: number,
      options: Readonly<{ deadline: number }>,
    ) => Promise<ScopedCollectionSourceWorkGroup>;
    limits: CollectionSourceLimits;
  }>;
  members: Readonly<{
    createWork: (allowance: WorkAllowance, deadline: number) => NativeCollectionWork;
    readWorkDefinition: (
      work: MembersPreparationWorkContext,
      options: Readonly<{ pool: Pool; access: Access; deadline: number }>,
    ) => ReturnType<ReturnType<typeof createMembersPreparation>['readWorkDefinition']>;
  }>;
}>;

function receivingCost(cost: ReturnType<typeof CANONICAL_SOURCE_RECEIVING_COST>): CanonicalSourceReceivingCost {
  return Object.freeze({
    state: workOf(cost.state),
    seek: workOf(cost.seek),
    group: (limit: number) => workOf(cost.group(limit)),
  });
}

/** Construct native Source, Members getter, limits and receiving costs for one Search application. */
export function createScopedSearchLibraryOperations(): ScopedSearchLibraryOperations {
  const receiving = CANONICAL_SOURCE_RECEIVING_COST();
  return Object.freeze({
    source: Object.freeze({
      open(deps: ScopedCollectionSourceDeps): CollectionSource {
        return createCollectionSource(deps) as CollectionSource;
      },
      readWorkState: readCollectionSourceWorkState,
      readWorkGroup: readCollectionSourceWorkGroup,
      limits: Object.freeze({
        collectionWorkGroupLimit: COLLECTION_SOURCE_WORK_GROUP_LIMIT,
        ordinalPageBound: nativeCollectionOrdinalPageBound,
        receivingCost: receivingCost(receiving),
      }),
    }),
    members: Object.freeze({
      createWork: (allowance: WorkAllowance, deadline: number) => new NativeCollectionWork(allowance, deadline),
      async readWorkDefinition(
        work: MembersPreparationWorkContext,
        options: Readonly<{ pool: Pool; access: Access; deadline: number }>,
      ) {
        const resources = currentOperationalResources(work.tx);
        return createMembersPreparation({
          pool: resources.pool,
          workClient: resources.workClient,
          access: options.access,
        }).readWorkDefinition(work.tx, work.locator);
      },
    }),
  });
}

export type { CollectionSourceWorkState };
export type { CollectionSourceRawKey };
