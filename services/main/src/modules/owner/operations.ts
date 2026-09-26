import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readExactWorkRevision, RevisionCorrupt, RevisionNotFound, RevisionUnavailable }
  from '../work/history.ts';
import type { OwnerReconciliationRow, OwnerRelocationRow } from './schema.ts';

export class OwnerOperationConflict extends Error {}
export class OwnerOperationBusy extends Error {}
export class OwnerOperationMissing extends Error {}
export class OwnerOperationInvalid extends Error {}

export interface RevisionReconciliationInput { revision: string }
export interface RelocationStageInput {
  owner: 'graph' | 'content' | 'object';
  datasetId: string;
  sourceLocation: string;
  targetLocation: string;
  sourceRoutingEpoch: string;
}
export interface ReconciliationView {
  id: string; kind: 'revision_recovery'; revision: string;
  state: 'running' | 'held' | 'reconciled' | 'failed';
  disposition: 'matched' | 'unavailable' | 'corrupt' | null;
  replayed: boolean;
}
export interface RelocationView {
  id: string; owner: RelocationStageInput['owner']; datasetId: string;
  state: OwnerRelocationRow['state']; replayed: boolean;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * One indexed relay lookup, one bounded Work anchor lookup and at most four
 * immutable object attempts (S3 then filesystem fallback) per revision pass.
 * An advisory lock serializes one
 * operation key without holding a SQL transaction across Fuseki/object I/O.
 * A crashed running pass is retried with the same key; settled passes are
 * immutable and a later repair needs a new key.
 */
export class OwnerOperations {
  constructor(private readonly relay: Pool, private readonly environment: WorkActivationEnvironment) {}

  private async lock(client: PoolClient, operationId: string): Promise<void> {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [operationId]);
    if (result.rows[0]?.locked !== true) throw new OwnerOperationBusy('owner operation is running');
  }

