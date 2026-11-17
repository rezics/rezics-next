import { afterAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { standingFixture } from '../access/standing-fixture.ts';
import { createPool, withConnection, withQueryAccounting } from '../../src/database/pool.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { softDeletePost } from '../../src/content/erase-post.ts';
import { restorePost } from '../../src/content/restore-post.ts';
import { createReviewDiscoverySource } from '../../src/content/review-discovery.ts';
import {
  createReviewDiscoveryEffect,
  processReviewDiscoveryPage,
} from '../../src/content/review-discovery-lifecycle.ts';
import { REVIEW_DISCOVERY_CHANGED } from '../../src/content/review-discovery-events.ts';
import { readReviewDiscoveryChanges } from '../../src/content/review-discovery-changes.ts';
import type { CommandOutcome } from '../../src/command/command.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { nativeDiscoveryRegistry, createDiscoveryProjection } from '../../src/search/account-discovery.ts';
import {
  advanceDiscovery,
  allocateDiscovery,
  discoveryGenerations,
  DiscoveryProducerCoverageError,
  discoveryConsumer,
} from '../../src/search/generations.ts';
import { createDiscoveryIndex, discoveryIndexName, discoveryIndexUuid } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { startDiscoveryIndexing } from '../../src/search/runner.ts';
import { resolveDiscoveryOwnerAdapters } from '../../src/search/discovery-owner-registry.ts';
import {
  createReviewDiscoveryReceiving,
  requestReviewDiscoveryReceiving,
  readReviewDiscoveryReceiving,
} from '../../src/search/review-discovery-receiving.ts';
import { discoveryDocumentId } from '../../src/search/discovery-documents.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());
const routeKey = new Uint8Array(32).fill(73);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const request = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  deadline: Date.now() + 30_000,
  requestId: Bun.randomUUIDv7(),
});

