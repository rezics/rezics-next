import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import {
  bindNativeIdentityCapabilities,
  nativeIdentityCapabilities,
} from '../../src/semantic/identity-adapter-bind.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { drainExpiredServingPits } from '../../src/search/public-filter-custody.ts';
import { subjectConsumer } from '../../src/search/consumer-name.ts';
import { readFreshness } from '../../src/search/freshness.ts';
import { publishBookOriginals } from './support/book-composition.ts';

test('cold Subject publication discloses the originals and preserves relevance ties across a subsequent Book search cursor', async () => {
  const started = Date.now();
  const { fixture, published, originals, createSubject, waitForPublication, pauseWhenCaughtUp, database } =
    await publishBookOriginals(started + 600_000, 180_000, { searchWorker: 'owned-child' });
  try {
    const deadline = Math.min(started + 600_000, Date.now() + 120_000);
    const consumer = subjectConsumer(fixture.search!.indexPrefix, published.generation);
    const marker = `rankedbook${crypto.randomUUID().replaceAll('-', '').replace(/[0-9]/g, 'a')}`;
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await createSubject('schema:Book', marker)).id);
    expect(await waitForPublication(ids, deadline)).toEqual(published);
    await pauseWhenCaughtUp(deadline);
    expect((await readFreshness(database.pool, consumer, { deadline })).behind).toBe(0);
    const projectionBuilds = async () =>
      (
        await database.pool.query(
          `SELECT subject_id,build_id,generation FROM semantic.public_filter_projection_build
         WHERE subject_id=ANY($1::uuid[]) ORDER BY subject_id`,
          [ids],
        )
      ).rows;
    const before = await projectionBuilds();
    const query = { text: marker, filter: { type: { in: ['schema:Book'] } }, limit: 1, languages: ['en'] };
    // A crash after either commit must leave the matching recovery work with its native receipt.
    await database.pool.query(`CREATE FUNCTION search.check_test_pit_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state='opening' AND (OLD.consumer_work IS NOT NULL OR NEW.consumer_work IS NULL) THEN
          RAISE EXCEPTION 'The PIT grant did not install its original recovery work';
        END IF;
        IF NEW.state='retained' AND NEW.consumer_work IS NOT DISTINCT FROM OLD.consumer_work THEN
          RAISE EXCEPTION 'The PIT receipt committed without its recovery work';
        END IF;
        IF NEW.state='handed' AND NOT EXISTS (
          SELECT FROM semantic.public_filter_bootstrap b
          WHERE (b.partition_no,b.bootstrap)=(NEW.partition_no,NEW.bootstrap)
            AND b.state='adopted' AND b.xmin=pg_current_xact_id()::xid
        ) THEN RAISE EXCEPTION 'The handed PIT did not adopt its Source cut in the same transaction';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER check_test_pit_handoff AFTER UPDATE OF state ON search.public_filter_pit_claim
      FOR EACH ROW WHEN (OLD.state<>NEW.state AND NEW.state IN ('opening','retained','handed'))
      EXECUTE FUNCTION search.check_test_pit_handoff()`);
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => fixture.request('anonymous', 'POST', '/v1/subjects:search', query)),
    ).finally(() =>
      database.pool.query(
        'DROP TRIGGER check_test_pit_handoff ON search.public_filter_pit_claim; DROP FUNCTION search.check_test_pit_handoff()',
      ),
    );
    for (const response of concurrent) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.subjects).toEqual([expect.objectContaining({ id: ids.sort()[0] })]);
      expect(typeof response.body.next).toBe('string');
    }
    expect(new Set(concurrent.map((response) => response.body.next)).size).toBe(concurrent.length);
    const originalsHeld = await database.pool.query(
      `SELECT b.bootstrap,b.queried,o.registration,o.observation,o.consumer_bootstrap,o.state,p.state AS pit_state
       FROM semantic.public_filter_bootstrap b JOIN search.public_filter_observation o ON
         (o.partition_no,o.observation)=(b.partition_no,b.queried)
       JOIN search.public_filter_pit p ON (p.partition_no,p.observation)=(o.partition_no,o.observation)
       WHERE b.request_key LIKE 'pit:%' AND b.state='adopted' AND o.state='open' AND p.state='owned'`,
    );
    expect(originalsHeld.rows.length).toBe(4);
    for (const row of originalsHeld.rows) {
      expect(row.queried).toBe('0:' + row.bootstrap);
      expect(row.consumer_bootstrap).toBe(row.queried);
    }
    // Fail one new first page after native adoption. Previously returned cursors keep their own PITs.
    await database.pool.query(`
      CREATE FUNCTION search.fail_test_page() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER fail_test_page BEFORE INSERT ON search.public_filter_coverage_page
      FOR EACH ROW EXECUTE FUNCTION search.fail_test_page()`);
    try {
      const failed = await fixture.request('anonymous', 'POST', '/v1/subjects:search', query);
      expect(failed.status).toBe(503);
    } finally {
      await database.pool.query(
        'DROP TRIGGER fail_test_page ON search.public_filter_coverage_page; DROP FUNCTION search.fail_test_page()',
      );
    }
    const released = async () =>
      (
        await database.pool.query<{ state: string; pit_state: string; locator: string }>(
          `SELECT o.state, p.state AS pit_state, p.locator FROM search.public_filter_observation o
         JOIN search.public_filter_pit p USING (partition_no,observation)
         WHERE o.partition_no=0 AND o.registration=$1 AND NOT (o.observation=ANY($2::text[]))`,
          [originalsHeld.rows[0]!.registration, originalsHeld.rows.map((row) => row.observation)],
        )
      ).rows;
    let abandoned = await released();
    const retirementDeadline = Date.now() + 10_000;
    while (
      Date.now() < retirementDeadline &&
      !abandoned.some((row) => row.state === 'closed' && row.pit_state === 'released')
    ) {
      await Bun.sleep(50);
      abandoned = await released();
    }
    expect(abandoned.map(({ state, pit_state }) => [state, pit_state])).toEqual([['closed', 'released']]);
    const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
    const inventory = await engine.request<{ pits: { pit_id: string }[] }>('GET', '/_search/point_in_time/_all');
    expect(inventory.body.pits.some((pit) => pit.pit_id === abandoned[0]!.locator)).toBe(false);
    // Lose the retaining transaction after the physical POST succeeds. The only
    // opening attempt must use its exact delete receipt to settle its original cut.
    const cutIds = async () =>
      (
        await database.pool.query(
          `SELECT b.bootstrap,b.state,b.queried,c.state AS claim FROM semantic.public_filter_bootstrap b
       LEFT JOIN search.public_filter_pit_claim c USING(partition_no,bootstrap)
       WHERE b.read_definition=(SELECT read_definition FROM semantic.public_filter_bootstrap WHERE partition_no=0 AND bootstrap=$1)
         AND b.request_key LIKE 'pit:%'`,
          [originalsHeld.rows[0]!.bootstrap],
        )
      ).rows;
    const existing = new Set((await cutIds()).map((row) => row.bootstrap));
    const physicalTarget = fixture.search!.indexPrefix + 'subjects-g' + published.generation;
    const nativePits = async () => {
      const stats = await engine.request<{
        indices: Record<string, { total: { search: { point_in_time_current: number } } }>;
      }>('GET', '/' + physicalTarget + '/_stats/search?filter_path=indices.*.total.search.point_in_time_current');
      return stats.body.indices[physicalTarget]!.total.search.point_in_time_current;
    };
    const held = await nativePits();
    expect(held).toBeGreaterThanOrEqual(concurrent.length);
    await database.pool.query(`CREATE FUNCTION search.refuse_test_retain() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER refuse_test_retain BEFORE UPDATE ON search.public_filter_pit_claim
      FOR EACH ROW WHEN (OLD.state='opening' AND NEW.state='retained') EXECUTE FUNCTION search.refuse_test_retain()`);
    try {
      const failed = await fixture.request('anonymous', 'POST', '/v1/subjects:search', query);
      expect(failed.status, JSON.stringify(failed.body)).toBe(503);
    } finally {
      await database.pool.query(
        'DROP TRIGGER refuse_test_retain ON search.public_filter_pit_claim; DROP FUNCTION search.refuse_test_retain()',
      );
    }
    expect((await cutIds()).filter((row) => !existing.has(row.bootstrap))).toEqual([
      expect.objectContaining({ state: 'aborted', queried: null, claim: null }),
    ]);
    expect(await nativePits()).toBe(held);
    // A refused original admission leaves a provably undispatched child. Expire it
    // with the already-closed child and keep all live, independently signed pages.
    const priorCuts = new Set((await cutIds()).map((row) => row.bootstrap));
    await database.pool.query(`CREATE FUNCTION search.refuse_test_open() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER refuse_test_open BEFORE UPDATE ON search.public_filter_pit_claim
      FOR EACH ROW WHEN (OLD.state='new' AND NEW.state='opening') EXECUTE FUNCTION search.refuse_test_open()`);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const failed = await fixture.request('anonymous', 'POST', '/v1/subjects:search', query);
        expect(failed.status).toBe(503);
      }
    } finally {
      await database.pool.query(
        'DROP TRIGGER refuse_test_open ON search.public_filter_pit_claim; DROP FUNCTION search.refuse_test_open()',
      );
    }
    const children = (await cutIds()).filter((row) => !priorCuts.has(row.bootstrap));
    expect(children).toHaveLength(2);
    for (const child of children)
      expect(child).toEqual(expect.objectContaining({ state: 'begun', queried: null, claim: 'new' }));
    const [undispatched, dispatched] = children;
    // At the dispatch boundary the native claim is durable before OpenSearch can reply.
    // With no retained locator this child cannot prove that its PIT is closed.
    await database.pool.query(
      `UPDATE search.public_filter_pit_claim SET state='opening',deadline=$2,retry_after=$2
       WHERE partition_no=0 AND bootstrap=$1 AND state='new'`,
      [dispatched!.bootstrap, Date.now() - 1],
    );
    expect(await nativePits()).toBe(held);
    const expired = await database.pool.query(
      `UPDATE search.public_filter_pit_claim c SET deadline=$2,retry_after=$2
      WHERE registration=$1 AND (c.bootstrap=$3 OR EXISTS (SELECT FROM search.public_filter_observation o
        WHERE (o.partition_no,o.registration,o.observation)=(c.partition_no,c.registration,c.partition_no::text||':'||c.bootstrap::text)
          AND o.state='closed')) RETURNING bootstrap`,
      [originalsHeld.rows[0]!.registration, Date.now() - 1, undispatched!.bootstrap],
    );
    expect(expired.rows.length).toBeGreaterThanOrEqual(1);
    expect(
      await drainExpiredServingPits(database.pool, engine, fixture.search!.indexPrefix, {
        deadline: Date.now() + 5000,
      }),
    ).toBe(false);
    const retired = new Set(expired.rows.map((row) => row.bootstrap));
    for (const row of (await cutIds()).filter((row) => retired.has(row.bootstrap))) {
      expect(row).toEqual(expect.objectContaining({ state: 'aborted', claim: null }));
    }
    expect((await cutIds()).find((row) => row.bootstrap === dispatched!.bootstrap)).toEqual(
      expect.objectContaining({ state: 'aborting', claim: 'uncertain', queried: null }),
    );
    expect(await nativePits()).toBe(held);
    const continuations = await Promise.all(
      concurrent.map((response) =>
        fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...query, cursor: response.body.next }),
      ),
    );
    for (const response of continuations) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.subjects).toEqual([expect.objectContaining({ id: ids[1] })]);
    }
    let cursor: string | undefined;
    for (const [page, id] of ids.sort().entries()) {
      const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.subjects).toEqual([
        expect.objectContaining({ id, labels: { en: marker + ' — controlled discovery test case' } }),
      ]);
      if (page === ids.length - 1) expect(response.body.next).toBeNull();
      else {
        const next = response.body.next;
        expect(typeof next).toBe('string');
        if (typeof next !== 'string' || !next) throw new Error('A nonfinal ranked page requires a cursor');
        expect(next).not.toBe(cursor);
        cursor = next;
      }
    }
    const prior = (await database.pool.query('SELECT id::text FROM search.public_filter_coverage_page')).rows;
    await database.pool.query(`CREATE FUNCTION search.refuse_test_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER refuse_test_reservation BEFORE UPDATE OF consumer_work ON search.public_filter_observation
      FOR EACH ROW WHEN (OLD.consumer_work IS NOT NULL AND NEW.consumer_work IS DISTINCT FROM OLD.consumer_work)
      EXECUTE FUNCTION search.refuse_test_reservation()`);
    try {
      const refused = await fixture.request('alice', 'POST', '/v1/subjects:search', query);
      expect(refused.status).toBe(503);
      const held = await database.pool.query(
        `SELECT p.state,p.rounds,p.charged,e.page_engine_started FROM search.public_filter_coverage_page p
         JOIN search.public_filter_execution e ON (e.partition_no,e.page_id,e.id)=(p.partition_no,p.id,p.pending)
         WHERE NOT (p.id=ANY($1::uuid[]))`,
        [prior.map((row) => row.id)],
      );
      expect(held.rows).toEqual([
        { state: 'failed', rounds: 1, charged: expect.any(Number), page_engine_started: false },
      ]);
      expect(held.rows[0]!.charged).toBeGreaterThan(0);
    } finally {
      await database.pool.query(
        'DROP TRIGGER refuse_test_reservation ON search.public_filter_observation; DROP FUNCTION search.refuse_test_reservation()',
      );
    }
    expect(await projectionBuilds()).toEqual(before);
    // Put an independent native commit between the two and then run the complete public request.
    const native = nativeIdentityCapabilities();
    async function searchAcross(change: () => Promise<unknown>) {
      let observations = 0;
      bindNativeIdentityCapabilities({
        ...native,
        read: {
          ...native.read,
          async withReadStatement<T>(pool: Pool, read: (client: PoolClient) => Promise<T>, deadline: number) {
            const value = await native.read.withReadStatement!(pool, read, deadline);
            if (read.name === 'readFreshSearchShards' && ++observations === 1) await change();
            return value;
          },
        },
      });
      try {
        const result = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...query, limit: 3 });
        expect(observations).toBe(2);
        return result;
      } finally {
        bindNativeIdentityCapabilities(native);
      }
    }
    const acrossBirth = await searchAcross(() => createSubject('schema:Book', 'Independent original'));
    expect(acrossBirth.status, JSON.stringify(acrossBirth.body)).toBe(200);
    expect(acrossBirth.body.subjects).toEqual([...ids].sort().map((id) => expect.objectContaining({ id })));
    expect(acrossBirth.body.next).toBeNull();
    const acrossFence = await searchAcross(async () => {
      await database.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=17");
      await database.pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=17");
    });
    expect(acrossFence.status).toBe(503);
    expect(acrossFence.body.code).toBe('index_not_ready');
    console.info('Cold Subject publication', {
      generation: published.generation,
      originals: originals.length,
      elapsedMs: Date.now() - started,
    });
  } finally {
    await fixture.close(Date.now() + 180_000);
  }
}, 780_000);
