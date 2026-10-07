import { StructureGroupRootStore } from '../structure/group-root.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type GraphLineage } from './activate.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { knownSearchPosition } from '../search/snapshot-state.ts';
import type { Pool, PoolClient } from 'pg';
import { accessOutboxCoverage, accessStateCoverage,
  scanAccessOutbox, scanAccessState } from './access-recovery-coverage.ts';
import { relayCoverage, relayCoverageOnClient, type RelayCoverage } from '../outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../outbox/relay-position.ts';
import { assertAccountDeletionJournalCoverage } from
  '../outbox/account-deletion-journal.ts';
import { assertAccountSubjectDeletionsAbsent } from
  '../outbox/account-subject-deletion.ts';
import { assertCurrentRecoveryCoverageHead } from
  '../outbox/recovery-coverage-head.ts';
import { assertDeletionRecoverySet, type DeletionRecoverySet } from
  '../../../../account/src/deletion-recovery-set.ts';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import { accountRecoveryCoverage, assertAccountRecoveryCoverage,
  type AccountRecoveryCoverage } from '../../../../account/src/recovery-coverage.ts';
import { advancePgRecoveryFrontier, assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier } from './pg-recovery-frontier.ts';
import { assertContentRecoveryCoverage, captureContentRecoveryCoverage,
  graphContentReferences, type ContentRecoveryCoverage } from './content-recovery-coverage.ts';
import { assertCommerceRecoveryCoverageOnClient, captureCommerceRecoveryCoverage,
  type CommerceRecoveryCoverage } from '../commerce/recovery-coverage.ts';
import { assertObjectRecoveryCoverage, captureObjectRecoveryCoverage,
  ObjectRecoveryConflict,
  type ObjectRecoveryCoverage, type ObjectRecoveryStore } from '../owner/object-coverage.ts';

export class RestoreLineageConflict extends Error {}
export class RecoveryHold extends Error {}

export interface RestoreLineageCutover {
  prior: GraphLineage & { sequence: string };
  next: GraphLineage;
}

export interface RecoveryCoverage {
  priorDataEpoch: string;
  priorSequence: string;
  accountPg: PgRecoveryFrontier;
  account: AccountRecoveryCoverage;
  accessOutboxCount: string;
  accessOutboxDigest: string;
  accessStateCount: string;
  accessStateDigest: string;
  relay: RelayCoverage;
  content?: ContentRecoveryCoverage;
  commerce: CommerceRecoveryCoverage;
  objects?: ObjectRecoveryCoverage;
}

export interface DeletionReleaseEvidence {
  accountPool: Pool;
  hmacKey: string;
  sealedSets: readonly string[];
}

export interface AuthenticatedRecoveryCoverage {
  sealedCoverage: string;
  hmacKey: string;
  accountPool: Pool;
  deletions?: DeletionReleaseEvidence;
  contentPool?: Pool;
  objectStore?: ObjectRecoveryStore;
  /**
   * Reconcile retained erasures after verifying the captured cut, then release
   * graph and Access under the same journal lock and borrowed owner clients.
   * The callback owns neither transaction nor client lifecycle.
   */
  releaseErasures?: (clients: RestoredReleaseClients,
    releaseGraph: () => Promise<void>) => Promise<void>;
}

export interface RestoredReleaseClients {
  accessClient: PoolClient;
  relayClient: PoolClient;
  fenceGeneration: string;
}

export { accessOutboxCoverage, accessStateCoverage } from './access-recovery-coverage.ts';

export interface GraphRecoverySource extends GraphLineage {
  sequence: string;
  relay: RelayHandoffPosition;
}

/** The diagnostic graph cut and Main's delivery cut share one source snapshot. */
export async function readGraphRecoverySource(fuseki: FusekiClient): Promise<GraphRecoverySource> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence ?streamEpoch ?streamSequence WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ?streamEpoch ; rv:streamSequence ?streamSequence .
    } } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.epoch || !row.routing || !row.sequence || !row.streamEpoch || !row.streamSequence
    || row.streamEpoch.value !== row.epoch.value || !/^[0-9]+$/.test(row.sequence.value)
    || !/^[0-9]+$/.test(row.streamSequence.value)) {
    throw new RestoreLineageConflict('graph recovery source control is unavailable or ambiguous');
  }
  return { dataEpoch: row.epoch.value, routingEpoch: row.routing.value, sequence: row.sequence.value,
    relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: row.streamEpoch.value, sequence: row.streamSequence.value } };
}

