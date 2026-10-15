import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { importDigest, LibraryFileStore } from '../../../services/main/src/modules/library-import/file-store.ts';
import { emptyRow, FILE_IMPORT_COST } from '../../../services/main/src/modules/library-import/formats/contract.ts';
import { startMediaStack } from './media-support.ts';

interface Plan {
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
}
type Sample = { operation: string; size: number; statements: number; returned: number; examined: number; ms: number };
const id = () => `https://rezics.com/id/${randomUUID()}`;

// Count the leaves that touched owner tables, including rows discarded below
// LIMIT/aggregate. A one-row count result is not one row of database work.
function examined(plan: Plan): number {
  return (plan['Relation Name'] ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)
    + (plan['Rows Removed by Index Recheck'] ?? 0)) * plan['Actual Loops'] : 0)
    + (plan.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);
}

function meter(pool: Pool) {
  let active: Sample | undefined;
  type Result = { rows: Array<Record<string, unknown>>; rowCount: number | null };
  const wrap = <T extends Pool | PoolClient>(target: T): T => new Proxy(target, {
    get(owner, key) {
      if (key === 'connect') return async () => wrap(await pool.connect());
      if (key === 'query') return async (sql: string, values?: unknown[]) => {
        const query = owner.query.bind(owner) as (sql: string, values?: unknown[]) => Promise<Result>;
        const result = await query(sql, values);
        if (active) {
          active.statements++;
          active.returned += result.rows.length;
          if (/^\s*SELECT\b/i.test(sql) && /\b(?:reader|structure)\./.test(sql)) {
            const explained = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
            const plan = (explained.rows[0]?.['QUERY PLAN'] as Array<{ Plan: Plan }>)[0]!.Plan;
            active.examined += examined(plan);
          }
        }
        return result;
      };
      const value: unknown = Reflect.get(owner, key, owner);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
  return { pool: wrap(pool), async measure(operation: string, size: number, read: () => Promise<unknown>) {
    const sample: Sample = { operation, size, statements: 0, returned: 0, examined: 0, ms: 0 };
    active = sample;
    const start = performance.now();
    try { await read(); } finally { active = undefined; sample.ms = performance.now() - start; }
    return sample;
  } };
}

test('shelf counts and import progress touch summaries as each reader inventory grows', async () => {
  const stack = await startMediaStack('personal-owner-growth');
  const samples: Sample[] = [];
  try {
    const measured = meter(stack.contentPool);
    const statuses = new ReaderLibraryStatusStore(measured.pool);
    const files = new LibraryFileStore(measured.pool);
    for (const size of [32, 128, 512]) {
      const agent = id();
      // Identical seed method/distribution at every size; each inventory is isolated.
      for (let index = 0; index < size; index++) await statuses.write({ agent, work: id(), status: 'read',
        expectedVersion: 0, idempotencyKey: `seed:${index}`, finishedOn: '2026-10-01' });
      const rows = Array.from({ length: size }, (_, index) => ({ ...emptyRow(`row:${index}`, '', {}), kind: 'retained' as const }));
      const file = await files.create(agent, 'growth', importDigest(rows), 'rezics', rows);
      await files.complete(agent, file.id, 0, { applied: [], issues: ['unresolved-work'] });
      await stack.contentPool.query('ANALYZE reader.library_status');
      await stack.contentPool.query('ANALYZE reader.library_import_source_row');
      samples.push(await measured.measure('shelf-counts', size, async () => {
        expect(await statuses.counts(agent)).toEqual({ read: size, reading: 0, 'want-to-read': 0 });
      }));
      samples.push(await measured.measure('shelf-filters', size, async () => {
        expect((await statuses.shelves(agent)).find(row => row.status === 'read')?.count).toBe(size);
      }));
      samples.push(await measured.measure('import-progress', size, async () => {
        expect(await files.progress(agent, file.id)).toMatchObject({ total: size, completed: 1, issues: 1 });
      }));
      samples.push(await measured.measure('import-batch', size, async () => {
        expect(await files.pending(agent, file.id)).toHaveLength(FILE_IMPORT_COST.page);
      }));
    }
    console.table(samples);
    // Existing page bounds; these are examined rows, not returned aggregate rows.
    for (const sample of samples) expect(sample.examined, JSON.stringify(sample)).toBeLessThanOrEqual(
      sample.operation === 'import-batch' ? 40 : sample.operation === 'shelf-filters' ? 6 : 3);
  } finally {
    const directory = `.temp/personal-authoring-growth/${Bun.env.REZICS_QA_RUN_ID ?? 'local'}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/owner.json`, JSON.stringify(samples, null, 2) + '\n');
    await stack.stop();
  }
}, 300_000);
