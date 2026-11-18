import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type { FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Access, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import { routeOf } from '../route/route.ts';
import { readCanonicalSourceGroup, readCanonicalSourceState, type CanonicalWork } from './canonical-source-store.ts';
import { CANONICAL_SOURCE_COMPLETED_READBACK, CANONICAL_SOURCE_RECEIVING_COST } from './canonical-source-bounds.ts';
import { CANONICAL_SOURCE_RAW_KEY_LIMIT } from './canonical-source-limits.ts';
import { collectionAuthorizationPreparationWork } from './access-port.ts';
import { createCollectionSource, createOrdinaryCollectionPageSource } from './collection-source.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
import type { SearchPreparationCapability } from './contract/index.ts';
import { readNativeCollectionScopeIdentity } from './collection-source-native.ts';
import {
  type CollectionWorkLedger,
  WORK_AXES,
  zeroWorkDimensions,
  ordinaryCollectionPagePlan,
  ordinaryPageWorkDimensions,
  type OrdinaryCollectionPagePlan,
} from './core/index.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import { peekLibraryDomain } from './domain-binding.ts';

export type OwnerQueryDependencies = {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
  routeKey?: Uint8Array;
  search?: unknown;
  searchPreparation?: SearchPreparationCapability;
};

class OwnerQueryWorkLedger {
  readonly plan: OrdinaryCollectionPagePlan;
  readonly physical: NativeCollectionWork;

  constructor(plan: OrdinaryCollectionPagePlan, deadline: number) {
    this.plan = plan;
    this.physical = new NativeCollectionWork(
      {
        reservationId: crypto.randomUUID(),
        remaining: ordinaryPageWorkDimensions(plan.total),
      },
      deadline,
    );
  }

  remaining(): WorkAllowance {
    const remaining = { ...zeroWorkDimensions() };
    for (const axis of WORK_AXES) remaining[axis] = this.physical.available(axis);
    return { reservationId: this.receipt().reservationId, remaining };
  }

  sourceAllowance(): WorkAllowance {
    const spent = this.receipt();
    const remaining = { ...ordinaryPageWorkDimensions(this.plan.sourceBound) };
    for (const axis of WORK_AXES) remaining[axis] = Math.max(0, remaining[axis] - spent.used[axis]);
    return { reservationId: spent.reservationId, remaining };
  }

  receipt() {
    return this.physical.receipt();
  }

  consume(used: WorkDimensions): void {
    const charge = this.physical.reserve(used);
    charge.dispatch();
    charge.settle();
  }

  native(receipt: WorkReceipt): void {
    if (receipt.reservationId !== this.receipt().reservationId) throw new TypeError('Foreign owner page reservation');
    this.consume(receipt.used);
  }
}

/** Canonical and Search work settle into the same request reservation, including failed dispatches. */
export function ownerQueryWork(
  limit: number,
  view: 'BASIC' | 'FULL' = 'BASIC',
  deadline = deadlineFor(WORK_STEP_DEADLINE_MS),
) {
  return new OwnerQueryWorkLedger(ordinaryCollectionPagePlan(limit, view), deadline);
}

/** Continue reads chronological candidates, resolves whole Source groups, and verifies shown rows again. */
export function continueOwnerQueryWork(limit: number, deadline = deadlineFor(WORK_STEP_DEADLINE_MS)) {
  const page = ordinaryCollectionPagePlan(limit);
  const checks = page.candidateLimit + limit;
  const sourceReads = 2 + 3 * checks;
  const cost = (axes: Partial<Bound>) => declareBound({ ...zeroWorkDimensions(), engineRequests: 0, ...axes });
  const sourceBound = sumBounds(
    page.sourceBound,
    repeatBound(
      sumBounds(
        CANONICAL_SOURCE_COMPLETED_READBACK(),
        declareBound(collectionAuthorizationPreparationWork()),
        cost({ nativeRows: 128, nativePoints: 24, statements: 24, emptySeeks: 16, bytes: 48 * 1024 }),
      ),
      sourceReads,
    ),
    repeatBound(
      cost({ ...CANONICAL_SOURCE_RECEIVING_COST().group(CANONICAL_SOURCE_RAW_KEY_LIMIT), candidateKeys: 0 }),
      2 * checks,
    ),
    // Membership may probe, resolve and recheck each original. Eligibility also resolves the original,
    // reads its owner facts and interprets both accepted pins, all settled against the same raw-key cap.
    repeatBound(
      cost({ nativeRows: 16_640, nativePoints: 300, statements: 300, emptySeeks: 24, bytes: 3 * 1024 * 1024 }),
      page.candidateLimit,
    ),
  );
  return new OwnerQueryWorkLedger({ ...page, sourceBound, total: sourceBound }, deadline);
}

function canonicalAllowance(allowance: WorkAllowance) {
  const remaining = allowance.remaining;
  return {
    reservationId: allowance.reservationId,
    rawKeys: Math.min(100, remaining.candidateKeys),
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

function searchPreparationOf(deps: OwnerQueryDependencies): SearchPreparationCapability {
  return (
    deps.searchPreparation ??
    peekLibraryDomain()?.searchPreparation ?? {
      async prepareScope() {
        throw new ProblemError('dependency_unavailable', {
          detail: 'The registered Search service is not configured.',
        });
      },
      ownerFilterHasOwnerLeaf() {
        return false;
      },
      filterLeaves() {
        return [];
      },
    }
  );
}

/** One current native Source and the registered Search service. No owner/client impersonation or GET work. */
export async function openOwnerQuery(
  deps: OwnerQueryDependencies,
  input: {
    actor: Actor;
    collectionId: string;
    deadline: number;
    work: Pick<CollectionWorkLedger, 'remaining' | 'receipt' | 'native'>;
    logical?: boolean;
    publishedEverythingPage?: boolean;
    at?: AuthoritativeTime;
  },
) {
  const clock = deps.clock ?? systemClock;
  const at = input.at ?? (await withConnection(deps.pool, (client) => mintReadTime(client, clock)));
  const close = () => {
    if (input.at === undefined) releaseOperationalTime(at);
  };
  const planned = input.work instanceof OwnerQueryWorkLedger ? input.work.plan : undefined;
  const native = planned
    ? createOrdinaryCollectionPageSource(deps, input.publishedEverythingPage)
    : createCollectionSource(deps);
  const context = { actor: input.actor, at, deadline: input.deadline };
  const sourceAllowance = () =>
    input.work instanceof OwnerQueryWorkLedger ? input.work.sourceAllowance() : input.work.remaining();
  try {
    let prepared;
    try {
      const domain = peekLibraryDomain();
      if (domain) {
        prepared = await domain.sourceCapture.capture({
          actor: input.actor,
          collectionId: input.collectionId,
          deadline: input.deadline,
          at,
          allowance: sourceAllowance(),
          source: native,
          ...(input.logical !== undefined ? { logical: input.logical } : {}),
          ordinaryPage: Boolean(planned),
        });
      } else {
        if (input.logical)
          throw new ProblemError('dependency_unavailable', {
            detail: 'Logical built-ins require the registered Library Source Capture.',
          });
        prepared = await native.prepare({
          ...context,
          collectionId: input.collectionId,
          allowance: sourceAllowance(),
          ...(input.logical !== undefined ? { logical: input.logical } : {}),
        });
      }
    } catch (error) {
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
        let identity = source.observation.sourceIdentity;
        if (!source.queryCapture) {
          const current = await readNativeCollectionScopeIdentity(deps.pool, {
            route: source.observation.route,
            collectionId: input.collectionId,
            deadline: input.deadline,
            allowance: sourceAllowance(),
          });
          input.work.native(current.work);
          if (!current.identity || current.identity.incarnation !== source.observation.incarnation)
            throw new ProblemError('semantic_not_ready');
          identity = current.identity;
        }
        const preparedScope = await searchPreparationOf(deps).prepareScope({
          search: deps.search,
          access: deps.access,
          actor: input.actor,
          routeKey: deps.routeKey,
          nativeT: at,
          deadline: input.deadline,
          filter,
          releaseDigest,
          identity,
          allowance: sourceAllowance(),
        });
        input.work.native(preparedScope.work);
        return { scope: preparedScope.scope, prepared: preparedScope.prepared };
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
