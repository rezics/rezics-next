import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createCollectionSource,
  type CollectionSourceObservation,
  type PreparedCollectionSource,
  type WorkAllowance,
  type WorkReceipt,
} from './collection-source.ts';
import type { DynamicMemberView } from './builtin-runtime.ts';

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

/** One common caller ledger; native owners return actual charged work, including rejected/empty reads. */
function pageWork(limit: number) {
  const candidates = Math.min(600, 6 * limit + 3);
  const id = crypto.randomUUID();
  let remaining: WorkAllowance['remaining'] = {
    candidateKeys: candidates,
    nativeRows: 64 + 16 * candidates,
    nativePoints: 16 + 8 * candidates,
    witnessKeys: 16 + 8 * candidates,
    statements: 12,
    bytes: 80 * 1024 + 5120 * candidates,
    emptySeeks: 3,
    identityMetadataRows: 0,
  };
  return {
    allowance(candidateKeys = remaining.candidateKeys): WorkAllowance {
      return {
        reservationId: id,
        remaining: { ...remaining, candidateKeys: Math.min(candidateKeys, remaining.candidateKeys) },
      };
    },
    settle(receipt: WorkReceipt) {
      if (receipt.reservationId !== id) throw new TypeError('Foreign owner source work receipt');
      const next = { ...remaining };
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        const used = receipt.used[key];
        if (!Number.isSafeInteger(used) || used < 0 || used > next[key])
          throw new ProblemError('dependency_unavailable');
        next[key] -= used;
      }
      remaining = next;
    },
  };
}

/**
 * Common canonical member caller. The delivered Source owns candidate order, alias completion,
 * original+terminal disclosure and source-scoped identity currentness. No raw-ID page is normalized here.
 * The provisional createCollectionSource body fails unavailable until that producer executes these operations.
 */
export async function readOwnerMembers(
  deps: { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock },
  input: {
    actor: AccountActor;
    collectionId: string;
    limit: number;
    cursor?: string | null;
    deadline: number;
    /** Actual owner-home reread after releasing all foreign source homes. */
    revalidateOwner: () => Promise<void>;
    /** Actual native source version, independent of identity and permission. */
    readSourceVersion: () => Promise<string>;
  },
): Promise<{ members: DynamicMemberView[]; next: string | null }> {
  const clock = deps.clock ?? systemClock;
  const binding = {
    route: 'GET /v1/collections/:collectionId/members',
    viewer: input.actor.accountId,
    query: { collectionId: input.collectionId, limit: input.limit, order: 'id', source: 'private_builtin' },
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
  const work = pageWork(input.limit);
  const source = createCollectionSource(deps);
  const version = await input.readSourceVersion();
  const at = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
  try {
    const context = { actor: input.actor, at, deadline: input.deadline };
    async function prepare(time: AuthoritativeTime = at): Promise<PreparedCollectionSource> {
      const result = await source.prepare({
        ...context,
        at: time,
        collectionId: input.collectionId,
        allowance: work.allowance(),
      });
      work.settle(result.work);
      return result.source;
    }
    const prepared = await prepare();
    const observed = prepared.observation;
    if (observed.authority.kind !== 'private_builtin' || observed.authority.curatorAccountId !== input.actor.accountId)
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
      const quota = Math.min(600, 2 * (input.limit - members.length) + 1);
      const prefix = await source.prefix({
        ...context,
        source: prepared,
        allowance: work.allowance(quota),
        afterSubjectId: after,
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
        if (membership.result) members.push({ kind: 'dynamic', subjectId: candidate.subjectId });
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
    const finalAt = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
    try {
      const current = await prepare(finalAt);
      if (!sameSource(observed, current.observation)) throw new ProblemError('semantic_not_ready');
      for (const member of shown) {
        const checked = await source.containsSubject({
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
      await input.revalidateOwner();
      if ((await input.readSourceVersion()) !== version) throw new ProblemError('semantic_not_ready');
    } finally {
      releaseOperationalTime(finalAt);
    }
    return {
      members: shown,
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
