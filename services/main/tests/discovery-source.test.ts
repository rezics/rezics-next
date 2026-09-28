import { expect, test } from 'bun:test';
import { projectDiscoveryBatch } from '../src/modules/discovery/source.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const field = (value: string) => ({ type: 'literal', value });

test('Discovery source advances past an unavailable classified Work without losing later candidates', async () => {
  const session = { position: { dataEpoch: 'epoch', sequence: '9' }, options: {}, deps: {},
    scope: async () => ({ kind: 'global', realm: null }),
    query: async (query: string) => {
      if (query.includes('SELECT ?epoch ?prior')) return [];
      if (query.includes('SELECT DISTINCT ?work WHERE')) return [1, 2].map(n => ({ work: field(id(n)) }));
      if (query.includes('SELECT DISTINCT ?work ?head ?main')) return [1, 2].map(n => ({
        work: field(id(n)), head: field(id(n + 10)), main: field(id(n + 20)),
        sequence: field('1'), epochOrder: field('0'), classified: field(n === 1 ? 'true' : 'false'), credited: field('false'),
      }));
      // readWorkClassifications repeats the Work owner's disclosure admission.
      expect(query).toContain('SELECT ?head ?main ?mainHead');
      return [];
    } } as unknown as WorkReadSession;
  const result = await projectDiscoveryBatch(session, { scope: 'global', realm: null, context: null }, '');
  expect(result).toMatchObject({ after: id(2), complete: true });
  expect(result.items.map(item => item.work)).toEqual([id(2)]);
});

test('global discovery admits publicly selected Works through its source query', async () => {
  const work = id(1);
  const session = { position: { dataEpoch: 'epoch', sequence: '9' }, options: {}, deps: {},
    scope: async () => ({ kind: 'global', realm: null }),
    query: async (query: string) => {
      if (query.includes('SELECT ?epoch ?prior')) return [];
      if (query.includes('SELECT DISTINCT ?work WHERE')) return [{ work: field(work) }];
      // In ARQ, an otherwise empty GRAPH block containing only FILTER NOT EXISTS
      // produces no solutions, even when this Work is publicly selected.
      if (/GRAPH <urn:rezics:graph:current> \{ FILTER NOT EXISTS/.test(query)) return [];
      return [{ work: field(work), head: field(id(2)), main: field(id(3)),
        sequence: field('9'), epochOrder: field('0'), classified: field('false'), credited: field('false') }];
    } } as unknown as WorkReadSession;
  const result = await projectDiscoveryBatch(session, { scope: 'global', realm: null, context: null }, '');
  expect(result.items.map(item => item.work)).toEqual([work]);
});
