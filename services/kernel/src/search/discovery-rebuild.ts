import type { Pool } from 'pg';
import type { OpenSearch } from './opensearch.ts';
import type { SubjectListingSource } from './source.ts';
import type { DiscoveryProducerEntry } from './index.ts';
import { resolveDiscoveryOwnerAdapters } from './discovery-owner-registry.ts';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import {
  admitSearchTurn,
  allocateDiscovery,
  discoveryGenerations,
  RebuildError,
  runSearchTurn,
  searchTurnMetadataProducers,
} from './generations.ts';
import { SECOND_SCOPE_PUBLIC_METADATA_KINDS } from './discovery-readiness.ts';

type DiscoveryRebuild = {
  pool: Pool;
  prefix: string;
  routeKey: Uint8Array;
  producers: DiscoveryProducerEntry;
  requiredKinds?: readonly string[];
};

/** Resolve each actual population producer before allocating its native home inventory. */
export async function requestDiscoveryRebuild(options: DiscoveryRebuild) {
  const { pool, prefix, routeKey, producers } = options;
  const turn = admitSearchTurn();
  try {
    return await runSearchTurn(turn, async () => {
      const owners = await turn.call(() =>
        resolveDiscoveryOwnerAdapters({
          ...producers,
          metadataProducers: searchTurnMetadataProducers(producers.metadataProducers, 'population'),
        }),
      );
      const registry = await turn.call(() =>
        nativeDiscoveryRegistry(pool, routeKey, producers.subjects, {
          ownerAdapters: owners.ownerAdapters,
          accounts: producers.accounts,
          omittedKinds: owners.omittedKinds,
        }),
      );
      const previous =
        (await discoveryGenerations(pool, prefix)).find((row) => row.state === 'active')?.generation ?? null;
      const requiredKinds = options.requiredKinds ?? SECOND_SCOPE_PUBLIC_METADATA_KINDS;
      await allocateDiscovery(pool, prefix, registry, requiredKinds, [
        'account',
        'subject',
        ...Object.keys(owners.metadataProducers),
      ]);
      const generation = (await discoveryGenerations(pool, prefix)).at(-1)?.generation;
      if (generation === undefined) throw new Error('Discovery allocation is absent');
      return { generation, previous };
    });
  } finally {
    turn.close();
  }
}

/** CLI uses the same native factories and lifecycle as the default worker. */
export async function rebuildDiscovery(
  options: DiscoveryRebuild & { search: OpenSearch; listing: SubjectListingSource },
) {
  const requiredKinds = options.requiredKinds ?? SECOND_SCOPE_PUBLIC_METADATA_KINDS;
  const { generation, previous } = await requestDiscoveryRebuild(options);
  const { startDiscoveryIndexing } = await import('./runner.ts');
  const runner = startDiscoveryIndexing({ ...options, source: options.producers.subjects, requiredKinds }),
    deadline = Date.now() + 3_600_000;
  try {
    for (;;) {
      await runner.refresh();
      if (
        (await discoveryGenerations(options.pool, options.prefix)).some(
          (row) => row.generation === generation && row.state === 'active',
        )
      )
        return { generation, previous };
      if (Date.now() >= deadline) throw new RebuildError('timeout', generation);
    }
  } finally {
    await runner.stop();
  }
}
