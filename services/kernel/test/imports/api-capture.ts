import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { partitionOf } from '../../src/route/route.ts';
import type { Counters, PhaseCounters } from '../../../../specs/imports-api-driver.ts';
import type { GrowingRelation, SqliteStatement } from '../../../../specs/imports-growth-driver.ts';
import type { SqliteEvidence } from '../../../importer/tests/support/sqlite-growth.ts';
import { capture, withoutCatalogStatements, type GrowthDatabase, type Capture } from '../support/growth.ts';

const empty = (): Counters => ({
  statements: 0,
  rowsReturned: 0,
  sqlite: { analyzed: true, growingRelations: [], executions: [] },
  postgres: { statements: [], plans: [] },
  partitions: 0,
  inputBytes: 0,
  records: 0,
  peakBufferedBytes: 0,
  maxPageRecords: 0,
  workUnits: 0,
});

/** Actual SQLite executions and shared PostgreSQL capture, owned by this composition. */
export function createApiCapture(database: GrowthDatabase, auth: GrowthDatabase) {
  let active: PhaseCounters | undefined;
  let local: Database | undefined;
  let relations: GrowingRelation[] = [];
  let partitions = new Set<number>();
  let sources = new Set<string>();

  function metadata() {
    if (!local) throw new Error('Importer SQLite is not open');
    local.exec('ANALYZE');
    const tables = local
      .query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string }[];
    relations = tables.map(({ name, sql }) => {
      const columns = local!.query(`PRAGMA table_info("${name}")`).all() as {
        name: string;
        type: string;
        pk: number;
      }[];
      const indexes = local!.query(`PRAGMA index_list("${name}")`).all() as { name: string; unique: number }[];
      const primary = columns.filter((c) => c.pk > 0);
      return {
        table: name,
        indexes: indexes.map((index) => ({
          name: index.name,
          unique: !!index.unique,
          columns: (local!.query(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]).map((c) => c.name),
        })),
        ...(!/WITHOUT ROWID/i.test(sql) && primary.length === 1 && primary[0]!.type === 'INTEGER'
          ? { integerPrimaryKey: primary[0]!.name }
          : {}),
      };
    });
  }

  function execution(event: SqliteEvidence): SqliteStatement {
    const reads: { table: string; alias: string }[] = [];
    for (const node of event.plan) {
      const alias = /^(?:SEARCH|SCAN) (\S+)/i.exec(node.detail)?.[1];
      if (!alias) continue;
      const direct = relations.find((r) => r.table === alias);
      const aliased = new RegExp(`\\b(?:FROM|JOIN|UPDATE)\\s+(\\w+)\\s+(?:AS\\s+)?${alias}\\b`, 'i').exec(
        event.sql,
      )?.[1];
      const table = direct?.table ?? aliased;
      if (!table || !relations.some((r) => r.table === table)) throw new Error(`Unbound SQLite read: ${alias}`);
      if (!reads.some((r) => r.alias === alias && r.table === table)) reads.push({ table, alias });
    }
    return {
      engine: 'sqlite',
      sql: event.sql,
      parameters: Object.fromEntries(event.parameters.map((v, i) => [String(i), v])) as SqliteStatement['parameters'],
      rowsReturned: event.rows,
      classification:
        event.kind === 'control' ? 'transaction-control' : event.kind === 'insert' ? 'keyed-insert' : 'readable',
      reads,
      explain: JSON.stringify(event.plan),
    };
  }

  function merge(captured: Capture) {
    if (!active) return;
    // Shared plan-based accounting bounds catalog freshness probes separately from request work.
    const raw = withoutCatalogStatements('import API', captured);
    function visit(value: unknown): void {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['Index Cond', 'Filter', 'Recheck Cond'].includes(key) && typeof child === 'string') {
          for (const match of child.matchAll(/\b(partition_no|route)\s*=\s*'?([0-9]+)'?/g)) {
            const number = Number(match[2]);
            partitions.add(match[1] === 'route' ? partitionOf(number) : number);
          }
        } else visit(child);
      }
    }
    for (const plan of raw.plans) visit(plan);
    active.api.partitions = partitions.size;
    const previous = active.api.postgres;
    active.api.postgres = {
      statements: [...previous.statements, ...raw.statements],
      plans: [...previous.plans, ...raw.plans],
    };
  }

  return {
    get active() {
      return active;
    },
    instrument(db: Database) {
      local = db;
      const prepare = db.prepare.bind(db);
      const wrapped = new WeakSet<object>();
      let executing = 0;
      const bind = (args: unknown[]): SQLQueryBindings[] =>
        (args.length === 1 && Array.isArray(args[0]) ? args[0] : args) as SQLQueryBindings[];
      function begin(sql: string, parameters: SQLQueryBindings[]) {
        if (!active || executing) return;
        const statement = prepare(`EXPLAIN QUERY PLAN ${sql}`);
        let plan: SqliteEvidence['plan'];
        try {
          plan = statement.all(...parameters) as SqliteEvidence['plan'];
        } finally {
          statement.finalize();
        }
        const event: SqliteEvidence = {
          sql,
          parameters: structuredClone(parameters),
          rows: 0,
          kind: /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)
            ? 'control'
            : /^\s*INSERT\b/i.test(sql) && !plan.length
              ? 'insert'
              : 'read',
          plan,
        };
        const counter = active.reconcile;
        const record = execution(event);
        counter.statements++;
        (counter.sqlite.executions as SqliteStatement[]).push(record);
        return { counter, record };
      }
      function call(sql: string, parameters: SQLQueryBindings[], operation: () => unknown, method: string) {
        const observation = begin(sql, parameters);
        executing++;
        let result: unknown;
        try {
          result = operation();
        } finally {
          executing--;
        }
        if (observation) {
          const rows = method === 'get' ? (result == null ? 0 : 1) : Array.isArray(result) ? result.length : 0;
          observation.record.rowsReturned += rows;
          observation.counter.rowsReturned += rows;
        }
        return result;
      }
      function wrap(statement: ReturnType<Database['prepare']>, sql: string, initial: unknown[] = []) {
        if (wrapped.has(statement)) return statement;
        wrapped.add(statement);
        let parameters = bind(initial);
        for (const method of ['get', 'all', 'run', 'values', 'raw', 'iterate'] as const) {
          const native = Reflect.get(statement, method);
          if (typeof native !== 'function') continue;
          Object.defineProperty(statement, method, {
            configurable: true,
            value: (...args: unknown[]) => {
              if (args.length) parameters = bind(args);
              if (method !== 'iterate')
                return call(sql, parameters, () => Reflect.apply(native, statement, args), method);
              const iterator = Reflect.apply(native, statement, args) as IterableIterator<unknown>;
              const owner = active;
              let observation: ReturnType<typeof begin>;
              let started = false;
              return {
                [Symbol.iterator]() {
                  return this;
                },
                next(...next: [] | [unknown]) {
                  if (!started) {
                    observation = begin(sql, parameters);
                    started = true;
                  }
                  if (active !== owner) throw new Error('SQLite iterator escaped measurement');
                  executing++;
                  let value: IteratorResult<unknown>;
                  try {
                    value = iterator.next(...next);
                  } finally {
                    executing--;
                  }
                  if (observation && !value.done) {
                    observation.record.rowsReturned++;
                    observation.counter.rowsReturned++;
                  }
                  return value;
                },
                return(value?: unknown) {
                  return iterator.return?.(value) ?? { done: true, value };
                },
              };
            },
          });
        }
        return statement;
      }
      for (const method of ['prepare', 'query'] as const) {
        const native = db[method];
        Object.defineProperty(db, method, {
          configurable: true,
          value: (...args: unknown[]) =>
            wrap(
              Reflect.apply(native, db, args),
              String(args[0]),
              method === 'prepare' && args[1] != null ? [args[1]] : [],
            ),
        });
      }
      for (const method of ['run', 'exec'] as const) {
        const native = db[method];
        Object.defineProperty(db, method, {
          configurable: true,
          value: (...args: unknown[]) =>
            call(String(args[0]), bind(args.slice(1)), () => Reflect.apply(native, db, args), 'run'),
        });
      }
      // Bun's native transaction helper prepares its own control statements via
      // its receiver. Forward that receiver while preserving native transactions.
      const proxy = new Proxy(db, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
        },
      });
      const transaction = db.transaction;
      Object.defineProperty(db, 'transaction', {
        configurable: true,
        value: (...args: unknown[]) => Reflect.apply(transaction, proxy, args),
      });
      return proxy;
    },
    attach(objects: readonly object[]) {
      for (const object of objects) {
        for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(object))) {
          if (!/^page[A-Z]|^candidates$/.test(name)) continue;
          const native = Reflect.get(object, name);
          if (typeof native !== 'function') continue;
          Object.defineProperty(object, name, {
            configurable: true,
            value: (...args: unknown[]) => {
              const result: unknown = Reflect.apply(native, object, args);
              if (active && Array.isArray(result)) {
                active.reconcile.maxPageRecords = Math.max(active.reconcile.maxPageRecords, result.length);
                const first = args[0];
                const source =
                  typeof first === 'string'
                    ? first
                    : first && typeof first === 'object' && 'source' in first
                      ? first.source
                      : undefined;
                if (typeof source === 'string') sources.add(source);
                active.reconcile.partitions = sources.size;
              }
              return result;
            },
          });
        }
      }
      metadata();
    },
    merge,
    async measure(action: () => Promise<void>): Promise<PhaseCounters> {
      if (active) throw new Error('Nested importer measurement');
      metadata();
      const counters: PhaseCounters = { reader: empty(), converter: empty(), reconcile: empty(), api: empty() };
      for (const counter of Object.values(counters))
        counter.sqlite = { analyzed: true, growingRelations: relations, executions: [] };
      partitions = new Set();
      sources = new Set();
      active = counters;
      try {
        // One capture owns the whole operation, including concurrent fence
        // requests. Per-request captures contend for the same native pool and
        // turn legitimate parallel reads into transport failures and retries.
        const result = await capture(database, () => capture(auth, action, { includeBackends: true }), {
          includeBackends: true,
        });
        merge(result.capture);
        merge(result.value.capture);
        return counters;
      } finally {
        active = undefined;
      }
    },
  };
}
