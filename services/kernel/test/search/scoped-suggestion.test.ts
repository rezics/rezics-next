import { expect, test } from 'bun:test';
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type {
  PublicFilterQueriedObservation,
  PublicFilterConsumerQuery,
} from '../../src/search/public-filter-consumer-contract.ts';
import { executeScopedSuggestions } from '../../src/search/scoped-suggestion.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork } from '../../src/search/scope-execution.ts';
import type { PreparedSearchScope, SearchScopeEvaluation } from '../../src/search/scope-source.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';
import type { PublicSuggestionOperations } from '../../src/search/public-suggestion.ts';

const route = (partition: number) => (partition * 16).toString(16).padStart(4, '0');
const subject = (n: number): IndexedSubject => ({
  id: `018f0000-0000-7000-8000-${route(10)}${String(n).padStart(8, '0')}`,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [],
});

function fixture(changeDuringHydration = false, changeDisplayedFields = false) {
  const [deniedA, deniedB, allowed] = [subject(1), subject(2), subject(3)];
  const values = new Map([deniedA, deniedB, allowed].map((value) => [value.id, value]));
  const source: SubjectSource = {
    async read(partition, ids) {
      return { partition, position: 1n, subjects: ids.flatMap((id) => (values.has(id) ? [values.get(id)!] : [])) };
    },
    async count() {
      return { position: 1n, count: values.size };
    },
  };
  const allowance = scopeAllowance(700, 'scoped-suggestion');
  const work = new ScopeWork(allowance);
  let permitted = new Set([allowed.id]);
  const scope = {
    async evaluate(_prepared: PreparedSearchScope, ids: readonly string[]): Promise<SearchScopeEvaluation> {
      return {
        basis: { canonical: 'current-scope' } as SearchScopeEvaluation['basis'],
        values: ids.map((id) => permitted.has(id)),
        usage: { keys: ids.length, native: {} as SearchScopeEvaluation['usage']['native'] },
        evidence: [],
        progress: null,
      };
    },
    work: () => ({ reservationId: allowance.reservationId, used: zeroScopeWork() }),
  };
  const queried = { consumer: {} } as PublicFilterQueriedObservation;
  const calls: { refill?: { execution: string; consumed: number; size: number }; result: string[] }[] = [];
  const operations = {
    async queryScoped(
      _q: PublicFilterQueriedObservation,
      _context: { deadline: number },
      refill?: { execution: string; consumed: number; size: number },
    ) {
      const hits = refill ? [allowed] : [deniedA, deniedB];
      calls.push({ ...(refill ? { refill } : {}), result: hits.map((hit) => hit.id) });
      const query = {
        status: 'queried',
        queried,
        execution: refill ? 'execution-2' : 'execution-1',
        start: {},
        result: {
          hits: hits.map((hit, index) => ({
            id: hit.id,
            index: 'subjects-g1',
            partition: 10,
            securityRevision: 1,
            matched: [],
            sort: [1, hit.id],
          })),
          total: { value: 3, relation: 'lower_bound' },
        },
        window: {
          positions: hits.map((_, index) => index),
          examined: hits.length,
          exhausted: Boolean(refill),
        },
        cost: {},
      };
      return query as unknown as PublicFilterConsumerQuery;
    },
    async readStatus() {
      return { status: 'observed', blocking: [] } as never;
    },
  } as unknown as PublicSuggestionOperations;
  const run = (complete?: () => void) =>
    executeScopedSuggestions({
      operations,
      queried,
      context: { deadline: Date.now() + 10_000 },
      limit: 1,
      generation: 1,
      filter: {} as FilterDocument,
      release: {} as FilterRelease,
      source,
      scope: scope as never,
      preparedScope: { readiness: 'ready', basis: { canonical: 'current-scope' } } as PreparedSearchScope,
      scopeWork: work,
      readSource: (operation) => operation(),
      project: (value) => ({
        id: value.id,
        type: value.type,
        labels: Object.fromEntries(value.labels.map(({ language, value: label }) => [language, label])),
      }),
      asOf: async () => '2026-11-03T00:00:00.000Z',
      freshGeneration: async () => 1,
      releaseIsCurrent: async () => true,
      complete: async () => {
        if (changeDuringHydration) permitted = new Set();
        if (changeDisplayedFields) allowed.labels[0]!.value = 'Changed during hydration';
        complete?.();
      },
    });
  return { allowed, calls, run };
}

test('scoped prefix consumes denied candidates and refills to a current permitted match', async () => {
  const { allowed, calls, run } = fixture();
  const page = await run();
  expect(page.subjects.map(({ id }) => id)).toEqual([allowed.id]);
  expect(calls).toHaveLength(2);
  expect(calls[1]?.refill).toEqual({ execution: 'execution-1', consumed: 2, size: 3 });
  expect(calls.reduce((total, call) => total + call.result.length, 0)).toBeLessThanOrEqual(9);
});

test('membership withdrawn while summaries are hydrated restarts without returning the stale subject', async () => {
  const { run } = fixture(true);
  await expect(run()).rejects.toMatchObject({ code: 'search_restart_required' });
});

test('a displayed label changed while summaries are hydrated restarts before disclosure', async () => {
  const { run } = fixture(false, true);
  await expect(run()).rejects.toMatchObject({ code: 'search_restart_required' });
});