function validRecoveryRelayCut(relay: RelayCoverage, epoch: string): boolean {
  return relay?.streamScope === MAIN_RELAY_STREAM_SCOPE && relay.dataEpoch === epoch
    && /^[0-9]+$/.test(relay.sequence) && relay.batchCount === relay.sequence
    && /^[0-9a-f]{64}$/.test(relay.batchDigest) && /^[0-9]+$/.test(relay.eventCount)
    && /^[0-9a-f]{64}$/.test(relay.eventDigest);
}

/** All allocated Main positions must have reached the acknowledged relay cut. */
export function assertGraphRecoveryRelayCut(source: GraphRecoverySource, relay: RelayCoverage): void {
  if (!validRecoveryRelayCut(relay, source.dataEpoch) || source.relay.streamScope !== MAIN_RELAY_STREAM_SCOPE
    || source.relay.dataEpoch !== source.dataEpoch || source.relay.sequence !== relay.sequence) {
    throw new RestoreLineageConflict('source graph or relay moved during recovery capture');
  }
}

/** Capture only after Account, graph and relay writers are externally quiesced. */
export async function captureGraphRecoveryCoverage(
  fuseki: FusekiClient, accountPool: Pool, accessPool: Pool,
  relayPool: Pool, consumer: string, contentPool: Pool,
  objectStore?: ObjectRecoveryStore,
): Promise<RecoveryCoverage> {
  if (!contentPool) throw new RestoreLineageConflict('Content owner is required for recovery coverage');
  if (objectStore?.structureObjects) objectStore = { ...objectStore,
    structureGroupRoots: new StructureGroupRootStore(contentPool, objectStore.structureObjects) };
  const fence = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  if (fence.rows[0]?.open !== false) {
    throw new RestoreLineageConflict('Access recovery fence must be held for capture');
  }
  const before = await readGraphRecoverySource(fuseki);
  await assertGraphAdmissionOpen(fuseki, {
    dataEpoch: before.dataEpoch, routingEpoch: before.routingEpoch,
  });
  const graphReferences = await graphContentReferences(fuseki);
  const content = await captureContentRecoveryCoverage(contentPool, graphReferences);
  const commerce = await captureCommerceRecoveryCoverage(accessPool);
  const objects = objectStore ? await captureObjectRecoveryCoverage(fuseki, objectStore) : undefined;
  const outbox = await accessOutboxCoverage(accessPool);
  const state = await accessStateCoverage(accessPool);
  const accountPg = await capturePgRecoveryFrontier(accountPool);
  const account = await accountRecoveryCoverage(accountPool);
  const relay = await relayCoverage(relayPool, consumer);
  await assertAccountSubjectDeletionsAbsent(accountPool, relayPool);
  await assertAccountDeletionJournalCoverage(accessPool, relayPool);
  const after = await readGraphRecoverySource(fuseki);
  assertGraphRecoveryRelayCut(before, relay);
  if (before.dataEpoch !== after.dataEpoch || before.routingEpoch !== after.routingEpoch
    || before.sequence !== after.sequence || before.relay.sequence !== after.relay.sequence) {
    throw new RestoreLineageConflict('source graph or relay moved during recovery capture');
  }
  // A second checkout of a pool that this capture already holds deadlocks a
  // one-connection pool, so each pool's reads run one after another.
  const [[outboxAfter, stateAfter], [accountPgAfter, accountAfter], relayAfter] = await Promise.all([
    (async () => [await accessOutboxCoverage(accessPool), await accessStateCoverage(accessPool)] as const)(),
    (async () => [await capturePgRecoveryFrontier(accountPool), await accountRecoveryCoverage(accountPool)] as const)(),
    relayCoverage(relayPool, consumer),
  ]);
  const final = await readGraphRecoverySource(fuseki);
  const graphReferencesAfter = await graphContentReferences(fuseki);
  const contentAfter = await captureContentRecoveryCoverage(contentPool, graphReferencesAfter);
  const commerceAfter = await captureCommerceRecoveryCoverage(accessPool);
  const objectsAfter = objectStore ? await captureObjectRecoveryCoverage(fuseki, objectStore) : undefined;
  // The cluster can emit checkpoint/hint-bit WAL while every owner row stays
  // fixed. Keep the latest replay floor after both full comparisons, rather
  // than recapturing every immutable object for background WAL alone.
  // https://www.postgresql.org/docs/18/runtime-config-wal.html#GUC-WAL-LOG-HINTS
  const retainedPg = advancePgRecoveryFrontier(
    advancePgRecoveryFrontier(accountPg, accountPgAfter), await capturePgRecoveryFrontier(accountPool));
  const fenceAfter = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  const moved = [
    fenceAfter.rows[0]?.open !== false ? 'Access fence' : null,
    before.dataEpoch !== final.dataEpoch || before.routingEpoch !== final.routingEpoch
      || before.sequence !== final.sequence || before.relay.sequence !== final.relay.sequence ? 'graph control' : null,
    outbox.count !== outboxAfter.count || outbox.digest !== outboxAfter.digest
      ? 'Access outbox' : null,
    state.count !== stateAfter.count || state.digest !== stateAfter.digest
      ? 'Access state' : null,
    account.rowCount !== accountAfter.rowCount || account.rowDigest !== accountAfter.rowDigest
      ? 'Account rows' : null,
    JSON.stringify(relay) !== JSON.stringify(relayAfter) ? 'relay' : null,
    JSON.stringify(graphReferences) !== JSON.stringify(graphReferencesAfter)
      ? 'graph Content references' : null,
    JSON.stringify(content) !== JSON.stringify(contentAfter) ? 'Content owner' : null,
    JSON.stringify(commerce) !== JSON.stringify(commerceAfter) ? 'Commerce owner' : null,
    JSON.stringify(objects) !== JSON.stringify(objectsAfter) ? 'immutable objects' : null,
  ].filter((part): part is string => part !== null);
  if (moved.length) {
    throw new RestoreLineageConflict(`owner or graph moved during recovery capture: ${moved.join(', ')}`);
  }
  return { priorDataEpoch: before.dataEpoch, priorSequence: before.sequence,
    accountPg: retainedPg, account,
    accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
    accessStateCount: state.count, accessStateDigest: state.digest, relay,
    content, commerce, ...(objects ? { objects } : {}) };
}

