import { expect, test } from 'bun:test';
import type { SearchPlacement } from '../src/modules/structure/searchable-placements.ts';
import { matchesSearchText, rankedSearchMatches, querySearchFields, fenceSearchFields,
  type SearchFieldOwners } from '../src/modules/search/fields.ts';
import { workRead, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { FusekiClient, fusekiReadBudget, type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { SearchRequestTimedOut, withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readAuthorNames } from '../src/modules/source/author-name-read.ts';

test('title priority is independent of body term frequency and each Work has one strongest match', () => {
  const base = { work: 'work', mainVersion: 'main', matchUnit: 'unit', score: 1 };
  expect(rankedSearchMatches([{ ...base, matchedField: 'body', score: 100_000 },
    { ...base, matchedField: 'title' }, { ...base, mainVersion: 'other', matchedField: 'credit' }])
    .map(row => [row.mainVersion, row.matchedField])).toEqual([['main', 'title'], ['other', 'credit']]);
});

test('ranking retains occurrence order and exact revisions across matching Content sources', () => {
  const first: SearchPlacement = { resource: 'opening-source', work: 'anthology', occurrence: 'opening',
    profile: 'section-list-v1', title: 'Opening notes', revision: 'opening-revision' };
  const last: SearchPlacement = { resource: 'closing-source', work: 'anthology', occurrence: 'closing',
    profile: 'section-list-v1', title: 'Closing notes', revision: 'closing-revision' };
  const base = { work: 'anthology', mainVersion: 'main' };
  const results = rankedSearchMatches([
    { ...base, matchUnit: 'opening-unit', score: 1, revision: first.revision, matchedPlacements: [first] },
    { ...base, matchUnit: 'closing-unit', score: 10, revision: last.revision, matchedPlacements: [last] },
  ]);
  expect(results).toHaveLength(1);
  expect(results[0]?.matchUnit).toBe('closing-unit');
  expect(results[0]?.matchedPlacements).toEqual([first, {
    resource: last.resource, work: last.work, occurrence: last.occurrence,
    profile: last.profile, title: last.title,
  }]);
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

test('equal-score typeahead fields order by title before credit, then Main and unit identity', () => {
  const rows = [
    { work: 'second', mainVersion: 'main-b', matchUnit: 'unit-b', score: 1, matchedField: 'title' as const },
    { work: 'first', mainVersion: 'main-a', matchUnit: 'unit-b', score: 1, matchedField: 'title' as const },
    { work: 'first', mainVersion: 'main-a', matchUnit: 'unit-a', score: 1, matchedField: 'title' as const },
    { work: 'credit', mainVersion: 'main-0', matchUnit: 'unit-0', score: 1, matchedField: 'credit' as const },
  ];
  expect(rankedSearchMatches(rows).map(row => [row.mainVersion, row.matchUnit, row.matchedField]))
    .toEqual([['main-a', 'unit-a', 'title'], ['main-b', 'unit-b', 'title'], ['main-0', 'unit-0', 'credit']]);
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
  const deps = { access: { assertRecoveryOpen: async () => undefined },
    environment: { lineage: { dataEpoch: 'e', routingEpoch: 'r' },
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
  // The fence re-reads the selected inputs once.
  expect(outer.callsLeft).toBe(6);
  await expect(withStableSearchSnapshot(undefined, () => workRead(deps, new Request('http://test'), {}, async () => {
    await Bun.sleep(50);
  }), 10)).rejects.toBeInstanceOf(SearchRequestTimedOut);
});

test('first-page and retained-continuation retries share the outer budget and repeat authority and source-name fences', async () => {
  const payload = JSON.stringify({ results: { bindings: [{ epoch: { type: 'literal', value: 'e' },
    sequence: { type: 'literal', value: '1' } }] } });
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    calls++;
    return new Response(payload, { headers: { 'content-type': 'application/json' } });
  } });
  try {
    for (const retained of [false, true]) {
      calls = 0;
      let nameReads = 0, verifies = 0, authorities = 0;
      const key = '/authors/OL1A';
      const deps = { environment: { lineage: { dataEpoch: 'e', routingEpoch: 'r' },
        fuseki: new FusekiClient(`http://127.0.0.1:${server.port}/rezics`) },
        account: { verify: async () => { verifies++; return { issuer: 'issuer', subject: 'reader' }; } },
        access: { assertRecoveryOpen: async () => undefined,
          activePrincipalId: async () => { authorities++; return 'principal'; } },
        sourceAuthorNames: { batch: async () => {
          nameReads++;
          return new Map([[key, { displayName: nameReads === 1 ? 'Before' : 'After',
            nameSource: { revision: nameReads === 1 ? '1' : '2' } }]]);
        } },
      } as unknown as MainWorkDependencies;
      const outer = { signal: AbortSignal.timeout(2_000), callsLeft: 10, bytesLeft: 100_000 };
      const budgets: FusekiReadBudget[] = [];
      const sessions: WorkReadSession[] = [];
      const name = await fusekiReadBudget.run(outer, () => workRead(deps,
        new Request(`http://main.test/v1/works${retained ? '?cursor=retained' : ''}`,
          { headers: { authorization: 'Bearer reader' } }),
        { actingSubject: 'actor', ...(retained ? { cursor: 'retained', retainedBasis: true } : {}) }, async session => {
          sessions.push(session);
          budgets.push(fusekiReadBudget.getStore()!);
          await session.query('SELECT ?x WHERE {}', 1);
          return (await readAuthorNames(session, [key])).get(key)?.displayName;
        }));
      expect(name).toBe('After');
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).not.toBe(sessions[1]);
      expect(budgets[0]).toBe(budgets[1]);
      expect(budgets[0]!.signal).toBe(budgets[1]!.signal);
      expect(verifies).toBe(2);
      expect(authorities).toBe(4);
      expect(nameReads).toBe(4);
      // The fence re-reads the selected inputs once.
      expect(calls).toBe(8);
      expect(outer.callsLeft).toBe(2);
      expect(outer.bytesLeft).toBe(100_000 - 8 * Buffer.byteLength(payload));
    }
  } finally { await server.stop(true); }
});

test('SearchSnapshotMoved retries cannot replenish an enclosing search call or byte budget', async () => {
  const payload = JSON.stringify({ results: { bindings: [{ epoch: { type: 'literal', value: 'e' },
    sequence: { type: 'literal', value: '1' } }] } });
  const bytes = Buffer.byteLength(payload);
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
    calls++;
    return new Response(payload, { headers: { 'content-type': 'application/json' } });
  } });
  const deps = { access: { assertRecoveryOpen: async () => undefined },
    environment: { lineage: { dataEpoch: 'e', routingEpoch: 'r' },
    fuseki: new FusekiClient(`http://127.0.0.1:${server.port}/rezics`) } } as unknown as MainWorkDependencies;
  try {
    for (const limit of ['calls', 'bytes']) {
      calls = 0;
      let attempts = 0;
      const outer = { signal: AbortSignal.timeout(2_000),
        callsLeft: limit === 'calls' ? 3 : 10, bytesLeft: limit === 'bytes' ? 2 * bytes : 100_000 };
      // Retry admission answers unavailable.
      await expect(fusekiReadBudget.run(outer, () => workRead(deps, new Request('http://main.test/v1/queries/page'), {},
        async session => {
          attempts++;
          await session.query('SELECT ?x WHERE {}', 1);
          throw new SearchSnapshotMoved('Injected movement after a paid read');
        }))).rejects.toBeInstanceOf(WorkReadUnavailable);
      expect(calls).toBe(2);
      expect(attempts).toBe(1);
      expect(outer.callsLeft).toBe(limit === 'calls' ? 1 : 8);
      expect(outer.bytesLeft).toBe(limit === 'bytes' ? 0 : 100_000 - 2 * bytes);
    }
  } finally { await server.stop(true); }
});
