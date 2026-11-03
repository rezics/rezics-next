import type { Pool } from 'pg';
import { accountDiscoverySource, readAccountDiscoverySummaries } from '../access/account-discovery-source.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import type {
  DiscoveryOwnerHit,
  DiscoveryOwnerKey,
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerKind,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistry,
  DiscoveryReadContext,
  DiscoveryRegistryOptions,
} from './discovery.ts';
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
  ownerAdapters?: DiscoveryOwnerAdapterSlots;
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
    ...(options.ownerAdapters ? { ownerAdapters: options.ownerAdapters } : {}),
  });
}

function currentMetadata(value: unknown, id: string): value is DiscoveryOwnerMetadataSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    Object.keys(summary).length === 3 &&
    Object.keys(summary).every((key) => ['id', 'title', 'summary'].includes(key)) &&
    summary.id === id &&
    typeof summary.title === 'string' &&
    summary.title.isWellFormed() &&
    (summary.summary === null || (typeof summary.summary === 'string' && summary.summary.isWellFormed()))
  );
}

/** Hydrate only owner kinds whose native adapter has an explicit ready slot. */
export async function hydrateOwnerDiscoveryHits(
  registry: ReturnType<typeof createDiscoveryRegistry> & DiscoveryOwnerRegistry,
  keys: readonly DiscoveryOwnerKey[],
  context: DiscoveryReadContext,
): Promise<DiscoveryOwnerHit[]> {
  if (keys.length > 200) throw new RangeError('Discovery hydration exceeds its owner bound');
  const canonical = keys.map((key) => registry.ownerKey(key));
  const idsByKind = new Map<DiscoveryOwnerKind, string[]>();
  for (const key of canonical) {
    const ids = idsByKind.get(key.kind) ?? [];
    if (!ids.includes(key.id)) ids.push(key.id);
    idsByKind.set(key.kind, ids);
  }
  const current = new Map<string, DiscoveryOwnerMetadataSummary>();
  for (const [kind, ids] of idsByKind) {
    const adapter = registry.getOwnerAdapter(kind);
    const summaries = await adapter.readCurrent(ids, context);
    if (!summaries || typeof summaries.get !== 'function' || typeof summaries[Symbol.iterator] !== 'function')
      throw new TypeError('Owner discovery adapter returned an invalid current summary set');
    const requested = new Set(ids);
    for (const [id, summary] of summaries) {
      if (!requested.has(id) || !currentMetadata(summary, id))
        throw new TypeError('Owner discovery adapter returned a foreign or invalid current summary');
      current.set(`${kind}:${id}`, { id, title: summary.title, summary: summary.summary });
    }
  }
  return canonical.flatMap((key): DiscoveryOwnerHit[] => {
    const summary = current.get(`${key.kind}:${key.id}`);
    if (!summary) return [];
    switch (key.kind) {
      case 'collection':
        return [{ key, summary: { kind: 'collection', value: summary } }];
      case 'review':
        return [{ key, summary: { kind: 'review', value: summary } }];
      case 'space':
        return [{ key, summary: { kind: 'space', value: summary } }];
      default:
        throw new TypeError('Unknown owner discovery kind');
    }
  });
}
