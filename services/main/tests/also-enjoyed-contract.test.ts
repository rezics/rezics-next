import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import type { Pool } from 'pg';
import { AlsoEnjoyedStore, ALSO_ENJOYED_COST } from '../src/modules/also-enjoyed/store.ts';

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
  expect(ALSO_ENJOYED_COST.purgeRows).toBeLessThanOrEqual(1000);
  expect(ALSO_ENJOYED_COST.minBuildIntervalMs).toBeGreaterThanOrEqual(60_000);
});

function retainedPopulation() {
  const queries: string[] = [];
  const state = { ordinaryChange: true, privateAccessChange: false, privateContentChange: false };
  const query = async (sql: string, content = false) => {
    queries.push(sql);
    if (sql.includes('privacy_revision::text AS revision')) return { rows: [{ revision: '1',
      changed: content ? state.privateContentChange : state.privateAccessChange }] };
    if (sql.includes('also_enjoyed_source_fence')) return { rows: [{ revision: '1', changed: state.ordinaryChange }] };
    if (sql.includes('recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('derived_generation_head')) return { rows: [{ generation: 'retained-generation',
      graph_epoch: 'epoch', graph_sequence: '10', access_revision: '1', content_revision: '1' }] };
    if (sql.includes('count(*)::text AS readers')) return { rows: [{ readers: '4' }] };
    if (sql.includes('also_enjoyed_pair')) return { rows: [{ candidate_work: 'candidate', shared_readers: 4, score: '1' }] };
    if (sql.includes('FROM access.also_enjoyed_generation')) return { rows: [{ access_revision: '1', content_revision: '1' }] };
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected owner query: ${sql}`);
  };
  const client = { query, release: () => {} };
  const access = { connect: async () => client } as unknown as Pool;
  const content = { query: (sql: string) => query(sql, true) } as unknown as Pool;
  return { store: new AlsoEnjoyedStore(access, content), state, queries };
}

test('ordinary pending source changes retain co-readers without folding or building in a read', async () => {
  const fixture = retainedPopulation();
  expect(await fixture.store.candidates('source', 12)).toMatchObject({ generation: 'retained-generation',
    stale: true, sourceReaders: 4, candidates: [{ work: 'candidate', sharedReaders: 4, score: 1 }] });
  expect(await fixture.store.privacyCurrent('retained-generation')).toBe(true);
  expect(fixture.queries.some(sql => /fold_also_enjoyed|\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
});

test('pending privacy withdrawal withholds retained co-readers at either owner', async () => {
  for (const owner of ['privateAccessChange', 'privateContentChange'] as const) {
    const fixture = retainedPopulation();
    fixture.state[owner] = true;
    expect(await fixture.store.candidates('source', 12)).toMatchObject({ generation: null,
      stale: true, sourceReaders: 0, candidates: [] });
    expect(await fixture.store.privacyCurrent('retained-generation')).toBe(false);
  }
});

test('privacy withdrawal after selection invalidates the generation before disclosure', async () => {
  const fixture = retainedPopulation();
  const selection = await fixture.store.candidates('source', 12);
  expect(selection.generation).toBe('retained-generation');
  fixture.state.privateContentChange = true;
  expect(await fixture.store.privacyCurrent(selection.generation!)).toBe(false);
});

test('a candidate page above the owner bound is refused before touching storage', async () => {
  const fixture = retainedPopulation();
  await expect(fixture.store.candidates('source', ALSO_ENJOYED_COST.pageRows + 1)).rejects.toThrow('out of bounds');
  expect(fixture.queries).toHaveLength(0);
});