/**
 * Every retained Account deletion intent needs a current two-owner proof.
 * A passed client stays in the caller's transaction: this does not begin,
 * commit, roll back or release it.
 */
export async function assertGraphDeletionEvidence(
  accessPool: Pool, evidence?: DeletionReleaseEvidence, client?: PoolClient,
): Promise<void> {
  const owned = !client;
  const held = client ?? await accessPool.connect();
  try {
    if (owned) await held.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await held.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) {
      throw new RestoreLineageConflict('Access recovery fence is not held');
    }
    const result = await held.query<{ principal_id: string; authority_epoch: string }>(
      `SELECT principal_id, authority_epoch FROM access.outbox
       WHERE kind = 'account.deletion_fenced' ORDER BY principal_id`);
    const markers = result.rows;
    if (markers.length !== (evidence?.sealedSets.length ?? 0)) {
      throw new RestoreLineageConflict('Account deletion recovery evidence is incomplete');
    }
    if (markers.length > 0) {
      if (!evidence?.accountPool || !evidence.hmacKey) {
        throw new RestoreLineageConflict('Account deletion recovery evidence is unavailable');
      }
      const byPrincipal = new Map(markers.map(row => [row.principal_id, row.authority_epoch]));
      for (const sealed of evidence.sealedSets) {
        let set: DeletionRecoverySet;
        try { set = openRecoveryPayload<DeletionRecoverySet>(
          sealed, evidence.hmacKey, 'deletion-recovery-set'); }
        catch { throw new RestoreLineageConflict('Account deletion recovery envelope is invalid'); }
        const epoch = byPrincipal.get(set.deletion?.accessPrincipalId);
        if (!epoch || epoch !== set.deletion.enforcementEpoch) {
          throw new RestoreLineageConflict('Account deletion intent differs from retained evidence');
        }
        byPrincipal.delete(set.deletion.accessPrincipalId);
        try { await assertDeletionRecoverySet(evidence.accountPool, accessPool, set, held); }
        catch { throw new RestoreLineageConflict('deleted Account/Access state differs from retained evidence'); }
      }
      if (byPrincipal.size !== 0) {
        throw new RestoreLineageConflict('Account deletion recovery evidence is incomplete');
      }
    }
    if (owned) await held.query('COMMIT');
  } catch (error) {
    if (owned) { try { await held.query('ROLLBACK'); } catch { /* retain original error */ } }
    throw error;
  } finally {
    if (owned) held.release();
  }
}

