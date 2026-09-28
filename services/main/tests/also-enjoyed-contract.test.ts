import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { ALSO_ENJOYED_COST } from '../src/modules/also-enjoyed/store.ts';

test('Also enjoyed read has a bounded Eden card and cursor contract', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const consume = async () => {
    const page = await client.v1.works({ id: '00000000-0000-4000-8000-000000000001' })['also-enjoyed']
      .get({ query: { language: 'en', limit: 6 } });
    const basis: 'co-readers' | 'similar' | 'realm' | undefined = page.data?.items[0]?.basis;
    const author: string | null | undefined = page.data?.items[0]?.primaryCredits[0]?.displayName;
    const ratingCount: number | undefined = page.data?.items[0]?.rating?.count;
    const cursor: string | null | undefined = page.data?.nextCursor;
    const stale: boolean | undefined = page.data?.stale;
    const projectionSequence: string | undefined = page.data?.projectionPosition?.sequence;
    return { basis, author, ratingCount, cursor, stale, projectionSequence };
  };
  expect(consume).toBeFunction();
  expect(ALSO_ENJOYED_COST.ratingRows).toBeLessThanOrEqual(32);
  expect(ALSO_ENJOYED_COST.shelfRows).toBeLessThanOrEqual(64);
  expect(ALSO_ENJOYED_COST.pairsPerWork).toBeLessThanOrEqual(64);
  expect(ALSO_ENJOYED_COST.pageRows).toBeLessThanOrEqual(64);
});
