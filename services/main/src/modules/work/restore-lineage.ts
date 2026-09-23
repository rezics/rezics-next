import { DATASET, GRAPHS, RV, iri, lit, type GraphLineage } from './activate.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
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
import { assertPgRecoveryFrontier, capturePgRecoveryFrontier,
  type PgRecoveryFrontier } from './pg-recovery-frontier.ts';

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
}

export { accessOutboxCoverage, accessStateCoverage } from './access-recovery-coverage.ts';

/** Capture only after Account, graph and relay writers are externally quiesced. */
export async function captureGraphRecoveryCoverage(
  fuseki: FusekiClient, accountPool: Pool, accessPool: Pool,
  relayPool: Pool, consumer: string,
): Promise<RecoveryCoverage> {
  const fence = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  if (fence.rows[0]?.open !== false) {
    throw new RestoreLineageConflict('Access recovery fence must be held for capture');
  }
  const before = await control(fuseki);
  await assertGraphAdmissionOpen(fuseki, {
    dataEpoch: before.dataEpoch, routingEpoch: before.routingEpoch,
  });
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
  const [outboxAfter, stateAfter, accountPgAfter, accountAfter, relayAfter] = await Promise.all([
    accessOutboxCoverage(accessPool), accessStateCoverage(accessPool),
    capturePgRecoveryFrontier(accountPool), accountRecoveryCoverage(accountPool),
    relayCoverage(relayPool, consumer),
  ]);
  const final = await control(fuseki);
  const fenceAfter = await accessPool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true');
  if (fenceAfter.rows[0]?.open !== false || before.dataEpoch !== final.dataEpoch
    || before.routingEpoch !== final.routingEpoch || before.sequence !== final.sequence
    || outbox.count !== outboxAfter.count || outbox.digest !== outboxAfter.digest
    || state.count !== stateAfter.count || state.digest !== stateAfter.digest
    || accountPg.systemIdentifier !== accountPgAfter.systemIdentifier
    || accountPg.flushedLsn !== accountPgAfter.flushedLsn
    || accountPg.walFile !== accountPgAfter.walFile
    || account.rowCount !== accountAfter.rowCount || account.rowDigest !== accountAfter.rowDigest
    || JSON.stringify(relay) !== JSON.stringify(relayAfter)) {
    throw new RestoreLineageConflict('owner or graph moved during recovery capture');
  }
  return { priorDataEpoch: before.dataEpoch, priorSequence: before.sequence,
    accountPg, account,
    accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
    accessStateCount: state.count, accessStateDigest: state.digest, relay };
}

/** Every retained Account deletion intent needs a current two-owner proof. */
export async function assertGraphDeletionEvidence(
  accessPool: Pool, evidence?: DeletionReleaseEvidence,
): Promise<void> {
  const client = await accessPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== false) {
      throw new RestoreLineageConflict('Access recovery fence is not held');
    }
    const result = await client.query<{ principal_id: string; authority_epoch: string }>(
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
        try { await assertDeletionRecoverySet(evidence.accountPool, accessPool, set); }
        catch { throw new RestoreLineageConflict('deleted Account/Access state differs from retained evidence'); }
      }
      if (byPrincipal.size !== 0) {
        throw new RestoreLineageConflict('Account deletion recovery evidence is incomplete');
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function assertGraphAdmissionOpen(fuseki: FusekiClient, lineage: GraphLineage): Promise<void> {
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
  if (!uuid.test(prior.dataEpoch) || !uuid.test(next.dataEpoch)
    || prior.dataEpoch === next.dataEpoch || !/^[0-9]+$/.test(prior.sequence)
    || !/^[0-9]+$/.test(prior.routingEpoch) || !/^[0-9]+$/.test(next.routingEpoch)
    || BigInt(next.routingEpoch) <= BigInt(prior.routingEpoch)) {
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
  let updateError: unknown;
  try { await fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(next.dataEpoch)} ;
      rv:routingEpoch ${lit(next.routingEpoch)} ; rv:sequence 0 ;
      rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
      ${iri(marker)} a rv:RestoreCutover ; rv:priorDataEpoch ${lit(prior.dataEpoch)} ;
        rv:priorSequence ?oldSequence ; rv:dataEpoch ${lit(next.dataEpoch)} . } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(prior.dataEpoch)} ;
      rv:routingEpoch ${lit(prior.routingEpoch)} ; rv:sequence ?oldSequence . }
      FILTER(?oldSequence = ${prior.sequence})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(marker)} ?p ?o } }
    }`); }
  catch (error) { updateError = error; }
  const after = await control(fuseki);
  if (after.dataEpoch !== next.dataEpoch || after.routingEpoch !== next.routingEpoch
    || after.sequence !== '0') {
    throw new RestoreLineageConflict(updateError
      ? 'restore lineage update outcome is unknown' : 'restored graph lineage was not activated');
  }
  return { lineage: next, sequence: '0', replayed: false };
}

/** Release only after an independently retained authority/receipt frontier is compared. */
export async function releaseRestoredGraphHold(
  fuseki: FusekiClient, accessPool: Pool, relayPool: Pool,
  lineage: GraphLineage, evidence: AuthenticatedRecoveryCoverage,
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
    try { await assertPgRecoveryFrontier(evidence.accountPool, coverage.accountPg); }
    catch { throw new RestoreLineageConflict('Account WAL differs from recovery coverage'); }
    try { await assertAccountRecoveryCoverage(evidence.accountPool, coverage.account); }
    catch { throw new RestoreLineageConflict('Account rows differ from recovery coverage'); }
    try { await assertAccountSubjectDeletionsAbsent(evidence.accountPool, relayPool); }
    catch { throw new RestoreLineageConflict('retained Account deletion subject exists in restored Account'); }
    await assertAccountDeletionJournalCoverage(accessPool, relayPool);
    await assertGraphDeletionEvidence(accessPool, evidence.deletions);
    let retainedRelay: RelayCoverage;
    try { retainedRelay = await relayCoverage(relayPool, coverage.relay.consumer); }
    catch { throw new RestoreLineageConflict('relay checkpoint or delivered events are unavailable'); }
    if (retainedRelay.dataEpoch !== coverage.priorDataEpoch
      || retainedRelay.sequence !== coverage.priorSequence
      || retainedRelay.batchCount !== coverage.relay.batchCount
      || retainedRelay.batchDigest !== coverage.relay.batchDigest
      || retainedRelay.eventCount !== coverage.relay.eventCount
      || retainedRelay.eventDigest !== coverage.relay.eventDigest) {
      throw new RestoreLineageConflict('relay handoff differs from recovery coverage');
    }
    relayHeadClient = await relayPool.connect();
    await relayHeadClient.query('BEGIN');
    await relayHeadClient.query("SET LOCAL lock_timeout = '5s'");
    try { await assertCurrentRecoveryCoverageHead(relayHeadClient, coverage); }
    catch { throw new RestoreLineageConflict('signed recovery coverage is not the retained current capture'); }
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
      try { await fuseki.update(`PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        WHERE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
            rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} rv:priorDataEpoch ${lit(coverage.priorDataEpoch)} ;
            rv:priorSequence ?savedSequence .
          OPTIONAL { ${iri(marker)} rv:reconciledPriorSequence ?reconciledSequence }
          FILTER(COALESCE(?reconciledSequence, ?savedSequence) = ${coverage.priorSequence})
        } }`); }
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
    relayHeadClient?.release();
    client.release();
  }
}
