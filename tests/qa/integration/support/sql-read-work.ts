import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type QueryResult } from 'pg';
import { attributeSqlCheckoutCallers, foregroundCounted } from './query-cost-meter.ts';

export interface ReadPlan {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: ReadPlan[];
}

/** Count visits at storage scans, including rejected rows, without counting
 * each tuple again at every ancestor join/sort/limit. */
export function scanVisits(plan: ReadPlan): number {
  const own = /Scan$/.test(plan['Node Type']) && plan['Node Type'] !== 'Bitmap Index Scan'
    ? ((plan['Actual Rows'] ?? 0) + (plan['Rows Removed by Filter'] ?? 0)
      + (plan['Rows Removed by Index Recheck'] ?? 0)) * (plan['Actual Loops'] ?? 0) : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + scanVisits(child), 0);
}

export interface SqlReadWork {
  statements: number;
  rowsTouched: number;
  plans: { sql: string; rowsTouched: number; plan: ReadPlan }[];
}

/** EXPLAIN runs on the same connection and snapshot as the real read. Its
 * probes are deliberately excluded from statements and must not be used as
 * served-time evidence; measure served time in a separate unprobed request.
 * Callers select pure owner reads, never commands or lock/function calls. */
export function meterSqlReadWork(select: (sql: string) => boolean) {
  const restoreCheckouts = attributeSqlCheckoutCallers();
  const active = new AsyncLocalStorage<SqlReadWork>();
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  prototype.query = function (this: object, ...args: unknown[]) {
    const work = foregroundCounted() ? active.getStore() : undefined;
    if (!work) return original.apply(this, args);
    work.statements++;
    const config = args[0];
    const sql = typeof config === 'string' ? config : (config as { text?: string })?.text ?? '';
    if (!select(sql)) return original.apply(this, args);
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|MERGE|nextval|set_config|pg_advisory\w*)\b/i.test(sql)
      || typeof args.at(-1) === 'function') throw new Error('SQL work probe requires a pure promised read');
    const values = typeof config === 'string' ? args[1] : (config as { values?: unknown[] }).values;
    return (async () => {
      const result = await original.apply(this, args);
      const explained = await original.call(this, `EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${sql}`, values) as
        QueryResult<{ 'QUERY PLAN': { Plan: ReadPlan }[] }>;
      const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
      const rowsTouched = scanVisits(plan);
      work.rowsTouched += rowsTouched;
      work.plans.push({ sql, rowsTouched, plan });
      return result;
    })();
  };
  return {
    async measure<T>(read: () => Promise<T>) {
      const work: SqlReadWork = { statements: 0, rowsTouched: 0, plans: [] };
      const result = await active.run(work, read);
      return { result, work };
    },
    restore() { prototype.query = original; restoreCheckouts(); },
  };
}
