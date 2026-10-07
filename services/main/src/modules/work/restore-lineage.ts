import { DATASET, GRAPHS, RV, hash, iri, lit, type GraphLineage } from './activate.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { knownSearchPosition } from '../search/snapshot-state.ts';
import type { Pool, PoolClient } from 'pg';
import { accessOutboxCoverage, accessStateCoverage,
  scanAccessOutbox, scanAccessState } from './access-recovery-coverage.ts';
import { relayCoverage, type RelayCoverage } from '../outbox/relay.ts';
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
}

export { accessOutboxCoverage, accessStateCoverage } from './access-recovery-coverage.ts';

/** Capture only after Account, graph and relay writers are externally quiesced. */
export async function captureGraphRecoveryCoverage(
  fuseki: FusekiClient, accountPool: Pool, accessPool: Pool,
  relayPool: Pool, consumer: string, contentPool: Pool,
  objectStore?: ObjectRecoveryStore,
): Promise<RecoveryCoverage> {
  if (!contentPool) throw new RestoreLineageConflict('Content owner is required for recovery coverage');
  const fence = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  if (fence.rows[0]?.open !== false) {
    throw new RestoreLineageConflict('Access recovery fence must be held for capture');
  }
  const before = await control(fuseki);
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
  const after = await control(fuseki);
  if (before.dataEpoch !== after.dataEpoch || before.routingEpoch !== after.routingEpoch
    || before.sequence !== after.sequence || relay.dataEpoch !== before.dataEpoch
    || relay.sequence !== before.sequence || relay.batchCount !== before.sequence) {
    throw new RestoreLineageConflict('source graph or relay moved during recovery capture');
  }
  // A second checkout of a pool that this capture already holds deadlocks a
  // one-connection pool, so each pool's reads run one after another.
  const [[outboxAfter, stateAfter], [accountPgAfter, accountAfter], relayAfter] = await Promise.all([
    (async () => [await accessOutboxCoverage(accessPool), await accessStateCoverage(accessPool)] as const)(),
    (async () => [await capturePgRecoveryFrontier(accountPool), await accountRecoveryCoverage(accountPool)] as const)(),
    relayCoverage(relayPool, consumer),
  ]);
  const final = await control(fuseki);
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
      || before.sequence !== final.sequence ? 'graph control' : null,
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
        rv:priorSequence ?oldSequence ; rv:dataEpoch ${lit(next.dataEpoch)} . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
      rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ;
      rv:dataEpoch ${lit(next.dataEpoch)} ; rv:sequence 0 . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . }
      FILTER(?oldSequence = ${prior.sequence})
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

