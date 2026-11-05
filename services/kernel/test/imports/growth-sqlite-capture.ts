import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type {
  GrowingRelation,
  SqliteParameters,
  SqliteStatement,
  SqliteValue,
} from '../../../../specs/imports-growth-driver.ts';

type PlanRow = { id: number; parent: number; detail: string };
type Execution = {
  sql: string;
  args: unknown[];
  parameters: SqliteParameters;
  rowsReturned: number;
  changes?: number;
  classification: SqliteStatement['classification'];
  reads: { table: string; alias: string }[];
  explain: string;
};

function sqlKey(sql: string, values: SqliteParameters): string {
  return JSON.stringify([sql, values], (_key, value: unknown) =>
    value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('base64') } : value,
  );
}

function parameterShape(args: unknown[]): { args: unknown[]; parameters: SqliteParameters } {
  if (args.length === 1 && Array.isArray(args[0])) {
    const values = args[0] as unknown[];
    return { args: [...values], parameters: values.map(sqliteValue) };
  }
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const values = Object.fromEntries(Object.entries(args[0]).map(([key, value]) => [key, sqliteValue(value)]));
    return { args: [args[0]], parameters: values };
  }
  return { args: [...args], parameters: args.map(sqliteValue) };
}

function sqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
    return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new TypeError(`Unsupported SQLite bind value: ${Object.prototype.toString.call(value)}`);
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Instrument the importer's live bun:sqlite handle; plans are explained after the measured callback. */
export function createGrowthSqliteCapture() {
  let database: Database | undefined;
  let active: Execution[] | undefined;
  let growingRelations: GrowingRelation[] = [];
  let analyzed = false;
  let wrapped = false;
  let nativePrepare: ((sql: string) => ReturnType<Database['prepare']>) | undefined;
  let replayingExplain = false;

  function refreshMetadata() {
    if (!database) throw new Error('Importer SQLite handle is not attached');
    const db = database;
    db.exec('ANALYZE');
    const tables = db
      .query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string; sql: string }[];
    growingRelations = tables.map(({ name, sql }) => {
      const columns = db.query(`PRAGMA table_info(${quote(name)})`).all() as {
        name: string;
        type: string;
        pk: number;
      }[];
      const indexes = db.query(`PRAGMA index_list(${quote(name)})`).all() as { name: string; unique: number }[];
      const primary = columns.filter((column) => column.pk > 0);
      return {
        table: name,
        indexes: indexes.map((index) => ({
          name: index.name,
          unique: index.unique !== 0,
          columns: (db.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string | null }[])
            .map((column) => column.name)
            .filter((column): column is string => column !== null),
        })),
        ...(!/WITHOUT ROWID/i.test(sql) && primary.length === 1 && primary[0]!.type.toUpperCase() === 'INTEGER'
          ? { integerPrimaryKey: primary[0]!.name }
          : {}),
      };
    });
    analyzed = true;
  }

  function instrument(db: Database): Database {
    if (wrapped) throw new Error('SQLite database was instrumented more than once');
    wrapped = true;
    database = db;
    nativePrepare = db.prepare.bind(db);
    const patchedStatements = new WeakSet<object>();

    function record(sql: string, args: unknown[], method: string, invoke: () => unknown): unknown {
      const ledger = active;
      if (!ledger || replayingExplain) return invoke();
      const shape = parameterShape(args);
      const execution: Execution = {
        sql,
        args: shape.args,
        parameters: shape.parameters,
        rowsReturned: 0,
        classification: /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)
          ? 'transaction-control'
          : 'readable',
        reads: [],
        explain: '[]',
      };
      ledger.push(execution);
      const result = invoke();
      if (method === 'get') execution.rowsReturned += result == null ? 0 : 1;
      else if (Array.isArray(result)) execution.rowsReturned += result.length;
      if (method === 'run' && result && typeof result === 'object' && 'changes' in result) {
        const changes = Number((result as { changes: number | bigint }).changes);
        if (Number.isSafeInteger(changes) && changes >= 0) execution.changes = changes;
      }
      return result;
    }

    function wrapStatement<T extends object>(statement: T, sql: string, initial: unknown[] = []): T {
      if (patchedStatements.has(statement)) return statement;
      patchedStatements.add(statement);
      for (const method of ['get', 'all', 'values', 'raw', 'run', 'iterate'] as const) {
        const native = Reflect.get(statement, method);
        if (typeof native !== 'function') continue;
        Object.defineProperty(statement, method, {
          configurable: true,
          value: (...args: unknown[]) => {
            const supplied = args.length ? args : initial;
            if (method !== 'iterate')
              return record(sql, supplied, method, () => Reflect.apply(native, statement, args));
            const iterator = Reflect.apply(native, statement, args) as IterableIterator<unknown>;
            const ledger = active;
            let observation: Execution | undefined;
            let started = false;
            return {
              [Symbol.iterator]() {
                return this;
              },
              next(...nextArgs: [] | [unknown]) {
                if (!started) {
                  started = true;
                  if (ledger && active === ledger) {
                    const shape = parameterShape(supplied);
                    observation = {
                      sql,
                      args: shape.args,
                      parameters: shape.parameters,
                      rowsReturned: 0,
                      classification: 'readable',
                      reads: [],
                      explain: '[]',
                    };
                    ledger.push(observation);
                  }
                }
                if (ledger && active !== ledger) throw new Error('SQLite iterator escaped its measurement');
                const value = Reflect.apply(iterator.next, iterator, nextArgs) as IteratorResult<unknown>;
                if (observation && !value.done) observation.rowsReturned++;
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
          wrapStatement(
            Reflect.apply(native, db, args) as object,
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
          record(String(args[0]), args.slice(1), method, () => Reflect.apply(native, db, args)),
      });
    }
    const proxy = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      },
    });
    const nativeTransaction = db.transaction;
    Object.defineProperty(db, 'transaction', {
      configurable: true,
      value: (...args: unknown[]) => Reflect.apply(nativeTransaction, proxy, args),
    });
    return proxy;
  }

  function readAliases(sql: string, plan: readonly PlanRow[]): { table: string; alias: string }[] {
    const relations = new Map(growingRelations.map((relation) => [relation.table, relation.table]));
    const aliases = new Map<string, string>();
    const matcher = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([\w.]+)(?:\s+(?:AS\s+)?([\w]+))?/gi;
    for (const match of sql.matchAll(matcher)) {
      const table = match[1]!.split('.').at(-1)!;
      const maybeAlias = match[2];
      aliases.set(table, table);
      if (maybeAlias && !/^(?:INDEXED|NOT|WHERE|SET|ON|VALUES|RETURNING)$/i.test(maybeAlias))
        aliases.set(maybeAlias, table);
    }
    const reads: { table: string; alias: string }[] = [];
    for (const row of plan) {
      const match = /^(?:SEARCH|SCAN)\s+(\S+)/i.exec(row.detail);
      if (!match) continue;
      const alias = match[1]!;
      const table = relations.get(alias) ?? aliases.get(alias);
      if (!table || !relations.has(table)) throw new Error(`Unbound SQLite read: ${alias} in ${sql}`);
      if (!reads.some((read) => read.table === table && read.alias === alias)) reads.push({ table, alias });
    }
    return reads;
  }

  async function capture<T>(operation: () => Promise<T>): Promise<{ value: T; statements: SqliteStatement[] }> {
    if (active) throw new Error('Nested growth SQLite capture');
    if (!database) throw new Error('Importer SQLite handle is not attached');
    refreshMetadata();
    const executions: Execution[] = [];
    active = executions;
    let value!: T;
    let failure: unknown;
    try {
      value = await operation();
    } catch (error) {
      failure = error;
    } finally {
      active = undefined;
    }

    const plans = new Map<
      string,
      { rows: PlanRow[]; classification: SqliteStatement['classification']; reads: { table: string; alias: string }[] }
    >();
    for (const execution of executions) {
      const key = sqlKey(execution.sql, execution.parameters);
      let plan = plans.get(key);
      if (!plan) {
        if (execution.classification === 'transaction-control') {
          plan = { rows: [], classification: 'transaction-control', reads: [] };
        } else {
          if (!nativePrepare) throw new Error('Importer SQLite prepare handle is not attached');
          const explain = nativePrepare(`EXPLAIN QUERY PLAN ${execution.sql}`);
          let rows: PlanRow[];
          try {
            replayingExplain = true;
            rows = explain.all(...(execution.args as SQLQueryBindings[])) as PlanRow[];
          } finally {
            replayingExplain = false;
            explain.finalize();
          }
          const classification = /^\s*INSERT\b/i.test(execution.sql) && rows.length === 0 ? 'keyed-insert' : 'readable';
          plan = { rows, classification, reads: readAliases(execution.sql, rows) };
        }
        plans.set(key, plan);
      }
      execution.explain = JSON.stringify(plan.rows);
      execution.classification = plan.classification;
      execution.reads = plan.reads;
    }

    const statements = executions.map((execution): SqliteStatement => ({
      engine: 'sqlite',
      sql: execution.sql,
      parameters: execution.parameters,
      explain: execution.explain,
      rowsReturned: execution.rowsReturned,
      ...(execution.changes === undefined ? {} : { changes: execution.changes }),
      classification: execution.classification,
      reads: execution.reads,
    }));
    if (failure !== undefined) throw failure;
    return { value, statements };
  }

  return {
    instrument,
    attach(_objects: readonly object[]) {
      refreshMetadata();
    },
    refreshMetadata,
    capture,
    get metadata() {
      return { analyzed, growingRelations };
    },
  };
}