export async function assertGraphAdmissionOpen(fuseki: FusekiClient, lineage: GraphLineage): Promise<void> {
  if (knownSearchPosition(fuseki, lineage)) return;
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} .
    FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
  } }`);
  if (result.boolean !== true) throw new RecoveryHold('graph admission is held or lineage differs');
}

async function control(fuseki: FusekiClient): Promise<{ dataEpoch: string; routingEpoch: string; sequence: string }> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?routing ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
    } }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0]?.routing || !rows[0]?.sequence) {
    throw new RestoreLineageConflict('product control record is unavailable or ambiguous');
  }
  return { dataEpoch: rows[0].epoch.value, routingEpoch: rows[0].routing.value,
    sequence: rows[0].sequence.value };
}

/** Run only on a fenced, isolated restored dataset before product admission. */
export async function cutoverRestoredGraphLineage(
  fuseki: FusekiClient, cutover: RestoreLineageCutover,
): Promise<{ lineage: GraphLineage; sequence: '0' | string; replayed: boolean }> {
  const { prior, next } = cutover;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const numericRouting = /^(0|[1-9][0-9]*)$/.test(prior.routingEpoch)
    && /^(0|[1-9][0-9]*)$/.test(next.routingEpoch)
    && BigInt(next.routingEpoch) > BigInt(prior.routingEpoch);
  const uuidRouting = uuid.test(prior.routingEpoch) && uuid.test(next.routingEpoch)
    && prior.routingEpoch !== next.routingEpoch;
  if (!uuid.test(prior.dataEpoch) || !uuid.test(next.dataEpoch)
    || prior.dataEpoch === next.dataEpoch || !/^[0-9]+$/.test(prior.sequence)
    || (!numericRouting && !uuidRouting)) {
    throw new RestoreLineageConflict('invalid restore lineage transition');
  }
  const before = await control(fuseki);
  if (before.dataEpoch === next.dataEpoch && before.routingEpoch === next.routingEpoch) {
    return { lineage: next, sequence: before.sequence, replayed: true };
  }
  if (before.dataEpoch !== prior.dataEpoch || before.routingEpoch !== prior.routingEpoch
    || before.sequence !== prior.sequence) {
    throw new RestoreLineageConflict('restored graph cut differs from recorded position');
  }
  // Read both cuts together before the command resets the scoped Main counter.
  // Existing cutover receipts return above without changing their original identity.
  const source = await readGraphRecoverySource(fuseki);
  if (source.dataEpoch !== prior.dataEpoch || source.routingEpoch !== prior.routingEpoch
    || source.sequence !== prior.sequence) {
    throw new RestoreLineageConflict('restored graph cut moved before lineage cutover');
  }
  const marker = `urn:rezics:restore:${next.dataEpoch}`;
  const receipt = `urn:rezics:receipt:restore-cutover:${hash(next.dataEpoch)}`;
  const digest = hash(JSON.stringify({ family: 'restore-cutover-v1', prior, next }));
  let updateError: unknown;
  let updateStatus: string | undefined;
  let updateReport: unknown;
  try { const result = await fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
    update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence ;
      rv:restoreCutover ?priorMarker . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(next.dataEpoch)} ;
      rv:routingEpoch ${lit(next.routingEpoch)} ; rv:sequence 0 ;
      rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} a rv:RestoreCutover ; rv:priorDataEpoch ${lit(prior.dataEpoch)} ;
        rv:priorSequence ?oldSequence ; rv:priorMainSequence ?oldMainSequence ;
        rv:dataEpoch ${lit(next.dataEpoch)} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ;
      rv:dataEpoch ${lit(next.dataEpoch)} ; rv:sequence 0 . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(prior.dataEpoch)} ; rv:streamSequence ?oldMainSequence . }
      FILTER(?oldSequence = ${prior.sequence} && ?oldMainSequence = ${source.relay.sequence})
      OPTIONAL { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreCutover ?priorMarker . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
    }` });
    updateStatus = result.status;
    if (result.status === 'invalid') updateReport = result.report;
  }
  catch (error) { updateError = error; }
  const after = await control(fuseki);
  if (after.dataEpoch !== next.dataEpoch || after.routingEpoch !== next.routingEpoch
    || after.sequence !== '0') {
    throw new RestoreLineageConflict(updateError
      ? 'restore lineage update outcome is unknown'
      : `restored graph lineage was not activated (${updateStatus ?? 'no status'}: ${JSON.stringify(updateReport)})`);
  }
  return { lineage: next, sequence: '0', replayed: false };
}

