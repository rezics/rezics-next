import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { readPublicFilterCreationPrefix } from '../../src/semantic/public-filter-creation-prefix.ts';

test('creation prefix closes only complete unrelated event groups under the retained cut', async () => {
  const receipt = '12'.repeat(32);
  const first = { home: 6, epoch: 1, base: '3', head: '4', receipt };
  const second = { ...first, home: 7, head: '5' };
  const event = { position: '4', epoch: 1, event_seq: 0, event_count: 2, repairs_subject: false };
  const tail = { ...event, event_seq: 1 };
  const later = { ...event, position: '5', event_count: 1 };
  const deadline = Date.now() + 30_000;
  const bootstrap = '32323232-3232-3232-3232-323232323232';
  for (const invalid of [
    [],
    [event, later],
    [event, tail, { ...later, epoch: 2 }],
    [event, tail, { ...later, repairs_subject: true }],
  ]) {
    const queries: unknown[][] = [];
    const pool = {
      async query(sql: string, values: unknown[]) {
        if (sql.includes('generate_series')) return { rows: [first, second] };
        queries.push(values);
        return { rows: values[0] === first.home ? [event, tail] : invalid };
      },
    } as unknown as Pool;
    const cost = { inputKeys: 0, rows: 0, dependencyPoints: 0 };
    const prefix = await readPublicFilterCreationPrefix(
      pool,
      { bootstrap, from: 6, inputLimit: 12 },
      { deadline },
      cost,
    );
    expect(prefix.map(({ window }) => window.partition)).toEqual([6]);
    expect(cost.inputKeys).toBe(8 + invalid.length);
    expect(cost.rows).toBe(20 + invalid.length);
    expect(queries).toEqual([
      [6, '3', '4', 6],
      [7, '3', '5', 4],
    ]);
  }

  // Replay stops at the retained head even if unrelated new positions have since committed.
  const pool = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes('generate_series')) return { rows: [{ ...first, head: '5' }] };
      expect(values).toEqual([6, '3', '4', 7]);
      return { rows: [event, tail] };
    },
  } as unknown as Pool;
  const replay = await readPublicFilterCreationPrefix(
    pool,
    { bootstrap, from: 6, inputLimit: 8, through: ['4'] },
    {
      deadline,
    },
    { inputKeys: 0, rows: 0, dependencyPoints: 0 },
  );
  expect(replay[0]?.window.through).toBe(4n);
});

test('quiet windows use the full remaining metadata allowance across groups', async () => {
  const receipt = '12'.repeat(32);
  const pool = {
    async query(sql: string, values: [number, number]) {
      expect(sql).toContain('generate_series');
      const [from, through] = values;
      return {
        rows: Array.from({ length: through - from + 1 }, (_, i) => ({
          home: from + i,
          epoch: 1,
          base: '0',
          head: '0',
          receipt,
        })),
      };
    },
  } as unknown as Pool;
  const cost = { inputKeys: 0, rows: 0, dependencyPoints: 0 };
  const result = await readPublicFilterCreationPrefix(
    pool,
    { bootstrap: '32323232-3232-3232-3232-323232323232', from: 0, inputLimit: 128 },
    { deadline: Date.now() + 30_000 },
    cost,
  );
  expect(result).toHaveLength(128);
  expect(cost).toEqual({ inputKeys: 128, rows: 384, dependencyPoints: 384 });
});
