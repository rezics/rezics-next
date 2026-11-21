import { expect, test } from 'bun:test';
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
