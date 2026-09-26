import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Pool as PgPool } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import type { ObjectRecoveryStore } from './object-coverage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readExactWorkRevision, RevisionCorrupt, RevisionNotFound, RevisionUnavailable }
  from '../work/history.ts';
import { releaseRestoredGraphHold, RestoreLineageConflict, type RecoveryCoverage }
  from '../work/restore-lineage.ts';
import type { OwnerReconciliationRow, OwnerRelocationRow } from './schema.ts';

export class OwnerOperationConflict extends Error {}
export class OwnerOperationBusy extends Error {}
export class OwnerOperationMissing extends Error {}
export class OwnerOperationInvalid extends Error {}
export class OwnerOperationUnavailable extends Error {}

export interface RevisionReconciliationInput { revision: string }
export interface RelocationStageInput {
  owner: 'graph' | 'content' | 'object';
  datasetId: string;
  sourceLocation: string;
  targetLocation: string;
  sourceRoutingEpoch: string;
}
export interface RevisionReconciliationView {
  id: string; kind: 'revision_recovery'; revision: string;
  state: 'running' | 'held' | 'reconciled' | 'failed';
  disposition: 'matched' | 'unavailable' | 'corrupt' | null;
  replayed: boolean;
}
export interface RestoreReconciliationView {
  id: string; kind: 'restore'; scope: 'product';
  state: 'running' | 'held' | 'reconciled' | 'failed';
  disposition: 'matched' | 'conflict' | 'unavailable' | 'corrupt' | null;
  replayed: boolean;
}
export type ReconciliationView = RevisionReconciliationView | RestoreReconciliationView;
export interface RestoreResources {
  accountPool: Pool;
  accessPool: Pool;
  contentPool: Pool;
  hmacKey: string;
  objectStore: ObjectRecoveryStore;
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
  constructor(private readonly relay: Pool, private readonly environment: WorkActivationEnvironment,
    private readonly restoreResources?: RestoreResources) {}

