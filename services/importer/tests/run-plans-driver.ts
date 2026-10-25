import type { CreateImportRunPlansDriver, RunPlansDriver } from '../../../specs/imports-run-plans-driver.ts';
import { RunStore, RUN_TABLES } from '../src/run-store.ts';
import { createSqliteProbe, type SqliteEvidence } from './support/sqlite-growth.ts';
import type { Evidence, Execution, Parameter, Relation } from '../../../specs/imports-run-store-driver.ts';

// Only forwarding and observations of actual SQLite state; no outcome model or transport.
export const createImportRunPlansDriver: CreateImportRunPlansDriver = async ({ directory }) => {
  let probe: ReturnType<typeof createSqliteProbe>;
  const store = new RunStore(`${directory}/runs.sqlite`, {
    instrumentDatabase(db) {
      probe = createSqliteProbe(db, { growingTables: RUN_TABLES });
      return db;
    },
  });
  const db = store.database;
  const database = `${directory}/runs.sqlite`;
  const analysis: Evidence['analysis'] = [];
  let capture: Execution[] | undefined;

  function rawAll(sql: string, ...parameters: Parameter[]): unknown[] {
    const statement = db.prepare(sql);
    try {
      return statement.all(...parameters);
    } finally {
      statement.finalize();
    }
  }
  function schema(): Relation[] {
    return (
      rawAll("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name LIKE 'run_%'") as {
        name: string;
        sql: string;
      }[]
    ).map((table) => {
      const columns = rawAll(`PRAGMA table_info(${table.name})`) as { name: string; type: string; pk: number }[];
      const integer =
        !/WITHOUT ROWID/i.test(table.sql) && columns.filter((c) => c.pk).length === 1
          ? columns.find((c) => c.pk && c.type.toUpperCase() === 'INTEGER')?.name
          : undefined;
      return {
        ...(integer ? { integerPrimaryKey: integer } : {}),
        table: table.name,
        createSql: table.sql,
        indexes: (
          rawAll(`PRAGMA index_list(${table.name})`) as { name: string; unique: number; origin: 'pk' | 'u' | 'c' }[]
        ).map((index) => ({
          name: index.name,
          unique: !!index.unique,
          origin: index.origin,
          columns: (rawAll(`PRAGMA index_info(${index.name})`) as { name: string }[]).map((c) => c.name),
          createSql:
            (rawAll('SELECT sql FROM sqlite_schema WHERE name=?', index.name) as { sql: string | null }[])[0]?.sql ??
            null,
        })),
      };
    });
  }
  function execution(event: SqliteEvidence): Execution {
    const kind = event.kind === 'control' ? 'control' : event.kind === 'insert' ? 'keyed-insert' : 'readable';
    if (event.kind === 'unsupported') throw new Error('Unsupported actual SQLite execution');
    const reads: Execution['reads'] = [];
    if (kind === 'readable') {
      // Every relation occurrence, including scalar subqueries and aliases, is kept.
      for (const match of event.sql.matchAll(/\b(?:FROM|JOIN|UPDATE)\s+(run_\w+)(?:\s+AS\s+(\w+))?/gi)) {
        reads.push({ table: match[1]!, alias: match[2] ?? match[1]! });
      }
    }
    // Actual EQP for every SQL/binding, after synchronous capture ends, never a supplied plan.
    const plan =
      kind === 'readable'
        ? (rawAll(`EXPLAIN QUERY PLAN ${event.sql}`, ...(event.parameters as Parameter[])) as Execution['plan'])
        : [];
    return {
      database,
      sql: event.sql,
      parameters: event.parameters as Parameter[],
      rows: event.rows,
      kind,
      reads,
      plan,
    };
  }
  function forward<T>(operation: () => T): T {
    if (!capture) return operation();
    // The shared probe deliberately requires synchronous work. Surround each concrete
    // store operation and aggregate every native execution across the async driver call.
    // Reinstall before preparing/querying to bound probe logs without losing any handle.
    probe.restore();
    probe = createSqliteProbe(db, { growingTables: RUN_TABLES });
    let failure: unknown;
    let rejected = false;
    const measured = probe.measure(() => {
      try {
        return operation();
      } catch (error) {
        rejected = true;
        failure = error;
        return undefined;
      }
    });
    probe.verifyPlans();
    capture.push(...measured.statements.map(execution));
    if (rejected) throw failure;
    return measured.value as T;
  }
  const driver: RunPlansDriver = {
    async close() {
      store.close();
    },
    async begin(source, options) {
      return forward(() => store.begin(source, options));
    },
    async reopen(run) {
      return forward(() => store.reopen(run));
    },
    async abandon(run) {
      return forward(() => store.abandon(run));
    },
    async stage(run, record) {
      forward(() => store.stage(run, record));
    },
    async seal(run, input) {
      return forward(() => store.seal(run, input));
    },
    async classify(run, key, input) {
      return forward(() => store.classify(run, key, input));
    },
    async prepare(run, key, input) {
      return forward(() => store.prepare(run, key, input));
    },
    async pagePending(run, page) {
      return forward(() => store.pagePending(run, page));
    },
    async pageVanished(run, page) {
      return forward(() => store.pageVanished(run, page));
    },
    async acknowledge(run, result, scope) {
      forward(() => store.acknowledge(run, result, scope));
    },
    async finalize(run, cap) {
      return forward(() => store.finalize(run, cap));
    },
    async source(source) {
      return forward(() => store.source(source));
    },
    async key(source, key, run) {
      return forward(() => store.key(source, key, run));
    },
    async persisted() {
      return Object.fromEntries(RUN_TABLES.map((table) => [table, rawAll(`SELECT * FROM ${table}`)]));
    },
    async analyze() {
      db.exec('ANALYZE');
      analysis.push({ database, sql: 'ANALYZE' });
    },
    async measure(operation) {
      if (capture) throw new Error('Nested measurement');
      const executions: Execution[] = [];
      capture = executions;
      try {
        const value = await operation();
        return {
          value,
          networkRequests: 0,
          kernelPartitions: [],
          evidence: { analysis: [...analysis], schema: [{ database, relations: schema() }], executions },
        };
      } finally {
        capture = undefined;
      }
    },
  };
  return driver;
};
