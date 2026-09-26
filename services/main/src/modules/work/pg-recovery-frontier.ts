import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

export class PgRecoveryFrontierConflict extends Error {}

export interface PgRecoveryFrontier {
  systemIdentifier: string;
  flushedLsn: string;
  walFile: string;
}

/** Capture only after the owner is quiesced; store this outside its PostgreSQL backup. */
export async function capturePgRecoveryFrontier(pool: Pool): Promise<PgRecoveryFrontier> {
  const result = await pool.query<{ system_identifier: string; flushed_lsn: string; wal_file: string }>(
    `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
       pg_current_wal_flush_lsn()::text AS flushed_lsn,
       pg_walfile_name(pg_current_wal_flush_lsn()) AS wal_file`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row
    || !/^[0-9]+$/.test(row.system_identifier)
    || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(row.flushed_lsn)
    || !/^[0-9A-F]{24}$/i.test(row.wal_file)) {
    throw new PgRecoveryFrontierConflict('PostgreSQL source frontier is unavailable');
  }
  return { systemIdentifier: row.system_identifier,
    flushedLsn: row.flushed_lsn, walFile: row.wal_file };
}

/** A promoted isolated restore must have replayed through the recorded source LSN. */
export async function assertPgRecoveryFrontier(pool: Pool, frontier: PgRecoveryFrontier): Promise<void> {
  if (!/^[0-9]+$/.test(frontier?.systemIdentifier ?? '')
    || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(frontier?.flushedLsn ?? '')
    || !/^[0-9A-F]{24}$/i.test(frontier?.walFile ?? '')) {
    throw new PgRecoveryFrontierConflict('invalid PostgreSQL recovery frontier');
  }
  const result = await pool.query<{ system_identifier: string; recovering: boolean;
    replay_lsn: string | null; covered: boolean | null }>(
    `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
       pg_is_in_recovery() AS recovering,
       pg_last_wal_replay_lsn()::text AS replay_lsn,
       pg_last_wal_replay_lsn() >= $1::pg_lsn AS covered`, [frontier.flushedLsn]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.system_identifier !== frontier.systemIdentifier
    || row.recovering || !row.replay_lsn || row.covered !== true) {
    throw new PgRecoveryFrontierConflict('PostgreSQL restore did not reach retained WAL frontier');
  }
}

export class OwnerCoverageConflict extends Error {}

/** One recovered owner table; `key` is its primary key in index order. */
export interface OwnerTable {
  name: string;
  schema: string;
  table: string;
  key: readonly string[];
  keyTypes: readonly string[];
  columns: readonly string[];
}

/** Catalog-derived table set of one owner database at one snapshot. */
export interface OwnerCatalog {
  tables: readonly OwnerTable[];
  excluded: Readonly<Record<string, string>>;
  digest: string;
}

export interface RowCoverage { count: string; digest: string }

const PAGE = 128;
const MARKER = /^recovery-coverage:/;
const EXCLUSION = /^recovery-coverage: exclude (\S.*)$/;

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Row text must not depend on role, database or client output defaults. */
export async function canonicalRowText(client: PoolClient): Promise<void> {
  await client.query(`SELECT set_config('TimeZone', 'UTC', true),
    set_config('DateStyle', 'ISO, YMD', true), set_config('IntervalStyle', 'postgres', true),
    set_config('bytea_output', 'hex', true), set_config('extra_float_digits', '1', true)`);
}

/**
 * Every ordinary or partitioned table outside PostgreSQL's own schemas, in byte
 * order. A table is excluded only by the caller's dedicated coverage, a
 * `recovery-coverage: exclude <reason>` line in its comment or unlogged storage,
 * which physical backups do not retain. Any other table without a primary key
 * fails closed.
 */