test('pending Review invalidation leaves other population frontiers runnable', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `review-coverage-${crypto.randomUUID().slice(0, 8)}-`;
  const source = createRatedSubjectSource(pool, routeKey).source;
  const entry = createDiscoveryProducerEntry({
    clock: () => new Date(),
    pool,
    routeKey,
    access: fixture.access,
    subjects: source,
    tokens,
  });
  const metadataProducers = { review: entry.metadataProducers.review! };
  const { ownerAdapters } = await resolveDiscoveryOwnerAdapters({ ...entry, metadataProducers });
  const registry = await nativeDiscoveryRegistry(pool, routeKey, source, {
    release: bundledRelease,
    accounts: entry.accounts,
    ownerAdapters,
  });
  const advance = () =>
    advanceDiscovery({
      pool,
      search,
      prefix,
      registry,
      listing: subjectListingSource(pool),
      requiredKinds: ['review'],
      metadataProducers,
    });
  const work = { route: 65_520, id: crypto.randomUUID() };
  async function frontiers() {
    const result = await pool.query<{ owner: string; complete: number; withCursor: number }>(
      `SELECT owner, count(*) FILTER (WHERE complete)::int AS complete,
         count(*) FILTER (WHERE after_id IS NOT NULL OR continuation IS NOT NULL)::int AS "withCursor"
       FROM search.discovery_population WHERE prefix=$1 GROUP BY owner ORDER BY owner`,
      [prefix],
    );
    return result.rows;
  }
  try {
    await advance();
    await pool.query('DELETE FROM search.discovery_population WHERE prefix=$1 AND partition_no>=64', [prefix]);
    await pool.query(
      `INSERT INTO content.review_discovery_work(route,id,origin,scopes)
       VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
      [
        work.route,
        work.id,
        JSON.stringify({
          partition: 4095,
          epoch: 1,
          position: '1',
          eventIndex: 0,
          id: work.id,
          type: 'com.rezics.content.post.restored.v1',
        }),
        JSON.stringify([{ kind: 'post', id: newId(work.route) }]),
      ],
    );
    const blocked = await advance().catch((error: unknown) => (error as Error).name);
    expect({ blocked, frontiers: await frontiers() }).toEqual({
      blocked: undefined,
      frontiers: [
        { owner: 'accounts', complete: 64, withCursor: 0 },
        { owner: 'review', complete: 0, withCursor: 0 },
        { owner: 'semantic', complete: 64, withCursor: 0 },
      ],
    });
    expect(await advance()).toBe('waiting-for-review-invalidation');
    expect((await discoveryGenerations(pool, prefix))[0]?.state).toBe('populating');
    expect((await processReviewDiscoveryPage(pool, work)).complete).toBe(true);
    expect(await advance()).toBeUndefined();
    expect(await frontiers()).toContainEqual({ owner: 'review', complete: 64, withCursor: 0 });
  } finally {
    await search.request('DELETE', `/${discoveryIndexName(prefix, 1)}`);
    for (const table of ['discovery_population', 'discovery_generation'])
      await pool.query(`DELETE FROM search.${table} WHERE prefix=$1`, [prefix]);
    await pool.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [discoveryConsumer(prefix, 1)]);
    await pool.query('DELETE FROM content.review_discovery_work WHERE route=$1 AND id=$2', [work.route, work.id]);
    await pool.end();
  }
});

// Real Content lifecycle, native journal, PostgreSQL and exact mixed writer.
test('default mixed supervisor applies current reviews and recovers exact journal progress', async () => {
  await bootstrapRelease(fixture.pool, bundledRelease);
  // Each native command has its own request-bound authority.
  const actor = async () => (await fixture.context()).actor;
  const author = await actor();
  const deps = { clock: () => new Date(), pool: fixture.pool, access: fixture.access, routeKey };
  const board = (
    await fixture.reader.query(
      "SELECT route,board_id FROM content.board WHERE realm_id IS NULL AND purpose='reviews' AND visibility='published'",
    )
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });
  const subject = newId(0x6b30);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
    VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subject), subject],
  );
  const opened = await createThread(
    deps,
    author,
    {
      kind: 'review',
      title: 'Opening title',
      body: fromPlainText('Opening body'),
      licence: 'MIT',
      subjectIds: [subject],
      boardId: board.board_id,
      visibility: 'published',
    },
    request(),
  );
  const home = opened.partition;
  const id = opened.value.threadId;
  const source = createRatedSubjectSource(fixture.pool, routeKey).source;
  const listing = subjectListingSource(fixture.pool);
  const nativeSource = createReviewDiscoverySource({ ...deps, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));
  const entry = createDiscoveryProducerEntry({ ...deps, subjects: source, reviewSource: nativeSource });
  const review = entry.metadataProducers.review!;
  const producers = { ...entry, metadataProducers: { review } };
  const { ownerAdapters } = await resolveDiscoveryOwnerAdapters(producers);
  const registry = await nativeDiscoveryRegistry(fixture.pool, routeKey, source, {
    accounts: entry.accounts,
    ownerAdapters,
  });
  const prefix = `receive-${crypto.randomUUID().slice(0, 8)}-`;
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  let lose = false;
  const search: OpenSearch = {
    ...native,
    async bulkRaw<T>(...args: Parameters<NonNullable<OpenSearch['bulkRaw']>>) {
      const result = await native.bulkRaw!<T>(...args);
      if (lose) {
        lose = false;
        throw new Error('Lost visible bulk response');
      }
      return result;
    },
  };
  await allocateDiscovery(fixture.pool, prefix, registry, ['review'], ['account', 'subject', 'review']);
  const target = (await discoveryGenerations(fixture.pool, prefix))[0]!;
  const index = discoveryIndexName(prefix, target.generation);
  await createDiscoveryIndex(search, prefix, target.generation, target.incarnation);
  target.uuid = await discoveryIndexUuid(search, index);
  await fixture.pool.query("UPDATE search.discovery_generation SET index_uuid=$2,state='populating' WHERE prefix=$1", [
    prefix,
    target.uuid,
  ]);
  const projection = createDiscoveryProjection({ pool: fixture.pool, search, registry, listing, target });
  const receiver = () =>
    createReviewDiscoveryReceiving({ pool: fixture.pool, search, projection, source: nativeSource, batchSize: 1 });
  const effect = createReviewDiscoveryEffect(fixture.pool);
  async function invalidate(outcome: CommandOutcome<unknown>, type: string) {
    const row = (
      await fixture.reader.query(
        'SELECT id,type,subject,data,recorded_at FROM core.outbox WHERE partition_no=$1 AND position=$2 AND type=$3',
        [outcome.partition, outcome.position.toString(), type],
      )
    ).rows[0]!;
    const event: CloudEvent = {
      specversion: '1.0',
      datacontenttype: 'application/json',
      id: row.id,
      type,
      subject: row.subject,
      data: row.data,
      time: row.recorded_at.toISOString(),
      source: `urn:rezics:log:${outcome.partition}.${outcome.epoch}`,
      sequence: outcome.position.toString().padStart(19, '0'),
    };
    await effect.run(event);
    if (outcome === opened) {
      expect(await review.readiness('population')).toBe('ready');
      expect(await nativeSource.pageWithCut!(0, null, 1)).toMatchObject({
        state: 'preparing',
        missing: 'lifecycle-invalidation',
      });
      await expect(review.page(0, null, null, 100)).rejects.toMatchObject({ unsupportedKinds: ['review'] });
    }
    let done = false;
    for (let n = 0; n < 20 && !done; n++)
      done = (await processReviewDiscoveryPage(fixture.pool, { route: outcome.partition * 16, id: row.id })).complete;
    expect(done).toBe(true);
    const wakeup = (
      await fixture.reader.query(
        'SELECT data FROM core.outbox WHERE partition_no=$1 AND type=$2 ORDER BY position DESC LIMIT 1',
        [home, REVIEW_DISCOVERY_CHANGED],
      )
    ).rows[0]!.data;
    await requestReviewDiscoveryReceiving(fixture.pool, prefix, wakeup);
    return wakeup;
  }
  const identity = discoveryDocumentId(registry, { owner: 'content', kind: 'review', route: routeOf(id)!, id });
  async function visible(physicalIndex = index) {
    const response = await native.request<{
      hits: { hits: { _source: { names: string[]; descriptions: string[] } }[] };
    }>('POST', `/${physicalIndex}/_search`, { query: { ids: { values: [identity] } } });
    return response.body.hits.hits.map((hit) => hit._source);
  }
  let runner: ReturnType<typeof startDiscoveryIndexing> | undefined;
  async function advance() {
    runner ??= startDiscoveryIndexing({
      pool: fixture.pool,
      search,
      source,
      listing,
      prefix,
      routeKey,
      producers,
      requiredKinds: ['space'],
      intervalMs: 1_000_000,
    });
    // Missing Space refuses activation while the installed supervisor still receives reviews.
    await expect(runner.refresh()).rejects.toBeInstanceOf(DiscoveryProducerCoverageError);
    return readReviewDiscoveryReceiving(fixture.pool, target, home);
  }
  const releases: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    const firstWake = await invalidate(opened, 'com.rezics.content.thread.created.v1');
    await advance();
    // Drain the initial scheduled maintenance before faulting subsequent explicit refreshes.
    await advance();
    expect(await visible()).toMatchObject([{ names: ['Opening title'], descriptions: ['Opening body'] }]);
    const first = await readReviewDiscoveryReceiving(fixture.pool, target, home);
    expect(first.status).toBe('ready');

    await fixture.grant(author.accountId, 'post:revise', {
      route: routeOf(opened.value.itemId)!,
      id: opened.value.itemId,
    });
    const edit = await revisePost(
      deps,
      await actor(),
      { threadId: id, itemId: opened.value.itemId, title: 'Edited title', body: fromPlainText('Edited body') },
      request(),
    );
    const editedWake = await invalidate(edit, 'com.rezics.content.revision.created.v1');
    lose = true;
    await expect(runner!.refresh()).rejects.toThrow('Lost visible bulk response');
    expect(await visible()).toMatchObject([{ names: ['Edited title'] }]);
    expect(await receiver().status(home)).toMatchObject({ acknowledged: first.acknowledged, status: 'unavailable' });
    await runner!.stop();
    runner = undefined;
    await advance(); // supervisor restart, current refresh, identical visible winner
    await advance(); // drain its initial scheduled maintenance
    expect((await receiver().status(home)).acknowledged).toBeGreaterThan(first.acknowledged);

    await fixture.grant(author.accountId, 'post:erase', {
      route: routeOf(opened.value.itemId)!,
      id: opened.value.itemId,
    });
    const deleted = await softDeletePost(
      deps,
      await actor(),
      { postId: opened.value.itemId, reason: 'Withdraw' },
      request(),
    );
    await invalidate(deleted, 'com.rezics.content.post.erased.v1');
    // Duplicate and older wakeups cannot rewind journal progress or restore old text.
    await requestReviewDiscoveryReceiving(fixture.pool, prefix, firstWake);
    await requestReviewDiscoveryReceiving(fixture.pool, prefix, editedWake);
    const removed = await advance();
    expect(await visible()).toEqual([]);
    expect((await nativeSource.hydrate(home, [id])).reviews).toEqual([]);
    const restored = await restorePost(deps, await actor(), opened.value.itemId, request());
    await invalidate(restored, 'com.rezics.content.post.restored.v1');

    // A refresh held across lease takeover must never overwrite the successor's current application.
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const held = createReviewDiscoveryReceiving({
      pool: fixture.pool,
      search,
      projection,
      source: {
        ...nativeSource,
        async read(...args) {
          const value = await nativeSource.read(...args);
          reached.resolve();
          await release.promise;
          return value;
        },
      },
    });
    const older = held.step(home);
    releases.push(() => release.resolve());
    pending.push(older);
    void older.catch(() => {});
    await reached.promise;
    // Concurrent live claim does no refresh or acknowledgement.
    expect((await advance()).acknowledged).toBe(removed.acknowledged);
    expect(
      (
        await fixture.pool.query(
          `UPDATE search.review_discovery_receiving SET claim_until=clock_timestamp()-interval '1 second'
           WHERE prefix=$1 AND generation=$2 AND partition_no=$3 AND claim IS NOT NULL`,
          [prefix, target.generation, home],
        )
      ).rowCount,
    ).toBe(1);
    const newer = await revisePost(
      deps,
      await actor(),
      { threadId: id, itemId: opened.value.itemId, title: 'Newest title', body: fromPlainText('Newest body') },
      request(),
    );
    await invalidate(newer, 'com.rezics.content.revision.created.v1');
    await advance(); // retained fixed cut, but current refresh is newer
    release.resolve();
    await expect(older).rejects.toThrow('Review receiving claim or native observation is no longer current');
    expect(await visible()).toMatchObject([{ names: ['Newest title'] }]);
    await advance(); // next cut includes the newer invalidation
    const complete = await receiver().status(home);
    const staged: string[] = [];
    const empty = await withQueryAccounting(
      {
        connection: (dispatch) => dispatch(),
        query(sql, _operands, dispatch) {
          if (sql.includes('SET through=$8,stage=') || sql.includes('SET stage=$8')) staged.push(sql);
          return dispatch();
        },
      },
      () => receiver().step(home),
    );
    expect(staged).toEqual([]);
    expect(empty).toMatchObject({
      acknowledged: complete.acknowledged,
      nativePosition: complete.nativePosition,
      through: null,
      status: 'ready',
    });

    // A native dependency failure never acknowledges, and is explicitly unavailable.
    const failing = createReviewDiscoveryReceiving({
      pool: fixture.pool,
      search,
      projection,
      source: {
        ...nativeSource,
        async read() {
          throw new Error('Native dependency unavailable');
        },
      },
    });
    await invalidate(newer, 'com.rezics.content.revision.created.v1');
    // Existing original delivery is deduplicated; create one fresh native revision to test failure.
    const final = await revisePost(
      deps,
      await actor(),
      { threadId: id, itemId: opened.value.itemId, body: fromPlainText('Final current body') },
      request(),
    );
    await invalidate(final, 'com.rezics.content.revision.created.v1');
    await expect(failing.step(home)).rejects.toThrow('Native dependency unavailable');
    expect(await failing.status(home)).toMatchObject({ acknowledged: complete.acknowledged, status: 'unavailable' });
    await advance();
    const page = await readReviewDiscoveryChanges(fixture.pool, home);
    expect((await receiver().status(home)).acknowledged).toBe(page.through);
    expect((await nativeSource.hydrate(home, [id])).reviews).toMatchObject([{ excerpt: 'Final current body' }]);

    // Current disclosure removes a concealed row even though the opening itself still exists.
    const conceal = await revisePost(
      deps,
      await actor(),
      { threadId: id, itemId: opened.value.itemId, body: fromPlainText('Concealed opening') },
      request(),
    );
    await fixture.reader.query(
      "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE subject_id=$1 AND route=$2",
      [subject, routeOf(subject)],
    );
    await invalidate(conceal, 'com.rezics.content.revision.created.v1');
    await advance();
    expect(await visible()).toEqual([]);
    expect((await nativeSource.hydrate(home, [id])).reviews).toEqual([]);
    await fixture.reader.query(
      "UPDATE semantic.subject SET visibility='visible',security_revision=security_revision+1 WHERE subject_id=$1 AND route=$2",
      [subject, routeOf(subject)],
    );
    // A source identity can also disappear before its retained original is dispatched.
    const vanished = await revisePost(
      deps,
      await actor(),
      { threadId: id, itemId: opened.value.itemId, body: fromPlainText('Disappeared opening') },
      request(),
    );
    const saved = await withConnection(fixture.reader, async (client) => {
      await client.query('BEGIN');
      try {
        // Inject a missing owner row while retaining the original post graph for restoration.
        await client.query('SET LOCAL session_replication_role = replica');
        const result = await client.query('DELETE FROM content.thread WHERE route=$1 AND thread_id=$2 RETURNING *', [
          routeOf(id),
          id,
        ]);
        expect(result.rowCount).toBe(1);
        await client.query('COMMIT');
        return result.rows[0]!;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    try {
      await invalidate(vanished, 'com.rezics.content.revision.created.v1');
      await advance();
      expect(await visible()).toEqual([]);
      expect((await nativeSource.hydrate(home, [id])).reviews).toEqual([]);
    } finally {
      await fixture.reader.query(
        'INSERT INTO content.thread SELECT (jsonb_populate_record(NULL::content.thread,$1::jsonb)).*',
        [JSON.stringify(saved)],
      );
    }
    const returned = await revisePost(
      deps,
      await actor(),
      { threadId: id, itemId: opened.value.itemId, body: fromPlainText('Returned opening') },
      request(),
    );
    const returnedWake = await invalidate(returned, 'com.rezics.content.revision.created.v1');
    const restoredFrontier = await advance();
    expect(await visible()).toMatchObject([{ descriptions: ['Returned opening'] }]);

    // A replacement allocation has independent zero coverage and the retired target refuses late work.
    await fixture.pool.query("UPDATE search.discovery_generation SET state='active' WHERE prefix=$1", [prefix]);
    await allocateDiscovery(fixture.pool, prefix, registry, ['review'], ['account', 'subject', 'review']);
    const replacement = (await discoveryGenerations(fixture.pool, prefix)).find(
      (row) => row.generation !== target.generation,
    )!;
    await createDiscoveryIndex(native, prefix, replacement.generation, replacement.incarnation);
    replacement.uuid = await discoveryIndexUuid(native, discoveryIndexName(prefix, replacement.generation));
    await fixture.pool.query(
      "UPDATE search.discovery_generation SET index_uuid=$3,state='populating' WHERE prefix=$1 AND generation=$2",
      [prefix, replacement.generation, replacement.uuid],
    );
    expect(await readReviewDiscoveryReceiving(fixture.pool, replacement, home)).toMatchObject({
      acknowledged: 0n,
      status: 'preparing',
    });
    await fixture.pool.query(
      "UPDATE search.discovery_generation SET state='retired' WHERE prefix=$1 AND generation=$2",
      [prefix, target.generation],
    );
    await expect(receiver().step(home)).rejects.toThrow('no longer writable');
    expect((await receiver().status(home)).acknowledged).toBe(restoredFrontier.acknowledged);
    await requestReviewDiscoveryReceiving(fixture.pool, prefix, returnedWake);
    await advance();
    const replacementFrontier = await readReviewDiscoveryReceiving(fixture.pool, replacement, home);
    expect(replacementFrontier).toMatchObject({
      status: 'ready',
      acknowledged: restoredFrontier.acknowledged,
      completedCut: restoredFrontier.completedCut,
    });
    expect(await visible(discoveryIndexName(prefix, replacement.generation))).toMatchObject([
      { names: ['Newest title'], descriptions: ['Returned opening'] },
    ]);
    expect((await nativeSource.hydrate(home, [id])).reviews).toMatchObject([
      { id, title: 'Newest title', excerpt: 'Returned opening' },
    ]);
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(pending);
    await runner?.stop();
    for (const row of (
      await fixture.pool.query('SELECT generation FROM search.discovery_generation WHERE prefix=$1', [prefix])
    ).rows)
      await native.request('DELETE', `/${discoveryIndexName(prefix, Number(row.generation))}`);
    for (const table of [
      'review_discovery_receiving',
      'review_discovery_receiving_scan',
      'discovery_copy',
      'discovery_population',
      'discovery_generation',
    ])
      await fixture.pool.query(`DELETE FROM search.${table} WHERE prefix=$1`, [prefix]);
    for (const table of ['consumer_checkpoint', 'consumer_lag'])
      await fixture.pool.query(`DELETE FROM core.${table} WHERE consumer=ANY($1::text[])`, [
        [1, 2].map((n) => discoveryConsumer(prefix, n)),
      ]);
  }
}, 120_000);
