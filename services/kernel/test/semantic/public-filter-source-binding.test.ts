import { runCommand } from '../../src/command/command.ts';
import { enrollAccountDiscoveryHome, enrollNewAccountDiscoveryHomes } from '../../src/access/adapters/index.ts';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import { createPool, withConnection, withQueryAccounting } from '../../src/database/pool.ts';
import type { PoolClient } from 'pg';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  readPublicFilterCreationEvents,
  type PublicFilterCreationWindow,
} from '../../src/semantic/public-filter-creation-window.ts';
import { planColdSubjectEnrollment } from '../../src/semantic/public-filter-coverage-baseline.ts';
import { readPublicFilterCreationPrefix } from '../../src/semantic/public-filter-creation-prefix.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { encode as encodeSearch, tree } from '../../src/search/public-filter-codec.ts';
import { checkGrowth, seed } from '../support/growth.ts';
import { publicationJob } from './support/public-filter-binding.ts';
import { expect, test } from 'bun:test';
import {
  createPublicFilterSourceBinding,
  advanceNativePublicFilterPreparation,
  readNativePublicFilterPublicationCompletion,
  nativePublicFilterRepairEvidence,
  withNativePublicFilterRepairReadBatch,
  type NativeSourceRepairLocator,
  type NativeSourceRepairStepVerification,
} from '../../src/semantic/public-filter-source-binding.ts';
import {
  capturedConsumer,
  consumerFixture,
  fixture,
  nativeProducer,
  readContext,
  setNativePartitionEpochForFixture,
} from './support/public-filter-source.ts';

type SourceBinding = ReturnType<typeof createPublicFilterSourceBinding>;

test.each([true, false])(
  'native enrollment groups new homes with accounts=%s and preserves each pinned receipt',
  async (accounts) => {
    const pool = createPool(process.env.DATABASE_URL!);
    try {
      const input = {
        bootstrap: crypto.randomUUID(),
        registration: { partition: 0, id: 'group-enrollment-fixture' },
        readDefinition: crypto.randomUUID(),
        keys: ['["type"]', accounts ? '["domain","accounts"]' : '["field","name_sort"]'],
        keyLimit: 2,
        accounts,
      };
      const partitions = Array.from({ length: 16 }, (_, index) => 4066 + index);
      const found = await enrollNewAccountDiscoveryHomes(pool, { ...input, partitions }, readContext());
      if (!found) throw new Error('Fresh enrollment was refused');
      expect(found.map(({ partition }) => partition)).toEqual(partitions);
      expect(found.every(({ complete, receipt }) => complete && receipt?.length === 64)).toBe(true);
      for (const receipt of found) {
        expect(
          await enrollAccountDiscoveryHome(pool, { ...input, partition: receipt.partition }, readContext()),
        ).toEqual(receipt);
      }
      expect(
        await enrollNewAccountDiscoveryHomes(pool, { ...input, partitions: [4081, 4082] }, readContext()),
      ).toBeNull();
      const effects = await pool.query(
        `SELECT e.partition_no AS home,coalesce(sum(1) FILTER (WHERE k.input_key IS NOT NULL),0)::integer AS keys,
          bool_and(c.consumer IS NOT NULL AND c.position<=e.creation_position) AS pinned,
          bool_and(e.native_revision IS NOT NULL AND e.native_claim_revision IS NOT NULL) AS accounts
       FROM semantic.public_filter_home_enrollment e
       LEFT JOIN semantic.public_filter_key_enrollment k USING(partition_no,bootstrap)
       LEFT JOIN core.consumer_checkpoint c ON (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)
       WHERE e.bootstrap=$1 GROUP BY e.partition_no ORDER BY e.partition_no`,
        [input.bootstrap],
      );
      expect(effects.rows).toEqual(partitions.map((home) => ({ home, keys: 2, pinned: true, accounts })));
      const unpinned = await pool.query(
        'SELECT 1 FROM core.consumer_checkpoint WHERE partition_no=4082 AND consumer=$1',
        ['public_filter_' + input.bootstrap.replaceAll('-', '')],
      );
      expect(unpinned.rowCount).toBe(0);
    } finally {
      await pool.end();
    }
  },
);

test('native baseline cursor requires every predecessor and final root in a bounded interval', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const bootstrap = crypto.randomUUID();
  const root = (character: string) => character.repeat(64);
  try {
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('INSERT INTO search.public_filter_target VALUES (0,$1,$1)', [bootstrap]);
        await client.query(
          `INSERT INTO search.public_filter_registration (partition_no,id,physical_target,consumer,definition,state)
           VALUES (0,$1,$1,'cursor-test','cursor-test','active')`,
          [bootstrap],
        );
        await client.query(
          `INSERT INTO search.public_filter_coverage_preparation
             (partition_no,registration,bootstrap,definition,consumer,generation,root)
           VALUES (0,$1,$1::text::uuid,$1::text::uuid,'cursor-test',0,$2)`,
          [bootstrap, root('a')],
        );
        const insert = (home: number, predecessor: string, next: string) =>
          client.query(
            `INSERT INTO search.public_filter_coverage_baseline
               (partition_no,registration,bootstrap,source_home,source_epoch,source_position,creation_position,
                native_enqueue_revision,receipt,predecessor,root)
             VALUES (0,$1,$1::text::uuid,$2,1,0,0,0,$3,$4,$5)`,
            [bootstrap, home, root('f'), root(predecessor), root(next)],
          );
        const advance = (after: number, next: string) =>
          client.query(
            'UPDATE search.public_filter_coverage_preparation SET after_home=$2,root=$3 WHERE bootstrap=$1',
            [bootstrap, after, root(next)],
          );
        const reject = async (after: number, next: string) => {
          await client.query('SAVEPOINT invalid_frontier');
          await expect(advance(after, next)).rejects.toMatchObject({ code: '23514' });
          await client.query('ROLLBACK TO SAVEPOINT invalid_frontier');
          await client.query('RELEASE SAVEPOINT invalid_frontier');
        };
        await insert(0, 'a', 'b');
        expect((await advance(1, 'b')).rowCount).toBe(1);
        await insert(2, 'c', 'd');
        await reject(3, 'd'); // a missing home
        await client.query('SAVEPOINT broken_chain');
        await insert(1, 'e', 'c');
        await reject(3, 'd');
        await client.query('ROLLBACK TO SAVEPOINT broken_chain');
        await insert(1, 'b', 'c');
        const unpinned = await client.query(
          `SELECT search.public_filter_baseline_interval(0,$1,$1::text::uuid,1,3,NULL,$2) AS valid`,
          [bootstrap, root('d')],
        );
        expect(unpinned.rows).toEqual([{ valid: false }]);
        await reject(3, 'e'); // a different final root
        for (let home = 3; home <= 30; home++) await insert(home, 'd', 'd');
        await reject(31, 'd'); // a complete chain beyond the page limit
        expect((await advance(30, 'd')).rowCount).toBe(1);
      } finally {
        await client.query('ROLLBACK');
      }
    });
  } finally {
    await pool.end();
  }
});

test('native mixed coverage shares pagination widths while preserving the exact public capture and consumer controls', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  try {
    const capture = { representation: 'discovery-v1', sort: 'id', text: undefined, size: 41, pageSize: 20 };
    const narrow = { ...capture, size: 15, pageSize: 7 };
    const encodeCapture = (value: unknown) => JSON.stringify(tree(value, 'value'));
    const parent = crypto.randomUUID(),
      child = crypto.randomUUID();
    const consumer = {
      catalogue: null,
      physicalTarget: 'native-mixed-discovery-g2',
      incarnation: crypto.randomUUID(),
      consumerGeneration: crypto.randomUUID(),
      meaningDigest: 'release',
      readDefinition: child,
      projectionGeneration: child,
    };
    const comparison = await pool.query(
      `SELECT semantic.public_filter_mixed_page_scope($1)=semantic.public_filter_mixed_page_scope($2) AS same,
         semantic.public_filter_mixed_page_scope($1)=semantic.public_filter_mixed_page_scope($3) AS changed,
         semantic.public_filter_mixed_page_scope($4) IS NULL AS invalid_width,
         semantic.public_filter_mixed_consumer_for_definition($5,$6,$7) AS parent,
         semantic.public_filter_mixed_consumer_for_definition($5,$7,$6) IS NULL AS different_child`,
      [
        encodeCapture(capture),
        encodeCapture(narrow),
        encodeCapture({ ...narrow, text: null }),
        encodeCapture({ ...narrow, size: narrow.size + 1 }),
        encodeSearch(consumer),
        child,
        parent,
      ],
    );
    expect(comparison.rows).toEqual([
      {
        same: true,
        changed: false,
        invalid_width: true,
        different_child: true,
        parent: encodeSearch({ ...consumer, projectionGeneration: parent, readDefinition: parent }),
      },
    ]);
  } finally {
    await pool.end();
  }
});

