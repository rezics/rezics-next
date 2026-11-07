import type { Pool } from 'pg';
import type { OpenSearch } from './opensearch.ts';
import type { SubjectSource, SubjectListingSource } from './source.ts';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import { allocateDiscovery, discoveryGenerations, RebuildError } from './generations.ts';
import { SECOND_SCOPE_PUBLIC_METADATA_KINDS } from './discovery-readiness.ts';

/** CLI uses the same native factories and lifecycle as the default worker. */
export async function rebuildDiscovery(options: {
  pool: Pool;
  search: OpenSearch;
  source: SubjectSource;
  listing: SubjectListingSource;
  prefix: string;
  routeKey: Uint8Array;
  requiredKinds?: readonly string[];
}) {
  const registry = await nativeDiscoveryRegistry(options.pool, options.routeKey, options.source);
  const previous =
    (await discoveryGenerations(options.pool, options.prefix)).find((row) => row.state === 'active')?.generation ??
    null;
  const requiredKinds = options.requiredKinds ?? SECOND_SCOPE_PUBLIC_METADATA_KINDS;
  await allocateDiscovery(options.pool, options.prefix, registry, requiredKinds);
  const generation = (await discoveryGenerations(options.pool, options.prefix)).at(-1)?.generation;
  if (generation === undefined) throw new Error('Discovery allocation is absent');
  const { startDiscoveryIndexing } = await import('./runner.ts');
  const runner = startDiscoveryIndexing({ ...options, requiredKinds }),
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
