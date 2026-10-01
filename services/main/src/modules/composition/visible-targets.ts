import { resolveVisibleTargets, TARGET_RESOLVE_COST } from '../target/resolve.ts';
import type { WorkReadSession } from '../work/read-session.ts';

/** A range has at most 101 candidates. Distinct targets are hydrated once in
 * bounded resolver batches; unavailable targets never enter the disclosed page. */
export function collectionTargetBatchReader(session: WorkReadSession) {
  return async (targets: readonly string[]): Promise<ReadonlySet<string>> => {
    const resources = [...new Set(targets)];
    const visible = new Set<string>();
    for (let at = 0; at < resources.length; at += TARGET_RESOLVE_COST.batch) {
      session.checkDeadline();
      for (const target of await resolveVisibleTargets(session,
        resources.slice(at, at + TARGET_RESOLVE_COST.batch), 'collection-member')) {
        visible.add(target.resource);
      }
    }
    return visible;
  };
}