/** Drive the same bounded native preparation used by Search, retaining its original cut. */
async function prepareSource(
  f: Awaited<ReturnType<typeof fixture>>,
  binding: SourceBinding,
  input: Parameters<SourceBinding['begin']>[0],
): Promise<Awaited<ReturnType<SourceBinding['begin']>>> {
  let result = await advanceNativePublicFilterPreparation(binding, input, readContext());
  if (!result || !('bootstrap' in result)) throw new Error(`Native Source preparation: ${JSON.stringify(result)}`);
  const original = result.bootstrap.id;
  for (let step = 0; result.status === 'preparing'; step++) {
    expect(step, 'Bounded retained home batches must complete the original enrollment').toBeLessThan(512);
    result = await advanceNativePublicFilterPreparation(binding, { bootstrap: original }, readContext());
    if (!result || !('bootstrap' in result)) {
      const state = await f.db.admin.query(
        `SELECT b.state,b.account_after,b.coverage_after,b.coverage_sealed,b.coverage_generation::text,
                c.after_home,c.generation::text AS preparation_generation,
                e.complete,e.receipt,e.owner_epoch,p.epoch,p.write_state
         FROM semantic.public_filter_bootstrap b
         LEFT JOIN search.public_filter_coverage_preparation c
           ON (c.partition_no,c.bootstrap)=(b.partition_no,b.bootstrap)
         LEFT JOIN semantic.public_filter_home_enrollment e
           ON (e.partition_no,e.bootstrap)=(b.account_after-1,b.bootstrap)
         LEFT JOIN core.partition p ON p.partition_no=b.account_after-1
         WHERE b.partition_no=0 AND b.bootstrap=$1::uuid`,
        [original.slice(2)],
      );
      throw new Error(
        `Native Source preparation ${original} step=${step}: ${JSON.stringify(result)} state=${JSON.stringify(state.rows[0])}`,
      );
    }
    expect(result.bootstrap.id).toBe(original);
  }
  if (result.status !== 'begun') throw new Error(`Native Source preparation: ${JSON.stringify(result)}`);
  return result;
}

test('native public Source configuration and immutable meaning/read definition resolve without trusting caller identity', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'id' as const,
      size: 10,
      filterDocument: undefined,
      text: undefined,
    };
    const result = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(result.status, result.status === 'resolved' ? undefined : JSON.stringify(result)).toBe('resolved');
    if (result.status !== 'resolved') throw new Error(`Native Source binding ${result.reason}`);
    expect(result.definition.source.epoch).toBeGreaterThan(0);
    expect(result.definition.source.configuration.length).toBeGreaterThan(0);
    expect(result.definition.readDefinition.length).toBeGreaterThan(0);
    expect(result.definition.meaning).toEqual({ digest: f.meaning.digest, release: f.meaning.release });
    expect(Object.keys(result.definition.meaning).sort()).toEqual(['digest', 'release']);
    expect(result.definition.dependencyKeys).toContainEqual({ kind: 'type' });
    const reused = await binding.resolve(
      { source, meaning: structuredClone(f.meaning), capture: structuredClone(capture) },
      readContext(),
    );
    expect(reused.status).toBe('resolved');
    if (reused.status !== 'resolved') throw new Error(`Native Source reuse ${reused.reason}`);
    expect(reused.definition.readDefinition).toBe(result.definition.readDefinition);
    const obsoleteMeaning = { ...f.meaning, type: 'schema:Book' };
    expect(await binding.resolve({ source, meaning: obsoleteMeaning, capture }, readContext())).toMatchObject({
      status: 'unavailable',
      reason: 'binding_mismatch',
    });
    expect(result.definition.dependencyKeys).toContainEqual({
      kind: 'field',
      field: 'id',
    });
    capture.size = 20;
    expect(result.definition.capture.size).toBe(10);
    expect(
      (await binding.resolve({ source: { ...source }, meaning: f.meaning, capture }, readContext())).status,
    ).not.toBe('resolved');
    expect(
      (await binding.resolve({ source, meaning: { ...f.meaning, digest: 'invented' }, capture }, readContext())).status,
    ).not.toBe('resolved');
    const foreign = createPublicFilterSourceBinding(f.db.pool, new Uint8Array(32).fill(12), f.config.access);
    expect((await foreign.resolve({ source, meaning: f.meaning, capture }, readContext())).status).not.toBe('resolved');
  } finally {
    await f.close();
  }
});

