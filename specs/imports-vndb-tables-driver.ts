/**
 * TEST ONLY. IMPORT_VNDB_TABLES_DRIVER exports createVndbTablesDriver(limits, attachSqlite).
 * Bind actual importer begin/stage/page/commit operations and durable indexed
 * importer-owned storage. The adapter forwards raw archive-entry streams unchanged;
 * it must not parse COPY, group rows, implement conversion or model run state.
 * Tar/zstd acquisition is outside this boundary. No live VNDB API fallback.
 * close removes isolated fixtures; reopen closes/reopens real storage handles,
 * preserving only durable state (including committed source baselines).
 *
 * Evidence reused from the downloaded official 2026-10-25 dump and generator:
 * https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst (README.txt, schema_vndbid.sql)
 * https://g.blicky.net/vndb.git/tree/util/dbdump.pl (export_table)
 * SHA256 README: 49dc1574d7a656fa43fe0809f1981e09c401a0fa0c3c365d9fc0509c3c71e454
 * SHA256 schema: d608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758
 * SHA256 generator: 7849210e7df27c12ba93bb98b9440cca3b28f2f0dfe6142bdfde54075d2d5608
 * The six fixture files are synthetic COPY TO STDOUT bytes and tab-separated
 * headers, with real columns. They are not SQL, JSON or pregrouped source records.
 * entry_meta's exported column is id, although the generator selects itemid.
 *
 * Grouped payload follows the independently frozen imports-vndb-driver.ts suite:
 * vn {id, olang}, vn_titles array, entry_meta object with numeric per-entry revision.
 * Validate all known input columns, then retain only the converter's needed
 * columns. Descriptions, image IDs and unused VN columns are discarded, never
 * reconstructed by this adapter. Preserve native entry_meta dates and counters.
 * entry_meta also contains other entry types: skip those, not orphan v IDs.
 * No auxiliary table is needed for the current converter. Use the
 * actual VNDB @rezics/conversion module and its converter_revision by reference.
 * converter below forwards the real converter call by reference, with only the
 * native input envelope framing allowed by imports-vndb-driver.ts. A table page
 * has no API-resolved subject: never fabricate or supply target context. Its
 * unresolved output is one create containing type/labels/aliases/descriptions,
 * with no statements or citations. Native identity and string revision belong
 * in Source.external_id/record_revision; entry_meta.revision remains numeric.
 * Bootstrap metadata is checked directly, without inventing observed facts.
 * locate paths point into actual output, including non-command license metadata.
 * parseProposal uses the real semantic validator, not a test schema. Proposals
 * remain opaque: this file defines no competing public bulk API.
 *
 * All required tables validate before page/conversion/proposal publication.
 * commit promotes only a complete validated run to the comparison baseline;
 * failed runs cannot become disappearances or replace the previous baseline.
 * Skip unrelated tables without parsing or retaining personal data, including
 * spools/logs. Never execute any SQL shipped in the archive.
 *
 * SQLite evidence is installed on every real handle before any statement is
 * prepared, including reopened handles, by the factory's second argument.
 * measure includes nested calls; ANALYZE and bound EXPLAIN QUERY PLAN run outside
 * measurement. All importer relations are growing: reads must SEARCH declared
 * indexes or INTEGER PRIMARY KEY with an equality/range prefix. No scan, automatic
 * index, temporary sort, OFFSET, whole-state enumeration or historical COUNT.
 * Returned rows count actual get/all/iterate consumption, not examined VM rows.
 * Actual returned-row/statement counts and bound EQP prove indexed access;
 * SQLite buffers and physical IO are not measured.
 * Streaming the explicit archive once is O(input bytes), independently asserted.
 * Staging writes equal S, durable bytes <=8*input bytes+4096, buffered rows <=160.
 */
