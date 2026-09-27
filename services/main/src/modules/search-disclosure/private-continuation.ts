/** A private continuation never carries an Access lease across HTTP requests.
 * Each page admits its exact targets again and must still use the owner's
 * begin/arm/receipt delivery fence before offering any result bytes. */
export interface PrivateSearchPageFence {
  graphDataEpoch: string;
  graphSequence: string;
  /** Digest of the exact owner position vector used to materialize results. */
  sourceDigest: string;
  indexGeneration: string;
  resultDigest: string;
  /** Retained, commit-ordered erasure journal head, independent of graph restore. */
  erasureEpoch: string;
}

export interface PrivateSearchPageTarget {
  /** Stable exact target identity, including disclosure scope. */
  key: string;
  revision: string;
}

export interface PrivateSearchPageLease { id: string }

export interface PrivateSearchPageOwner<T extends PrivateSearchPageTarget,
  L extends PrivateSearchPageLease> {
  /** Reads the complete bounded relation and retained erasure journal head. */
  readFence(): Promise<PrivateSearchPageFence>;
  /** Commits a fresh exact Access read admission before source inspection. */
  admit(target: T): Promise<L>;
  /** Reads the exact source/disclosure status, including erased revisions. */
  readCurrent(target: T): Promise<'available' | 'denied' | 'erased' | 'missing' | 'unavailable'>;
  /** Aborts an admitted, unarmed lease. */
  abort(lease: L): Promise<void>;
}

export class PrivateSearchPageRestart extends Error {}
export class InvalidPrivateSearchPage extends Error {}
export class PrivateSearchPageUnavailable extends Error {}

export const PRIVATE_SEARCH_PAGE_NARROWING_COST = {
  maxTargets: 64, fenceReads: 2, admissionsPerTarget: 1,
  exactReadsPerTarget: 1, abortsPerTarget: 1,
} as const;

const decimal = /^(0|[1-9][0-9]{0,18})$/;
const digest = /^[0-9a-f]{64}$/;

function validFence(fence: PrivateSearchPageFence): boolean {
  return !!fence && typeof fence.graphDataEpoch === 'string' && !!fence.graphDataEpoch
    && decimal.test(fence.graphSequence)
    && digest.test(fence.sourceDigest)
    && typeof fence.indexGeneration === 'string' && !!fence.indexGeneration
    && digest.test(fence.resultDigest) && decimal.test(fence.erasureEpoch);
}

/** SEARCH16: every materialization change requires a restart. In particular,
 * neither advancing nor rolling back the retained erasure frontier may reuse
 * an old page, even before physical Content erasure catches up. */
export function assertPrivateSearchErasureRollback(previous: PrivateSearchPageFence,
  current: PrivateSearchPageFence): void {
  if (!validFence(previous) || !validFence(current)) {
    throw new InvalidPrivateSearchPage('private page fence is invalid');
  }
  if (current.erasureEpoch !== previous.erasureEpoch
    || current.graphDataEpoch !== previous.graphDataEpoch
    || current.graphSequence !== previous.graphSequence
    || current.sourceDigest !== previous.sourceDigest
    || current.indexGeneration !== previous.indexGeneration
    || current.resultDigest !== previous.resultDigest) {
    throw new PrivateSearchPageRestart('private search changed; restart at page one');
  }
}

/** SEARCH16: O(page size) owner checks, at most 64 targets, two fence reads.
 * `targets` must come from the freshly evaluated complete relation whose digest
 * is in readFence. A narrowed authority or erased revision restarts the page;
 * no old result/count/lease is returned. All newly admitted leases are aborted
 * on failure, including a movement detected by the final fence read. */
export async function narrowPrivateSearchPageLeases<T extends PrivateSearchPageTarget,
  L extends PrivateSearchPageLease>(previous: PrivateSearchPageFence,
  targets: readonly T[], owner: PrivateSearchPageOwner<T, L>): Promise<{
    fence: PrivateSearchPageFence; leases: readonly { target: T; lease: L }[];
  }> {
  if (!Array.isArray(targets) || targets.length > PRIVATE_SEARCH_PAGE_NARROWING_COST.maxTargets
    || targets.some(target => !target || typeof target.key !== 'string' || !target.key
      || typeof target.revision !== 'string' || !target.revision)
    || new Set(targets.map(target => target.key)).size !== targets.length) {
    throw new InvalidPrivateSearchPage('private page targets are invalid');
  }
  const admitted: { target: T; lease: L }[] = [];
  try {
    const initial = await owner.readFence();
    assertPrivateSearchErasureRollback(previous, initial);
    for (const target of targets) {
      const lease = await owner.admit(target);
      admitted.push({ target, lease });
      if (await owner.readCurrent(target) !== 'available') {
        throw new PrivateSearchPageRestart('private authority or source changed');
      }
    }
    const final = await owner.readFence();
    assertPrivateSearchErasureRollback(initial, final);
    return { fence: final, leases: admitted };
  } catch (cause) {
    const outcomes = await Promise.allSettled(admitted.map(({ lease }) => owner.abort(lease)));
    if (outcomes.some(outcome => outcome.status === 'rejected')) {
      throw new PrivateSearchPageUnavailable('private page lease cleanup failed', { cause });
    }
    throw cause;
  }
}
