import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Pool as PgPool } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { assertRetainedAuthorityCoverage, type RetainedAuthorityCoverage } from '../erasure/authority.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  type RestoredOwners } from '../erasure/reconcile.ts';
import { ErasureAuthorityCoverageConflict } from '../erasure/authority.ts';
import { ErasureUnavailable } from '../erasure/journal.ts';
import { GraphErasureConflict, GraphErasureUnavailable } from '../erasure/graph.ts';
import { AccountDeletionJournalConflict } from '../outbox/account-deletion-journal.ts';
import { RecoveryCoverageHeadConflict } from '../outbox/recovery-coverage-head.ts';
import { assertReleasedErasuresCurrent } from '../erasure/reconcile.ts';
import { captureReleaseBasis, proveReleaseTransition, readBindings, readErasuresRecord,
  recordQualification, recordRelease, requireQualification }
  from './restore-release-binding.ts';
import type { RestoredGraphCustody } from '../erasure/custody.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import { StructureQualifierRootStore } from '../structure/qualifier-index.ts';
import type { ObjectRecoveryStore } from './object-coverage.ts';
import { StructureGroupRootStore } from '../structure/group-root.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readExactWorkRevision, RevisionCorrupt, RevisionNotFound, RevisionUnavailable }
  from '../work/history.ts';
import { readRestoredGraphReleaseExpectation, releaseRestoredGraphHold, RestoreInterrupted,
  RestoreLineageConflict, type RecoveryCoverage, type RestoredGraphReleaseExpectation,
  type RestoredReleaseClients }
  from '../work/restore-lineage.ts';
import { heldErasureMaintenanceClient } from '../erasure/graph.ts';
import type { OwnerReconciliationRow, OwnerRelocationRow } from './schema.ts';
import { GraphRelocationOperator, RelocationConflict,
  type GraphRelocationTarget } from './relocation.ts';
import { OwnerPartitionRoutes } from '../partition/route.ts';
import { FusekiClient } from '../../infrastructure/fuseki.ts';
import { reconcileRelayGap as rebuildRelayGap, RelayGapConflict, RelayGapInvalid,
  type RelayGapInput, type RelayGapView } from './relay-gap.ts';
import { reconcileRetentionGc as collectUnreferencedObjects, readRetentionGcView,
  RetentionGcConflict, type RetentionGcView } from './retention-gc.ts';

/** Refusals that settle a restore as held; any other error is an interruption. */
function isDefinitiveRefusal(error: unknown): error is Error {
  return error instanceof ErasureRestoreHold || error instanceof ErasureAuthorityCoverageConflict
    || error instanceof ErasureUnavailable || error instanceof GraphErasureConflict
    || error instanceof GraphErasureUnavailable
    || error instanceof AccountDeletionJournalConflict || error instanceof RecoveryCoverageHeadConflict;
}

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
export type ReconciliationView = RevisionReconciliationView | RestoreReconciliationView
  | RelayGapView | RetentionGcView;