import { Database } from 'bun:sqlite';
import type { VndbDriver } from './imports-vndb-driver.ts';
export type { Path } from './imports-vndb-driver.ts';
export type Converter = VndbDriver;
export interface Entry {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink';
  declaredBytes: number;
  bytes: AsyncIterable<Uint8Array>;
  linkTarget?: string;
}
export interface GroupedRecord {
  vn: { id: string; olang: string };
  vn_titles: Array<{ id: string; lang: string; official: boolean; title: string; latin: string | null }>;
  entry_meta: { id: string; created: string; lastmod: string; revision: number; num_edits: number; num_users: number };
}
export interface Cost {
  statements: number;
  /** Actual rows returned to store code, including consumed iterator rows. */
  rows: number;
  /** Actual staging writes, excluding maintained run counters. */
  rowWrites: number;
  peakBufferedRows: number;
  /** Actual cross-kernel-partition executor calls, including nested calls. */
  crossPartitionStatements: number;
}
export interface Baseline {
  run: string;
  revision: number;
  digest: string;
  converterRevision: string;
}
export interface VndbTablesDriver {
  readonly converter: Converter;
  begin(): Promise<string>;
  stage(run: string, entries: AsyncIterable<Entry>): Promise<void>;
  page(
    run: string,
    after: string | null,
    limit: number,
  ): Promise<{
    records: Array<{ key: string; revision: number; record: GroupedRecord; output: unknown }>;
    next: string | null;
  }>;
  commit(run: string): Promise<void>;
  baseline(key: string): Promise<Baseline | null>;
  inspect(run: string): Promise<{
    state: 'new' | 'staging' | 'ready' | 'failed';
    sourceRecords: number;
    stagedRows: number;
    stagedBytes: number;
    retainedTables: string[];
    proposalEmissions: number;
    publishedProposals: number;
    externalRequests: string[];
    executedDumpStatements: number;
  }>;
  /** Search actual current SQLite logical rows and durable spools/logs for these
   * bytes, outside measurement; do not search deleted SQLite page remnants. */
  retainedMarkers(markers: string[]): Promise<string[]>;
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; cost: Cost }>;
  /**
   * Seed unrelated VN rows/keys in earlier runs of the same VNDB importer tables
   * and storage partition, plus catalogue keys and unrelated historical activity.
   * Do not isolate them in another database/source/partition to evade the probe.
   */
  seed(input: { unrelatedKeys: number; historicalActivity: number }): Promise<void>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}
export const limits = { childRowsPerVn: 8, pageSize: 16 } as const;
export async function loadVndbTablesDriver(): Promise<VndbTablesDriver> {
  const module = process.env.IMPORT_VNDB_TABLES_DRIVER;
  if (!module) throw new Error('IMPORT_VNDB_TABLES_DRIVER is required: bind real VNDB table ingestion');
  const binding = await import(module);
  const evidence = sqliteEvidence();
  const driver: VndbTablesDriver = await binding.createVndbTablesDriver(limits, evidence.attach);
  const measure = driver.measure.bind(driver);
  driver.measure = async (operation) => {
    evidence.start();
    try {
      const result = await measure(operation);
      const measured = evidence.finish();
      return { value: result.value, cost: { ...result.cost, ...measured } };
    } catch (error) {
      evidence.cancel();
      throw error;
    }
  };
  return driver;
}

/** Test support only. The binding must attach EVERY actual SQLite handle before
 * preparing statements. Never attach a substitute database or a shadow store.
 * Transaction boundaries execute through the observed real exec method so native
 * hidden statements cannot escape counting (including nested rollback/release).
 */
