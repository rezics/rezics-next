import { memoizedValue } from '../memoized.ts';
import type { FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { scopeAllowance, ScopeWork } from '../search/scope-execution.ts';
import { createSearchScopeForService, type SearchService } from '../search/service-scope.ts';
import { readCanonicalSourceGroup, readCanonicalSourceState, type CanonicalWork } from './canonical-source-store.ts';
import {
  createCollectionSource,
  createOrdinaryCollectionPageSource,
  type WorkAllowance,
  type WorkReceipt,
  type WorkDimensions,
} from './collection-source.ts';
import { readNativeCollectionScopeIdentity } from './collection-source-native.ts';
import {
  ordinaryCollectionPagePlan,
  ordinaryPageWorkDimensions,
  type OrdinaryCollectionPagePlan,
} from './ordinary-read-bounds.ts';

export type OwnerQueryDependencies = {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
  routeKey?: Uint8Array;
  search?: SearchService;
};

class OwnerQueryWorkLedger extends ScopeWork {
  constructor(readonly plan: OrdinaryCollectionPagePlan) {
    super(scopeAllowance(plan.candidateLimit, crypto.randomUUID(), ordinaryPageWorkDimensions(plan.total)));
  }

  override consume(used: WorkDimensions): void {
    try {
      super.consume(used);
    } catch (error) {
      if (error instanceof RangeError)
        throw new ProblemError('dependency_unavailable', {
          detail: error.message,
        });
      throw error;
    }
  }
}

function OwnerQueryWork() {
  return memoizedValue(OwnerQueryWork, () => OwnerQueryWorkLedger);
}
type OwnerQueryWork = InstanceType<ReturnType<typeof OwnerQueryWork>>;

/** Canonical and Search work settle into the same request reservation, including failed dispatches. */
export function ownerQueryWork(limit: number, view: 'BASIC' | 'FULL' = 'BASIC') {
  return new (OwnerQueryWork())(ordinaryCollectionPagePlan(limit, view));
}

function canonicalAllowance(allowance: WorkAllowance) {
  const remaining = allowance.remaining;
  return {
    reservationId: allowance.reservationId,
    rawKeys: 100,
    nativeRows: remaining.nativeRows,
    nativePoints: remaining.nativePoints,
    emptySeeks: remaining.emptySeeks,
    statements: remaining.statements,
    bytes: remaining.bytes,
    identityMetadataRows: remaining.identityMetadataRows,
  };
}
function canonicalReceipt(work: CanonicalWork): WorkReceipt {
  return {
    reservationId: work.reservationId,
    used: {
      candidateKeys:
        work.candidateKeys + work.aliasKeys + work.duplicateKeys + work.lookaheadKeys + work.internalDriverKeys,
      nativeRows: work.nativeRows,
      nativePoints: work.nativePoints,
      statements: work.statements,
      bytes: work.bytes,
      emptySeeks: work.emptySeeks,
      identityMetadataRows: work.identityMetadataRows,
      witnessKeys: 0,
    },
  };
}

/** One current native Source and the registered Search service. No owner/client impersonation or GET work. */
export async function openOwnerQuery(
  deps: OwnerQueryDependencies,
  input: {
    actor: Actor;
    collectionId: string;
    deadline: number;
    work: ScopeWork;
    logical?: boolean;
    at?: AuthoritativeTime;
  },
) {
  const clock = deps.clock ?? systemClock;
  const at = input.at ?? (await withConnection(deps.pool, (client) => mintReadTime(client, clock)));
  const close = () => {
    if (input.at === undefined) releaseOperationalTime(at);
  };
  const planned = input.work instanceof OwnerQueryWork() ? input.work.plan : undefined;
  const native = planned ? createOrdinaryCollectionPageSource(deps) : createCollectionSource(deps);
  const context = { actor: input.actor, at, deadline: input.deadline };
  const sourceAllowance = (): WorkAllowance => ({
    reservationId: input.work.receipt().reservationId,
    remaining: planned ? ordinaryPageWorkDimensions(planned.sourceBound) : input.work.remaining().remaining,
  });
  try {
    let prepared;
    try {
      prepared = await native.prepare({
        ...context,
        collectionId: input.collectionId,
        allowance: sourceAllowance(),
      });
    } catch (error) {
      // The logical descriptor was admitted independently. A missing native producer is not a missing Collection.
      if (input.logical && error instanceof ProblemError && error.code === 'not_found')
        throw new ProblemError('dependency_unavailable', {
          detail: 'The native Collection Source has no current logical built-in binding.',
        });
      throw error;
    }
    input.work.native(prepared.work);
    const source = prepared.source;
    return {
      source,
      native,
      context,
      close() {
        close();
      },
      /** Complete native group, never a point mapping used as alias/population coverage. */
      async originals(subjectId: string) {
        const route = routeOf(input.collectionId)!;
        const state = await readCanonicalSourceState(deps.pool, {
          route,
          collectionId: input.collectionId,
          deadline: input.deadline,
          allowance: canonicalAllowance(sourceAllowance()),
        });
        input.work.native(canonicalReceipt(state.work));
        if (state.state !== 'ready' || state.basis.digest !== source.observation.basis.digest)
          throw new ProblemError('semantic_not_ready');
        const group = await readCanonicalSourceGroup(deps.pool, {
          route,
          collectionId: input.collectionId,
          deadline: input.deadline,
          allowance: canonicalAllowance(sourceAllowance()),
          basis: state.basis,
          progress: {
            pendingSubjectId: subjectId,
            after: null,
            generation: state.generation,
            basis: state.basis,
          },
        });
        input.work.native(canonicalReceipt(group.work));
        if (group.state !== 'ready' || !group.exhausted) throw new ProblemError('dependency_unavailable');
        return [...new Set(group.rows.map((row) => row.key.storedSubjectId))];
      },
      async filter(filter: FilterDocument, releaseDigest: string) {
        if (!deps.search || !deps.routeKey)
          throw new ProblemError('dependency_unavailable', {
            detail: 'The registered Search service is not configured.',
          });
        const identity = await readNativeCollectionScopeIdentity(deps.pool, {
          route: source.observation.route,
          collectionId: input.collectionId,
          deadline: input.deadline,
          allowance: sourceAllowance(),
        });
        input.work.native(identity.work);
        if (!identity.identity || identity.identity.incarnation !== source.observation.incarnation)
          throw new ProblemError('semantic_not_ready');
        const scope = createSearchScopeForService(deps.search, {
          access: deps.access,
          actor: input.actor,
          routeKey: deps.routeKey,
          nativeT: at,
          deadline: input.deadline,
        });
        const prepared = await scope.prepare(filter, {
          releaseDigest,
          order: { kind: 'id', source: identity.identity },
          allowance: sourceAllowance(),
          readOnly: true,
        });
        input.work.native(scope.work(prepared));
        return { scope, prepared };
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
