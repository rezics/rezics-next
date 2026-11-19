import { expect, test } from 'bun:test';
import { subjectConsumer } from '../../src/search/consumer-name.ts';
import { readFreshness } from '../../src/search/freshness.ts';
import { publishBookOriginals } from './support/book-composition.ts';

test('cold Subject publication discloses the three originals and the worker settles a subsequent Book', async () => {
  const started = Date.now();
  const { fixture, published, originals, createSubject, waitForPublication, pauseWhenCaughtUp, database } =
    await publishBookOriginals(started + 600_000, 180_000, { searchWorker: 'owned-child' });
  try {
    const deadline = Math.min(started + 600_000, Date.now() + 120_000);
    const consumer = subjectConsumer(fixture.search!.indexPrefix, published.generation);
    const extra = await createSubject('schema:Book', 'Additional catalogue title');
    expect(await waitForPublication([extra.id], deadline)).toEqual(published);
    await pauseWhenCaughtUp(deadline);
    expect((await readFreshness(database.pool, consumer, { deadline })).behind).toBe(0);
    console.info('Cold Subject publication', {
      generation: published.generation,
      originals: originals.length,
      elapsedMs: Date.now() - started,
    });
  } finally {
    await fixture.close(Date.now() + 180_000);
  }
}, 780_000);