export function sqliteEvidence() {
  type Call = { db: Database; sql: string; parameters: unknown[] };
  const handles = new Set<Database>();
  const calls: Call[] = [];
  let active = false;
  let rows = 0;
  let savepoint = 0;
  const requireThat = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`SQLite indexed-key proof: ${message}`);
  };
  function record(db: Database, sql: string, parameters: unknown[]) {
    if (active) calls.push({ db, sql, parameters: structuredClone(parameters) });
  }
  // Preserve quoted semicolons and strip comments; never split SQL on raw ';'.
  function statements(sql: string): string[] {
    const tokens =
      sql.match(
        /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|;|[^'"`\[;/-]+|./g,
      ) ?? [];
    const result: string[] = [];
    let current = '';
    for (const token of tokens) {
      if (token.startsWith('--') || token.startsWith('/*')) current += ' ';
      else if (token === ';') {
        if (current.trim()) result.push(current.trim());
        current = '';
      } else current += token;
    }
    if (current.trim()) result.push(current.trim());
    return result;
  }
  function attach(db: Database) {
    requireThat(db instanceof Database, 'attach the actual bun:sqlite Database');
    requireThat(!active, 'open and attach handles before measurement/ANALYZE');
    if (handles.has(db)) return;
    handles.add(db);
    const seen = new WeakSet<object>();
    for (const method of ['prepare', 'query'] as const) {
      const original = db[method].bind(db);
      Object.defineProperty(db, method, {
        configurable: true,
        value: (...args: Parameters<typeof original>) => {
          const statement = Reflect.apply(original, db, args);
          if (seen.has(statement)) return statement;
          seen.add(statement);
          const initial = (args as unknown[])[1];
          let bound: unknown[] = initial === undefined ? [] : Array.isArray(initial) ? initial : [initial];
          for (const execute of ['get', 'all', 'iterate', 'run', 'values'] as const) {
            const run = statement[execute].bind(statement);
            Object.defineProperty(statement, execute, {
              configurable: true,
              value: (...parameters: unknown[]) => {
                if (parameters.length > 0) bound = parameters;
                const actualParameters = structuredClone(bound);
                if (execute !== 'iterate') record(db, args[0], actualParameters);
                const result = Reflect.apply(run, statement, parameters);
                if (execute === 'iterate') {
                  return (function* () {
                    record(db, args[0], actualParameters);
                    for (const row of result as Iterable<unknown>) {
                      if (active) rows++;
                      yield row;
                    }
                  })();
                }
                if (active && execute === 'get' && result !== null && result !== undefined) rows++;
                if (active && (execute === 'all' || execute === 'values')) rows += (result as unknown[]).length;
                return result;
              },
            });
          }
          return statement;
        },
      });
    }
    for (const method of ['run', 'exec'] as const) {
      const original = db[method].bind(db);
      Object.defineProperty(db, method, {
        configurable: true,
        value: (sql: string, ...parameters: unknown[]) => {
          if (!active) return Reflect.apply(original, db, [sql, ...parameters]);
          let result: unknown;
          for (const statement of statements(sql)) {
            record(db, statement, parameters);
            result = Reflect.apply(original, db, [statement, ...parameters]);
          }
          return result;
        },
      });
    }
    Object.defineProperty(db, 'transaction', {
      configurable: true,
      value: (fn: (...args: unknown[]) => unknown) => {
        requireThat(typeof fn === 'function', 'transaction callback must be a function');
        const wrap = (mode: string) =>
          function (this: unknown, ...args: unknown[]) {
            const nested = db.inTransaction;
            const name = `vndb_measure_${++savepoint}`;
            try {
              db.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode}`);
              const result = fn.apply(this, args);
              db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
              return result;
            } catch (error) {
              if (db.inTransaction) {
                db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
                if (nested) db.exec(`RELEASE ${name}`);
              }
              throw error;
            }
          };
        const wrapped = wrap('DEFERRED');
        return Object.defineProperties(wrapped, {
          default: { value: wrapped },
          deferred: { value: wrap('DEFERRED') },
          immediate: { value: wrap('IMMEDIATE') },
          exclusive: { value: wrap('EXCLUSIVE') },
          database: { value: db },
        });
      },
    });
  }

  function prove({ db, sql, parameters }: Call) {
    requireThat(!/\bOFFSET\b|\bCOUNT\s*\(/i.test(sql), 'OFFSET/history COUNT is forbidden');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(parameters as never[])) as Array<{ detail: string }>;
    const indexes = new Set(
      (db.query("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const { detail } of plan) {
      requireThat(!/\bAUTOMATIC\b|USE TEMP B-TREE/i.test(detail), detail);
      requireThat(!/\bSCAN\b/i.test(detail) || detail === 'SCAN CONSTANT ROW', detail);
      if (/\bSEARCH\b/i.test(detail)) {
        const index = /USING (?:COVERING )?INDEX (\S+)\s+\(/i.exec(detail)?.[1];
        requireThat(/USING INTEGER PRIMARY KEY\s*\(/i.test(detail) || (index && indexes.has(index)), detail);
        requireThat(/\([^)]*(?:=|>|<|BETWEEN)[^)]*\)/i.test(detail), `missing equality/range prefix: ${detail}`);
      }
    }
    // Empty plans are classified explicitly. SELECT/UPDATE/DELETE always went
    // through bound EXPLAIN above; spelling alone never exempts a readable plan.
    if (plan.length === 0) {
      if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) return;
      const insert = /^INSERT(?: OR \w+)? INTO\s+("?[\w]+"?)\s*\(([^)]+)\)\s*VALUES\s*\(/i.exec(sql);
      requireThat(insert && !/\bSELECT\b/i.test(sql), `unclassified empty plan: ${sql}`);
      const table = insert![1]!.replaceAll('"', '');
      const columns = insert![2]!.split(',').map((column) => column.trim().replaceAll('"', ''));
      const primary = (db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; pk: number }>)
        .filter((column) => column.pk > 0)
        .map((column) => column.name);
      requireThat(
        primary.length > 0 && primary.every((column) => columns.includes(column)),
        `INSERT lacks exact primary key: ${sql}`,
      );
    }
  }
  return {
    attach,
    start() {
      requireThat(!active && handles.size > 0, 'a real observed production handle is mandatory');
      calls.length = 0;
      rows = 0;
      // Closed handles are discarded only when a real reopen has replaced them.
      for (const db of handles) {
        try {
          db.exec('ANALYZE');
        } catch (error) {
          if ((error as Error).message.includes('closed')) handles.delete(db);
          else throw error;
        }
      }
      requireThat(handles.size > 0, 'no open production handles');
      active = true;
    },
    finish() {
      active = false;
      requireThat(calls.length > 0, 'operation executed no observed SQL');
      const distinct = new Set<string>();
      for (const call of calls) {
        const key = `${[...handles].indexOf(call.db)}:${call.sql}:${JSON.stringify(call.parameters, (_key, value) => (typeof value === 'bigint' ? { bigint: String(value) } : value))}`;
        if (!distinct.has(key)) prove(call);
        distinct.add(key);
      }
      return { rows, statements: calls.length };
    },
    cancel() {
      active = false;
    },
  };
}