  private async unlock(client: PoolClient, operationId: string): Promise<void> {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [operationId]);
  }

  private async reconciliation(client: PoolClient, id: string, replayed: boolean): Promise<ReconciliationView> {
    const record = await client.query<Pick<OwnerReconciliationRow, 'id' | 'kind' | 'scope' | 'state'>>(
      'SELECT id, kind, scope, state FROM relay.owner_reconciliation WHERE id = $1', [id]);
    const row = record.rows[0];
    if (!row || row.kind !== 'revision_recovery') throw new OwnerOperationMissing('reconciliation is missing');
    const finding = await client.query<{ disposition: ReconciliationView['disposition'] }>(
      `SELECT disposition FROM relay.owner_reconciliation_item
       WHERE reconciliation_id = $1 ORDER BY ordinal LIMIT 1`, [id]);
    return { id: row.id, kind: 'revision_recovery', revision: row.scope, state: row.state,
      disposition: finding.rows[0]?.disposition ?? null, replayed };
  }

  async readReconciliation(id: string): Promise<ReconciliationView> {
    const client = await this.relay.connect();
    try { return await this.reconciliation(client, id, true); }
    finally { client.release(); }
  }

  async reconcileRevision(input: RevisionReconciliationInput, key: string): Promise<ReconciliationView> {
    const operationId = `owner:reconcile:${key}`;
    const requestDigest = digest({ family: 'owner-revision-recovery-v1', ...input });
    const client = await this.relay.connect();
    let locked = false;
    try {
      await this.lock(client, operationId);
      locked = true;
      let row = (await client.query<Pick<OwnerReconciliationRow,
        'id' | 'request_digest' | 'state'>>(
        'SELECT id, request_digest, state FROM relay.owner_reconciliation WHERE operation_id = $1',
        [operationId])).rows[0];
      const replayed = Boolean(row);
      if (row && row.request_digest !== requestDigest) {
        throw new OwnerOperationConflict('idempotency key binds another reconciliation');
      }
      if (!row) {
        const id = randomUUID();
        try {
          await client.query(`INSERT INTO relay.owner_reconciliation
            (id, operation_id, request_digest, kind, scope) VALUES ($1,$2,$3,'revision_recovery',$4)`,
          [id, operationId, requestDigest, input.revision]);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new OwnerOperationBusy('revision reconciliation is running');
          }
          throw error;
        }
        row = { id, request_digest: requestDigest, state: 'running' };
      }
      if (row.state !== 'running') return await this.reconciliation(client, row.id, true);
      let disposition: 'matched' | 'unavailable' | 'corrupt';
      let evidence: string | null = null;
      let position: { dataEpoch: string; sequence: string } | null = null;
      let findingOwner: 'graph' | 'object' = 'graph';
      let findingKind: 'anchor' | 'payload' | 'revision' = 'revision';
      try {
        const exact = await readExactWorkRevision(this.environment, input.revision, async () => true);
        disposition = 'matched';
        findingKind = 'anchor';
        evidence = digest(exact);
        position = exact.sourcePosition;
      } catch (error) {
        if (error instanceof RevisionCorrupt) disposition = 'corrupt';
        else if (error instanceof RevisionNotFound) {
          disposition = 'unavailable';
          findingKind = 'anchor';
        } else if (error instanceof RevisionUnavailable) {
          disposition = 'unavailable';
          findingOwner = 'object';
          findingKind = 'payload';
        } else throw error;
      }
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO relay.owner_reconciliation_item
          (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
          VALUES ($1,1,$2,$3,$4,$5,$6)`, [row.id,
          findingOwner, findingKind,
          input.revision, disposition, evidence]);
        if (position && evidence) {
          await client.query(`INSERT INTO relay.owner_reconciliation_cut
            (reconciliation_id, owner, data_epoch, sequence, coverage_digest, status)
            VALUES ($1,'graph',$2,$3,$4,'matched')`,
          [row.id, position.dataEpoch, position.sequence, evidence]);
        }
        await client.query(`UPDATE relay.owner_reconciliation SET state = $2,
          hold_reason = $3, outcome_digest = $4, completed_at = $5 WHERE id = $1`,
        [row.id, disposition === 'matched' ? 'reconciled' : 'held',
          disposition === 'matched' ? null : `exact_revision_${disposition}`,
          evidence, disposition === 'matched' ? new Date() : null]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      return await this.reconciliation(client, row.id, replayed);
    } finally {
      try { if (locked) await this.unlock(client, operationId); }
      finally { client.release(); }
    }
  }

  /**
   * Stage only: a caller cannot assert copied bytes or activate routing.
   * One unique-index insert plus one operation-key read; no dataset scan.
   */
  async stageRelocation(input: RelocationStageInput, key: string): Promise<RelocationView> {
    if (input.sourceLocation === input.targetLocation) {
      throw new OwnerOperationInvalid('source and target locations must differ');
    }
    const operationId = `owner:relocate:${key}`;
    const requestDigest = digest({ family: 'owner-relocation-stage-v1', ...input });
    const id = randomUUID();
    let replayed = false;
    try {
      const result = await this.relay.query(`INSERT INTO relay.owner_relocation
        (id, operation_id, request_digest, owner, dataset_id, source_location,
         target_location, source_routing_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (operation_id) DO NOTHING`,
      [id, operationId, requestDigest, input.owner, input.datasetId, input.sourceLocation,
        input.targetLocation, input.sourceRoutingEpoch]);
      replayed = result.rowCount === 0;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new OwnerOperationBusy('owner dataset already has an active relocation');
      }
      throw error;
    }
    const found = await this.relay.query<Pick<OwnerRelocationRow,
      'id' | 'request_digest' | 'owner' | 'dataset_id' | 'state'>>(
      `SELECT id, request_digest, owner, dataset_id, state FROM relay.owner_relocation
       WHERE operation_id = $1`, [operationId]);
    const row = found.rows[0];
    if (!row) throw new OwnerOperationMissing('staged relocation is missing');
    if (row.request_digest !== requestDigest) throw new OwnerOperationConflict('idempotency key binds another move');
    return { id: row.id, owner: row.owner, datasetId: row.dataset_id, state: row.state, replayed };
  }

  async readRelocation(id: string): Promise<RelocationView> {
    const found = await this.relay.query<Pick<OwnerRelocationRow,
      'id' | 'owner' | 'dataset_id' | 'state'>>(
      'SELECT id, owner, dataset_id, state FROM relay.owner_relocation WHERE id = $1', [id]);
    const row = found.rows[0];
    if (!row) throw new OwnerOperationMissing('relocation is missing');
    return { id: row.id, owner: row.owner, datasetId: row.dataset_id,
      state: row.state, replayed: true };
  }
}
