import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { runCommand } from '../../src/command/command.ts';
import { publishNativeSpaceDiscoveryWitness } from '../../src/community/space-discovery-publisher.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createPool } from '../../src/database/pool.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { newId } from '../../src/route/route.ts';
import { createDiscoveryProjection, nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import {
  discoveryFailureObservation,
  discoveryFinalizationTrace,
} from '../../src/search/discovery-finalization-trace.ts';
import { resolveDiscoveryOwnerAdapters } from '../../src/search/discovery-owner-registry.ts';
import {
  admitSearchTurn,
  advanceDiscovery,
  checkDiscoveryCutBatch,
  discoveryConsumer,
  discoveryGenerations,
  readDiscoveryCuts,
  runSearchTurn,
  searchTurnMetadataProducers,
} from '../../src/search/generations.ts';
import { createDiscoveryIndexer } from '../../src/search/indexer.ts';
import { discoveryIndexName } from '../../src/search/indices.ts';
import { DiscoveryReviewFrontierError } from '../../src/search/operation-outcomes.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

test('64 certified mixed Discovery homes distinguish changed native cuts before activation', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `home-cuts-${crypto.randomUUID().slice(0, 8)}-`;
  const homes = 64;
  const kinds = ['collection', 'review', 'space'];
  const generation = 1;
  const index = discoveryIndexName(prefix, generation);

  try {
    configureTestReceiptKeys(pool);
    await bootstrapRelease(pool, bundledRelease);
    // This file owns an empty database clone. Install its empty Space inventory before binding the native producers.
    expect((await pool.query('SELECT 1 FROM community.space LIMIT 1')).rows).toHaveLength(0);
    await pool.query(`UPDATE community.space_discovery_dependency_install SET complete=true,
      cursor_route=cut_route,cursor_id=cut_id WHERE NOT complete AND NOT EXISTS (SELECT 1 FROM community.space)`);
    await publishNativeSpaceDiscoveryWitness(pool);
    const routeKey = new Uint8Array(32).fill(73);
    const entry = createDiscoveryProducerEntry({
      pool,
      routeKey,
      access: createAccess({
        actions: new Map([
          ['space:read', { anonymous: true }],
          ['realm:read', { anonymous: true }],
        ]),
      }),
      clock: () => new Date(),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
    });
    const resolved = await resolveDiscoveryOwnerAdapters(entry);
    expect(Object.keys(resolved.metadataProducers).sort()).toEqual(kinds);
    const registry = await nativeDiscoveryRegistry(pool, routeKey, entry.subjects, {
      release: bundledRelease,
      ownerAdapters: resolved.ownerAdapters,
      accounts: entry.accounts,
    });
    const options = {
      pool,
      search,
      prefix,
      registry,
      listing: subjectListingSource(pool),
      requiredKinds: kinds,
      capabilityWitnesses: resolved.capabilityWitnesses,
      metadataProducers: resolved.metadataProducers,
    };
    await advanceDiscovery(options);

    // Omitted homes have no rows and cannot pass the full generation's inventory check.
    await pool.query('DELETE FROM search.discovery_population WHERE prefix=$1 AND partition_no >= $2', [prefix, homes]);
    const owners = ['accounts', 'collection', 'review', 'semantic', 'space'];
    let heldReview = false;
    for (let turn = 0; turn < 16; turn++) {
      const counts = await pool.query<{ owner: string; certified: number }>(
        `SELECT owner,count(*) FILTER (WHERE complete AND certified)::int AS certified FROM search.discovery_population
         WHERE prefix=$1 AND generation=$2 GROUP BY owner ORDER BY owner`,
        [prefix, generation],
      );
      expect(counts.rows.map((row) => row.owner)).toEqual(owners);
      if (counts.rows.every((row) => row.certified === homes)) break;
      if (!heldReview && (await discoveryGenerations(pool, prefix))[0]?.state === 'reconciling') {
        const review = resolved.metadataProducers.review!;
        await expect(
          advanceDiscovery({
            ...options,
            metadataProducers: {
              ...resolved.metadataProducers,
              review: {
                ...review,
                page: (partition, ...args) => {
                  if (partition === 0) throw new DiscoveryReviewFrontierError();
                  return review.page(partition, ...args);
                },
              },
            },
          }),
        ).rejects.toBeInstanceOf(DiscoveryReviewFrontierError);
        const progress = await pool.query<{ held: boolean; later: boolean }>(
          `SELECT bool_or(partition_no=0 AND NOT certified AND NOT native_complete) AS held,
                  bool_or(partition_no>=8 AND certified) AS later
           FROM search.discovery_population WHERE prefix=$1 AND generation=$2 AND owner='review'`,
          [prefix, generation],
        );
        expect(progress.rows[0]).toEqual({ held: true, later: true });
        heldReview = true;
      } else await advanceDiscovery(options);
    }
    expect(heldReview).toBe(true);
    await expect(advanceDiscovery(options)).rejects.toThrow('Discovery population partitions are incomplete');
    expect((await discoveryGenerations(pool, prefix))[0]?.state).toBe('reconciling');
    const cuts = await readDiscoveryCuts(pool, prefix, generation);
    expect(cuts).toHaveLength(homes);
    const check = async (rows: typeof cuts, producers = resolved.metadataProducers) => {
      const turn = admitSearchTurn();
      const trace = discoveryFinalizationTrace(prefix, turn.deadline);
      try {
        trace.start(generation, 'native-cuts');
        const checks = await runSearchTurn(turn, () =>
          checkDiscoveryCutBatch(pool, rows, searchTurnMetadataProducers(producers, 'population'), kinds, trace),
        );
        const observed = trace.report({
          outcome: 'batch-checked',
          current: checks.filter((row) => row.state === 'current').length,
        });
        return { checks, native: observed!.native };
      } catch (error) {
        trace.report({ outcome: 'error', error: discoveryFailureObservation(error) });
        throw error;
      } finally {
        turn.close();
      }
    };
    const current = await check(cuts);
    expect(current.checks.every((row) => row.state === 'current')).toBe(true);
    expect(current.native['account-witness']?.homes).toBe(homes);
    expect(current.native['review-batch']?.homes).toBe(homes);
    expect(current.native.review).toBeUndefined();
    // Present stale certified observations to the identical native checker in the same 64-home cohort.
    const stale = cuts.map((row) => ({ ...row }));
    stale[0]!.claim_revision = String(BigInt(cuts[0]!.claim_revision) + 1n);
    stale[1]!.collection_epoch = cuts[1]!.collection_epoch! + 1;
    stale[2]!.collection_position = String(BigInt(cuts[2]!.collection_position!) + 1n);
    stale[3]!.review_position = String(BigInt(cuts[3]!.review_position!) + 1n);
    stale[4]!.space_position = String(BigInt(cuts[4]!.space_position!) + 1n);
    // Exercise the existing per-home Review fallback against the same native source and cuts.
    const { readEmptyPositions, ...review } = resolved.metadataProducers.review!;
    expect(typeof readEmptyPositions).toBe('function');
    const { checks, native } = await check(stale, { ...resolved.metadataProducers, review });
    expect(native['review-batch']).toBeUndefined();
    expect(native.review?.calls).toBe(homes - 2);
    expect(checks.slice(0, 5)).toEqual([
      {
        state: 'native',
        partition: 0,
        changed: { accountPosition: false, semanticPosition: false, accountRevision: false, claimRevision: true },
      },
      { state: 'retire', partition: 1, kind: 'collection' },
      { state: 'metadata', partition: 2, kind: 'collection' },
      { state: 'metadata', partition: 3, kind: 'review' },
      { state: 'metadata', partition: 4, kind: 'space' },
    ]);
    expect(checks.slice(5).every((row) => row.state === 'current')).toBe(true);

    // Advance a certified empty home with a private Search event. Hold the real replay until after repair.
    const empty = await pool.query<{ partition_no: number }>(
      `SELECT partition_no FROM search.discovery_population WHERE prefix=$1 AND generation=$2
       GROUP BY partition_no HAVING bool_and(census=0 AND indexed=0) AND count(*)=5
       ORDER BY partition_no<>44,partition_no LIMIT 1`,
      [prefix, generation],
    );
    const home = empty.rows[0]!.partition_no;
    const route = home * 16;
    const id = newId(route);
    const target = (await discoveryGenerations(pool, prefix))[0]!;
    const consumer = discoveryConsumer(prefix, generation);
    const relay = createDiscoveryIndexer(pool, createDiscoveryProjection({ ...options, target }), consumer);
    const checkpoint = async () =>
      (
        await pool.query<{ position: string }>(
          'SELECT position::text FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer=$2',
          [home, consumer],
        )
      ).rows[0]!.position;
    const before = await checkpoint();
    const noise = await runCommand(pool, { partition: home }, async () => ({
      value: null,
      events: [{ type: 'com.rezics.search.recent-changed.v1', subject: id, data: { accountId: id } }],
    }));
    expect(noise.position).toBeGreaterThan(BigInt(before));
    await advanceDiscovery(options);
    const refreshed = (await readDiscoveryCuts(pool, prefix, generation)).filter((row) => row.partition === home);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.position).toBe(noise.position.toString());
    expect((await check(refreshed)).checks).toEqual([{ state: 'current' }]);
    expect(await checkpoint()).toBe(before);
    expect((await discoveryGenerations(pool, prefix))[0]?.state).toBe('reconciling');
    expect(await relay.run(home)).toMatchObject({ status: 'read', position: noise.position });
    await expect(advanceDiscovery(options)).rejects.toThrow('Discovery population partitions are incomplete');

    // The same home's next advance creates a public Account absent from the index. Its raw pass must reopen.
    await runCommand(pool, { partition: home }, async (tx) => {
      await tx.query(
        `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id,membership_inverse_complete)
         VALUES ($1,$2,'actor','active',false,$2,true)`,
        [route, id],
      );
      return {
        value: null,
        events: [{ type: 'com.rezics.access.account-updated.v1', subject: id, data: { accountId: id } }],
      };
    });
    expect((await entry.accounts.count(home)).count).toBe(1);
    await advanceDiscovery(options);
    const account = await pool.query(
      `SELECT complete,certified FROM search.discovery_population
       WHERE prefix=$1 AND generation=$2 AND partition_no=$3 AND owner='accounts'`,
      [prefix, generation, home],
    );
    expect(account.rows).toEqual([{ complete: false, certified: false }]);
    expect((await discoveryGenerations(pool, prefix))[0]?.state).toBe('populating');
    expect(await checkpoint()).toBe(noise.position.toString());
  } finally {
    try {
      const owned = await search.request<{ indices: { name: string }[] }>(
        'GET',
        `/_resolve/index/${prefix}*`,
        undefined,
        { query: { expand_wildcards: 'all' } },
      );
      for (const { name } of owned.body.indices) {
        if (name !== index) throw new Error('Unexpected physical index in the finalization fixture');
        await search.request('DELETE', `/${name}`);
      }
    } finally {
      try {
        for (const table of ['discovery_population', 'discovery_generation'])
          await pool.query(`DELETE FROM search.${table} WHERE prefix=$1`, [prefix]);
        await pool.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [
          discoveryConsumer(prefix, generation),
        ]);
      } finally {
        await pool.end();
      }
    }
  }
}, 60_000);
