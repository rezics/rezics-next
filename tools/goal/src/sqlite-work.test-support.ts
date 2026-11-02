import type { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Read counters from Bun's own SQLite through the extension API, never a second SQLite library or a replay.
const source = `#include <sqlite3ext.h>
#include <string.h>
SQLITE_EXTENSION_INIT1
static void work(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const char *sql = (const char *)sqlite3_value_text(argv[0]);
  int reset = sqlite3_value_int(argv[1]), counters[4] = {0};
  int ops[4] = {SQLITE_STMTSTATUS_RUN, SQLITE_STMTSTATUS_VM_STEP,
    SQLITE_STMTSTATUS_FULLSCAN_STEP, SQLITE_STMTSTATUS_SORT};
  for (sqlite3_stmt *s = sqlite3_next_stmt(db, 0); s; s = sqlite3_next_stmt(db, s)) {
    if (!sqlite3_sql(s) || strcmp(sqlite3_sql(s), sql)) continue;
    for (int i = 0; i < 4; i++) counters[i] += sqlite3_stmt_status(s, ops[i], reset);
  }
  char *json = sqlite3_mprintf("{\\"runs\\":%d,\\"vmSteps\\":%d,\\"fullscanSteps\\":%d,\\"sorts\\":%d}",
    counters[0], counters[1], counters[2], counters[3]);
  sqlite3_result_text(ctx, json, -1, sqlite3_free);
}
int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  return sqlite3_create_function(db, "goal_statement_work", 2, SQLITE_UTF8, 0, work, 0, 0);
}`;

export type SqliteWork = { sql: string; runs: number; vmSteps: number; fullscanSteps: number; sorts: number };

/** Compiler/header absence fails the owning group; unavailable index-row visits are explicitly null. */
export function observeSqliteWork(db: Database, directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'work');
  writeFileSync(`${path}.c`, source);
  const build = Bun.spawnSync(['cc', '-shared', '-fPIC', '-O2', '-o', `${path}.so`, `${path}.c`]);
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  db.loadExtension(`${path}.so`);
  const original = db.query;
  const query = original.bind(db);
  const counter = query<{ work: string }, [string, number]>('SELECT goal_statement_work(?, ?) AS work');
  const engine = query('SELECT sqlite_version() AS version, sqlite_source_id() AS source').get();
  const rows: SqliteWork[] = [];
  db.query = ((sql: string) => {
    const statement = query(sql);
    if (!/^\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:SELECT|PRAGMA)\b/i.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, key) {
        const method = Reflect.get(target, key, target);
        if (!['all', 'get', 'run', 'values'].includes(String(key)))
          return typeof method === 'function' ? method.bind(target) : method;
        return (...args: unknown[]) => {
          counter.get(sql, 1);
          const result = Reflect.apply(method, target, args);
          rows.push({ sql, ...JSON.parse(counter.get(sql, 1)!.work) });
          return result;
        };
      },
    });
  }) as typeof db.query;
  return {
    drain(label: string): SqliteWork[] {
      const work = rows.splice(0);
      console.log(
        JSON.stringify({
          label,
          engine,
          indexedRowVisits: null,
          attribution: 'stmt_status on actual Bun statements; index row visits unavailable through extension API',
          work,
        }),
      );
      return work;
    },
    restore() {
      db.query = original;
    },
  };
}
