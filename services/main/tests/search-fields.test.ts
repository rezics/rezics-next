import { expect, test } from 'bun:test';
import { matchesSearchText, rankedSearchMatches, querySearchFields, fenceSearchFields,
  type SearchFieldOwners } from '../src/modules/search/fields.ts';
import { workRead, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { SearchRequestTimedOut, withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('title priority is independent of body term frequency and each Work has one strongest match', () => {
  const base = { work: 'work', mainVersion: 'main', matchUnit: 'unit', score: 1 };
  expect(rankedSearchMatches([{ ...base, matchedField: 'body', score: 100_000 },
    { ...base, matchedField: 'title' }, { ...base, mainVersion: 'other', matchedField: 'credit' }])
    .map(row => [row.mainVersion, row.matchedField])).toEqual([['main', 'title'], ['other', 'credit']]);
});

test('prefix completion handles literal punctuation, case, word starts and unspaced CJK titles', () => {
  for (const [name, prefix] of [['Pride and Prejudice', 'pr'], ['Jane Austen', 'aus'],
    ['西游记', '西'], ['張愛玲', '張愛'], ['東京図書館', '東京'], ['Bun', 'BUN'], ['A+B', 'a+']]) {
    expect(matchesSearchText(name!, prefix!, true)).toBe(true);
  }
  expect(matchesSearchText('Pride', 'ride', true)).toBe(false);
  expect(matchesSearchText('Pride', '*', true)).toBe(false);
  expect(matchesSearchText('Pride', 'pr OR *', false)).toBe(false);
  expect(matchesSearchText('寻找齐天大圣的故事', '大圣', false)).toBe(true);
});

test('an empty credited-name match detects a newly matching source name at the final fence', async () => {
  let generation = '1';
  const owners = { names: { search: async () => ({ names: new Map(), generation }),
    searchGeneration: async () => generation } } as unknown as SearchFieldOwners;
  const env = { fuseki: { query: async (sparql: string) => ({ results: { bindings:
    sparql.includes('SELECT ?epoch ?sequence WHERE') ? [{ epoch: { value: 'e' }, sequence: { value: '1' } }] : [] } }) } } as unknown as WorkActivationEnvironment;
  expect(await querySearchFields(env, { phrase: 'new name', language: null },
    { dataEpoch: 'e', sequence: '1' }, owners)).toEqual([]);
  generation = '2';
  await expect(fenceSearchFields(owners)).rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('nested card reads debit the search budget and cannot outlive its wall deadline', async () => {
  let inside: WorkReadSession | undefined;
  const deps = { environment: { lineage: { dataEpoch: 'e', routingEpoch: 'r' },
    fuseki: { query: async () => {
      const budget = fusekiReadBudget.getStore()!;
      budget.callsLeft--;
      return { results: { bindings: [{ epoch: { value: 'e' }, sequence: { value: '1' } }] } };
    } } } } as unknown as MainWorkDependencies;
  const outer = { signal: AbortSignal.timeout(1000), callsLeft: 10, bytesLeft: 100_000 };
  await fusekiReadBudget.run(outer, () => workRead(deps, new Request('http://test'), {}, async session => {
    inside = session;
    await session.query('SELECT', 1);
  }));
  expect(inside).toBeDefined();
  expect(outer.callsLeft).toBe(7);
  await expect(withStableSearchSnapshot(undefined, () => workRead(deps, new Request('http://test'), {}, async () => {
    await Bun.sleep(50);
  }), 10)).rejects.toBeInstanceOf(SearchRequestTimedOut);
});
