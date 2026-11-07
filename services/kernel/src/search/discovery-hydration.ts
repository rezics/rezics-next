import type { Pool } from 'pg';
import { accountDiscoverySource, readAccountDiscoverySummaries, readSubjectSummaries } from './native-bindings.ts';
import type {
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerRegistry,
  DiscoveryReadContext,
  DiscoveryRegistryOptions,
} from './discovery.ts';
import { createDiscoveryRegistry } from './discovery-registry.ts';
import { discloseOwnerHits } from './disclosure-application.ts';
import type { OwnerDisclosurePorts, DiscoveryOwnerCandidate } from './disclosure/owner-current.ts';

/** Native owner assembly. Accounts never pass through SubjectSource or attribution readers.
 * The caller pins release/metadata and language preferences before entering its safety envelope.
 */
export function createNativeDiscoveryRegistry(options: {
  pool: Pool;
  routeKey: Uint8Array;
  release: DiscoveryRegistryOptions['release'];
  semantic: Pick<DiscoveryRegistryOptions['semantic'], 'source' | 'icons'>;
  accounts: Pick<DiscoveryRegistryOptions['accounts'], 'labels' | 'icon'> &
    Partial<Pick<DiscoveryRegistryOptions['accounts'], 'source'>>;
  ownerAdapters?: DiscoveryOwnerAdapterSlots;
  omittedKinds?: DiscoveryRegistryOptions['omittedKinds'];
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
      source: options.accounts.source ?? accountDiscoverySource(pool),
      async hydrate(ids, context) {
        const summaries = await readAccountDiscoverySummaries({ pool, routeKey, ...context }, ids, {
          languages,
          context: true,
        });
        return new Map([...summaries].flatMap(([id, summary]) => (summary ? [[id, summary]] : [])));
      },
    },
    ...(options.ownerAdapters ? { ownerAdapters: options.ownerAdapters } : {}),
    ...(options.omittedKinds ? { omittedKinds: options.omittedKinds } : {}),
  });
}

export type { DiscoveryOwnerCandidate } from './disclosure/owner-current.ts';

/** Bind the registry's native owners to the application's narrow capabilities. */
export function ownerDisclosurePorts(
  registry: DiscoveryOwnerRegistry & ReturnType<typeof createDiscoveryRegistry>,
): OwnerDisclosurePorts {
  return {
    ownerKey: (key) => registry.ownerKey(key),
    readCurrent: (kind, ids, context) => registry.getOwnerAdapter(kind).readCurrent(ids, context),
    hydrateAccounts: (ids, context) => {
      const entry = registry.get('account');
      if (entry.owner !== 'accounts') throw new TypeError('Discovery Account hydrator is unavailable');
      return entry.hydrate(ids, context);
    },
    hydrateSubjects: (ids, context) => {
      const entry = registry.entries.find((entry) => entry.owner === 'semantic');
      return entry ? entry.hydrate(ids, context) : Promise.resolve(new Map());
    },
  };
}

/** Compatibility adapter; the application owns the complete current/hydrate/current sequence. */
export function hydrateOwnerDiscoveryHits(
  registry: DiscoveryOwnerRegistry & ReturnType<typeof createDiscoveryRegistry>,
  candidates: readonly DiscoveryOwnerCandidate[],
  context: DiscoveryReadContext,
) {
  return discloseOwnerHits(ownerDisclosurePorts(registry), candidates, context);
}
