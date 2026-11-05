import { accountDiscoverySource } from '../access/index.ts';
import { createReviewDiscoverySource, type ReviewDiscoverySource } from '../content/discovery-source.ts';
import { publicCollectionDiscoverySource } from '../library/discovery.ts';
import { readSpaceDiscoverySummaries, spaceDiscoverySource } from '../community/index.ts';
import type { DiscoveryProducerEntry } from '../search/index.ts';
import { createDiscoveryOwnerAdapters } from '../search/default-discovery.ts';
import { createRatedSubjectSource } from '../search/rated-source.ts';
import { createSpaceDiscoveryAdapter } from '../search/space-discovery.ts';
import type { SubjectSource } from '../search/source.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Access } from '../request/access.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';

/**
 * Bind each native producer once for the live mixed query and its default indexer.
 * Owner factories retain their Access, source fences, and current disclosure behavior.
 */
export function createDiscoveryProducerEntry(input: {
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  tokens?: KeyRing;
  clock?: KernelClock;
  subjects?: SubjectSource;
  reviewSource?: ReviewDiscoverySource;
}): DiscoveryProducerEntry {
  const { pool, routeKey, access, clock } = input;
  const reviewSource = input.reviewSource ?? (input.tokens
    ? createReviewDiscoverySource(
        { pool, access, tokens: input.tokens, ...(clock ? { clock } : {}) },
        () => ({ actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 }),
      )
    : undefined);
  if (!reviewSource) throw new TypeError('Search composition requires the native Content review producer');
  const spaceDependencies = { pool, access, ...(clock ? { clock } : {}) };
  const space = createSpaceDiscoveryAdapter(
    spaceDiscoverySource(spaceDependencies),
    (ids, context) => readSpaceDiscoverySummaries(spaceDependencies, ids, context),
  );
  const ownerAdapters = createDiscoveryOwnerAdapters({
    pool,
    routeKey,
    access,
    ...(clock ? { clock } : {}),
    collectionSource: publicCollectionDiscoverySource({ pool }),
    reviewSource,
    space,
  });
  return Object.freeze({
    subjects: input.subjects ?? createRatedSubjectSource(pool, routeKey).source,
    accounts: accountDiscoverySource(pool),
    reviewSource,
    ownerAdapters,
    metadataProducers: ownerAdapters.metadataProducers,
  });
}
