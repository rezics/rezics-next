import { expect, test } from 'bun:test';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { withResourceListBudget } from '../src/modules/query/budget.ts';
import { RESOURCE_LIST_COST } from '../src/modules/query/resource-contract.ts';
import { conceptResourceMatches } from '../src/modules/query/resources.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { DiscoveryReadGeneration } from '../src/modules/discovery/store.ts';
import { REALM_DIRECTORY_COST } from '../src/modules/realm-directory/contract.ts';

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

test('Realm directory source uses its owner allocation and still debits an enclosing budget', async () => {
  const outer = { signal: new AbortController().signal, callsLeft: 80, bytesLeft: 1024 };
  await withResourceListBudget(async () => {
    expect(fusekiReadBudget.getStore()!.callsLeft).toBe(
      RESOURCE_LIST_COST.graphCalls + REALM_DIRECTORY_COST.graphCalls);
  }, 'all', ['realm']);
  await fusekiReadBudget.run(outer, () => withResourceListBudget(async () => {
    const budget = fusekiReadBudget.getStore()!;
    expect(budget.callsLeft).toBe(80);
    budget.callsLeft -= 33;
    expect(outer.callsLeft).toBe(47);
    await withResourceListBudget(async () => {
      const nested = fusekiReadBudget.getStore()!;
      expect(nested.callsLeft).toBe(47);
      nested.callsLeft -= 47;
      expect(outer.callsLeft).toBe(0);
    }, 'all', ['realm']);
  }, 'all', ['work', 'realm']));
});
