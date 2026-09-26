import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET } from '../work/activate.ts';
import { captureObjectRecoveryCoverage, type ObjectRecoveryStore } from './object-coverage.ts';
import { graphPlacementControl } from './placement.ts';

export class RetentionGcConflict extends Error {}

export interface RetentionGcView {
  id: string;
  kind: 'retention_gc';
  scope: 'product';
  state: 'running' | 'held' | 'reconciled' | 'failed';
  disposition: 'retired' | 'preserved' | null;
  replayed: boolean;
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DIGEST = /^[0-9a-f]{64}$/;

export async function readRetentionGcView(client: PoolClient, id: string,
  replayed: boolean): Promise<RetentionGcView> {
  const found = await client.query<{ state: RetentionGcView['state']; retired: boolean;
    preserved: boolean }>(`SELECT r.state,
      EXISTS (SELECT 1 FROM relay.owner_reconciliation_item i WHERE i.reconciliation_id = r.id
        AND i.disposition = 'retired') AS retired,
      EXISTS (SELECT 1 FROM relay.owner_reconciliation_item i WHERE i.reconciliation_id = r.id
        AND i.disposition = 'preserved') AS preserved
      FROM relay.owner_reconciliation r WHERE r.id = $1 AND r.kind = 'retention_gc'`, [id]);
  const row = found.rows[0];
  if (!row) throw new RetentionGcConflict('retention GC pass is missing');
  return { id, kind: 'retention_gc', scope: 'product', state: row.state,
    disposition: row.retired ? 'retired' : row.preserved ? 'preserved' : null, replayed };
}

/**
 * Only a held, immutable old placement may be collected. Complete anchor and
 * manifest reachability protects exact retained history and preparation pins.
 * Cost is O(Q + B + F log F) for graph refs, object bytes and F local files;
 * no unreferenced file newer than 24 hours is eligible.
 */
export async function reconcileRetentionGc(relay: Pool, fuseki: FusekiClient,
  store: ObjectRecoveryStore, key: string): Promise<RetentionGcView> {
  const operationId = `owner:reconcile:${key}`;
  const requestDigest = sha({ family: 'owner-retention-gc-v1', scope: DATASET });
  const client = await relay.connect();
  let locked = false;
  try {
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [operationId]);
    if (acquired.rows[0]?.locked !== true) throw new RetentionGcConflict('retention GC is running');
    locked = true;
    let row = (await client.query<{ id: string; request_digest: string; state: string }>(
      'SELECT id, request_digest, state FROM relay.owner_reconciliation WHERE operation_id = $1',
      [operationId])).rows[0];
    const replayed = Boolean(row);
    if (row && row.request_digest !== requestDigest) {
      throw new RetentionGcConflict('idempotency key binds another reconciliation');
    }
    if (!row) {
      const id = randomUUID();
      try { await client.query(`INSERT INTO relay.owner_reconciliation
        (id, operation_id, request_digest, kind, scope)
        VALUES ($1,$2,$3,'retention_gc',$4)`, [id, operationId, requestDigest, DATASET]); }
      catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new RetentionGcConflict('another retention GC is running');
        }
        throw error;
      }
      row = { id, request_digest: requestDigest, state: 'running' };
    }
    if (row.state !== 'running') return readRetentionGcView(client, row.id, true);
    const control = await graphPlacementControl(fuseki);
    if (!control.held) throw new RetentionGcConflict('local object GC requires a fenced graph placement');
    const retained = new Set<string>();
    const coverage = await captureObjectRecoveryCoverage(fuseki, store, retained);
    const existing = await client.query<{ ordinal: number; item_ref: string;
      disposition: string }>(`SELECT ordinal, item_ref, disposition
      FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1 ORDER BY ordinal`, [row.id]);
    let nextOrdinal = Math.max(0, ...existing.rows.map(item => item.ordinal)) + 1;
    const recorded = new Map(existing.rows.map(item => [item.item_ref, item]));
    for (const digest of [...retained].sort()) {
      const saved = recorded.get(digest);
      if (saved?.disposition === 'retired') {
        throw new RetentionGcConflict('retired object gained a retained graph reference');
      }
      if (saved) continue;
      await client.query(`INSERT INTO relay.owner_reconciliation_item
        (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
        VALUES ($1,$2,'object','retention_pin',$3,'preserved',$3)`,
      [row.id, nextOrdinal++, digest]);
    }
    const names = (await readdir(store.directory)).filter(name => DIGEST.test(name)).sort();
    const cutoff = Date.now() - 86_400_000;
    for (const digest of names) {
      if (retained.has(digest)) continue;
      const path = join(store.directory, digest);
      const status = await lstat(path);
      if (!status.isFile() || status.mtimeMs > cutoff) continue;
      const saved = recorded.get(digest);
      if (saved && saved.disposition !== 'retired') {
        throw new RetentionGcConflict('retention item disposition differs from local object');
      }
      if (!saved) {
        await client.query(`INSERT INTO relay.owner_reconciliation_item
          (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
          VALUES ($1,$2,'object','payload',$3,'retired',$3)`,
        [row.id, nextOrdinal++, digest]);
      }
      await unlink(path);
    }
    const after = await captureObjectRecoveryCoverage(fuseki, store);
    if (JSON.stringify(after) !== JSON.stringify(coverage)
      || !(await graphPlacementControl(fuseki)).held) {
      throw new RetentionGcConflict('retained graph or object coverage moved during GC');
    }
    const items = await client.query<{ item_ref: string; disposition: string }>(
      `SELECT item_ref, disposition FROM relay.owner_reconciliation_item
       WHERE reconciliation_id = $1 ORDER BY ordinal`, [row.id]);
    const outcome = sha({ coverage, items: items.rows });
    await client.query('BEGIN');
    try {
      for (const owner of ['graph', 'object']) {
        await client.query(`INSERT INTO relay.owner_reconciliation_cut
          (reconciliation_id, owner, data_epoch, sequence, coverage_digest, status)
          VALUES ($1,$2,$3,$4,$5,'matched')`, [row.id, owner,
          control.dataEpoch, control.sequence, owner === 'object'
            ? coverage.objectDigest : coverage.anchorDigest]);
      }
      await client.query(`UPDATE relay.owner_reconciliation SET state = 'reconciled',
        outcome_digest = $2, completed_at = clock_timestamp() WHERE id = $1`,
      [row.id, outcome]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    return readRetentionGcView(client, row.id, replayed);
  } finally {
    try { if (locked) await client.query(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))', [operationId]); }
    finally { client.release(); }
  }
}
