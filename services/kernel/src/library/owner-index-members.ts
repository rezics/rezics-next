import type { FilterDocument } from '@rezics/filter';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { openOwnerQuery, ownerQueryWork, type OwnerQueryDependencies } from './builtin-runtime-query.ts';
import { systemClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import type { WorkReceipt } from './contract/work-dimensions.ts';
import type { DynamicMemberView } from './builtin-runtime.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import { ordinaryCollectionPagePlan, ordinaryPageWorkDimensions } from './ordinary-read-bounds.ts';

/** Structural/source compatibility is not disclosure. Each positive is checked by the native Source again. */
function sameSource(left: CollectionSourceObservation, right: CollectionSourceObservation) {
  return (
    left.collectionId === right.collectionId &&
    left.route === right.route &&
    left.incarnation === right.incarnation &&
    left.revision === right.revision &&
    left.stamp.epoch === right.stamp.epoch &&
    JSON.stringify(left.authority) === JSON.stringify(right.authority) &&
    JSON.stringify(left.basis) === JSON.stringify(right.basis)
  );
}

/**
 * Common canonical member caller. The delivered Source owns candidate order, alias completion,
 * original+terminal disclosure and source-scoped identity currentness. No raw-ID page is normalized here.
 */
export async function readCollectionSourceMembers(
  deps: OwnerQueryDependencies & { tokens: KeyRing },
  input: {
    actor: Actor;
    scope: 'private_builtin' | 'activated_output';
    collectionId: string;
    limit: number;
    cursor?: string | null;
    deadline: number;
    query?: { filter: FilterDocument; releaseDigest: string };
    view?: 'BASIC' | 'FULL';
    /** Actual owner-home reread after releasing all foreign source homes. */
    revalidateOwner: () => Promise<void>;
    /** Actual native source version, independent of identity and permission. */
    readSourceVersion: () => Promise<string>;
  },
): Promise<{ members: DynamicMemberView[]; next: string | null }> {
  if (input.scope === 'activated_output' && input.query) throw new ProblemError('unsupported_query');
  const clock = deps.clock ?? systemClock;
  const binding = {
    route: 'GET /v1/collections/:collectionId/members',
    viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
    query: {
      collectionId: input.collectionId,
      limit: input.limit,
      order: 'id',
      source: input.scope,
      ...(input.query
        ? {
            filter: createHash('sha256').update(canonicalize(input.query.filter)!).digest('hex'),
            release: input.query.releaseDigest,
          }
        : {}),
    },
  };
  const position = input.cursor == null ? null : await decodeListCursor(deps.tokens, binding, input.cursor, clock());
  if (
    position &&
    (!position.ok ||
      position.after.length !== 4 ||
      position.after.some((value) => typeof value !== 'string') ||
      routeOf(String(position.after[3])) === null)
  )
    throw new ProblemError('invalid_cursor');
  const pagePlan = ordinaryCollectionPagePlan(input.limit, input.view ?? 'BASIC');
  const ledger = ownerQueryWork(input.limit, input.view ?? 'BASIC');
  const pageDimensions = ordinaryPageWorkDimensions(pagePlan.sourceBound);
  const reservationId = ledger.receipt().reservationId;
  const work = {
    allowance: (keys = pagePlan.candidateLimit) => {
      return {
        reservationId,
        remaining: {
          ...pageDimensions,
          candidateKeys: Math.min(keys, pagePlan.candidateLimit),
        },
      };
    },
    settle: (receipt: WorkReceipt) => ledger.native(receipt),
  };
  const version = await input.readSourceVersion();
  const at = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
  try {
    const context = { actor: input.actor, at, deadline: input.deadline };
    let runtime;
    try {
      runtime = await openOwnerQuery(deps, {
        actor: input.actor,
        collectionId: input.collectionId,
        deadline: input.deadline,
        work: ledger,
        logical: input.scope === 'private_builtin',
        at,
      });
    } catch (error) {
      // Without a submitted continuation, a stale derived public generation is unavailable preparation.
      // It must not be returned as an old selection or inferred as an empty result.
      if (
        input.scope === 'activated_output' &&
        input.cursor == null &&
        error instanceof ProblemError &&
        error.code === 'stale_cursor'
      )
        throw new ProblemError('dependency_unavailable');
      throw error;
    }
    const prepared = runtime.source;
    const source = runtime.native;
    const filtered = input.query ? await runtime.filter(input.query.filter, input.query.releaseDigest) : null;
    const observed = prepared.observation;
    if (
      observed.authority.kind !== input.scope ||
      (observed.authority.kind === 'private_builtin' &&
        (input.actor.kind !== 'account' || observed.authority.curatorAccountId !== input.actor.accountId))
    )
      throw new ProblemError('not_found');
    let after: string | null = null;
    if (position?.ok) {
      if (
        position.epoch !== observed.stamp.epoch ||
        position.after[0] !== observed.incarnation ||
        position.after[1] !== observed.basis.digest ||
        position.after[2] !== version
      )
        throw new ProblemError('stale_cursor');
      after = String(position.after[3]);
    }
    const members: DynamicMemberView[] = [];
    let exhausted = false;
    for (let round = 0; round < 3 && members.length <= input.limit && !exhausted; round++) {
      const quota = Math.min(pagePlan.prefixGroupLimit, 2 * (input.limit - members.length) + 1);
      const prefix = filtered
        ? await filtered.scope.sourcePrefix(filtered.prepared, {
            afterSubjectId: after,
            allowance: work.allowance(quota),
          })
        : await source.prefix({
            ...context,
            source: prepared,
            allowance: work.allowance(quota),
            afterSubjectId: after,
            candidateLimit: quota,
          });
      work.settle(prefix.work);
      if (prefix.candidates.length > quota) throw new ProblemError('dependency_unavailable');
      if (!sameSource(observed, prefix.observation)) throw new ProblemError('semantic_not_ready');
      for (const candidate of prefix.candidates) {
        if (routeOf(candidate.subjectId) === null || (after !== null && candidate.subjectId <= after))
          throw new ProblemError('dependency_unavailable');
        const membership = await source.containsSubject({
          ...context,
          source: prepared,
          allowance: work.allowance(),
          subjectId: candidate.subjectId,
          positiveEvidence: candidate.evidence,
        });
        work.settle(membership.work);
        if (!sameSource(observed, membership.observation)) throw new ProblemError('semantic_not_ready');
        if (membership.result === 'not_proven') throw new ProblemError('dependency_unavailable');
        after = candidate.subjectId;
        if (membership.result) {
          if (filtered) {
            const result = await filtered.scope.evaluate(filtered.prepared, [candidate.subjectId], {
              rawKeys: Math.min(256, pagePlan.candidateLimit),
              native: {
                points: pageDimensions.nativePoints,
                witnesses: pageDimensions.witnessKeys,
                rows: pageDimensions.nativeRows,
                bytes: pageDimensions.bytes,
                emptySeeks: pageDimensions.emptySeeks,
              },
              allowance: work.allowance(),
            });
            ledger.native(filtered.scope.work(result));
            if (result.values[0] === 'not_proven') throw new ProblemError('dependency_unavailable');
            if (result.values[0] !== true) continue;
          }
          members.push({ kind: 'dynamic', subjectId: candidate.subjectId });
        }
        if (members.length > input.limit) break;
      }
      if (members.length > input.limit) break;
      exhausted = prefix.exhausted;
      if (!exhausted && prefix.coveredThrough === null) throw new ProblemError('dependency_unavailable');
      after = prefix.coveredThrough ?? after;
    }
    // A consumed raw window never establishes a short or empty nonfinal page.
    if (members.length <= input.limit && !exhausted) throw new ProblemError('dependency_unavailable');
    const shown = members.slice(0, input.limit);
    // A wait or foreign-home read cannot reuse the old T for final disclosure.
    const revalidate = async () => {
      const finalAt = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
      try {
        const finalRuntime = await openOwnerQuery(deps, {
          actor: input.actor,
          collectionId: input.collectionId,
          deadline: input.deadline,
          work: ledger,
          logical: input.scope === 'private_builtin',
          at: finalAt,
        });
        const current = finalRuntime.source;
        const finalFilter = input.query
          ? await finalRuntime.filter(input.query.filter, input.query.releaseDigest)
          : null;
        if (
          filtered &&
          finalFilter &&
          JSON.stringify(filtered.prepared.basis) !== JSON.stringify(finalFilter.prepared.basis)
        )
          throw new ProblemError('semantic_not_ready');
        if (!sameSource(observed, current.observation)) throw new ProblemError('semantic_not_ready');
        for (const member of shown) {
          const checked = await finalRuntime.native.containsSubject({
            ...context,
            at: finalAt,
            source: current,
            allowance: work.allowance(),
            subjectId: member.subjectId,
          });
          work.settle(checked.work);
          if (!sameSource(observed, checked.observation) || checked.result !== true)
            throw new ProblemError('semantic_not_ready');
        }
        if (finalFilter) {
          const checked = await finalFilter.scope.evaluate(
            finalFilter.prepared,
            shown.map((member) => member.subjectId),
            {
              rawKeys: Math.min(256, pagePlan.candidateLimit),
              native: {
                points: pageDimensions.nativePoints,
                witnesses: pageDimensions.witnessKeys,
                rows: pageDimensions.nativeRows,
                bytes: pageDimensions.bytes,
                emptySeeks: pageDimensions.emptySeeks,
              },
              allowance: work.allowance(),
            },
          );
          ledger.native(finalFilter.scope.work(checked));
          if (checked.values.length !== shown.length || checked.values.some((value) => value !== true))
            throw new ProblemError('semantic_not_ready');
        }
        await input.revalidateOwner();
        if ((await input.readSourceVersion()) !== version) throw new ProblemError('semantic_not_ready');
      } finally {
        releaseOperationalTime(finalAt);
      }
    };
    await revalidate();
    const disclosed =
      input.view === 'FULL'
        ? await attachCollectionListFacts(
            { ...deps, routeKey: requiredRouteKey(deps.routeKey), actor: input.actor, deadline: input.deadline },
            shown,
            { revalidate },
          )
        : shown;
    if (disclosed.length !== shown.length) throw new ProblemError('dependency_unavailable');
    return {
      members: disclosed,
      next:
        members.length > input.limit
          ? await encodeListCursor(
              deps.tokens,
              binding,
              {
                epoch: observed.stamp.epoch,
                after: [observed.incarnation, observed.basis.digest, version, shown.at(-1)!.subjectId],
              },
              clock(),
            )
          : null,
    };
  } finally {
    releaseOperationalTime(at);
  }
}

function requiredRouteKey(key: Uint8Array | undefined): Uint8Array {
  if (!key) throw new ProblemError('dependency_unavailable');
  return key;
}

/** Existing private built-in caller, with unchanged native owner and query authority. */
export function readOwnerMembers(
  deps: OwnerQueryDependencies & { tokens: KeyRing },
  input: Omit<Parameters<typeof readCollectionSourceMembers>[1], 'actor' | 'scope'> & { actor: AccountActor },
) {
  return readCollectionSourceMembers(deps, { ...input, scope: 'private_builtin' });
}
