import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

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

/** Canonical private row coverage at a fixed PostgreSQL version and UTC session. */
export async function scanAccessState(client: PoolClient): Promise<{ count: string; digest: string }> {
  const digest = createHash('sha256');
  let count = 0n;
  const tables = [
    { name: 'principal', key: 'id', cast: 'uuid' },
    { name: 'authority_subject', key: 'id', cast: 'text' },
    { name: 'scope_gate', key: 'id', cast: 'text' },
    { name: 'representation', key: 'id', cast: 'uuid' },
    { name: 'permission_grant', key: 'id', cast: 'uuid' },
    { name: 'admission', key: 'id', cast: 'uuid' },
    { name: 'admission_receipt', key: 'admission_id', cast: 'uuid' },
  ] as const;
  for (const table of tables) {
    let lastId: string | null = null;
    while (true) {
      const result: QueryResult<{ cursor: string; body: string }> =
        await client.query<{ cursor: string; body: string }>(
          `SELECT t.${table.key}::text AS cursor, to_jsonb(t)::text AS body
           FROM access.${table.name} AS t
           WHERE ($1::${table.cast} IS NULL OR t.${table.key} > $1::${table.cast})
           ORDER BY t.${table.key} LIMIT 1000`, [lastId]);
      for (const row of result.rows) {
        digest.update(JSON.stringify([table.name, row.cursor, row.body]));
        digest.update('\n');
        count++;
        lastId = row.cursor;
      }
      if (result.rows.length < 1000) break;
    }
  }
  return { count: count.toString(), digest: digest.digest('hex') };
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
export async function accessStateCoverage(pool: Pool): Promise<{ count: string; digest: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const coverage = await scanAccessState(client);
    await client.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}
