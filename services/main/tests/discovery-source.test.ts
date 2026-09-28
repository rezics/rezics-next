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
