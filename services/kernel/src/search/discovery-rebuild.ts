import type { Pool } from 'pg';
import { setTimeout as wait } from 'node:timers/promises';
import type { OpenSearch } from './opensearch.ts';
import type { SubjectListingSource } from './source.ts';
import { discoveryConsumer } from './consumer-name.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { startDiscoveryIndexing } from './runner.ts';
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

// This is a liveness hint for the CLI. No cursor or progress read authorizes publication.
async function discoveryProgress(options: DiscoveryRebuild, generation: number, state: string, deadline: number) {
  return withBoundedReadConnection(options.pool, deadline, async (db) => {
    const parts: unknown[] = [state];
    if (state === 'populating' || state === 'reconciling') {
      const open = state === 'populating' ? 'NOT p.complete' : 'NOT p.certified';
      const result = await db.query(
        `SELECT f.partition_no,f.owner,f.written FROM unnest($3::text[]) k(owner)
         CROSS JOIN LATERAL (SELECT p.partition_no,p.owner,p.xmin::text AS written FROM search.discovery_population p
           WHERE p.prefix=$1 AND p.generation=$2 AND p.owner=k.owner AND ${open}
           ORDER BY p.partition_no,p.owner LIMIT 8) f ORDER BY f.owner,f.partition_no`,
        [
          options.prefix,
          generation,
          ['semantic', 'accounts', ...(options.requiredKinds ?? SECOND_SCOPE_PUBLIC_METADATA_KINDS)],
        ],
      );
      parts.push(result.rows);
    }
    if (state === 'replaying' || state === 'reconciling') {
      // A progressing replay can leave the population frontier stationary. The consumer-leading
      // index restricts this measurement to this original generation's 4,096 checkpoints.
      parts.push(
        (
          await db.query(
            'SELECT count(*)::int AS homes,sum(position)::text AS positions,sum(epoch)::text AS epochs FROM core.consumer_checkpoint WHERE consumer=$1',
            [discoveryConsumer(options.prefix, generation)],
          )
        ).rows,
      );
    }
    return JSON.stringify(parts);
  });
}

type DiscoveryRebuildRuntime = DiscoveryRebuild & {
  search: OpenSearch;
  listing: SubjectListingSource;
  observeWorker?: true;
};

export async function rebuildDiscovery(options: DiscoveryRebuildRuntime) {
  return finishDiscoveryRebuild(options, await requestDiscoveryRebuild(options));
}

/** Observe or recover this exact allocated generation, including after the observer itself restarts. */
export async function finishDiscoveryRebuild(
  options: DiscoveryRebuildRuntime,
  { generation, previous }: { generation: number; previous: number | null },
) {
  const requiredKinds = options.requiredKinds ?? SECOND_SCOPE_PUBLIC_METADATA_KINDS;
  const run = () => startDiscoveryIndexing({ ...options, source: options.producers.subjects, requiredKinds });
  // A standalone rebuild dispatches its own runner. The combined CLI just observed the real
  // worker publish Subjects, so initially leave its Discovery original in that worker's custody.
  let runner = options.observeWorker ? undefined : run();
  const deadline = Date.now() + 3_600_000;
  let observed: string | undefined,
    probeAfter = 0;
  try {
    while (Date.now() < deadline) {
      const now = Date.now(),
        turnDeadline = Math.min(deadline, now + 30_000);
      const target = (await discoveryGenerations(options.pool, options.prefix, { deadline: turnDeadline })).find(
        (row) => row.generation === generation,
      );
      if (target?.state === 'active') return { generation, previous };
      if (!target || target.state === 'retiring' || target.state === 'quarantined')
        throw new RebuildError('mismatch', generation);
      if (!runner && now >= probeAfter) {
        const progress = await discoveryProgress(options, generation, target.state, turnDeadline);
        if (progress === observed) runner = run();
        observed = progress;
        probeAfter = Date.now() + 60_000;
      }
      // The runner schedules its own bounded turns and recovery after a transient failure.
      await wait(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    throw new RebuildError('timeout', generation);
  } finally {
    await runner?.stop();
  }
}
