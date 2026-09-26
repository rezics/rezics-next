import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { canonicalRowText, foldRowCoverage, ownerCatalog, scanOwnerTable,
  type RowCoverage } from './pg-recovery-frontier.ts';

interface AccessOutboxRow {
  id: string;
  kind: string;
  admission_id: string | null;
  scope_id: string | null;
  principal_id: string | null;
  authority_epoch: string;
}

export async function scanAccessOutbox(client: PoolClient): Promise<{ count: string; digest: string }> {
  const digest = createHash('sha256');
  let count = 0n;
  let lastId: string | null = null;
  while (true) {
    const result: QueryResult<AccessOutboxRow> = await client.query<AccessOutboxRow>(
      `SELECT id, kind, admission_id, scope_id, principal_id, authority_epoch FROM access.outbox
       WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 1000`, [lastId]);
    for (const row of result.rows) {
      digest.update(JSON.stringify([row.id, row.kind, row.admission_id,
        row.scope_id, row.principal_id, row.authority_epoch]));
      digest.update('\n');
      count++;
      lastId = row.id;
    }
    if (result.rows.length < 1000) break;
  }
  return { count: count.toString(), digest: digest.digest('hex') };
}

/** Access tables whose rows a dedicated recovery check covers instead of the state digest. */
const ACCESS_DEDICATED = {
  'access.outbox': 'digested separately by the Access outbox coverage',
  'access.recovery_fence': 'recovery control row; capture and release check it directly',
} as const;

export interface AccessStateTables {
  state: RowCoverage;
  catalogDigest: string;
  tables: Record<string, RowCoverage>;
  excluded: Record<string, string>;
}

/**
 * Every table in the Access database, discovered from its catalog. Primary-key
 * order and canonical row text make the digest deterministic at a fixed
 * PostgreSQL major version, collation and schema.
 */
export async function scanAccessTables(client: PoolClient): Promise<AccessStateTables> {
  await canonicalRowText(client);
  const catalog = await ownerCatalog(client, ACCESS_DEDICATED);
  const tables: Record<string, RowCoverage> = {};
  for (const table of catalog.tables) tables[table.name] = await scanOwnerTable(client, table);
  return { state: foldRowCoverage('access-state-v5', catalog, tables),
    catalogDigest: catalog.digest, tables, excluded: { ...catalog.excluded } };
}

/** Canonical private row coverage of every Access table except dedicated ones. */
export async function scanAccessState(client: PoolClient): Promise<RowCoverage> {
  return (await scanAccessTables(client)).state;
}

/** Stable offline digest of the complete Access outbox at one PostgreSQL snapshot. */
export async function accessOutboxCoverage(pool: Pool): Promise<{ count: string; digest: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const coverage = await scanAccessOutbox(client);
    await client.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Stable offline digest of the authority and admission rows at one snapshot. */
export async function accessStateCoverage(pool: Pool): Promise<RowCoverage> {
  return (await accessStateTables(pool)).state;
}

/** Per-table Access coverage and its folded state digest at one snapshot. */
export async function accessStateTables(pool: Pool): Promise<AccessStateTables> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const coverage = await scanAccessTables(client);
    await client.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