export interface RestoreResources {
  accountPool: Pool;
  accessPool: Pool;
  contentPool: Pool;
  hmacKey: string;
  objectStore: ObjectRecoveryStore;
  /** Captured handoff rows in the isolated restored copy, never current authority. */
  restoredRelayPool?: Pool;
  /** External retained owner evidence and the existing held native capability. */
  erasures?: {
    authority: RetainedAuthorityCoverage;
    signingKey: string;
    maintenance: Pick<FusekiClient, 'command'>;
  } & (
    | { originalSource: 'original-graph'; originalGraph: Pick<RestoredGraphCustody, 'fuseki' | 'lineage'> }
    | { originalSource: 'retained-native-event'; originalGraph?: never }
  );
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
    private readonly restoreResources?: RestoreResources,
    private readonly relocationTarget?: GraphRelocationTarget,
    private readonly consumerAccessPool?: Pool) {}

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

  private configuredStructureObjects(): ImmutableObjects | undefined {
    const configured = (this.environment as WorkActivationEnvironment & {
      structureObjects?: ImmutableObjects }).structureObjects;
    if (configured) return configured;
    const endpoint = Bun.env.MAIN_S3_ENDPOINT;
    if (!endpoint) return undefined;
    const bucket = Bun.env.MAIN_S3_BUCKET;
    const region = Bun.env.MAIN_S3_REGION;
    const accessKeyId = Bun.env.MAIN_S3_ACCESS_KEY;
    const secretAccessKey = Bun.env.MAIN_S3_SECRET_KEY;
    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      throw new OwnerOperationUnavailable('immutable Structure object credentials are unavailable');
    }
    return new S3ImmutableObjects({ endpoint, bucket, region, accessKeyId,
      secretAccessKey, prefix: 'semantic/structure/' });
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

  private restoreInputs(sealedCoverage: string): { resources: RestoreResources; close: () => Promise<void> } {
    if (this.restoreResources) return { resources: this.restoreResources, close: async () => {} };
    const account = Bun.env.ACCOUNT_RECOVERY_DATABASE_URL;
    const access = Bun.env.ACCESS_DATABASE_URL;
    const content = Bun.env.CONTENT_DATABASE_URL;
    const hmacKey = Bun.env.RECOVERY_MANIFEST_HMAC_KEY;
    if (!account || !access || !content || !hmacKey) {
      throw new OwnerOperationUnavailable('restore owner credentials or recovery key are unavailable');
    }
    const workObjects = this.configuredWorkObjects();
    const structureObjects = this.configuredStructureObjects();
    const pools = [new PgPool({ connectionString: account, max: 1 }),
      new PgPool({ connectionString: access, max: 1 }),
      new PgPool({ connectionString: content, max: 1 })];
    const capturedRelay = Bun.env.MAIN_RELAY_DATABASE_URL;
    const retainedRelay = Bun.env.OWNER_RELAY_DATABASE_URL;
    const signingKey = Bun.env.FUSEKI_TITLE_ADMISSION_KEY;
    const maintenanceKey = Bun.env.FUSEKI_MAINTENANCE_TOKEN;
    const graphUrl = Bun.env.FUSEKI_URL;
    // The default primary relay may be the restored backup. Only an explicit
    // retained owner route can qualify the independently current journal.
    const configuredRetained = capturedRelay && retainedRelay && signingKey && maintenanceKey && graphUrl;
    const restoredRelayPool = configuredRetained ? new PgPool({ connectionString: capturedRelay, max: 1 }) : undefined;
    if (restoredRelayPool) pools.push(restoredRelayPool);
    return { resources: { accountPool: pools[0]!, accessPool: pools[1]!,
      contentPool: pools[2]!, hmacKey,
      objectStore: { directory: this.environment.objectDirectory,
        ...(workObjects ? { workObjects } : {}),
        ...(structureObjects ? { structureObjects,
          structureQualifierRoots: new StructureQualifierRootStore(pools[2]!, structureObjects),
          structureGroupRoots: new StructureGroupRootStore(pools[2]!, structureObjects) } : {}) },
      ...(restoredRelayPool ? { restoredRelayPool } : {}),
      ...(configuredRetained ? { erasures: { authority: { sealedCoverage, hmacKey },
        signingKey, maintenance: heldErasureMaintenanceClient(graphUrl, maintenanceKey),
        originalSource: 'retained-native-event' as const } } : {}) },
    close: async () => { await Promise.all(pools.map(pool => pool.end())); } };
  }

  private async assertIndependentRetainedRelay(resources: RestoreResources,
    client: PoolClient): Promise<void> {
    if (!resources.restoredRelayPool || resources.restoredRelayPool === this.relay) {
      throw new RestoreLineageConflict('independently retained current relay is unavailable');
    }
    const identity = `SELECT current_database() AS database,
      EXTRACT(EPOCH FROM pg_postmaster_start_time())::text AS instance`;
    const current = (await client.query<{ database: string; instance: string }>(identity)).rows[0];
    const captured = (await resources.restoredRelayPool.query<{ database: string; instance: string }>(identity)).rows[0];
    if (!current?.database || !current.instance || !captured?.database || !captured.instance
      || current.database === captured.database && current.instance === captured.instance) {
      throw new RestoreLineageConflict('restored relay cannot prove an independently current erasure journal');
    }
  }

  /**
   * One full signed owner-cut comparison per pass. The release helper requires
   * retained erasure reconciliation on its held clients; unavailable owner
   * replay support settles this operation as held rather than opening admission.
   * The scans are O(owner rows + graph quads + referenced object bytes), with
   * bounded owner-table pages and the graph query deadline enforced below.
   */
  async reconcileRestore(input: { sealedCoverage: string; sealedDeletionSets: readonly string[] },
    key: string): Promise<RestoreReconciliationView> {
    const { resources, close } = this.restoreInputs(input.sealedCoverage);
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
          if (resources.erasures) await this.assertIndependentRetainedRelay(resources, client);
          const erasures = resources.erasures;
          const bindings = erasures ? await readBindings(client, row.id) : undefined;
          const accessOpen = erasures
            ? (await resources.accessPool.query<{ open: boolean }>(
              'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open === true : false;
          if (erasures && accessOpen) {
            // An earlier pass committed both owners and lost only its outcome write.
            if (!bindings?.release) {
              throw new RestoreLineageConflict('Access is open without this restore\'s release binding');
            }
            await this.completeReleasedRestore(client, resources, erasures, row.id,
              `${operationId}:erasures`);
          } else await releaseRestoredGraphHold(this.environment.fuseki, resources.accessPool,
            this.relay, this.environment.lineage, { sealedCoverage: input.sealedCoverage,
              hmacKey: resources.hmacKey, accountPool: resources.accountPool,
              contentPool: resources.contentPool, objectStore: resources.objectStore,
              restoredRelayPool: resources.restoredRelayPool,
              ...(erasures ? { qualification: { resume: Boolean(bindings?.qualification) },
                releaseErasures: (clients, releaseGraph) => this.releaseRetainedErasures(resources, erasures,
                  coverage, operationId, row.id, Boolean(bindings?.qualification), clients, releaseGraph) } : {}),
              deletions: { accountPool: resources.accountPool, hmacKey: resources.hmacKey,
                sealedSets: input.sealedDeletionSets } }, client);
        } catch (error) {
          // The operation stays running; the same key resumes from its durable record.
          if (error instanceof RestoreInterrupted) throw new OwnerOperationUnavailable(error.message, { cause: error });
          if (!(error instanceof RestoreLineageConflict)) throw error;
          conflict = error;
        }
        await client.query('BEGIN');
        try {
          if (conflict) {
            const owner = /Account/.test(conflict.message) ? 'account'
              : /Access/.test(conflict.message) ? 'access'
              : /Content/.test(conflict.message) ? 'content'
              : /relay|handoff|coverage head|erasure/i.test(conflict.message) ? 'relay'
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

  /** The restored owners with the held-erasure configuration bound to one captured Access generation. */
  private restoredOwners(resources: RestoreResources, erasures: NonNullable<RestoreResources['erasures']>,
    graphRelease: RestoredGraphReleaseExpectation, fenceGeneration: string): RestoredOwners {
    if (erasures.originalSource === 'retained-native-event' && 'originalGraph' in erasures) {
      throw new RestoreLineageConflict('retained original proof source is ambiguous');
    }
    const originalSource = erasures.originalSource === 'retained-native-event'
      ? { originalSource: 'retained-native-event' as const }
      : erasures.originalSource === 'original-graph' && erasures.originalGraph
        ? { originalSource: 'original-graph' as const, originalGraph: erasures.originalGraph }
        : undefined;
    if (!originalSource) throw new RestoreLineageConflict('independently retained original proof source is unavailable');
    const restoredObjects = resources.objectStore.structureObjects
      ? { ...resources.objectStore, structureGroupRoots: new StructureGroupRootStore(
        resources.contentPool, resources.objectStore.structureObjects),
        structureQualifierRoots: new StructureQualifierRootStore(
          resources.contentPool, resources.objectStore.structureObjects) } : resources.objectStore;
    const restored: RestoredOwners = { account: resources.accountPool,
      access: resources.accessPool, content: resources.contentPool, objects: restoredObjects,
      graph: { fuseki: this.environment.fuseki, lineage: this.environment.lineage,
        ...(this.environment.receiptCustody ? { receiptCustody: this.environment.receiptCustody } : {}),
        // The marker's saved sequence is what the held cut names; a reconciled
        // cursor, if any, is the effective cut of graphRelease.
        heldErasure: { cut: { ...this.environment.lineage,
          restoreCutover: graphRelease.restoreCutover,
          priorDataEpoch: graphRelease.saved.dataEpoch, priorSequence: graphRelease.saved.graphSequence },
        accessHoldGeneration: fenceGeneration, signingKey: erasures.signingKey,
        maintenance: erasures.maintenance, ...originalSource } } };
    return restored;
  }

  /**
   * Qualify the retained erasures and commit that record while both holds are
   * closed, then release graph and Access in fresh transactions on the same
   * borrowed clients. A resumed pass skips the qualification and authenticates
   * its durable record instead of comparing the replayed owners to the base.
   */
  private async releaseRetainedErasures(resources: RestoreResources,
    erasures: NonNullable<RestoreResources['erasures']>, coverage: RecoveryCoverage,
    operationId: string, outerId: string, resume: boolean, clients: RestoredReleaseClients,
    releaseGraph: () => Promise<void>): Promise<void> {
    const { graphRelease } = clients;
    const restored = this.restoredOwners(resources, erasures, graphRelease, clients.fenceGeneration);
    let current: RecoveryCoverage;
    try { current = openRecoveryPayload<RecoveryCoverage>(erasures.authority.sealedCoverage,
      erasures.authority.hmacKey, 'graph-recovery-coverage'); }
    catch { throw new RestoreLineageConflict('independently current authority capture is invalid'); }
    if (!current?.relay?.consumer) {
      throw new RestoreLineageConflict('independently current authority capture is unavailable');
    }
    try { await assertRetainedAuthorityCoverage(clients.relayClient, resources.accessPool,
      current.relay.consumer, erasures.authority, clients.accessClient); }
    catch (error) { throw new RestoreLineageConflict('Access differs from independently current authority', { cause: error }); }
    const erasuresOperation = `${operationId}:erasures`;
    let committed = resume;
    try {
      if (!resume) {
        const result = await reconcileRestoredErasures(this.relay, restored,
          { operationId: erasuresOperation, consumer: current.relay.consumer,
            replay: true, authority: erasures.authority },
          { relayClient: clients.relayClient, accessClient: clients.accessClient });
        if (result.state !== 'reconciled') {
          throw new RestoreLineageConflict(`retained erasure reconciliation is held: ${result.holdReason ?? 'owner evidence is unavailable'}`);
        }
        const record = await readErasuresRecord(clients.relayClient, erasuresOperation);
        if (!record || record.id !== result.reconciliationId) {
          throw new RestoreLineageConflict('retained erasure reconciliation record is unavailable');
        }
        await recordQualification(clients.relayClient, erasures.authority.hmacKey, outerId, record,
          clients.fenceGeneration, graphRelease);
        await clients.commitQualification();
        committed = true;
      }
      const record = await readErasuresRecord(clients.relayClient, erasuresOperation);
      if (!record) throw new RestoreLineageConflict('retained erasure reconciliation record is unavailable');
      await requireQualification(clients.relayClient, erasures.authority.hmacKey, outerId, record,
        clients.fenceGeneration, graphRelease);
      // The signed pre-release Access coverage, pinned on the locked client before the CAS.
      const basis = await captureReleaseBasis(resources.accessPool, clients.accessClient, current);
      await releaseErasureRestoreHold(this.relay, restored, record.id, clients.fenceGeneration,
        erasures.authority, { clients: { relayClient: clients.relayClient, accessClient: clients.accessClient,
          graphRelease }, beforeAccessRelease: releaseGraph });
      const transition = await proveReleaseTransition(resources.accessPool, clients.accessClient, basis,
        clients.fenceGeneration);
      await recordRelease(clients.relayClient, erasures.authority.hmacKey, this.environment.fuseki, outerId, record,
        clients.fenceGeneration, graphRelease, createHash('sha256').update(erasures.authority.sealedCoverage)
          .digest('hex'), transition);
    } catch (error) {
      // Once the qualification is durable, only a definitive refusal settles
      // the operation as held; an owner interruption leaves it resumable.
      if (!committed || error instanceof RestoreLineageConflict || error instanceof RestoreInterrupted
        || isDefinitiveRefusal(error)) throw error;
      throw new RestoreInterrupted(`restore release interrupted: ${
        error instanceof Error ? error.message : 'owner outcome is unavailable'}`, { cause: error });
    }
  }

  /**
   * Complete the outer outcome after both owners committed, without any owner
   * effect: the authority helper authenticates this operation's HMAC-bound
   * qualification and proven release findings, the native receipt, the retained
   * frontier and the independently current authority, and live Access must still
   * equal the coverage the proven transition recorded. The original-event,
   * historical-root and remaining erased-closure reread, including any stored
   * comment or evidence source, is `assertReleasedErasuresCurrent` below.
   */
  private async completeReleasedRestore(client: PoolClient, resources: RestoreResources,
    erasures: NonNullable<RestoreResources['erasures']>, outerId: string,
    erasuresOperation: string): Promise<void> {
    let current: RecoveryCoverage;
    try { current = openRecoveryPayload<RecoveryCoverage>(erasures.authority.sealedCoverage,
      erasures.authority.hmacKey, 'graph-recovery-coverage'); }
    catch { throw new RestoreLineageConflict('independently current authority capture is invalid'); }
    if (!current?.relay?.consumer) {
      throw new RestoreLineageConflict('independently current authority capture is unavailable');
    }
    const accessClient = await resources.accessPool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
      await accessClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await accessClient.query("SET LOCAL TIME ZONE 'UTC'");
      const fence = (await accessClient.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
      if (fence?.open !== true || BigInt(fence.generation) < 1n) {
        throw new RestoreLineageConflict('Access is not open for this restore completion');
      }
      // The opened-phase comparison authenticates this operation's own findings itself.
      const graphRelease = await readRestoredGraphReleaseExpectation(this.environment.fuseki,
        this.environment.lineage, current);
      const captured = (BigInt(fence.generation) - 1n).toString();
      const record = await readErasuresRecord(client, erasuresOperation);
      if (!record) throw new RestoreLineageConflict('restore completion has no retained erasure record');
      const restored = this.restoredOwners(resources, erasures, graphRelease, captured);
      try {
        // Mandatory: authority, deletion journal and the full erased closure, no bypass.
        await assertReleasedErasuresCurrent(this.relay, restored, record.id, captured, erasures.authority,
          { relayClient: client, accessClient, graphRelease }, outerId);
      } catch (error) {
        if (error instanceof RestoreLineageConflict) throw error;
        if (isDefinitiveRefusal(error)) {
          throw new RestoreLineageConflict(error.message, { cause: error });
        }
        throw error;
      }
      await client.query('COMMIT');
      await accessClient.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      await accessClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { accessClient.release(); }
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
    if (!row || (row.kind !== 'revision_recovery' && row.kind !== 'restore'
      && row.kind !== 'relay_gap' && row.kind !== 'retention_gc')) {
      throw new OwnerOperationMissing('reconciliation is missing');
    }
    if (row.kind === 'retention_gc') return readRetentionGcView(client, row.id, replayed);
    const finding = await client.query<{ disposition: string }>(
      `SELECT disposition FROM relay.owner_reconciliation_item
       WHERE reconciliation_id = $1 AND item_ref NOT LIKE 'restore-qualification:%'
         AND item_ref NOT LIKE 'restore-release:%' ORDER BY ordinal LIMIT 1`, [id]);
    if (row.kind === 'restore') return { id: row.id, kind: 'restore', scope: 'product',
      state: row.state, disposition: (finding.rows[0]?.disposition ?? null) as
        RestoreReconciliationView['disposition'], replayed };
    if (row.kind === 'relay_gap') return { id: row.id, kind: 'relay_gap', consumer: row.scope,
      state: row.state, disposition: (finding.rows[0]?.disposition ?? null) as
        RelayGapView['disposition'], replayed };
    return { id: row.id, kind: 'revision_recovery', revision: row.scope, state: row.state,
      disposition: (finding.rows[0]?.disposition ?? null) as
        RevisionReconciliationView['disposition'], replayed };
  }

  async readReconciliation(id: string): Promise<ReconciliationView> {
    const client = await this.relay.connect();
    try { return await this.reconciliation(client, id, true); }
    finally { client.release(); }
  }

  async reconcileRelayGap(input: RelayGapInput, key: string): Promise<RelayGapView> {
    const pool = this.consumerAccessPool ?? this.restoreResources?.accessPool ??
      (Bun.env.ACCESS_DATABASE_URL
        ? new PgPool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 2 }) : undefined);
    if (!pool) throw new OwnerOperationUnavailable('Access consumer rebuild owner is unavailable');
    try { return await rebuildRelayGap(this.relay, pool, input, key); }
    catch (error) {
      if (error instanceof RelayGapInvalid) throw new OwnerOperationInvalid(error.message);
      if (error instanceof RelayGapConflict) throw new OwnerOperationBusy(error.message);
      throw error;
    } finally {
      if (!this.consumerAccessPool && !this.restoreResources) await pool.end();
    }
  }

  async reconcileRetentionGc(key: string): Promise<RetentionGcView> {
    const workObjects = this.configuredWorkObjects();
    const structureObjects = this.configuredStructureObjects();
    if (structureObjects && !this.environment.structureGroupRoots) {
      throw new OwnerOperationUnavailable('Structure group custody owner is unavailable');
    }
    if (structureObjects && !this.environment.structureQualifierRoots) {
      throw new OwnerOperationUnavailable('Structure qualifier custody owner is unavailable');
    }
    try { return await collectUnreferencedObjects(this.relay, this.environment.fuseki,
      { directory: this.environment.objectDirectory,
        ...(workObjects ? { workObjects } : {}),
        ...(structureObjects ? { structureObjects, structureGroupRoots: this.environment.structureGroupRoots,
          structureQualifierRoots: this.environment.structureQualifierRoots } : {}) }, key); }
    catch (error) {
      if (error instanceof RetentionGcConflict) throw new OwnerOperationBusy(error.message);
      throw error;
    }
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

  /** Target placement is operator configured; the request can only name its staged id. */
  async activateRelocation(id: string, key: string): Promise<RelocationView> {
    let target = this.relocationTarget;
    let temporaryPool: Pool | undefined;
    if (!target) {
      const sourceLocation = Bun.env.FUSEKI_URL;
      const targetLocation = Bun.env.OWNER_RELOCATION_TARGET_URL;
      const targetDirectory = Bun.env.OWNER_RELOCATION_TARGET_OBJECT_DIRECTORY;
      const accessUrl = Bun.env.ACCESS_DATABASE_URL;
      if (!sourceLocation || !targetLocation || !targetDirectory || !accessUrl) {
        throw new OwnerOperationUnavailable('relocation target or Access route owner is unavailable');
      }
      const workObjects = this.configuredWorkObjects();
      const structureObjects = this.configuredStructureObjects();
      if (structureObjects && !this.environment.structureGroupRoots) {
        throw new OwnerOperationUnavailable('Structure group custody owner is unavailable');
      }
      if (structureObjects && !this.environment.structureQualifierRoots) {
        throw new OwnerOperationUnavailable('Structure qualifier custody owner is unavailable');
      }
      temporaryPool = new PgPool({ connectionString: accessUrl, max: 1 });
      target = { sourceLocation, targetLocation,
        target: new FusekiClient(targetLocation),
        sourceObjects: { directory: this.environment.objectDirectory,
          ...(workObjects ? { workObjects } : {}),
          ...(structureObjects ? { structureObjects, structureGroupRoots: this.environment.structureGroupRoots,
          structureQualifierRoots: this.environment.structureQualifierRoots } : {}) },
        targetObjects: { directory: targetDirectory,
          ...(workObjects ? { workObjects } : {}),
          ...(structureObjects ? { structureObjects, structureGroupRoots: this.environment.structureGroupRoots,
          structureQualifierRoots: this.environment.structureQualifierRoots } : {}) },
        routes: new OwnerPartitionRoutes(temporaryPool) };
    }
    try {
      const before = await this.readRelocation(id);
      const result = await new GraphRelocationOperator(this.relay,
        this.environment.fuseki, target).activate(id, key);
      return { id: result.id, owner: result.owner, datasetId: result.dataset_id,
        state: result.state, replayed: before.state === 'activated' || before.state === 'retaining' };
    } catch (error) {
      if (error instanceof RelocationConflict) throw new OwnerOperationBusy(error.message);
      throw error;
    } finally { await temporaryPool?.end(); }
  }
}
