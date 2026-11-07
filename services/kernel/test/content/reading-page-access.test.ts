import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createNativeAccessReadingPorts } from '../../src/access/adapters/index.ts';
import { composeContentReading } from '../../src/composition/content.ts';
import { readingPageCapabilities } from '../../src/content/adapters/reading-page-bind.ts';

const live = '00000000-0000-4000-8000-000000000001';
const deleted = '00000000-0000-4000-8000-000000000002';
const unknown = '00000000-0000-4000-8000-000000000003';

test('ordinary composition uses the supplied pool for a real bounded Access projection', async () => {
  const queries: unknown[] = [];
  const pool = {
    query: async (query: unknown) => {
      queries.push(query);
      return {
        rows: [
          { id: live, kind: 'actor', state: 'active', handle: 'reader' },
          { id: deleted, kind: 'actor', state: 'deleted' },
        ],
        rowCount: 2,
      };
    },
  } as unknown as Pool;
  composeContentReading();
  const value = await readingPageCapabilities().readMentions(
    pool,
    {
      identities: [live, deleted, unknown],
      sources: [],
      overflow: false,
    },
    Date.now() + 10_000,
  );
  expect(queries).toHaveLength(1);
  expect(value).toEqual({
    state: 'current',
    retryable: false,
    overflow: false,
    sources: [],
    identities: [
      { id: live, state: 'active', handle: 'reader' },
      { id: deleted, state: 'erased' },
      { id: unknown, state: 'concealed' },
    ],
  });
});

test('Access outages and expired media budgets cannot certify successful empty evidence', async () => {
  const access = createNativeAccessReadingPorts();
  const pool = {
    query: async () => {
      throw Object.assign(new Error('deadline'), { code: '57014' });
    },
  } as unknown as Pool;
  expect(await access.identities(pool, [live], Date.now() + 10_000)).toEqual({ state: 'unavailable' });
  expect(await access.observe(async () => [], Date.now() - 1)).toEqual({ state: 'unavailable' });
  const defect = new Error('unexpected database defect');
  await expect(
    access.observe(async () => {
      throw defect;
    }),
  ).rejects.toBe(defect);
});
