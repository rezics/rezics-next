import type { Database } from 'bun:sqlite';

type PlanRow = { id: number; parent: number; notused: number; detail: string };
type Kind = 'read' | 'write' | 'insert' | 'control' | 'unsupported';
export type SqliteEvidence = {
  sql: string;
  parameters: unknown[];
  rows: number;
  kind: Kind;
  plan: PlanRow[];
  changes?: number | bigint;
};
type Sample<T> = {
  value: T;
  counts: { 'sqlite statements': number; 'sqlite returned rows': number };
  /** @deprecated Compatibility for unmigrated tests only. blocks:0 is not an IO measurement. */
  cost: { rows: number; blocks: 0; statements: number };
  statements: SqliteEvidence[];
};
type Callable = (...args: unknown[]) => unknown;
type NativeStatement = ReturnType<Database['query']>;
const LIMIT = 4096;
const BYTE_LIMIT = 1024 * 1024;

// Split only at SQL boundaries, never inside strings, identifiers or comments.
// Trigger bodies are intentionally unsupported in measured operations.
function splitSql(sql: string): string[] {
  const pieces =
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|[^'"`[;/-]+|[\s\S]/g,
    ) ?? [];
  const statements: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (piece.startsWith('--') || piece.startsWith('/*')) current += ' ';
    else if (piece === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += piece;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function bindingBytes(value: unknown): number {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (value && typeof value === 'object')
    return Object.entries(value).reduce((size, [key, item]) => size + key.length + bindingBytes(item), 0);
  return new TextEncoder().encode(String(value)).byteLength;
}

function bindings(args: unknown[]): unknown[] {
  return structuredClone(args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
}

/**
 * Counts actual native executions and rows delivered to the caller, never rows
 * visited internally. Install before preparing statements (RecordStore offers
 * instrumentDatabase for this). Evidence contains raw SQL/binds: do not log it.
 * Verification conservatively rejects all relation scans and temporary sorts,
 * including scans of aliases, views and relations not declared as growing.
 */
export function createSqliteProbe(database: Database, options: { growingTables: readonly string[] }) {
  if (options.growingTables.some((table) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(table))) {
    throw new TypeError('Growing tables must be unqualified identifiers');
  }
  const originalPrepare = database.prepare.bind(database);
  const originalRun = database.run.bind(database);
  const undo: (() => void)[] = [];
  const wrapped = new WeakSet<object>();
  const evidence: SqliteEvidence[] = [];
  let bytes = 0;
  let active: Sample<unknown> | undefined;
  let restored = false;
  let depth = 0;
  let invalid = false;
  let hasTriggers = false;

  function replace(target: object, key: PropertyKey, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    undo.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    });
  }

  function restore() {
    if (restored) return;
    restored = true;
    for (const reset of undo.reverse()) reset();
    undo.length = 0;
  }

  function classify(sql: string, parameters: unknown[]): Kind {
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) return 'control';
    if (hasTriggers && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return 'unsupported';
    if (/^(?:SELECT|WITH)\b/i.test(sql)) return 'read';
    if (/^(?:UPDATE|DELETE)\b/i.test(sql)) return 'write';
    if (/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*(?:\([^)]+\))?\s+SELECT\b/i.test(sql)) return 'write';
    // A single keyed VALUES insert/upsert has no readable input relation.
    const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*(?:\(([^)]+)\))?\s+VALUES\s*\(([^)]+)\)([\s\S]*)$/i.exec(
      sql,
    );
    if (insert && !/\b(?:SELECT|WITH)\b/i.test(sql) && !/^\s*,/.test(insert[4]!)) {
      const metadata = originalPrepare(`PRAGMA table_info("${insert[1]}")`);
      let info: { name: string; pk: number }[];
      try {
        info = metadata.all() as typeof info;
      } finally {
        metadata.finalize();
      }
      // Expressions and generated keys do not establish an exact supplied key.
      if (
        !insert[3]!
          .split(',')
          .every((value) => /^(?:\?|\?\d+|[:@$][A-Za-z_]\w*|[+-]?\d+(?:\.\d+)?|'(?:''|[^'])*')$/.test(value.trim()))
      )
        return 'unsupported';
      const columns =
        insert[2]?.split(',').map((column) => column.trim().toLowerCase()) ?? info.map((c) => c.name.toLowerCase());
      let slot = 0;
      const namedSlots = new Map<string, number>();
      const supplied = insert[3]!.split(',').map((value) => {
        const token = value.trim();
        if (!/^[?:@$]/.test(token)) return token;
        if (token === '?') return parameters[slot++];
        if (/^\?\d+$/.test(token)) {
          const index = Number(token.slice(1)) - 1;
          slot = Math.max(slot, index + 1);
          return parameters[index];
        }
        const object = parameters[0];
        if (object && typeof object === 'object' && !ArrayBuffer.isView(object)) {
          return Reflect.get(object, token) ?? Reflect.get(object, token.slice(1));
        }
        if (!namedSlots.has(token)) namedSlots.set(token, slot++);
        return parameters[namedSlots.get(token)!];
      });
      const keys = info.filter((column) => column.pk > 0);
      if (keys.length && keys.every((key) => supplied[columns.indexOf(key.name.toLowerCase())] != null))
        return 'insert';
    }
    return 'unsupported';
  }

  function begin(sql: string, parameters: unknown[]): SqliteEvidence | undefined {
    if (!active || depth || restored) return;
    // Fail closed rather than retain an unbounded execution log or source body.
    const size = new TextEncoder().encode(sql).byteLength + bindingBytes(parameters);
    if (evidence.length >= LIMIT || bytes + size > BYTE_LIMIT) {
      invalid = true;
      throw new Error('SQLite evidence limit exceeded');
    }
    bytes += size;
    let plan: PlanRow[] = [];
    const kind = classify(sql, parameters);
    try {
      const statement = originalPrepare(`EXPLAIN QUERY PLAN ${sql}`);
      try {
        plan = Reflect.apply(statement.all, statement, parameters) as PlanRow[];
      } finally {
        statement.finalize();
      }
    } catch {
      invalid = true;
      // Preserve the original execution error and fail verification closed.
    }
    bytes += new TextEncoder().encode(JSON.stringify(plan)).byteLength;
    if (bytes > BYTE_LIMIT) {
      invalid = true;
      throw new Error('SQLite evidence limit exceeded');
    }
    const event: SqliteEvidence = { sql, parameters: structuredClone(parameters), rows: 0, kind, plan };
    evidence.push(event);
    active.statements.push(event);
    active.cost.statements++;
    active.counts['sqlite statements']++;
    return event;
  }

  function execute(sql: string, parameters: unknown[], call: () => unknown, method: string) {
    const event = begin(sql, parameters);
    const sample = active;
    depth++;
    let result: unknown;
    try {
      result = call();
    } finally {
      depth--;
    }
    if (event && sample) {
      event.rows = method === 'get' ? (result == null ? 0 : 1) : Array.isArray(result) ? result.length : 0;
      sample.cost.rows += event.rows;
      sample.counts['sqlite returned rows'] += event.rows;
      if (result && typeof result === 'object' && 'changes' in result) {
        event.changes = (result as { changes: number | bigint }).changes;
      }
    }
    return result;
  }

  function wrapStatement(statement: NativeStatement, sql: string, initial: unknown[] = []) {
    if (wrapped.has(statement)) return statement;
    wrapped.add(statement);
    let bound = bindings(initial);
    for (const method of ['get', 'all', 'iterate', 'run', 'values', 'raw'] as const) {
      const native = Reflect.get(statement, method) as Callable;
      if (typeof native !== 'function') continue;
      replace(statement, method, function (...args: unknown[]) {
        if (method === 'iterate') {
          const iterator = Reflect.apply(native, statement, args) as IterableIterator<unknown>;
          let event: SqliteEvidence | undefined;
          let sample: Sample<unknown> | undefined;
          let started = false;

          return {
            [Symbol.iterator]() {
              return this;
            },
            next(...nextArgs: [] | [unknown]) {
              if (!started) {
                if (args.length) bound = bindings(args);
                event = begin(sql, bound);
                sample = active;
                started = true;
              }
              if (event && active !== sample && !restored) {
                invalid = true;
                throw new Error('SQLite iterator escaped its measurement');
              }
              depth++;
              let result: IteratorResult<unknown>;
              try {
                result = iterator.next(...nextArgs);
              } finally {
                depth--;
              }
              if (event && sample && !result.done) {
                event.rows++;
                sample.cost.rows++;
                sample.counts['sqlite returned rows']++;
              }
              return result;
            },
            return(value?: unknown) {
              return iterator.return?.(value) ?? { done: true, value };
            },
            throw(error?: unknown) {
              if (iterator.throw) return iterator.throw(error);
              throw error;
            },
          };
        }
        if (args.length) bound = bindings(args);
        return execute(sql, bound, () => Reflect.apply(native, statement, args), method);
      });
    }
    return statement;
  }

  // Bun's native transaction helper prepares its own control statements. A real
  // Database proxy forwards those preparations too, preserving native transaction
  // behavior and catching returned statements without relying on private symbols.
  const proxy = new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (
          result &&
          typeof result === 'object' &&
          typeof Reflect.get(result, 'get') === 'function' &&
          typeof args[0] === 'string'
        ) {
          return wrapStatement(result as NativeStatement, args[0]);
        }
        return result;
      };
    },
  });

  try {
    for (const method of ['prepare', 'query'] as const) {
      const native = database[method];
      replace(database, method, (...args: unknown[]) => {
        const statement = Reflect.apply(native, database, args) as NativeStatement;
        const sql = splitSql(args[0] as string);
        if (sql.length !== 1) throw new Error('Unsupported multi-statement preparation');
        return wrapStatement(statement, sql[0]!, method === 'prepare' && args[1] != null ? [args[1]] : []);
      });
    }
    for (const method of ['run', 'exec'] as const) {
      const native = database[method];
      replace(database, method, (...args: unknown[]) => {
        if (!active || depth || restored) return Reflect.apply(native, database, args);
        const statements = splitSql(args[0] as string);
        if (
          statements.some((sql) => /^CREATE\s+(?:TEMP\s+)?TRIGGER\b/i.test(sql)) ||
          (statements.length > 1 && args.length > 1)
        ) {
          invalid = true;
          throw new Error('Unsupported compound SQLite execution');
        }
        if (!statements.length) return Reflect.apply(native, database, args);
        let result: unknown;
        let changes = 0;
        for (const sql of statements) {
          result = execute(
            sql,
            bindings(args.slice(1)),
            () => Reflect.apply(originalRun, database, [sql, ...args.slice(1)]),
            'run',
          );
          changes += (result as { changes: number }).changes;
        }
        // Native run/exec returns total changes across the whole SQL batch.
        return statements.length > 1 ? { ...(result as object), changes } : result;
      });
    }
    const transaction = database.transaction;
    replace(database, 'transaction', (...args: unknown[]) => Reflect.apply(transaction, proxy, args));
    const close = database.close;
    replace(database, 'close', (...args: unknown[]) => {
      restore();
      return Reflect.apply(close, database, args);
    });
  } catch (error) {
    restore();
    throw error;
  }

  return {
    database: proxy,
    measure<T>(operation: () => T): Sample<T> {
      if (restored || active) throw new Error('SQLite probe is restored or already measuring');
      // Trigger programs have reads that EQP does not expose. Refuse to certify
      // their writes rather than silently miss those relation accesses.
      const triggers = originalPrepare(
        "SELECT 1 FROM sqlite_schema WHERE type='trigger' UNION ALL SELECT 1 FROM sqlite_temp_schema WHERE type='trigger' LIMIT 1",
      );
      try {
        hasTriggers = triggers.get() != null;
      } finally {
        triggers.finalize();
      }
      const sample: Sample<T> = {
        value: undefined as T,
        counts: { 'sqlite statements': 0, 'sqlite returned rows': 0 },
        cost: { rows: 0, blocks: 0, statements: 0 },
        statements: [],
      };
      active = sample;
      try {
        sample.value = operation();
        if (sample.value && typeof (sample.value as { then?: unknown }).then === 'function') {
          invalid = true;
          throw new Error('SQLite measurements must be synchronous');
        }
        return sample;
      } finally {
        active = undefined;
      }
    },
    verifyPlans() {
      if (invalid) throw new Error('Incomplete SQLite evidence');
      for (const event of evidence) {
        if (event.kind === 'unsupported') throw new Error('Unsupported SQLite statement');
        if (event.kind === 'control') continue;
        for (const row of event.plan) {
          if (
            /\bAUTOMATIC\b|USE TEMP B-TREE/i.test(row.detail) ||
            (/\bSCAN\b/i.test(row.detail) && !/^SCAN CONSTANT ROW$/i.test(row.detail))
          ) {
            throw new Error('SQLite plan contains an unbounded scan, automatic index or temporary sort');
          }
          if (
            /^SEARCH\b/i.test(row.detail) &&
            !/USING (?:COVERING )?(?:INDEX .+|INTEGER PRIMARY KEY|PRIMARY KEY)\s*\([^)]*[=<>][^)]*\)/i.test(row.detail)
          ) {
            throw new Error('Missing declared indexed key proof');
          }
        }
        if (
          (event.kind === 'read' && !event.plan.length) ||
          (event.kind === 'write' && !event.plan.some((row) => /^SEARCH\b/i.test(row.detail)))
        ) {
          throw new Error('Missing SQLite read plan evidence');
        }
      }
      return evidence;
    },
    restore,
  };
}