test('native Subject enrollment prepares disjoint ranges and rechecks the original ordered cut', async () => {
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const source = publicFilterSource(f.config);
  const consumer = await consumerFixture(f, source);
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const capture = await consumer.operations.capture(
      {
        plan: {
          sort: 'id',
          size: 1,
          filterDocument: undefined,
          text: undefined,
          catalogueCoverage: true,
          catalogueNameSort: true,
        },
        snapshot: 'prepared',
      },
      readContext(),
    );
    if (capture.status !== 'preparing') throw new Error(`Expected a capturing bootstrap, got ${capture.status}`);
    const originalConsumer = capture.repair.consumer;
    if (!originalConsumer.readDefinition) throw new Error('Capture lost its original definition');
    const bootstrap = decodeURIComponent(capture.repair.job.slice('0:bootstrap:'.length));
    const resolved = await binding.readDefinition!({ source, id: originalConsumer.readDefinition }, readContext());
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    const {
      rows: [registration],
    } = await f.db.admin.query<{ id: string }>(
      'SELECT id FROM search.public_filter_registration WHERE partition_no=0 AND consumer_bootstrap=$1',
      [bootstrap],
    );
    const resume = {
      bootstrap,
      subjectEnrollment: {
        consumer: originalConsumer,
        source: resolved.definition.source,
        registration: { partition: 0, id: registration!.id },
        capturingOnly: true as const,
      },
    };
    const advance = () => advanceNativePublicFilterPreparation(binding, resume, readContext());
    const readFrontier = async () =>
      (
        await f.db.admin.query(
          'SELECT account_after, coverage_after FROM semantic.public_filter_bootstrap WHERE partition_no=0 AND bootstrap=$1',
          [resume.bootstrap.slice(2)],
        )
      ).rows;
    const beforeRanges = (await readFrontier())[0]!;
    const start = beforeRanges.coverage_after as number;
    const next = start + 1;
    const job = await publicationJob(f, source, originalConsumer);
    const rangeContext = { version: 1 as const, job, byteLimit: 4 * 1024 * 1024 };
    const prepare = (
      ranges: { start: number; end: number }[],
      inputLimit = 872,
      byteLimit = rangeContext.byteLimit,
      owner = binding,
      context = readContext(),
    ) =>
      advanceNativePublicFilterPreparation(
        owner,
        {
          ...resume,
          inputLimit,
          coldEnrollment: { ...rangeContext, byteLimit, action: 'prepare', ranges },
        },
        context,
      );
    const adopt = (...ranges: { start: number; end: number; digest: string }[]) =>
      advanceNativePublicFilterPreparation(
        binding,
        {
          ...resume,
          inputLimit: 872,
          coldEnrollment: { ...rangeContext, action: 'adopt', ranges },
        },
        readContext(),
      );

    const first = { start, end: next };
    const later = { start: next, end: next + 1 };
    expect(await prepare([first, later], 80)).toMatchObject({ status: 'unavailable', reason: 'owner_unavailable' });
    expect(await prepare([first, later], 872, 64 * 1024)).toMatchObject({
      status: 'unavailable',
      reason: 'owner_unavailable',
    });
    const held = await f.db.admin.connect();
    let running: ReturnType<typeof prepare> | undefined;
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
    let laterRange: { start: number; end: number; digest: string } | undefined;
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM semantic.public_filter_privacy_head WHERE partition_no=$1 FOR UPDATE', [start]);
      running = prepare([first, later], 872, rangeContext.byteLimit, binding, { deadline: Date.now() + 10_000 });
      const staged = await prepare([later]);
      if (staged?.status !== 'ranges-prepared') throw new Error(`Later range ${staged?.status}`);
      laterRange = staged.ranges[0]!;
      const { rows } = await f.db.admin.query(
        'SELECT partition_no,complete FROM semantic.public_filter_home_enrollment WHERE bootstrap=$1 AND partition_no BETWEEN $2 AND $3 ORDER BY partition_no',
        [bootstrap.slice(2), start, next],
      );
      expect(rows).toEqual([{ partition_no: next, complete: true }]);
      expect(await adopt(laterRange)).toMatchObject({ status: 'range-pending' });
      expect((await readFrontier())[0]).toEqual(beforeRanges);
    } finally {
      try {
        await held.query('ROLLBACK');
      } finally {
        held.release();
        prepared = await running;
      }
    }
    if (prepared?.status !== 'ranges-prepared' || !laterRange) throw new Error(`Range offer ${prepared?.status}`);
    const [firstRange, retainedRange] = prepared.ranges;
    expect(retainedRange).toEqual(laterRange);
    const newOwner = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    expect(await prepare([later], 872, rangeContext.byteLimit, newOwner)).toMatchObject({
      status: 'ranges-prepared',
      ranges: [laterRange],
    });
    expect(await adopt(firstRange!, { ...laterRange, digest: '0'.repeat(64) })).toMatchObject({
      status: 'unavailable',
      reason: 'owner_unavailable',
    });
    expect((await readFrontier())[0]).toEqual(beforeRanges);
    const nextEpoch = (
      await f.db.admin.query<{ epoch: number }>('SELECT epoch FROM core.partition WHERE partition_no=$1', [next])
    ).rows[0]!.epoch;
    await setNativePartitionEpochForFixture(f.db, next, nextEpoch + 1);
    expect(await adopt(firstRange!, laterRange)).toMatchObject({ status: 'unavailable', reason: 'owner_unavailable' });
    expect((await readFrontier())[0]).toEqual(beforeRanges);
    await setNativePartitionEpochForFixture(f.db, next, nextEpoch);
    expect(await adopt(firstRange!, laterRange)).toMatchObject({ status: 'range-adopted' });
    expect(await adopt(firstRange!, laterRange)).toMatchObject({ status: 'range-adopted' });
    expect((await readFrontier())[0]).toEqual({ account_after: next + 1, coverage_after: next + 1 });
    const combined = await advanceNativePublicFilterPreparation(
      binding,
      {
        ...resume,
        inputLimit: 872,
        coldEnrollment: {
          ...rangeContext,
          action: 'prepare-and-adopt',
          ranges: [
            { start: next + 1, end: next + 2 },
            { start: next + 2, end: next + 3 },
          ],
        },
      },
      readContext(),
    );
    expect(combined).toMatchObject({ status: 'range-adopted' });
    expect((await readFrontier())[0]).toEqual({ account_after: next + 3, coverage_after: next + 3 });
    // A separately prepared worker page must fund the second binding read and
    // adoption from what is left after the original Access receipts commit.
    const startLookahead = next + 3;
    const inputLimit = 872;
    const planned = planColdSubjectEnrollment(
      resolved.definition.dependencyKeys,
      startLookahead,
      inputLimit,
      rangeContext.byteLimit,
      true,
    );
    if (planned?.length !== 1) throw new Error('Expected one funded lookahead range');
    const staged = await prepare([...planned], inputLimit);
    if (staged?.status !== 'ranges-prepared') throw new Error(`Lookahead preparation ${staged?.status}`);
    expect((await readFrontier())[0]).toEqual({ account_after: startLookahead, coverage_after: startLookahead });
    const committed = await advanceNativePublicFilterPreparation(
      binding,
      {
        ...resume,
        inputLimit: inputLimit - staged.cost.inputKeys,
        coldEnrollment: {
          ...rangeContext,
          byteLimit: rangeContext.byteLimit - staged.cost.bytes,
          action: 'adopt',
          ranges: staged.ranges,
        },
      },
      readContext(),
    );
    if (committed?.status !== 'range-adopted') throw new Error(`Lookahead adoption ${committed?.status}`);
    expect(staged.cost.inputKeys + committed.cost.inputKeys).toBeLessThanOrEqual(inputLimit);
    expect(staged.cost.bytes + committed.cost.bytes).toBeLessThanOrEqual(rangeContext.byteLimit);
    expect((await readFrontier())[0]).toEqual({ account_after: planned[0]!.end, coverage_after: planned[0]!.end });
    console.log('Cold enrollment Source cost', JSON.stringify(prepared.cost));
    const beforeLoss = (await readFrontier())[0]!;
    let lost = false;
    const queries = new Map<PoolClient, PoolClient['query']>();
    const acquire = (client: PoolClient) => {
      const query = client.query;
      queries.set(client, query);
      let adopting = false;
      client.query = (async (input: string | { text: string }, ...args: unknown[]) => {
        const sql = typeof input === 'string' ? input : input.text;
        const result = await Reflect.apply(query, client, [input, ...args]);
        if (sql.includes('SELECT semantic.adopt_public_filter_baseline_page')) adopting = true;
        if (adopting && sql === 'COMMIT' && !lost) {
          lost = true;
          throw new CommandUnavailableError('contention', 0);
        }
        return result;
      }) as PoolClient['query'];
    };
    const release = (_error: Error | undefined, client: PoolClient) => {
      const query = queries.get(client);
      if (query) client.query = query;
      queries.delete(client);
    };
    f.db.pool.on('acquire', acquire).on('release', release);
    try {
      expect(await advance()).toMatchObject({ status: 'preparing', enrollmentAdvanced: true });
      expect(lost).toBe(true);
    } finally {
      f.db.pool.off('acquire', acquire).off('release', release);
      for (const [client, query] of queries) client.query = query;
    }
    const recovered = (await readFrontier())[0]!;
    expect(recovered.account_after).toBeGreaterThan(beforeLoss.account_after);
    expect(recovered.coverage_after).toBe(recovered.account_after);
    expect(await advance()).toMatchObject({ status: 'preparing', enrollmentAdvanced: true });
    const frontier = await readFrontier();
    expect(frontier[0]!.coverage_after).toBeGreaterThan(recovered.coverage_after);
    const epoch = resolved.definition.source.epoch;
    await setNativePartitionEpochForFixture(f.db, 0, epoch + 1);
    expect(await advance()).toMatchObject({ status: 'unavailable', reason: 'observation_lost' });
    await setNativePartitionEpochForFixture(f.db, 0, epoch);
    await withConnection(f.db.admin, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL semantic.erasure_cleanup='on'");
        await client.query('DELETE FROM semantic.definition_activation WHERE route=0 AND digest=$1', [
          f.meaning.digest,
        ]);
        await client.query('DELETE FROM semantic.definition_release WHERE route=0 AND digest=$1', [f.meaning.digest]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    let checkouts = 0;
    const acquired = () => checkouts++;
    f.db.pool.on('acquire', acquired);
    try {
      const result = await advance();
      expect(result).toMatchObject({ status: 'unready', reason: 'definition_missing' });
      const cost = result?.cost;
      expect(cost && 'statements' in cost ? cost.statements : undefined).toBeGreaterThanOrEqual(6);
      expect(checkouts).toBe(1);
    } finally {
      f.db.pool.off('acquire', acquired);
    }
    expect(await readFrontier()).toEqual(frontier);
  } finally {
    try {
      await consumer.close();
    } finally {
      await f.close();
    }
  }
}, 60_000);

