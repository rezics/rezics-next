import { expect, test } from 'bun:test';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { withResourceListBudget } from '../src/modules/query/budget.ts';
import { RESOURCE_LIST_COST } from '../src/modules/query/resource-contract.ts';
import { conceptResourceMatches } from '../src/modules/query/resources.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { DiscoveryReadGeneration } from '../src/modules/discovery/store.ts';
import { resourceNamePages, resourceHydrationPrefix } from '../src/modules/query/resources.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';

test('G1032: nested resource Query charges one allocation including readiness and final fences', async () => {
  const outer = { signal: new AbortController().signal, callsLeft: 40, bytesLeft: 1024 };
  await fusekiReadBudget.run(outer, () =>
    withResourceListBudget(async () => {
      const budget = fusekiReadBudget.getStore()!;
      expect(budget.callsLeft).toBe(RESOURCE_LIST_COST.graphCalls);
      budget.callsLeft -= 7;
      budget.bytesLeft -= 100;
      expect(outer.callsLeft).toBe(33);
      expect(outer.bytesLeft).toBe(924);
      await withResourceListBudget(async () => {
        const nested = fusekiReadBudget.getStore()!;
        expect(nested.callsLeft).toBe(25);
        nested.callsLeft -= 25;
        expect(budget.callsLeft).toBe(0);
        expect(outer.callsLeft).toBe(8);
      });
    }),
  );
});

test('G1032: Work-only Concept matching never queries the unrelated resource topic graph', async () => {
  const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const concept = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const term = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
  const session = {
    deps: { discovery: { termMembership: async () => [{ work, term }] } },
    query: async () => {
      throw new Error('Work topics are owned by indexed interpretation membership');
    },
  } as unknown as WorkReadSession;
  const candidates = [{ id: work, summary: work, kind: 'work' as const, order: '' }];
  const meaning = new Map([[concept, { realm: null, interpretations: [term] }]]);
  expect(
    await conceptResourceMatches(
      session,
      candidates,
      [{ facet: 'concept', operator: 'all', values: [concept] }],
      undefined,
      {} as DiscoveryReadGeneration,
      meaning,
    ),
  ).toEqual(new Set([work]));
  expect(
    await conceptResourceMatches(
      session,
      candidates,
      [{ facet: 'concept', operator: 'none', values: [concept] }],
      undefined,
      {} as DiscoveryReadGeneration,
      meaning,
    ),
  ).toEqual(new Set());
});

test('Realm scope and source owners share canonical32 and still debit an enclosing budget', async () => {
  const outer = { signal: new AbortController().signal, callsLeft: 80, bytesLeft: 1024 };
  await withResourceListBudget(async () => {
    expect(fusekiReadBudget.getStore()!.callsLeft).toBe(
      RESOURCE_LIST_COST.graphCalls);
  }, 'all', ['realm']);
  await fusekiReadBudget.run(outer, () => withResourceListBudget(async () => {
    const budget = fusekiReadBudget.getStore()!;
    expect(budget.callsLeft).toBe(32);
    budget.callsLeft -= 7;
    expect(outer.callsLeft).toBe(73);
    await withResourceListBudget(async () => {
      const nested = fusekiReadBudget.getStore()!;
      expect(nested.callsLeft).toBe(25);
      nested.callsLeft -= 25;
      expect(outer.callsLeft).toBe(48);
    }, 'realm', ['realm']);
  }, 'realm', ['work', 'realm']));
});

test('all seven independent native sources retain their owner parsers and fences in one graph round trip', async () => {
  const graph = {}, lineage = { dataEpoch: 'epoch', routingEpoch: 'route' };
  const kinds = ['space', 'site', 'agent', 'collection', 'concept', 'resource', 'post'] as const;
  const bodies: string[] = [];
  let fence: ((rows: readonly import('../src/modules/work/read-session.ts').ReadRow[]) => unknown) | undefined;
  const rows = kinds.map((kind, index) => ({ resourceDirectorySource: { type: 'literal' as const, value: String(index) },
    page: { type: 'literal' as const, value: JSON.stringify({ hits: [{
      id: `urn:rezics:search:directory:${kind}:newest:${'0'.repeat(39)}1:00000000-0000-4000-8000-000000000001`,
      key: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', score: '0',
    }], more: true, commit: '1' }) } }));
  const session = { deps: { environment: { fuseki: graph, lineage } }, query: async (body: string, limit: number,
    normalize: typeof fence) => { bodies.push(body); expect(limit).toBe(7); fence = normalize; return rows; },
  } as unknown as WorkReadSession;
  await searchGraphSnapshot.run({ clients: new Set([graph as never]), lineage,
    position: { dataEpoch: 'epoch', sequence: '1', generation: 'g', population: 0,
      serverInstanceId: 'instance', publicSearchWriteEpoch: '0' } }, async () => {
    const pages = await resourceNamePages(session, kinds.map(kind => ({ kind, order: 'newest', limit: 64 })));
    expect(bodies).toHaveLength(1);
    expect(pages.size).toBe(7);
    expect([...pages.values()].every(page => page.more && page.rows.length === 1)).toBe(true);
    expect(bodies[0]!.match(/rv:rankedText/g)).toHaveLength(7);
    const baseline = fence!(rows);
    const committed = structuredClone(rows);
    committed[0]!.page.value = committed[0]!.page.value.replace('"commit":"1"', '"commit":"2"');
    expect(fence!(committed)).toEqual(baseline);
    committed[0]!.page.value = committed[0]!.page.value.replace('"more":true', '"more":false');
    expect(fence!(committed)).not.toEqual(baseline);
    await expect(resourceNamePages(session, [{ kind: 'space', order: 'newest', limit: 1 },
      { kind: 'space', order: 'newest', limit: 1 }])).rejects.toThrow('Resource source batch');
  });
  await expect(resourceNamePages(session, [{ kind: 'space', order: 'newest', limit: 1 }]))
    .rejects.toThrow('Resource source batch');
});

test('mixed hydration stops before the next owner without skipping denied or unexamined candidates', () => {
  const candidates = ['absent', 'realm1', 'realm2', 'space', 'site', 'resource', 'post', 'work', 'agent']
    .map(id => ({ id }));
  const owners = new Map([['realm1', 'realm'], ['realm2', 'realm'], ['space', 'space'], ['site', 'site'],
    ['resource', 'resource'], ['post', 'post'], ['work', 'work'], ['agent', 'agent']] as const);
  let rest = candidates;
  const pages: string[][] = [];
  while (rest.length) {
    const prefix = resourceHydrationPrefix(rest, owners);
    expect(prefix.length).toBeGreaterThan(0);
    pages.push(prefix.map(candidate => candidate.id));
    rest = rest.slice(prefix.length);
  }
  expect(pages).toEqual([['absent', 'realm1', 'realm2'], ['space', 'site'], ['resource', 'post'], ['work'], ['agent']]);
  expect(pages.flat()).toEqual(candidates.map(candidate => candidate.id));
});