  private configuredWorkObjects(): ImmutableObjects | undefined {
    if (this.environment.workObjects) return this.environment.workObjects;
    const endpoint = Bun.env.MAIN_S3_ENDPOINT;
    if (!endpoint) return undefined;
    const bucket = Bun.env.MAIN_S3_BUCKET;
    const region = Bun.env.MAIN_S3_REGION;
    const accessKeyId = Bun.env.MAIN_S3_ACCESS_KEY;
    const secretAccessKey = Bun.env.MAIN_S3_SECRET_KEY;
    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      throw new OwnerOperationUnavailable('immutable Work object credentials are unavailable');
    }
    return new S3ImmutableObjects({ endpoint, bucket, region, accessKeyId,
      secretAccessKey, prefix: 'semantic/work/' });
  }

  /** Operator principal lookup while the ordinary Access recovery fence is held. */
  async activeFencedOperator(principal: VerifiedPrincipal): Promise<boolean> {
    const pool = this.restoreResources?.accessPool ?? (Bun.env.ACCESS_DATABASE_URL
      ? new PgPool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 1 }) : undefined);
    if (!pool) throw new OwnerOperationUnavailable('restored Access owner is unavailable');
    try {
      const result = await pool.query<{ id: string }>(
        `SELECT p.id FROM access.principal p CROSS JOIN access.recovery_fence f
         WHERE f.id = true AND f.open = false AND p.account_issuer = $1
           AND p.account_subject = $2 AND p.active`, [principal.issuer, principal.subject]);
      return result.rowCount === 1;
    } finally { if (!this.restoreResources) await pool.end(); }
  }

  private restoreInputs(): { resources: RestoreResources; close: () => Promise<void> } {
    if (this.restoreResources) return { resources: this.restoreResources, close: async () => {} };
    const account = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
    const access = Bun.env.ACCESS_DATABASE_URL;
    const content = Bun.env.CONTENT_DATABASE_URL;
    const hmacKey = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
    if (!account || !access || !content || !hmacKey) {
      throw new OwnerOperationUnavailable('restore owner credentials or recovery key are unavailable');
    }
    const workObjects = this.configuredWorkObjects();
    const pools = [new PgPool({ connectionString: account, max: 1 }),
      new PgPool({ connectionString: access, max: 1 }),
      new PgPool({ connectionString: content, max: 1 })];
    return { resources: { accountPool: pools[0]!, accessPool: pools[1]!,
      contentPool: pools[2]!, hmacKey,
      objectStore: { directory: this.environment.objectDirectory,
        ...(workObjects ? { workObjects } : {}) } },
    close: async () => { await Promise.all(pools.map(pool => pool.end())); } };
  }

  /**
   * One full signed owner-cut comparison per pass. A crash after release and
   * before the relay outcome is safe to retry: release has a graph receipt.
   * The scans are O(owner rows + graph quads + referenced object bytes), with
   * bounded owner-table pages and the graph query deadline enforced below.
   */
  async reconcileRestore(input: { sealedCoverage: string; sealedDeletionSets: readonly string[] },
    key: string): Promise<RestoreReconciliationView> {
    const { resources, close } = this.restoreInputs();
    try {
      let coverage: RecoveryCoverage;
      try { coverage = openRecoveryPayload<RecoveryCoverage>(
        input.sealedCoverage, resources.hmacKey, 'graph-recovery-coverage'); }
      catch { throw new OwnerOperationInvalid('signed restore coverage is invalid'); }
      if (!coverage?.objects || !coverage.content || !coverage.relay?.consumer) {
        throw new OwnerOperationInvalid('signed restore coverage lacks owner evidence');
      }
      const operationId = `owner:reconcile:${key}`;
      const requestDigest = digest({ family: 'owner-restore-v1', ...input });
      const client = await this.relay.connect();
      let locked = false;
      try {
        await this.lock(client, operationId);
        locked = true;
        let row = (await client.query<Pick<OwnerReconciliationRow, 'id' | 'request_digest' | 'state'>>(
          'SELECT id, request_digest, state FROM relay.owner_reconciliation WHERE operation_id = $1',
          [operationId])).rows[0];
        const replayed = Boolean(row);
        if (row && row.request_digest !== requestDigest) {
          throw new OwnerOperationConflict('idempotency key binds another reconciliation');
        }
        if (!row) {
          const id = randomUUID();
          try { await client.query(`INSERT INTO relay.owner_reconciliation
            (id, operation_id, request_digest, kind, scope, consumer)
            VALUES ($1,$2,$3,'restore','product',$4)`,
          [id, operationId, requestDigest, coverage.relay.consumer]); }
          catch (error) {
            if ((error as { code?: string }).code === '23505') {
              throw new OwnerOperationBusy('restore reconciliation is running');
            }
            throw error;
          }
          row = { id, request_digest: requestDigest, state: 'running' };
        }
        if (row.state !== 'running') return await this.reconciliation(client, row.id, true) as RestoreReconciliationView;
        const retained = await client.query<{ generation: string }>(
          'SELECT generation::text FROM relay.recovery_coverage_head WHERE consumer = $1',
          [coverage.relay.consumer]);
        const generation = retained.rows[0]?.generation ?? null;
        let conflict: RestoreLineageConflict | undefined;
        try {
          await releaseRestoredGraphHold(this.environment.fuseki, resources.accessPool,
            this.relay, this.environment.lineage, { sealedCoverage: input.sealedCoverage,
              hmacKey: resources.hmacKey, accountPool: resources.accountPool,
              contentPool: resources.contentPool, objectStore: resources.objectStore,
              deletions: { accountPool: resources.accountPool, hmacKey: resources.hmacKey,
                sealedSets: input.sealedDeletionSets } });
        } catch (error) {
          if (!(error instanceof RestoreLineageConflict)) throw error;
          conflict = error;
        }
        await client.query('BEGIN');
        try {
          if (conflict) {
            const owner = /Account/.test(conflict.message) ? 'account'
              : /Access/.test(conflict.message) ? 'access'
              : /Content/.test(conflict.message) ? 'content'
              : /relay|handoff|coverage head/i.test(conflict.message) ? 'relay'
              : /object/i.test(conflict.message) ? 'object' : 'graph';
            await client.query(`INSERT INTO relay.owner_reconciliation_item
              (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition)
              VALUES ($1,1,$2,'receipt','urn:rezics:dataset:product',$3)`,
            [row.id, owner, /unavailable|missing/i.test(conflict.message) ? 'unavailable'
              : /corrupt/i.test(conflict.message) ? 'corrupt' : 'conflict']);
            await client.query(`UPDATE relay.owner_reconciliation SET state = 'held',
              hold_reason = $2 WHERE id = $1`, [row.id, conflict.message.slice(0, 500)]);
          } else {
            const verified = await client.query<{ generation: string }>(
              'SELECT generation::text FROM relay.recovery_coverage_head WHERE consumer = $1',
              [coverage.relay.consumer]);
            if (!generation || verified.rows[0]?.generation !== generation) {
              throw new OwnerOperationBusy('retained recovery coverage moved during reconciliation');
            }
            const cuts = [
              ['account', null, null, coverage.account.rowDigest,
                coverage.accountPg.systemIdentifier, coverage.accountPg.flushedLsn],
              ['access', null, null, coverage.accessStateDigest, null, null],
              ['content', coverage.content.dataEpoch, coverage.content.sequence,
                digest(coverage.content), null, null],
              ['graph', coverage.priorDataEpoch, coverage.priorSequence,
                digest([coverage.priorDataEpoch, coverage.priorSequence]), null, null],
              ['object', null, null, coverage.objects.objectDigest, null, null],
              ['relay', coverage.relay.dataEpoch, coverage.relay.sequence,
                coverage.relay.batchDigest, null, null],
            ] as const;
            for (const [owner, epoch, sequence, coverageDigest, cluster, lsn] of cuts) {
              await client.query(`INSERT INTO relay.owner_reconciliation_cut
                (reconciliation_id, owner, data_epoch, sequence, coverage_digest, cluster_id,
                 wal_lsn, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'matched')`,
              [row.id, owner, epoch, sequence, coverageDigest, cluster, lsn]);
            }
            const outcome = digest(coverage);
            await client.query(`INSERT INTO relay.owner_reconciliation_item
              (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
              VALUES ($1,1,'graph','receipt','urn:rezics:dataset:product','matched',$2)`,
            [row.id, outcome]);
            await client.query(`UPDATE relay.owner_reconciliation SET state = 'reconciled',
              coverage_generation = $2, outcome_digest = $3, completed_at = clock_timestamp()
              WHERE id = $1`, [row.id, generation, outcome]);
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        return await this.reconciliation(client, row.id, replayed) as RestoreReconciliationView;
      } finally {
        try { if (locked) await this.unlock(client, operationId); }
        finally { client.release(); }
      }
    } finally { await close(); }
  }

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
    if (!row || (row.kind !== 'revision_recovery' && row.kind !== 'restore')) {
      throw new OwnerOperationMissing('reconciliation is missing');
    }
    const finding = await client.query<{ disposition: string }>(
      `SELECT disposition FROM relay.owner_reconciliation_item
       WHERE reconciliation_id = $1 ORDER BY ordinal LIMIT 1`, [id]);
    if (row.kind === 'restore') return { id: row.id, kind: 'restore', scope: 'product',
      state: row.state, disposition: (finding.rows[0]?.disposition ?? null) as
        RestoreReconciliationView['disposition'], replayed };
    return { id: row.id, kind: 'revision_recovery', revision: row.scope, state: row.state,
      disposition: (finding.rows[0]?.disposition ?? null) as
        RevisionReconciliationView['disposition'], replayed };
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
        const workObjects = this.configuredWorkObjects();
        const exact = await readExactWorkRevision({ ...this.environment,
          ...(workObjects ? { workObjects } : {}) }, input.revision, async () => true);
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