/** Signed coverage retains independent diagnostic and scoped relay cuts. */
export function assertRecoveryCoverage(coverage: RecoveryCoverage): void {
  if (!coverage || !/^[0-9]+$/.test(coverage.priorSequence)
    || !/^[0-9]+$/.test(coverage.accountPg?.systemIdentifier ?? '')
    || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(coverage.accountPg?.flushedLsn ?? '')
    || !/^[0-9A-F]{24}$/i.test(coverage.accountPg?.walFile ?? '')
    || !/^[0-9]+$/.test(coverage.account?.rowCount ?? '')
    || !/^[0-9a-f]{64}$/.test(coverage.account?.rowDigest ?? '')
    || !/^[0-9]+$/.test(coverage.accessOutboxCount)
    || !/^[0-9a-f]{64}$/.test(coverage.accessOutboxDigest)
    || !/^[0-9]+$/.test(coverage.accessStateCount)
    || !/^[0-9a-f]{64}$/.test(coverage.accessStateDigest)
    || !coverage.commerce || coverage.commerce.version !== 1
    || !validRecoveryRelayCut(coverage.relay, coverage.priorDataEpoch)) {
    throw new RestoreLineageConflict('invalid recovery coverage');
  }
}

export function assertRetainedRecoveryRelayCut(coverage: RecoveryCoverage, retained: RelayCoverage): void {
  if (!validRecoveryRelayCut(retained, coverage.priorDataEpoch)
    || retained.streamScope !== coverage.relay.streamScope || retained.consumer !== coverage.relay.consumer
    || retained.sequence !== coverage.relay.sequence || retained.batchCount !== coverage.relay.batchCount
    || retained.batchDigest !== coverage.relay.batchDigest || retained.eventCount !== coverage.relay.eventCount
    || retained.eventDigest !== coverage.relay.eventDigest) {
    throw new RestoreLineageConflict('relay handoff differs from recovery coverage');
  }
}

/** Release only after an independently retained authority/receipt frontier is compared.
 * Supplying both Access and relay clients preserves the caller's transactions.
 * The legacy relay-only argument retains its original transaction lifecycle.
 */
