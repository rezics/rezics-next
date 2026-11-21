import { expect, test } from 'bun:test';
import { createOpenSearch } from '../../src/search/opensearch.ts';
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
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => fixture.request('anonymous', 'POST', '/v1/subjects:search', query)),
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
    expect(await projectionBuilds()).toEqual(before);
    console.info('Cold Subject publication', {
      generation: published.generation,
      originals: originals.length,
      elapsedMs: Date.now() - started,
    });
  } finally {
    await fixture.close(Date.now() + 180_000);
  }
}, 780_000);