export async function ownerCatalog(client: PoolClient,
  dedicated: Readonly<Record<string, string>> = {}): Promise<OwnerCatalog> {
  const result = await client.query<{ schema: string; table: string; persistence: string;
    comment: string | null; key: string[]; key_types: string[]; columns: string[] }>(
    `SELECT n.nspname::text AS schema, c.relname::text AS table, c.relpersistence::text AS persistence,
       obj_description(c.oid, 'pg_class') AS comment,
       COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ord)
         FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE i.indrelid = c.oid AND i.indisprimary AND k.ord <= i.indnkeyatts), '{}') AS key,
       COALESCE((SELECT array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY k.ord)
         FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
         WHERE i.indrelid = c.oid AND i.indisprimary AND k.ord <= i.indnkeyatts), '{}') AS key_types,
       COALESCE((SELECT array_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod)
           ORDER BY a.attname COLLATE "C")
         FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
         '{}') AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
         AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`);
  const tables: OwnerTable[] = [];
  const excluded: Record<string, string> = {};
  for (const row of result.rows) {
    const name = `${row.schema}.${row.table}`;
    const marked = (row.comment ?? '').split('\n').filter(line => MARKER.test(line));
    const reason = marked.map(line => EXCLUSION.exec(line)?.[1]?.trim());
    if (reason.some(item => !item) || marked.length > 1) {
      throw new OwnerCoverageConflict(`recovery-coverage comment is malformed: ${name}`);
    }
    const exclusion = dedicated[name] ?? reason[0]
      ?? (row.persistence === 'u' ? 'unlogged; physical backups do not retain its rows' : undefined);
    if (exclusion) { excluded[name] = exclusion; continue; }
    if (!row.key.length || row.key.length !== row.key_types.length) {
      throw new OwnerCoverageConflict(`recovery coverage requires a primary key: ${name}`);
    }
    tables.push({ name, schema: row.schema, table: row.table, key: row.key,
      keyTypes: row.key_types, columns: row.columns });
  }
  const digest = createHash('sha256').update(JSON.stringify({
    tables: tables.map(table => [table.name, table.key, table.keyTypes, table.columns]),
    excluded: Object.entries(excluded) })).digest('hex');
  return { tables, excluded, digest };
}

/**
 * Digest every row in primary-key order. Each page resumes after the last key
 * with a row comparison, so the primary-key index serves the whole scan once.
 */
export async function scanOwnerTable(client: PoolClient, table: OwnerTable,
  inspect?: (key: readonly string[], body: string) => void): Promise<RowCoverage> {
  const columns = table.key.map(column => `t.${ident(column)}`);
  const select = `SELECT ${columns.map((column, index) => `${column}::text AS k${index}`).join(', ')},
    to_jsonb(t)::text AS body FROM ${ident(table.schema)}.${ident(table.table)} AS t`;
  const order = `ORDER BY ${columns.join(', ')} LIMIT ${PAGE}`;
  const resume = `${select} WHERE (${columns.join(', ')}) > (${table.keyTypes
    .map((type, index) => `$${index + 1}::${type}`).join(', ')}) ${order}`;
  const hash = createHash('sha256');
  let count = 0n;
  let after: string[] | null = null;
  for (;;) {
    const page: QueryResult<Record<string, string>> = await client.query<Record<string, string>>(
      after ? resume : `${select} ${order}`, after ?? []);
    for (const row of page.rows) {
      const key = table.key.map((_, index) => row[`k${index}`]!);
      inspect?.(key, row.body!);
      hash.update(JSON.stringify([key, row.body])).update('\n');
      count++;
      after = key;
    }
    if (page.rows.length < PAGE) break;
  }
  return { count: count.toString(), digest: hash.digest('hex') };
}

/** One count and digest over a catalog and its per-table row coverage. */
export function foldRowCoverage(label: string, catalog: OwnerCatalog,
  tables: Readonly<Record<string, RowCoverage>>): RowCoverage {
  const hash = createHash('sha256').update(JSON.stringify([label, catalog.digest])).update('\n');
  let count = 0n;
  for (const table of catalog.tables) {
    const coverage = tables[table.name];
    if (!coverage) throw new OwnerCoverageConflict(`owner table coverage is missing: ${table.name}`);
    hash.update(JSON.stringify([table.name, coverage.count, coverage.digest])).update('\n');
    count += BigInt(coverage.count);
  }
  return { count: count.toString(), digest: hash.digest('hex') };
}