test('canonical retained observation execution joins preserve complete compiler keys', async () => {
  const { createPublicFilterCustody } = await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { parseText } = await import('../../src/search/text.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const index = `source-binding-${crypto.randomUUID()}`;
  const custody = createPublicFilterCustody(f.db.pool);
  let created = false;
  try {
    const person = await f.create();
    const book = await f.create('schema:Book');
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'name' as const,
      size: 10,
      filterDocument: {
        not: {
          statement: {
            property: 'schema:author',
            in: [person],
            qualifiers: [{ property: 'ex:left', in: [person] }],
          },
        },
      },
      text: parseText('native -excluded'),
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    for (const key of [
      { kind: 'type' },
      { kind: 'property', property: 'schema:author' },
      { kind: 'property', property: 'ex:left' },
      { kind: 'order', order: 'name' },
      { kind: 'field', field: 'id' },
      { kind: 'field', field: 'descriptions' },
    ] as const)
      expect(resolved.definition.dependencyKeys).toContainEqual(key);
    await search.request('PUT', `/${index}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
    });
    created = true;
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      search,
      readContext(),
    );
    expect(registered.status).toBe('registered');
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await prepareSource(f, binding, {
      source,
      meaning: f.meaning,
      capture,
      consumer: registered.consumer,
      snapshot: 'prepared',
    });
    expect(begun.status).toBe('begun');
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const enrollment = await f.db.pool.query(
      `SELECT count(*)::integer AS homes, min(partition_no) AS first, max(partition_no) AS last
       FROM semantic.public_filter_home_enrollment
       WHERE bootstrap=$1::uuid AND complete AND receipt IS NOT NULL`,
      [begun.bootstrap.id.slice(2)],
    );
    expect(enrollment.rows).toEqual([{ homes: 4096, first: 0, last: 4095 }]);
    const retained = await custody.retainPrepared(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        build: crypto.randomUUID(),
        generation: 1n,
        rows: [{ original: book, terminal: book }],
        expiresAt: Date.now() + 60000,
      },
      readContext(),
    );
    expect(retained.status).toBe('retained');
    if (retained.status !== 'retained') throw new Error(retained.reason);
    const adopted = await binding.adopt({ bootstrap: begun.bootstrap.id, queried: retained.queried }, readContext());
    expect(adopted.status).toBe('adopted');
    const acquired = await custody.acquire(retained.queried, readContext());
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error(acquired.reason);
    try {
      for (const ownRows of [[{ original: book, terminal: book }], []]) {
        const execution = {
          id: crypto.randomUUID(),
          start: begun.bootstrap.covered,
          ownRows,
        };
        expect((await custody.appendExecution({ use: acquired.use, execution }, readContext())).status).toBe(
          'appended',
        );
        const joined = await binding.join({ queried: retained.queried, execution: execution.id }, readContext());
        expect(joined.status).toBe('joined');
        if (joined.status !== 'joined') throw new Error(joined.reason);
        expect(joined.execution).toEqual(execution);
        expect(joined.definition).toEqual(resolved.definition);
        expect(joined.covered).toEqual(begun.bootstrap.covered);
      }
    } finally {
      await custody.release(acquired.use, readContext());
    }
    const diagnostic = await binding.join({ queried: retained.queried }, readContext());
    expect(diagnostic.status === 'joined' && diagnostic.execution).toBeNull();
    expect(
      await binding.join({ queried: retained.queried, execution: crypto.randomUUID() }, readContext()),
    ).toMatchObject({ reason: 'execution_missing' });
    const recovered = await createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access).recover(
      { bootstrap: begun.bootstrap.id },
      readContext(),
    );
    expect(recovered.status).toBe('adopted');
    // Closing Search custody invalidates this immutable observation without borrowing another cut.
    await custody.closeObservation(retained.queried, search, readContext());
    expect((await binding.join({ queried: retained.queried }, readContext())).status).not.toBe('joined');
    expect(await binding.abort({ bootstrap: begun.bootstrap.id }, readContext())).toMatchObject({ status: 'pending' });
  } finally {
    await custody.close();
    if (created) await search.request('DELETE', `/${index}`);
    await f.close();
  }
}, 300000);

test('a closed materializing PIT retires only its matching unadopted build in bounded batches', async () => {
  const { createPublicFilterCustody } = await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const index = `preparation-retire-${crypto.randomUUID()}`;
  const custody = createPublicFilterCustody(f.db.pool);
  try {
    await search.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const resolved = await binding.resolve(
      {
        source: publicFilterSource(f.config),
        meaning: f.meaning,
        capture: { sort: 'id', size: 10, filterDocument: undefined, text: undefined },
      },
      readContext(),
    );
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    const stored = await custody.register(
      { definition: resolved.definition, physicalTarget: index, consumerGeneration: '1', projectionGeneration: '1' },
      search,
      readContext(),
    );
    if (stored.status !== 'registered') throw new Error(stored.reason);
    const bootstrap = crypto.randomUUID();
    const build = '0:' + bootstrap;
    // Stage only the interrupted request. This fixture neither publishes a generation nor serves a search.
    await f.db.pool.query(
      `INSERT INTO semantic.public_filter_bootstrap
         (partition_no,bootstrap,read_definition,request_key,consumer,snapshot_kind,native_snapshot,owner_epoch,
          source_position,state,coverage_publication,coverage_generation)
       SELECT 0,$1,$2,$3,$4,'prepared',pg_current_snapshot(),epoch,position,'begun',$5,0
       FROM core.partition WHERE partition_no=0`,
      [
        bootstrap,
        resolved.definition.readDefinition,
        bootstrap,
        JSON.stringify(tree(stored.consumer, 'value')),
        crypto.randomUUID(),
      ],
    );
    const pit = await custody.openPit(
      { registration: stored.registration, covered: { observation: build }, keepAliveMs: 30_000 },
      search,
      readContext(),
    );
    if (pit.status !== 'retained') throw new Error(pit.reason);
    const retained = {
      registration: stored.registration,
      bootstrap: { id: build },
      materializing: pit.queried,
      queried: null,
      adopted: false,
    };
    const work = JSON.stringify(tree(retained, 'value'));
    const request = {
      bootstrap: build,
      closedPreparation: { registration: stored.registration.id, observation: pit.queried.snapshot.observation, work },
    };
    const args = [stored.registration.id, build];
    await f.db.pool.query(
      'UPDATE search.public_filter_registration SET consumer_bootstrap=$2,consumer_work=$3 WHERE partition_no=0 AND id=$1',
      [...args, work],
    );
    await f.db.pool.query(
      `INSERT INTO search.public_filter_prepared (partition_no,registration,build,generation,rows,segment_state,raw_count)
       VALUES(0,$1,$2,1,'[]','building',19)`,
      args,
    );
    await f.db.pool.query(
      `INSERT INTO search.public_filter_preparation_segment(partition_no,registration,build,generation,raw_ordinal,payload)
       SELECT 0,$1,$2,1,n,'{}' FROM generate_series(0,18) n`,
      args,
    );
    const remaining = async () =>
      Number(
        (
          await f.db.pool.query(
            'SELECT count(*) FROM search.public_filter_preparation_segment WHERE partition_no=0 AND registration=$1 AND build=$2',
            args,
          )
        ).rows[0].count,
      );
    expect((await binding.abort(request, readContext())).status).toBe('pending');
    expect(await remaining()).toBe(19);
    expect((await custody.closeObservation(pit.queried, search, readContext())).status).toBe('closed');
    const wrongWork = JSON.stringify(tree({ ...retained, revision: 2 }, 'value'));
    expect(
      (
        await binding.abort(
          { ...request, closedPreparation: { ...request.closedPreparation, work: wrongWork } },
          readContext(),
        )
      ).status,
    ).toBe('pending');
    expect(await remaining()).toBe(19);
    expect((await binding.abort(request, readContext())).status).toBe('pending');
    expect(await remaining()).toBe(3);
    const retries = await Promise.all([binding.abort(request, readContext()), binding.abort(request, readContext())]);
    expect(retries.map((r) => r.status).sort()).toEqual(['aborted', 'pending']);
    expect(await remaining()).toBe(0);
    expect(
      (
        await f.db.pool.query(
          'SELECT consumer_bootstrap,consumer_work FROM search.public_filter_registration WHERE partition_no=0 AND id=$1',
          [stored.registration.id],
        )
      ).rows[0],
    ).toEqual({ consumer_bootstrap: null, consumer_work: null });
    expect(
      (
        await f.db.pool.query(
          'SELECT state FROM semantic.public_filter_bootstrap WHERE partition_no=0 AND bootstrap=$1',
          [bootstrap],
        )
      ).rows[0].state,
    ).toBe('aborted');
    expect(
      (
        await f.db.pool.query(
          'SELECT FROM search.public_filter_prepared WHERE partition_no=0 AND registration=$1 AND build=$2',
          args,
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await custody.close();
    await search.request('DELETE', `/${index}`);
    await f.close();
  }
}, 120_000);

test('native Source repair receipts revalidate original steps, replay, and current ownership without completing an incomplete cut', async () => {
  const { createPublicFilterCustody } = await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const index = `source-repair-${crypto.randomUUID()}`;
  const custody = createPublicFilterCustody(f.db.pool);
  let created = false;
  try {
    const person = await f.create();
    const book = await f.create('schema:Book', {
      'schema:author': [
        {
          property: { id: 'schema:author' },
          value: { type: 'value', content: person },
          qualifiers: [],
        },
      ],
    });
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'id' as const,
      size: 10,
      filterDocument: undefined,
      text: undefined,
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    await search.request('PUT', `/${index}`, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
    });
    created = true;
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: '1',
      },
      search,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const begun = await prepareSource(f, binding, {
      source,
      meaning: f.meaning,
      capture,
      consumer: registered.consumer,
      snapshot: 'prepared',
    });
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const retained = await custody.retainPrepared(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        build: crypto.randomUUID(),
        generation: 1n,
        rows: [{ original: book, terminal: book }],
        expiresAt: Date.now() + 600000,
      },
      readContext(),
    );
    if (retained.status !== 'retained') throw new Error(retained.reason);
    expect(
      (await binding.adopt({ bootstrap: begun.bootstrap.id, queried: retained.queried }, readContext())).status,
    ).toBe('adopted');
    const acquired = await custody.acquire(retained.queried, readContext());
    if (acquired.status !== 'acquired') throw new Error(acquired.reason);
    const execution = crypto.randomUUID();
    try {
      expect(
        (
          await custody.appendExecution(
            {
              use: acquired.use,
              execution: {
                id: execution,
                start: begun.bootstrap.covered,
                ownRows: [{ original: book, terminal: book }],
              },
            },
            readContext(),
          )
        ).status,
      ).toBe('appended');
    } finally {
      await custody.release(acquired.use, readContext());
    }
    const original = {
      bootstrap: begun.bootstrap.id,
      queried: retained.queried,
      execution,
    };
    const forged: NativeSourceRepairLocator = {
      bootstrap: original.bootstrap,
      execution,
      step: crypto.randomUUID(),
      locatorDigest: '0'.repeat(64),
    };
    expect(
      (await binding.readRepairReceipt({ receipt: forged, queried: retained.queried, execution }, readContext()))
        .status,
    ).not.toBe('verified');
    expect((await binding.settle(original, readContext())).status).not.toBe('joined');

    // Ordinary native pages are the only way to reach the original produced step. No fixture receipt setter.
    let frontier: string | null = null;
    let found = false;
    // At most 32 empty-home batches cover 4096 partitions; the extra budget is
    // for the real subject advancement and projection receipts in this fixture.
    for (let steps = 0; steps < 128; steps++) {
      const request = { ...original, frontier, inputLimit: 256 };
      const page = await binding.repairPage(request, readContext());
      expect(page.status).toBe('progress');
      if (page.status !== 'progress') throw new Error(`Native repair stopped: ${page.status}`);
      if (steps === 0) {
        const sharedDeadline = readContext();
        const root = { ...original, predecessor: null };
        expect(
          await withNativePublicFilterRepairReadBatch(binding, original, sharedDeadline, () =>
            binding.readRepairStep(root, sharedDeadline),
          ),
        ).toMatchObject({ reason: 'owner_unavailable' });
        const scan = await binding.readRepairStep(root, readContext());
        expect(scan).toMatchObject({ status: 'verified', predecessor: null, complete: false, receipts: [] });
        if (scan.status !== 'verified') throw new Error(scan.reason);
        await withNativePublicFilterRepairReadBatch(binding, original, sharedDeadline, async () => {
          const first = await binding.readRepairStep(root, sharedDeadline);
          const second = await binding.readRepairStep(root, sharedDeadline);
          expect(first.status).toBe('verified');
          expect(second).toMatchObject({ status: 'verified', step: page.frontier, receipts: [] });
          expect(second.cost.inputKeys).toBeLessThan(first.cost.inputKeys);
          expect(second.cost.frontierWrites).toBe(0);
          expect(second.cost.inputKeys).toBeGreaterThan(0);
        });
        expect(nativePublicFilterRepairEvidence(binding, scan)).toEqual({ repairs: [], account: null });
        expect(nativePublicFilterRepairEvidence(binding, structuredClone(scan))).toBeUndefined();
        const restarted = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
        expect(nativePublicFilterRepairEvidence(restarted, scan)).toBeUndefined();
        const replay = await restarted.repairPage(request, readContext());
        expect(replay).toMatchObject({ status: 'progress', frontier: page.frontier, repairs: [] });
      }
      const repair = page.repairs.find((entry) => entry.source.subject === book);
      if (!repair) {
        frontier = page.frontier;
        continue;
      }
      found = true;
      const stepInput = { ...original, predecessor: frontier };
      // A second consumer replaces the mutable projection build before this
      // execution verifies the exact Source page it already retained.
      const competing = await publicFilterSource(f.config).readPublicFilterProjectionPage({
        subject: book,
        meaning: f.meaning,
        inputLimit: request.inputLimit,
        frontier: null,
        context: readContext(),
      });
      if (repair.projection.status !== 'complete' || competing.status !== 'complete')
        throw new Error('Both native projections must complete');
      expect(competing.frontier.build).not.toBe(repair.projection.frontier.build);
      const step = await binding.readRepairStep(stepInput, readContext());
      expect(step).toMatchObject({
        status: 'verified',
        step: page.frontier,
        predecessor: frontier,
        complete: false,
      });
      if (step.status !== 'verified') throw new Error('Native Source repair step was not verified');
      expect(step.receipts.map((receipt) => receipt.locatorDigest)).toEqual(
        page.repairs.map((entry) => entry.receipt.locatorDigest),
      );
      expect(nativePublicFilterRepairEvidence(binding, step)?.repairs.map((entry) => entry.receipt)).toEqual(
        page.repairs.map((entry) => entry.receipt),
      );
      const recovered = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
      const replay = await recovered.repairPage(request, readContext());
      expect(replay.status).toBe('progress');
      if (replay.status !== 'progress') throw new Error('Lost-response replay did not recover the native step');
      expect(replay.frontier).toBe(page.frontier);
      expect(replay.repairs.map((entry) => entry.receipt.step)).toEqual(
        page.repairs.map((entry) => entry.receipt.step),
      );
      const receipt: NativeSourceRepairLocator = JSON.parse(JSON.stringify(repair.receipt));
      const read = { receipt, queried: retained.queried, execution };
      expect((await recovered.readRepairReceipt(read, readContext())).status).toBe('verified');
      expect(
        (
          await recovered.readRepairReceipt(
            { ...read, receipt: { ...receipt, locatorDigest: 'f'.repeat(64) } },
            readContext(),
          )
        ).status,
      ).not.toBe('verified');
      expect(
        (await recovered.readRepairReceipt({ ...read, execution: crypto.randomUUID() }, readContext())).status,
      ).not.toBe('verified');
      expect((await recovered.repairPage({ ...request, inputLimit: 1 }, readContext())).status).not.toBe('progress');
      expect((await recovered.settle(original, readContext())).status).not.toBe('joined');
      const owner = (
        await f.db.admin.query<{ epoch: number; write_state: string; moved_to: string | null }>(
          'SELECT epoch,write_state,moved_to FROM core.partition WHERE partition_no=$1',
          [repair.source.partition],
        )
      ).rows[0]!;
      try {
        const settlementDeadline = readContext();
        await withNativePublicFilterRepairReadBatch(recovered, original, settlementDeadline, async () => {
          expect(await recovered.readRepairStep(stepInput, settlementDeadline)).toMatchObject({
            status: 'verified',
            step: step.step,
            receipts: step.receipts,
          });
          await setNativePartitionEpochForFixture(f.db, repair.source.partition, owner.epoch + 1);
          expect((await recovered.readRepairStep(stepInput, settlementDeadline)).status).not.toBe('verified');
          expect((await recovered.readRepairReceipt(read, readContext())).status).not.toBe('verified');
        });
      } finally {
        await setNativePartitionEpochForFixture(f.db, repair.source.partition, owner.epoch);
      }
      expect((await recovered.readRepairReceipt(read, readContext())).status).toBe('verified');
      try {
        await f.db.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [
          repair.source.partition,
        ]);
        expect((await recovered.readRepairReceipt(read, readContext())).status).not.toBe('verified');
      } finally {
        await f.db.admin.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
          repair.source.partition,
          owner.write_state,
          owner.moved_to,
        ]);
      }
      expect((await recovered.readRepairReceipt(read, readContext())).status).toBe('verified');
      await f.propose(book, person);
      expect((await recovered.readRepairReceipt(read, readContext())).status).not.toBe('verified');
      break;
    }
    expect(found).toBe(true);
  } finally {
    await custody.close();
    if (created) await search.request('DELETE', `/${index}`);
    await f.close();
  }
}, 300000);

test('Native public Source repair step and complete original cut are durably revalidated before joining genuine Search dispatch settlement without current ACK or incomplete enumeration substitutes', async () => {
  const { readPublicFilterConsumerCustody, readPublicFilterRepairSettlement } =
    await import('../../src/search/public-filter-custody.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  let consumer: Awaited<ReturnType<typeof consumerFixture>> | undefined;
  try {
    const source = publicFilterSource(f.config);
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    consumer = await consumerFixture(f, source);
    const capture = await capturedConsumer(
      f,
      consumer,
      { sort: 'id', size: 10, filterDocument: undefined, text: undefined },
      'prepared',
    );
    const query = await consumer.operations.query(capture.queried, readContext());
    expect(query.status).toBe('queried');
    if (query.status !== 'queried') throw new Error(`Native default query ${query.status}`);
    const retained = await readPublicFilterConsumerCustody(
      f.db.pool,
      { queried: query.queried, execution: query.execution },
      readContext(),
    );
    expect(retained.status).toBe('found');
    if (retained.status !== 'found' || !retained.execution) throw new Error('Missing actual Search execution');
    const request = {
      bootstrap: retained.covered.observation,
      queried: query.queried,
      execution: query.execution,
    };

    const job = await publicationJob(f, source, query.queried.consumer);
    const publication = { ...request, job };
    // The genuine native query has dispatched. Lose only the reply after the original
    // Source association commits, before the completion reader can adopt/settle it.
    let interrupted = false;
    const losingReply = new Proxy(f.db.pool, {
      get(target, key) {
        if (key === 'query')
          return async (statement: string, values?: unknown[]) => {
            const result = await target.query(statement, values);
            if (!interrupted && statement.includes('SET publication_job=')) {
              interrupted = true;
              throw new Error('Lost original Source publication association reply');
            }
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      readNativePublicFilterPublicationCompletion(
        createPublicFilterSourceBinding(losingReply, f.config.routeKey, f.config.access),
        publication,
        readContext(),
      ),
    ).rejects.toThrow('Lost original Source publication association reply');
    expect(interrupted).toBe(true);
    expect((await readNativePublicFilterPublicationCompletion(binding, publication, readContext())).status).not.toBe(
      'complete',
    );
    // Restart after the original observation: the persisted job resolves that same cut/execution.
    const restarted = () => createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    expect(await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext())).toMatchObject({
      status: 'pending',
      publication,
    });
    const first = await consumer.operations.repairStep(capture.repair, readContext());
    expect(first.status).toBe('progress');
    if (first.status !== 'progress') throw new Error(`Incomplete Source repair ${first.status}`);
    const incomplete = await binding.readRepairStep({ ...request, predecessor: null }, readContext());
    expect(incomplete).toMatchObject({
      status: 'verified',
      predecessor: null,
      complete: false,
    });
    if (incomplete.status !== 'verified') throw new Error('Original Source step was not revalidated');
    expect(incomplete.frontier).toBe(incomplete.step);
    expect(incomplete.receipts.length).toBeLessThanOrEqual(256);

    // An existing live target acknowledgement cannot replace the original cut's unfinished Source frontier.
    expect(
      (
        await readPublicFilterRepairSettlement(
          f.db.pool,
          { queried: query.queried, execution: query.execution },
          readContext(),
        )
      ).status,
    ).not.toBe('settled');
    expect((await binding.settle(request, readContext())).status).not.toBe('joined');

    let settled = false;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const result = await consumer.operations.repairStep(capture.repair, readContext());
      if (result.status === 'progress') continue;
      expect(result.status).toBe('settled');
      settled = result.status === 'settled';
      break;
    }
    expect(settled).toBe(true);

    let predecessor: string | null = null;
    let complete: NativeSourceRepairStepVerification | null = null;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const step: NativeSourceRepairStepVerification = await binding.readRepairStep(
        { ...request, predecessor },
        readContext(),
      );
      expect(step.status).toBe('verified');
      if (step.status !== 'verified') throw new Error(`Native Source step ${step.status}`);
      if (step.complete) {
        complete = step;
        break;
      }
      expect(step.frontier).toBe(step.step);
      predecessor = step.step;
    }
    expect(complete?.status).toBe('verified');
    if (!complete || complete.status !== 'verified') throw new Error('Original Source cut did not close');
    expect(complete.frontier).toBeNull();
    expect(complete.predecessor).toBe(predecessor);

    const dispatch = await readPublicFilterRepairSettlement(
      f.db.pool,
      { queried: query.queried, execution: query.execution },
      readContext(),
    );
    expect(dispatch.status).toBe('settled');
    if (dispatch.status !== 'settled') throw new Error(`Native Search settlement ${dispatch.status}`);
    const joined = await binding.settle(request, readContext());
    expect(joined.status).toBe('joined');
    if (joined.status !== 'joined') throw new Error(`Native Source settlement ${joined.status}`);
    expect(joined.queried).toEqual(query.queried);
    expect(joined.execution).toEqual(retained.execution);
    expect(joined.covered).toEqual(retained.covered);
    expect(dispatch.settlement.id).toBeString();
    // Native drain committed before a reply/restart. Both reads must return the original proof.
    for (let restart = 0; restart < 2; restart++) {
      const result = await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext());
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') throw new Error(`Native publication completion ${result.reason}`);
      expect(result.publication).toEqual(publication);
      expect(result.covered).toEqual(retained.covered);
      expect(result.execution).toEqual(retained.execution);
      expect(result.terminal.step).toBe(complete.step);
      expect(result.observation).toMatchObject({
        status: 'observed',
        coverage: 'all_native_homes',
      });
      expect(result.settlement.id).toBe(dispatch.settlement.id);
    }
    const growth = await checkGrowth(f.db, {
      name: 'original Source generation completion fixed window',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      async grow(database, scale, previous) {
        await seed(
          database,
          {
            name: `publication-unrelated-${job}`,
            hotPartition: 0,
            rows: ({ route }) => ({
              'semantic.subject': [
                {
                  route,
                  subject_id: newId(route),
                  type: 'schema:Person',
                  recorded_transaction_id: crypto.randomUUID(),
                  current_release: f.meaning.digest,
                },
              ],
            }),
          },
          { from: previous, to: scale },
        );
      },
      async operation() {
        const result = await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext());
        expect(result.status).toBe('complete');
        if (result.status !== 'complete') throw new Error(`Original completion ${result.reason}`);
        expect(result.publication).toEqual(publication);
        expect(result.cost.inputKeys).toBeLessThanOrEqual(1000);
        for (const field of ['rows', 'statements', 'bytes', 'engineRequests'])
          expect(Reflect.get(result.cost, field)).toBeGreaterThan(0);
      },
    });
    expect(growth.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
    const equivalent = await consumer.operations.query(query.queried, readContext());
    expect(equivalent.status).toBe('queried');
    if (equivalent.status !== 'queried') throw new Error('Missing equivalent native execution');
    expect(equivalent.execution).not.toBe(query.execution);
    expect(
      (
        await readNativePublicFilterPublicationCompletion(
          restarted(),
          { ...publication, execution: equivalent.execution },
          readContext(),
        )
      ).status,
    ).not.toBe('complete');
    expect((await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext())).status).toBe(
      'complete',
    );
    await consumer.recreate();
    expect((await readNativePublicFilterPublicationCompletion(restarted(), { job }, readContext())).status).not.toBe(
      'complete',
    );
  } finally {
    try {
      await consumer?.close();
    } finally {
      await f.close();
    }
  }
}, 300000);

test('native Source replays its original creation window after the same home advances', async () => {
  const { createPublicFilterCustody, decodePublicFilterNativeState } =
    await import('../../src/search/public-filter-custody.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { publicFilterSource } = await nativeProducer();
  const f = await fixture();
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `source-window-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const custody = createPublicFilterCustody(f.db.pool);
  let created = false;
  try {
    const binding = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const source = publicFilterSource(f.config);
    const capture = {
      sort: 'id' as const,
      size: 10,
      filterDocument: undefined,
      text: undefined,
    };
    const resolved = await binding.resolve({ source, meaning: f.meaning, capture }, readContext());
    if (resolved.status !== 'resolved') throw new Error(resolved.reason);
    await createSubjectIndex(search, prefix, 1);
    created = true;
    const registered = await custody.register(
      {
        definition: resolved.definition,
        physicalTarget: index,
        consumerGeneration: '1',
        projectionGeneration: resolved.definition.readDefinition,
      },
      search,
      readContext(),
    );
    if (registered.status !== 'registered') throw new Error(registered.reason);
    const author = await f.create('schema:Person');
    const execution = await publicationJob(f, source, registered.consumer);
    const begun = await prepareSource(f, binding, {
      source,
      meaning: f.meaning,
      capture,
      consumer: registered.consumer,
      snapshot: 'prepared',
    });
    if (begun.status !== 'begun') throw new Error(begun.reason);
    const retained = await custody.retainPrepared(
      {
        registration: registered.registration,
        covered: begun.bootstrap.covered,
        build: crypto.randomUUID(),
        generation: 1n,
        rows: [],
        expiresAt: Date.now() + 600000,
      },
      readContext(),
    );
    if (retained.status !== 'retained') throw new Error(retained.reason);
    expect(
      (await binding.adopt({ bootstrap: begun.bootstrap.id, queried: retained.queried }, readContext())).status,
    ).toBe('adopted');
    let callerQueries = 0;
    const ownCustody = await withQueryAccounting(
      {
        query: (_statement, _operands, dispatch) => {
          callerQueries++;
          return dispatch();
        },
        connection: (dispatch) => dispatch(),
      },
      () => custody.read({ queried: retained.queried }, readContext()),
    );
    expect(ownCustody.status).toBe('found');
    expect(ownCustody.cost.statements).toBeGreaterThan(0);
    expect(callerQueries).toBe(0);
    const acquired = await custody.acquire(retained.queried, readContext());
    if (acquired.status !== 'acquired') throw new Error(acquired.reason);
    try {
      expect(
        (
          await custody.appendExecution(
            {
              use: acquired.use,
              execution: {
                id: execution,
                start: begun.bootstrap.covered,
                ownRows: [],
              },
            },
            readContext(),
          )
        ).status,
      ).toBe('appended');
    } finally {
      await custody.release(acquired.use, readContext());
    }
    const request = {
      bootstrap: begun.bootstrap.id,
      queried: retained.queried,
      execution,
      frontier: null,
      inputLimit: 64,
      homeLimit: 128,
    };
    expect(
      await readNativePublicFilterPublicationCompletion(binding, { ...request, job: execution }, readContext()),
    ).toMatchObject({ status: 'pending', publication: { execution } });
    const page = await binding.repairPage(request, readContext());
    expect(page.status).toBe('progress');
    if (page.status !== 'progress') throw new Error('Native Source step did not persist');
    const read = {
      bootstrap: begun.bootstrap.id,
      queried: retained.queried,
      execution,
      predecessor: null,
    };
    expect(await binding.readRepairStep(read, readContext())).toMatchObject({
      status: 'verified',
      step: page.frontier,
      predecessor: null,
      frontier: page.frontier,
      complete: false,
      receipts: [],
    });
    const recovered = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
    const replay = await recovered.repairPage(request, readContext());
    expect(replay.status).toBe('progress');
    if (replay.status !== 'progress') throw new Error('Lost-response replay did not resolve the stored step');
    expect(replay.frontier).toBe(page.frontier);
    expect(await recovered.readRepairStep(read, readContext())).toMatchObject({
      status: 'verified',
      step: page.frontier,
      receipts: [],
    });
    const openHome = 40;
    const changedHomes = [openHome - 2, openHome - 1];
    const appendUnrelated = (partition: number) =>
      runCommand(f.db.pool, { partition }, async () => ({
        value: null,
        events: [{ type: 'com.rezics.fixture.created.v1', data: null }],
      }));
    for (const home of changedHomes) await appendUnrelated(home);
    let key = 0;
    while (
      key < 65536 &&
      partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, String(key)).route) !== openHome
    )
      key++;
    expect(key).toBeLessThan(65536);
    const book = await f.create('schema:Book', {}, String(key));
    expect(partitionOf(routeOf(book)!)).toBe(openHome);
    await runCommand(
      f.db.pool,
      { partition: openHome, deadline: readContext().deadline, clock: f.config.clock },
      async () => ({ value: null, events: [{ type: 'com.rezics.fixture.created.v1', data: null }] }),
    );

    await f.propose(book, author);
    let nextKey = key + 1;
    while (partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, String(nextKey)).route) !== openHome)
      nextKey++;
    const second = await f.create('schema:Person', {}, String(nextKey));

    let checkedRange = false;
    let frontier: string | null = page.frontier;
    let prefixPredecessor: string | null | undefined;
    let fallbackPredecessor: string | undefined;
    let closedWithEvents = false;
    for (let turn = 0; turn < 80; turn++) {
      const nextRequest = { ...request, frontier };
      const next = await recovered.repairPage(nextRequest, readContext());
      if (next.status !== 'progress' && next.status !== 'complete')
        throw new Error(`Original Source continuation ${turn}: ${next.reason}`);
      const stepRequest = { ...read, predecessor: frontier };
      const row = next.frontier
        ? (
            await f.db.pool.query<{ state: string }>(
              `SELECT state FROM semantic.public_filter_repair_step
         WHERE (partition_no,bootstrap,execution,step)=(0,$1,$2,$3)`,
              [request.bootstrap.slice(2), execution, next.frontier],
            )
          ).rows[0]
        : undefined;
      const window =
        row &&
        decodePublicFilterNativeState<{
          windowBatch?: { from: number; examined: number; through?: string[] };
          bridgeEvents?: { count?: number; envelopes?: string };
          input: { bridge?: PublicFilterCreationWindow };
          next: {
            phase: string;
            partition: number;
            bridge?: { partition: number };
            subject: string | null;
            bridgeThrough?: bigint;
            resumeBridge?: PublicFilterCreationWindow;
          };
        }>(row.state);
      if (window?.windowBatch?.through && window.windowBatch.from + window.windowBatch.examined === openHome) {
        prefixPredecessor = frontier;
        const { from, through } = window.windowBatch;
        expect(from).toBeLessThanOrEqual(changedHomes[0]!);
        const prefixInput = { bootstrap: request.bootstrap.slice(2), from, inputLimit: request.inputLimit };
        async function readPrefix(retainedThrough?: readonly string[]) {
          const dispatches: string[] = [];
          const meter = { inputKeys: 0, rows: 0, dependencyPoints: 0 };
          const windows = await withQueryAccounting(
            {
              query: (sql, parameters, dispatch) => {
                if (sql.includes('core.outbox') && parameters[0] !== openHome) dispatches.push(sql);
                return dispatch();
              },
              connection: (dispatch) => dispatch(),
            },
            () =>
              readPublicFilterCreationPrefix(
                f.db.pool,
                { ...prefixInput, ...(retainedThrough === undefined ? {} : { through: retainedThrough }) },
                readContext(),
                meter,
              ),
          );
          return { windows, dispatches, inputs: meter.inputKeys };
        }
        const original = await readPrefix();
        expect(original.windows.map(({ window }) => String(window.through))).toEqual(through);
        expect(original.dispatches).toHaveLength(changedHomes.length);
        await appendUnrelated(changedHomes[0]!);
        const replayed = await readPrefix(through);
        expect(replayed.windows).toEqual(original.windows);
        expect(replayed.inputs).toBe(through.length + changedHomes.length);
        expect(replayed.dispatches).toHaveLength(1);
        expect(replayed.dispatches[0]).toContain('jsonb_to_recordset');
        const lost = await recovered.repairPage(nextRequest, readContext());
        expect(lost).toMatchObject({ status: 'progress', frontier: next.frontier, repairs: next.repairs });
      }
      const fallback = !fallbackPredecessor && window && window.windowBatch?.from === openHome;
      if (fallback && window?.windowBatch) {
        if (frontier === null || prefixPredecessor === undefined) throw new Error('Missing verified creation prefix');
        fallbackPredecessor = frontier;
        expect(window.windowBatch.through).toBeUndefined();
        expect(window.windowBatch.examined).toBe(1);
        expect(window.next.bridge?.partition).toBe(openHome);
        await runCommand(
          f.db.pool,
          { partition: openHome, deadline: readContext().deadline, clock: f.config.clock },
          async () => ({ value: null, events: [{ type: 'com.rezics.fixture.created.v1', data: null }] }),
        );
        expect(await recovered.repairPage({ ...request, frontier: prefixPredecessor }, readContext())).toMatchObject({
          status: 'progress',
          frontier: fallbackPredecessor,
        });
      }
      if (window && window.input.bridge && window.next.subject === book) {
        const original = window.input.bridge;
        const successor = window.next.resumeBridge!;
        const keys = { bootstrap: request.bootstrap.slice(2), window: original, accounts: false, subjectRange: true };
        const meter = { inputKeys: 0, rows: 0, dependencyPoints: 0 };
        const range = await readPublicFilterCreationEvents(
          f.db.pool,
          { ...keys, inputLimit: 64 },
          readContext(),
          meter,
        );
        expect(window.bridgeEvents?.envelopes).toBe(range.packed);
        expect(range.next).toEqual(successor);
        expect(range.envelopes.filter(({ subject }) => subject === book).length).toBeGreaterThan(1);
        expect(window.next.bridgeThrough).toBe(BigInt(range.envelopes.at(-1)!.position));
        expect(meter.inputKeys).toBe(3 + range.envelopes.length + 1);
        const lookahead = await readPublicFilterCreationEvents(
          f.db.pool,
          { ...keys, window: successor, inputLimit: 1 },
          readContext(),
          meter,
        );
        expect(lookahead.event.subject).toBe(second);
        const capped = await readPublicFilterCreationEvents(
          f.db.pool,
          { ...keys, inputLimit: 1 },
          readContext(),
          meter,
        );
        expect(capped.envelopes).toEqual(range.envelopes.slice(0, 1));
        expect(capped.next.position <= successor.position).toBe(true);
        const restarted = createPublicFilterSourceBinding(f.db.pool, f.config.routeKey, f.config.access);
        expect(await restarted.repairPage(nextRequest, readContext())).toMatchObject({
          status: 'progress',
          frontier: next.frontier,
        });
        expect(await restarted.readRepairStep(stepRequest, readContext())).toMatchObject({
          status: 'verified',
          frontier: next.frontier,
        });
        checkedRange = true;
      }
      const verified = await recovered.readRepairStep(stepRequest, readContext());
      if (window && window.input.bridge?.partition === openHome && window.next.phase === 'window') {
        if (window.input.bridge.position <= window.input.bridge.through)
          expect(window.bridgeEvents?.count).toBeGreaterThan(0);
        else expect(window.bridgeEvents).toBeUndefined();
        expect(window.next.partition).toBe(openHome + 1);
        expect(await recovered.repairPage(nextRequest, readContext())).toMatchObject({
          status: 'progress',
          frontier: next.frontier,
        });
        closedWithEvents = true;
      }
      if (fallback) {
        const replay = await recovered.repairPage(nextRequest, readContext());
        expect([verified, replay]).toMatchObject([
          { status: 'verified', step: next.frontier, frontier: next.frontier, receipts: [], cost: { candidates: 1 } },
          { status: 'progress', frontier: next.frontier, repairs: [], cost: { candidates: 1, frontierWrites: 0 } },
        ]);
      }
      expect(verified).toMatchObject({
        status: 'verified',
        frontier: next.frontier,
        complete: next.status === 'complete',
      });
      frontier = next.frontier;
      if (next.status === 'complete') break;
    }
    if (!fallbackPredecessor) throw new Error('Missing ordinary window replay');
    expect(closedWithEvents).toBe(true);
    expect(checkedRange).toBe(true);
    expect(frontier).toBeNull();
    const closed = await f.db.pool.query<{ verified_home: number }>(
      `SELECT verified_home FROM semantic.public_filter_repair_step
       WHERE (partition_no,bootstrap,execution)=(0,$1,$2) AND verified_home=$3 AND verified_root IS NOT NULL`,
      [request.bootstrap.slice(2), execution, openHome],
    );
    expect(closed.rows).toEqual([{ verified_home: openHome }]);
    const windowRequest = { ...read, predecessor: fallbackPredecessor };
    await setNativePartitionEpochForFixture(f.db, openHome, 2);
    expect(await recovered.readRepairStep(windowRequest, readContext())).toMatchObject({
      status: 'unavailable',
      reason: 'owner_unavailable',
    });
    await setNativePartitionEpochForFixture(f.db, openHome, 1);
    expect(await recovered.readRepairStep(windowRequest, readContext())).toMatchObject({ status: 'verified' });
    // Model lost retention custody despite the normal checkpoint trigger.
    await withConnection(f.db.admin, async (admin) => {
      await admin.query('BEGIN');
      try {
        await admin.query("SET LOCAL session_replication_role='replica'");
        const removed = await admin.query(
          `DELETE FROM core.consumer_checkpoint c USING semantic.public_filter_home_enrollment e
           WHERE (e.partition_no,e.bootstrap)=($1,$2)
             AND (c.partition_no,c.consumer)=(e.partition_no,e.creation_consumer)`,
          [openHome, request.bootstrap.slice(2)],
        );
        expect(removed.rowCount).toBe(1);
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
    });
    expect(await recovered.readRepairStep(windowRequest, readContext())).toMatchObject({
      status: 'unavailable',
      reason: 'owner_unavailable',
    });
    const positions: bigint[] = [];
    const firstMixedHome = 4000;
    const accountHome = firstMixedHome + 47;
    for (let home = firstMixedHome; home <= accountHome; home++) {
      const id = newId(home * 16);
      const committed = await runCommand(f.db.pool, { partition: home }, async () => ({
        value: null,
        events: [
          home === accountHome
            ? { type: 'com.rezics.access.account-updated.v1', subject: id, data: { accountId: id } }
            : {
                type: 'com.rezics.semantic.canonical-generation.committed.v1',
                subject: id,
                data: { partition: home, generation: '1' },
              },
        ],
      }));
      positions.push(committed.position);
    }
    const mixedWindows = await readPublicFilterCreationPrefix(
      f.db.pool,
      { bootstrap: request.bootstrap.slice(2), from: firstMixedHome, inputLimit: 128, accounts: true },
      readContext(),
      { inputKeys: 0, rows: 0, dependencyPoints: 0 },
    );
    expect(mixedWindows.map(({ window }) => [window.partition, window.through])).toEqual(
      positions.slice(0, 32).map((position, offset) => [firstMixedHome + offset, position]),
    );
    const wider = await readPublicFilterCreationPrefix(
      f.db.pool,
      { bootstrap: request.bootstrap.slice(2), from: firstMixedHome, inputLimit: 192, accounts: true },
      readContext(),
      { inputKeys: 0, rows: 0, dependencyPoints: 0 },
    );
    expect(wider.map(({ window }) => [window.partition, window.through])).toEqual(
      positions.slice(0, -1).map((position, offset) => [firstMixedHome + offset, position]),
    );
  } finally {
    await custody.close();
    if (created) await search.request('DELETE', `/${index}`);
    await f.close();
  }
}, 300000);