/** Release only after an independently retained authority/receipt frontier is compared. */
export async function releaseRestoredGraphHold(
  fuseki: FusekiClient, accessPool: Pool, relayPool: Pool,
  lineage: GraphLineage, evidence: AuthenticatedRecoveryCoverage,
  relayClient?: PoolClient,
): Promise<void> {
  let coverage: RecoveryCoverage;
  try { coverage = openRecoveryPayload<RecoveryCoverage>(
    evidence?.sealedCoverage, evidence?.hmacKey, 'graph-recovery-coverage'); }
  catch { throw new RestoreLineageConflict('recovery coverage envelope is invalid'); }
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
    || !coverage.relay || coverage.relay.dataEpoch !== coverage.priorDataEpoch
    || coverage.relay.sequence !== coverage.priorSequence
    || coverage.relay.batchCount !== coverage.priorSequence
    || !/^[0-9a-f]{64}$/.test(coverage.relay.batchDigest)
    || !/^[0-9]+$/.test(coverage.relay.eventCount)
    || !/^[0-9a-f]{64}$/.test(coverage.relay.eventDigest)) {
    throw new RestoreLineageConflict('invalid recovery coverage');
  }
  const client = await accessPool.connect();
  let relayHeadClient: PoolClient | undefined;
  const borrowedRelay = relayClient !== undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) {
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
    try { await assertAccountSubjectDeletionsAbsent(evidence.accountPool, relayPool, relayClient); }
    catch { throw new RestoreLineageConflict('retained Account deletion subject exists in restored Account'); }
    await assertAccountDeletionJournalCoverage(accessPool, relayPool, client, relayClient);
    await assertGraphDeletionEvidence(accessPool, evidence.deletions, client);
    let retainedRelay: RelayCoverage;
    try { retainedRelay = await relayCoverage(relayPool, coverage.relay.consumer, relayClient); }
    catch { throw new RestoreLineageConflict('relay checkpoint or delivered events are unavailable'); }
    if (retainedRelay.dataEpoch !== coverage.priorDataEpoch
      || retainedRelay.sequence !== coverage.priorSequence
      || retainedRelay.batchCount !== coverage.relay.batchCount
      || retainedRelay.batchDigest !== coverage.relay.batchDigest
      || retainedRelay.eventCount !== coverage.relay.eventCount
      || retainedRelay.eventDigest !== coverage.relay.eventDigest) {
      throw new RestoreLineageConflict('relay handoff differs from recovery coverage');
    }
    relayHeadClient = relayClient ?? await relayPool.connect();
    await relayHeadClient.query('BEGIN');
    await relayHeadClient.query("SET LOCAL lock_timeout = '5s'");
    try { await assertCurrentRecoveryCoverageHead(relayHeadClient, coverage); }
    catch { throw new RestoreLineageConflict('signed recovery coverage is not the retained current capture'); }
    if (!coverage.content) throw new RestoreLineageConflict('Content recovery coverage is missing');
    if (!evidence.contentPool) throw new RestoreLineageConflict('restored Content owner is unavailable');
    try { await assertContentRecoveryCoverage(evidence.contentPool, fuseki, coverage.content); }
    catch { throw new RestoreLineageConflict('Content owner or graph references differ from recovery coverage'); }
    if (coverage.objects) {
      if (!evidence.objectStore) throw new RestoreLineageConflict('restored immutable object owner is unavailable');
      try { await assertObjectRecoveryCoverage(fuseki, evidence.objectStore, coverage.objects); }
      catch (error) { throw new RestoreLineageConflict(
        `graph or immutable objects differ from recovery coverage (${error instanceof ObjectRecoveryConflict
          ? error.kind : 'unavailable'})`); }
    }
    const marker = `urn:rezics:restore:${lineage.dataEpoch}`;
    const held = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
        rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
        rv:priorSequence ?savedSequence .
      OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
      FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
    } }`);
    let updateError: unknown;
    if (held.boolean === true) {
      const receipt = `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`;
      const digest = hash(JSON.stringify({ family: 'restore-release-v1', lineage,
        priorDataEpoch: coverage.priorDataEpoch, priorSequence: coverage.priorSequence }));
      try { await fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
        update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
            rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
            rv:priorSequence ?savedSequence .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
          FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        }` }); }
      catch (error) { updateError = error; }
    } else {
      const released = await fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
            rv:sequence 0 ; rv:restoreCutover ${iri(marker)} .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
            rv:priorSequence ?savedSequence .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
          FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
        }
      }`);
      if (released.boolean !== true) throw new RestoreLineageConflict('graph cut differs from recovery coverage');
    }
    try { await assertGraphAdmissionOpen(fuseki, lineage); }
    catch {
      throw new RestoreLineageConflict(updateError
        ? 'recovery release outcome is unknown' : 'recovery hold was not released');
    }
    await client.query('COMMIT');
    await relayHeadClient.query('COMMIT');
  } catch (error) {
    if (relayHeadClient) {
      try { await relayHeadClient.query('ROLLBACK'); } catch { /* retain original error */ }
    }
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    if (!borrowedRelay) relayHeadClient?.release();
    client.release();
  }
}