export async function releaseRestoredGraphHold(
  fuseki: FusekiClient, accessPool: Pool, relayPool: Pool,
  lineage: GraphLineage, evidence: AuthenticatedRecoveryCoverage,
  relayClient?: PoolClient, borrowedAccessClient?: PoolClient,
): Promise<void> {
  if (borrowedAccessClient && !relayClient) {
    throw new RestoreLineageConflict('borrowed restore requires both Access and relay clients');
  }
  let coverage: RecoveryCoverage;
  try { coverage = openRecoveryPayload<RecoveryCoverage>(
    evidence?.sealedCoverage, evidence?.hmacKey, 'graph-recovery-coverage'); }
  catch { throw new RestoreLineageConflict('recovery coverage envelope is invalid'); }
  assertRecoveryCoverage(coverage);
  if (!evidence.releaseErasures) {
    throw new RestoreLineageConflict('retained erasure restore release is unavailable');
  }
  let accessClient: PoolClient | undefined;
  let relayHeadClient: PoolClient | undefined;
  const borrowedRelay = relayClient !== undefined;
  const borrowedOwners = borrowedAccessClient !== undefined;
  let accessTransaction: string | undefined;
  let relayTransaction: string | undefined;
  const borrowedTransaction = async (owner: 'Access' | 'relay', client: PoolClient,
    isolation: 'repeatable read' | 'read committed', expected?: string): Promise<string> => {
    try {
      const actualIsolation = (await client.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
      if (actualIsolation !== isolation) {
        throw new RestoreLineageConflict(`borrowed ${owner} restore requires an active ${isolation} transaction`);
      }
      // Consecutive IDs are stable only inside the caller's explicit transaction;
      // an idle autocommit client obtains different IDs before any lock/effect.
      const first = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]?.id;
      const second = (await client.query<{ id: string }>('SELECT txid_current()::text AS id')).rows[0]?.id;
      if (typeof first !== 'string' || !/^[0-9]+$/.test(first) || first !== second) {
        throw new RestoreLineageConflict(`borrowed ${owner} restore requires an active ${isolation} transaction`);
      }
      if (expected !== undefined && first !== expected) {
        throw new RestoreLineageConflict(`borrowed ${owner} restore transaction changed`);
      }
      return first;
    } catch (error) {
      if (error instanceof RestoreLineageConflict) throw error;
      throw new RestoreLineageConflict(`borrowed ${owner} restore transaction is unavailable`, { cause: error });
    }
  };
  const assertBorrowedTransactions = async () => {
    if (!borrowedOwners) return;
    await borrowedTransaction('relay', relayHeadClient!, 'read committed', relayTransaction);
    await borrowedTransaction('Access', accessClient!, 'repeatable read', accessTransaction);
  };
  try {
    relayHeadClient = relayClient ?? await relayPool.connect();
    if (borrowedOwners) {
      relayTransaction = await borrowedTransaction('relay', relayHeadClient, 'read committed');
      accessTransaction = await borrowedTransaction('Access', borrowedAccessClient!, 'repeatable read');
    } else {
      await relayHeadClient.query('BEGIN');
      await relayHeadClient.query("SET LOCAL lock_timeout = '5s'");
    }
    // Every release takes the journal allocator before the Access fence. Keep
    // that order across owners and retain both locks through both releases.
    await relayHeadClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
    const client = borrowedAccessClient ?? await accessPool.connect();
    accessClient = client;
    if (!borrowedOwners) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
    }
    const fence = await client.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true FOR UPDATE');
    await assertBorrowedTransactions();
    const fenceGeneration = fence.rows[0]?.generation;
    if (fence.rows[0]?.open !== false || typeof fenceGeneration !== 'string'
      || !/^[0-9]+$/.test(fenceGeneration)) {
      throw new RestoreLineageConflict('Access recovery fence is not held');
    }
    const outbox = await scanAccessOutbox(client);
    if (outbox.count !== coverage.accessOutboxCount || outbox.digest !== coverage.accessOutboxDigest) {
      throw new RestoreLineageConflict('Access outbox differs from recovery coverage');
    }
    const state = await scanAccessState(client);
    if (state.count !== coverage.accessStateCount || state.digest !== coverage.accessStateDigest) {
      throw new RestoreLineageConflict('Access state differs from recovery coverage');
    }
    try { await assertCommerceRecoveryCoverageOnClient(client, coverage.commerce); }
    catch { throw new RestoreLineageConflict('Commerce owner differs from recovery coverage'); }
    try { await assertPgRecoveryFrontier(evidence.accountPool, coverage.accountPg); }
    catch { throw new RestoreLineageConflict('Account WAL differs from recovery coverage'); }
    try { await assertAccountRecoveryCoverage(evidence.accountPool, coverage.account); }
    catch { throw new RestoreLineageConflict('Account rows differ from recovery coverage'); }
    try { await assertAccountSubjectDeletionsAbsent(evidence.accountPool, relayPool, relayHeadClient); }
    catch { throw new RestoreLineageConflict('retained Account deletion subject exists in restored Account'); }
    await assertAccountDeletionJournalCoverage(accessPool, relayPool, client, relayHeadClient);
    await assertGraphDeletionEvidence(accessPool, evidence.deletions, client);
    let retainedRelay: RelayCoverage;
    try { retainedRelay = await relayCoverageOnClient(relayHeadClient, coverage.relay.consumer); }
    catch { throw new RestoreLineageConflict('relay checkpoint or delivered events are unavailable'); }
    assertRetainedRecoveryRelayCut(coverage, retainedRelay);
    try { await assertCurrentRecoveryCoverageHead(relayHeadClient, coverage); }
    catch { throw new RestoreLineageConflict('signed recovery coverage is not the retained current capture'); }
    if (!coverage.content) throw new RestoreLineageConflict('Content recovery coverage is missing');
    if (!evidence.contentPool) throw new RestoreLineageConflict('restored Content owner is unavailable');
    try { await assertContentRecoveryCoverage(evidence.contentPool, fuseki, coverage.content); }
    catch { throw new RestoreLineageConflict('Content owner or graph references differ from recovery coverage'); }
    if (!coverage.objects) throw new RestoreLineageConflict('immutable object recovery coverage is missing');
    if (!evidence.objectStore) throw new RestoreLineageConflict('restored immutable object owner is unavailable');
    const restoredObjects = evidence.objectStore.structureObjects
      ? { ...evidence.objectStore, structureGroupRoots: new StructureGroupRootStore(
        evidence.contentPool, evidence.objectStore.structureObjects) } : evidence.objectStore;
    try { await assertObjectRecoveryCoverage(fuseki, restoredObjects, coverage.objects); }
    catch (error) { throw new RestoreLineageConflict(
      `graph or immutable objects differ from recovery coverage (${error instanceof ObjectRecoveryConflict
        ? error.kind : 'unavailable'})`); }
    const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
    const receipt = `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`;
    const cuts = (await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?savedMainSequence ?reconciledMainSequence WHERE { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ; rv:priorSequence ?savedSequence .
        OPTIONAL { ${iri(marker)} rv:priorMainSequence ?savedMainSequence }
        OPTIONAL { ${iri(marker)} rv:reconciledPriorMainSequence ?reconciledMainSequence }
      } } LIMIT 2`)).results?.bindings ?? [];
    const cut = cuts[0];
    if (cuts.length !== 1 || !cut
      || ['savedMainSequence', 'reconciledMainSequence'].some(key => cut[key] && !/^[0-9]+$/.test(cut[key]!.value))
      || cut.reconciledMainSequence && !cut.savedMainSequence) {
      throw new RestoreLineageConflict('restored graph Main cut is unavailable or ambiguous');
    }
    const pairedMain = cut.savedMainSequence !== undefined;
    const mainCutGuard = pairedMain
      ? `${iri(marker)} rv:priorMainSequence ?savedMainSequence .
         OPTIONAL { ${iri(marker)} rv:reconciledPriorMainSequence ?reconciledMainSequence }
         FILTER(COALESCE(?reconciledMainSequence, ?savedMainSequence) = ${coverage.relay.sequence})`
      : `FILTER NOT EXISTS { ${iri(marker)} rv:priorMainSequence ?savedMainSequence }
         FILTER NOT EXISTS { ${iri(marker)} rv:reconciledPriorMainSequence ?reconciledMainSequence }`;
    // Exact legacy markers retain their original release digest and receipt.
    // Paired markers additionally bind the signed scoped Main cut.
    const releaseDigest = hash(JSON.stringify(pairedMain
      ? { family: 'restore-release-v2', lineage, priorDataEpoch: coverage.priorDataEpoch,
        priorSequence: coverage.priorSequence, priorMainSequence: coverage.relay.sequence,
        streamScope: MAIN_RELAY_STREAM_SCOPE }
      : { family: 'restore-release-v1', lineage,
        priorDataEpoch: coverage.priorDataEpoch, priorSequence: coverage.priorSequence }));
    const mainReceiptFacts = pairedMain
      ? `; rv:priorMainSequence ${coverage.relay.sequence} ; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)}` : '';
    const releasedQuery = `PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreCutover ${iri(marker)} .
        ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ; rv:priorSequence ?savedSequence .
        OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
        FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        ${mainCutGuard}
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(releaseDigest)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 ${mainReceiptFacts} .
      }
    }`;
    const held = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
        rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
        rv:priorSequence ?savedSequence .
      OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
      FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        ${mainCutGuard}
    } }`);
    // A replay may alter Content/object copies. Verify the signed base before
    // it starts; an interrupted release additionally requires its exact receipt.
    if (held.boolean !== true && (await fuseki.query(releasedQuery)).boolean !== true) {
      throw new RestoreLineageConflict('restored graph cut is not held for erasure reconciliation');
    }
    let graphReleased = false;
    const releaseGraph = async () => {
      if (graphReleased) throw new RestoreLineageConflict('restored graph release already completed');
      await assertBorrowedTransactions();
      const beforeRelease = (await client.query<{ open: boolean; generation: string }>(
        'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
      if (beforeRelease?.open !== false || beforeRelease.generation !== fenceGeneration) {
        throw new RestoreLineageConflict('captured Access fence changed before graph release');
      }
      await assertBorrowedTransactions();
      let updateError: unknown;
      if (held.boolean === true) {
        try { await fuseki.commandWithReceipt({ receipt, digest: releaseDigest, validations: [], deadlineMs: 10_000,
        update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(releaseDigest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 ${mainReceiptFacts} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
            rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
            rv:priorSequence ?savedSequence .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
          FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        ${mainCutGuard}
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        }` }); }
        catch (error) { updateError = error; }
      }
      // Recovery cannot use a cached ordinary search position as release proof.
      const released = await fuseki.query(releasedQuery);
      if (released.boolean !== true) {
        throw new RestoreLineageConflict(updateError
          ? 'recovery release outcome is unknown' : 'recovery hold was not released');
      }
      graphReleased = true;
    };
    try {
      await assertBorrowedTransactions();
      await evidence.releaseErasures({ accessClient: client, relayClient: relayHeadClient,
        fenceGeneration }, releaseGraph);
    } catch (error) {
      if (error instanceof RestoreLineageConflict) throw error;
      throw new RestoreLineageConflict(`retained erasure reconciliation failed: ${
        error instanceof Error ? error.message : 'owner replay outcome is unavailable'}`, { cause: error });
    }
    await assertBorrowedTransactions();
    if (!graphReleased) throw new RestoreLineageConflict('retained erasure reconciliation did not release the graph');
    const releasedFence = (await client.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
    if (releasedFence?.open !== true || releasedFence.generation !== (BigInt(fenceGeneration) + 1n).toString()) {
      throw new RestoreLineageConflict('retained erasure reconciliation did not release the captured Access fence');
    }
    if ((await fuseki.query(releasedQuery)).boolean !== true) {
      throw new RestoreLineageConflict('restored graph release evidence changed before Access commit');
    }
    await assertBorrowedTransactions();
    if (!borrowedOwners) {
      await client.query('COMMIT');
      await relayHeadClient.query('COMMIT');
    }
  } catch (error) {
    if (relayHeadClient && !borrowedOwners) {
      try { await relayHeadClient.query('ROLLBACK'); } catch { /* retain original error */ }
    }
    if (accessClient && !borrowedOwners) {
      try { await accessClient.query('ROLLBACK'); } catch { /* retain original error */ }
    }
    throw error;
  } finally {
    if (!borrowedRelay) relayHeadClient?.release();
    if (!borrowedOwners) accessClient?.release();
  }
}
