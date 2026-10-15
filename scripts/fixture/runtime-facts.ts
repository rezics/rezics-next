import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Physical PostgreSQL copies execute with the host's native libc and server.
 * Keep this outside source keys: drift is a repairable runtime refusal with an
 * explicit reason, rather than an unexplained different corpus key. */
export interface RetainedRuntimeFacts {
  postgres: string;
  collation: string;
}

export function retainedRuntimeFacts(): RetainedRuntimeFacts {
  const read = (command: string, args: string[]) => execFileSync(command, args,
    { encoding: 'utf8', timeout: 2_000 }).trim();
  return { postgres: read('pg_config', ['--version']), collation: read('getconf', ['GNU_LIBC_VERSION']) };
}

export function retainedRuntimeDifferences(recorded: RetainedRuntimeFacts | undefined,
  host: RetainedRuntimeFacts): string[] {
  if (!recorded) return ['recorded PostgreSQL/collation runtime is missing'];
  return (['postgres', 'collation'] as const).flatMap(field => recorded[field] === host[field] ? []
    : [`${field} drift: recorded ${recorded[field] ?? 'missing'}, host ${host[field]}`]);
}

export const POSTGRES_COLLATION_FILE = 'postgres-collations.json';
export type RetainedCollation = { database: string; version: string | null };
export async function readRetainedPostgresCollations(
  query: (sql: string) => Promise<{ rows: RetainedCollation[] }>): Promise<RetainedCollation[]> {
  return (await query(`SELECT datname AS database, datcollversion AS version
    FROM pg_database WHERE datlocprovider = 'c' ORDER BY datname`)).rows;
}
export async function recordRetainedPostgresCollations(directory: string,
  query: (sql: string) => Promise<{ rows: RetainedCollation[] }>): Promise<void> {
  writeFileSync(join(directory, POSTGRES_COLLATION_FILE), JSON.stringify(await readRetainedPostgresCollations(query)) + '\n', { mode: 0o600 });
}

export function retainedCollationDifferences(path: string, host: RetainedRuntimeFacts): string[] {
  return retainedDatabaseCollationDifferences(JSON.parse(readFileSync(path, 'utf8')) as RetainedCollation[], host);
}

export function retainedDatabaseCollationDifferences(rows: RetainedCollation[], host: RetainedRuntimeFacts): string[] {
  if (!Array.isArray(rows)) return ['PostgreSQL collation inventory is invalid'];
  const version = host.collation.replace(/^glibc\s+/, '');
  return rows.flatMap(row => row.version === null || row.version === version ? []
    : [`collation drift: database ${row.database}, recorded ${row.version}, host ${version}`]);
}
