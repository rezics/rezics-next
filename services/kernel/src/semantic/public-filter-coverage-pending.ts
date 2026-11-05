import type { CommandTransaction } from '../command/command.ts';
import type { PrivacyReductionLogEntry, PublicFilterDependencyKey } from './public-filter-source-contract.ts';
import enqueue from './public-filter-coverage-pending.sql';
import { routeOf } from '../route/route.ts';
import { runPublicFilterCollectionReductionQuery } from './public-filter-collection-reduction-work.ts';

// These cannot collide with any compiler input. Keys preserve identity rather than a
// growing home-level union, a hash of an input, or a list of matching subjects.
export const PUBLIC_FILTER_SUBJECT_SCOPE = JSON.stringify(['scope', 'subject']);
export const PUBLIC_FILTER_UNRESOLVED_SCOPE = JSON.stringify(['scope', 'unresolved']);

export function publicFilterCoverageKey(key: PublicFilterDependencyKey): string {
  switch (key.kind) {
    case 'property':
      return JSON.stringify(['property', key.property]);
    case 'type':
      return JSON.stringify(['type']);
    case 'order':
      return JSON.stringify(['order', key.order]);
    case 'field':
      return JSON.stringify(['field', key.field]);
    case 'function':
      return JSON.stringify(['function', key.input]);
    case 'realm': {
      const route = routeOf(key.realm);
      if (route === null) throw new TypeError('A Realm dependency requires its native UUID');
      return JSON.stringify(['authority', 'realm', route, key.realm]);
    }
  }
}

/** Same transaction and already-held privacy-head lock as the immutable log append.
 * This work follows admitted impact keys, never the number of definitions or users.
 * Foreign routing remains unresolved until the original maintenance owner settles it.
 */
export async function enqueuePublicFilterCoverage(
  tx: CommandTransaction,
  entry: PrivacyReductionLogEntry,
): Promise<void> {
  const keys = new Set<string>();
  const subjects = new Map<string, number>();
  for (const impact of entry.impacts) {
    if (impact.kind === 'dependency') {
      keys.add(PUBLIC_FILTER_UNRESOLVED_SCOPE);
      const dependency = impact.locator;
      if (dependency.kind === 'realm') keys.add(publicFilterCoverageKey({ kind: 'realm', realm: dependency.realm }));
      if (dependency.kind === 'board')
        keys.add(JSON.stringify(['authority', 'board', dependency.route, dependency.board]));
      if (dependency.kind === 'subject' || dependency.kind === 'selection' || dependency.kind === 'consent')
        subjects.set(dependency.subject.toLowerCase(), dependency.route);
      continue;
    }
    subjects.set(impact.subject.toLowerCase(), impact.route);
    if (impact.kind === 'subject') keys.add(PUBLIC_FILTER_SUBJECT_SCOPE);
    else for (const key of impact.keys) keys.add(publicFilterCoverageKey(key));
  }
  // Keep ALL-key current subject metadata independently of the query closure. An
  // unrelated property on a returned original/terminal still invalidates its cut.
  for (const affected of entry.affected) {
    if (affected.kind === 'subject' || affected.kind === 'selection' || affected.kind === 'consent')
      subjects.set(affected.subject.toLowerCase(), affected.route);
  }
  const input = {
    partition_no: entry.head.partition,
    owner_epoch: entry.head.epoch,
    position: entry.head.position.toString(),
    transaction_id: entry.transactionId,
    input_keys: [...keys].sort(),
    subjects: [...subjects].sort(([a], [b]) => a.localeCompare(b)).map(([subject, route]) => ({ subject, route })),
  };
  const retained =
    entry.cause === 'collection'
      ? await runPublicFilterCollectionReductionQuery('coverage', enqueue, tx, input)
      : await enqueue.run(tx, input);
  if (!retained || (Array.isArray(retained) && retained.length !== 1))
    throw new Error('Privacy log append lost its pending coverage barriers');
}

/** Full compiler closure, including explicit whole-subject and unresolved scopes. */
export function publicFilterCoverageKeys(keys: readonly PublicFilterDependencyKey[]): readonly string[] {
  return [
    ...new Set([PUBLIC_FILTER_SUBJECT_SCOPE, PUBLIC_FILTER_UNRESOLVED_SCOPE, ...keys.map(publicFilterCoverageKey)]),
  ].sort();
}
