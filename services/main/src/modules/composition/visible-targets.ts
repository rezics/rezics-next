import { resolveVisibleTargetSources, TARGET_RESOLVE_COST } from '../target/resolve.ts';
import type { WorkReadSession } from '../work/read-session.ts';

/** A range has at most 101 candidates. Distinct targets are hydrated once in
 * bounded resolver batches; unavailable targets never enter the disclosed page. */
export function collectionTargetBatchReader(session: WorkReadSession) {
  return visibleTargetBatchReader(session, false);
}

/** Parts and wholes disclose Work identities, even when a Composition admits
 * another capability grain. Keep that distinction after batched hydration. */
export function compositionWorkBatchReader(session: WorkReadSession) {
  return visibleTargetBatchReader(session, true);
}

function visibleTargetBatchReader(session: WorkReadSession, worksOnly: boolean) {
  return async (targets: readonly string[]): Promise<ReadonlySet<string>> => {
    const resources = [...new Set(targets)];
    const visible = new Set<string>();
    for (let at = 0; at < resources.length; at += TARGET_RESOLVE_COST.batch) {
      session.checkDeadline();
      for (const [source, target] of await resolveVisibleTargetSources(session,
        resources.slice(at, at + TARGET_RESOLVE_COST.batch), 'collection-member')) {
        if (!worksOnly || target.base === 'work') visible.add(source);
      }
    }
    return visible;
  };
}
