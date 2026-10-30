import type { Pool } from 'pg';
import { accountDiscoverySource, readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import type { DiscoveryRegistryOptions } from './discovery.ts';
import { createDiscoveryRegistry } from './discovery-registry.ts';

/** Native owner assembly. Accounts never pass through SubjectSource or attribution readers.
 * The caller pins release/metadata and language preferences before entering its safety envelope.
 */
export function createNativeDiscoveryRegistry(options: {
  pool: Pool;
  routeKey: Uint8Array;
  release: DiscoveryRegistryOptions['release'];
  semantic: Pick<DiscoveryRegistryOptions['semantic'], 'source' | 'icons'>;
  accounts: Pick<DiscoveryRegistryOptions['accounts'], 'labels' | 'icon'>;
  languages?: readonly string[];
}) {
  const { pool, routeKey, languages = [] } = options;
  return createDiscoveryRegistry({
    release: options.release,
    semantic: {
      ...options.semantic,
      async hydrate(ids, context) {
        const summaries = await readSubjectSummaries({ pool, routeKey, ...context }, ids, { languages });
        return new Map([...summaries].flatMap(([id, summary]) => (summary ? [[id, summary]] : [])));
      },
    },
    accounts: {
      ...options.accounts,
      source: accountDiscoverySource(pool),
      async hydrate(ids, context) {
        const summaries = await readAccountDiscoverySummaries({ pool, routeKey, ...context }, ids, { languages });
        return new Map([...summaries].flatMap(([id, summary]) => (summary ? [[id, summary]] : [])));
      },
    },
  });
}
