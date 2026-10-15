import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { join } from 'node:path';
import { readEnv } from '../../../../scripts/dev/config.ts';
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
  const own = /^(Seq|Index|Index Only|Bitmap Heap|Tid|Tid Range|Foreign) Scan$/.test(plan['Node Type'])
    ? ((plan['Actual Rows'] ?? 0) + (plan['Rows Removed by Filter'] ?? 0)
      + (plan['Rows Removed by Index Recheck'] ?? 0)) * (plan['Actual Loops'] ?? 0) : 0;
  return own + (plan.Plans ?? []).reduce((sum, child) => sum + scanVisits(child), 0);
}

export interface SqlReadWork {
  statements: number;
  rowsTouched: number;
  plans: { sql: string; rowsTouched: number; plan: ReadPlan }[];
}

/** Configure only this disposable QA server's application roles, before they
 * connect. Application credentials retain their normal owner permissions. */
export async function prepareSqlReadWork() {
  const run = process.env.REZICS_QA_RUN_ID;
  if (!run) throw new Error('SQL work profiling requires an isolated QA stack');
  const compose = readEnv(join('.temp/stack', `rezics-qa-${run}`, 'compose.env'));
  const admin = new pg.Client({ connectionString: `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
  await admin.connect();
  try {
    await admin.query("LOAD 'auto_explain'");
    const roles = new Set(['ACCESS_DATABASE_URL', 'CONTENT_DATABASE_URL', 'ACCOUNT_RELAY_DATABASE_URL']
      .map(key => decodeURIComponent(new URL(process.env[key]!).username)));
    for (const role of roles) {
      if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('Unexpected QA database role');
      for (const [name, value] of Object.entries({ session_preload_libraries: 'auto_explain',
        'auto_explain.log_analyze': 'on', 'auto_explain.log_timing': 'off',
        'auto_explain.log_format': 'json', 'auto_explain.log_level': 'notice',
        'auto_explain.log_nested_statements': 'on', 'auto_explain.log_parameter_max_length': '0' }))
        await admin.query(`ALTER ROLE "${role}" SET ${name}='${value}'`);
      await admin.query(`GRANT SET ON PARAMETER "auto_explain.log_min_duration" TO "${role}"`);
    }
  } finally { await admin.end(); }
}

/** auto_explain observes the actual execution, including SQL inside owner
 * functions, without replaying it. NOTICE delivery keeps each plan on its real
 * connection. Measure served time separately with the probe disabled.
 * https://www.postgresql.org/docs/18/auto-explain.html */
export function meterSqlReadWork(select: (sql: string) => boolean, explainMissing?: (sql: string) => boolean) {
  const restoreCheckouts = attributeSqlCheckoutCallers();
  const active = new AsyncLocalStorage<SqlReadWork>();
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  const initialized = new WeakSet<object>();
  const executing = new WeakMap<object, SqlReadWork>();
  prototype.query = function (this: object, ...args: unknown[]) {
    const work = foregroundCounted() ? active.getStore() : undefined;
    if (!work) return original.apply(this, args);
    work.statements++;
    const config = args[0];
    const sql = typeof config === 'string' ? config : (config as { text?: string })?.text ?? '';
    if (!select(sql)) return original.apply(this, args);
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) as (error: unknown, result?: unknown) => void : undefined;
    const queryArgs = callback ? args.slice(0, -1) : args;
    const pending = (async () => {
      if (!initialized.has(this)) {
        const settings = await original.call(this, "SELECT setting FROM pg_settings WHERE name='auto_explain.log_analyze'") as { rows: { setting: string }[] };
        if (settings.rows[0]?.setting !== 'on') throw new Error('SQL growth probe was not preloaded with ANALYZE');
        (this as pg.Client).on('notice', notice => {
          const target = executing.get(this);
          if (!target || !notice.message?.startsWith('duration:')) return;
          const offset = notice.message.indexOf('{');
          if (offset < 0) throw new Error('SQL work probe received a non-JSON plan');
          const entry = JSON.parse(notice.message.slice(offset)) as { 'Query Text': string; Plan: ReadPlan };
          const rowsTouched = scanVisits(entry.Plan);
          target.rowsTouched += rowsTouched;
          target.plans.push({ sql: entry['Query Text'], rowsTouched, plan: entry.Plan });
        });
        initialized.add(this);
      }
      await original.call(this, 'SET auto_explain.log_min_duration=0');
      executing.set(this, work);
      try {
        const before = work.plans.length;
        const result = await original.apply(this, queryArgs);
        if (work.plans.length === before && explainMissing?.(sql)) {
          // A pure, explicitly selected statement can still be measured if
          // auto_explain supplied no plan. The replay uses the same snapshot;
          // it is never used for served time or for an effectful statement.
          executing.delete(this);
          await original.call(this, 'SET auto_explain.log_min_duration=-1');
          const values = typeof config === 'string' ? queryArgs[1] : (config as { values?: unknown[] }).values;
          const explained = await original.call(this, `EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) ${sql}`, values) as
            { rows: { 'QUERY PLAN': { Plan: ReadPlan }[] }[] };
          const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
          const rowsTouched = scanVisits(plan);
          work.rowsTouched += rowsTouched;
          work.plans.push({ sql, plan, rowsTouched });
        }
        return result;
      }
      finally {
        executing.delete(this);
        // A failing query may leave an aborted transaction. The operation's
        // own rollback recovers it; never replace that original failure.
        await Promise.resolve(original.call(this, 'SET auto_explain.log_min_duration=-1')).catch(() => {});
      }
    })();
    if (callback) { void pending.then(result => callback(null, result), error => callback(error)); return; }
    return pending;
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
