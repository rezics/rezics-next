import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { RetainedAuthorityCoverage } from '../erasure/authority.ts';
import { assertCurrentRecoveryCoverageHead } from '../outbox/recovery-coverage-head.ts';
import {
  accessOutboxCoverage,
  accessStateCoverage,
  readRestoredGraphReleaseProof,
  RestoreLineageConflict,
  type RecoveryCoverage,
  type RestoredGraphReleaseExpectation,
} from '../work/restore-lineage.ts';

/**
 * Two immutable findings of the running outer restore operation bind its
 * release to the durable `:erasures` record. They ride on the transactions that
 * produce them: the first commits with the retained qualification while both
 * holds are closed, the second with the Access opening. A later pass can thereby
 * resume a half-finished release or complete a lost outcome without comparing
 * the replay-mutated owner copies to the original base again.
 */
const QUALIFICATION = 'restore-qualification:';
const RELEASE = 'restore-release:';

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface ErasuresRecord {
  id: string;
  consumer: string;
  requestDigest: string;
  outcomeDigest: string;
  coverageGeneration: string;
  erasureEpoch: string | null;
  items: number;
  cuts: string;
}

/** The reconciled `:erasures` record, or null while none is committed. */
export async function readErasuresRecord(
  relay: Pool | PoolClient,
  operationId: string,
): Promise<ErasuresRecord | null> {
  const row = (
    await relay.query<{
      id: string;
      consumer: string;
      request_digest: string;
      outcome_digest: string;
      coverage_generation: string;
      erasure_epoch: string | null;
    }>(
      `SELECT id, consumer, request_digest, outcome_digest, coverage_generation::text,
      erasure_epoch::text FROM relay.owner_reconciliation
     WHERE operation_id = $1 AND kind = 'restore' AND state = 'reconciled'
       AND erasure_id IS NULL AND consumer IS NOT NULL AND outcome_digest IS NOT NULL
       AND coverage_generation IS NOT NULL`,
      [operationId],
    )
  ).rows[0];
  if (!row) return null;
  const items = (
    await relay.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1',
      [row.id],
    )
  ).rows[0]!.count;
  const cuts = (
    await relay.query<{
      owner: string;
      data_epoch: string | null;
      sequence: string | null;
      coverage_digest: string;
    }>(
      `SELECT owner, data_epoch, sequence::text, coverage_digest
    FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1 ORDER BY owner`,
      [row.id],
    )
  ).rows;
  return {
    id: row.id,
    consumer: row.consumer,
    requestDigest: row.request_digest,
    outcomeDigest: row.outcome_digest,
    coverageGeneration: row.coverage_generation,
    erasureEpoch: row.erasure_epoch,
    items: Number(items),
    cuts: sha(cuts),
  };
}

export function qualificationRef(
  record: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): string {
  return QUALIFICATION + sha(['restore-qualification-v1', record, capturedGeneration, expectation]);
}

/** The retained head and journal bound at release, read on the caller's relay client. */
async function frontier(relay: Pool | PoolClient, consumer: string) {
  const head =
    (
      await relay.query<{ generation: string; coverage_digest: string }>(
        `SELECT generation::text, coverage_digest FROM relay.recovery_coverage_head
     WHERE consumer = $1 FOR SHARE`,
        [consumer],
      )
    ).rows[0] ?? null;
  const journal = (
    await relay.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure',
    )
  ).rows[0]!.epoch;
  return { head, journal };
}

interface AccessObservation {
  open: boolean;
  generation: string;
  state: { count: string; digest: string };
  outbox: { count: string; digest: string };
}

/** Full Access state and outbox as the borrowed Access transaction sees them. */
async function observeAccess(
  accessPool: Pool,
  accessClient: PoolClient,
): Promise<AccessObservation> {
  const fence = (
    await accessClient.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true',
    )
  ).rows[0];
  if (!fence) throw new RestoreLineageConflict('Access recovery fence is unavailable');
  const state = await accessStateCoverage(accessPool, accessClient);
  const outbox = await accessOutboxCoverage(accessPool, accessClient);
  return {
    open: fence.open,
    generation: fence.generation,
    state: { count: state.count, digest: state.digest },
    outbox: { count: outbox.count, digest: outbox.digest },
  };
}

async function releaseReference(
  relay: Pool | PoolClient,
  accessPool: Pool,
  accessClient: PoolClient,
  fuseki: FusekiClient,
  record: ErasuresRecord,
  qualification: string,
  expectation: RestoredGraphReleaseExpectation,
  capturedGeneration: string,
): Promise<string> {
  const access = await observeAccess(accessPool, accessClient);
  if (!access.open || access.generation !== (BigInt(capturedGeneration) + 1n).toString()) {
    throw new RestoreLineageConflict(
      'Access is not open at the generation after the captured fence',
    );
  }
  const proof = await readRestoredGraphReleaseProof(fuseki, expectation);
  if (!proof) throw new RestoreLineageConflict('native graph release evidence is unavailable');
  const retained = await frontier(relay, record.consumer);
  return (
    RELEASE +
    sha([
      'restore-release-v1',
      qualification,
      record,
      capturedGeneration,
      access,
      proof.receipt,
      retained,
    ])
  );
}

async function insertBinding(relay: PoolClient, outerId: string, reference: string): Promise<void> {
  await relay.query(
    `INSERT INTO relay.owner_reconciliation_item
      (reconciliation_id, ordinal, owner, item_kind, item_ref, disposition, evidence_digest)
    SELECT $1, coalesce(max(ordinal), 1) + 1, 'access', 'authority_fence', $2, 'matched', $3
    FROM relay.owner_reconciliation_item WHERE reconciliation_id = $1`,
    [outerId, reference, createHash('sha256').update(reference).digest('hex')],
  );
}

/** Bind the qualification inside the relay transaction that commits the `:erasures` record. */
export async function recordQualification(
  relay: PoolClient,
  outerId: string,
  record: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): Promise<void> {
  await insertBinding(relay, outerId, qualificationRef(record, capturedGeneration, expectation));
}

/** Bind the actual post-CAS Access state to the qualification, before either owner commits. */
export async function recordRelease(
  relay: PoolClient,
  accessPool: Pool,
  accessClient: PoolClient,
  fuseki: FusekiClient,
  outerId: string,
  record: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): Promise<void> {
  const qualification = qualificationRef(record, capturedGeneration, expectation);
  await requireBinding(relay, outerId, QUALIFICATION, qualification);
  await insertBinding(
    relay,
    outerId,
    await releaseReference(
      relay,
      accessPool,
      accessClient,
      fuseki,
      record,
      qualification,
      expectation,
      capturedGeneration,
    ),
  );
}

/** The latest binding of each kind recorded on the outer operation. */
export async function readBindings(
  relay: Pool | PoolClient,
  outerId: string,
): Promise<{ qualification: string | null; release: string | null }> {
  const latest = async (prefix: string) =>
    (
      await relay.query<{ item_ref: string }>(
        `SELECT item_ref FROM relay.owner_reconciliation_item
     WHERE reconciliation_id = $1 AND owner = 'access' AND item_kind = 'authority_fence'
       AND item_ref LIKE $2 AND disposition = 'matched' ORDER BY ordinal DESC LIMIT 1`,
        [outerId, prefix + '%'],
      )
    ).rows[0]?.item_ref ?? null;
  return { qualification: await latest(QUALIFICATION), release: await latest(RELEASE) };
}

async function requireBinding(
  relay: Pool | PoolClient,
  outerId: string,
  prefix: string,
  reference: string,
): Promise<void> {
  const recorded = (await readBindings(relay, outerId))[
    prefix === QUALIFICATION ? 'qualification' : 'release'
  ];
  if (recorded !== reference) {
    throw new RestoreLineageConflict(
      'durable restore qualification differs from the retained record',
    );
  }
}

/** Resume a recorded qualification: its record and bound cuts must still be exact. */
export async function requireQualification(
  relay: Pool | PoolClient,
  outerId: string,
  record: ErasuresRecord,
  capturedGeneration: string,
  expectation: RestoredGraphReleaseExpectation,
): Promise<void> {
  await requireBinding(
    relay,
    outerId,
    QUALIFICATION,
    qualificationRef(record, capturedGeneration, expectation),
  );
}

/**
 * Complete a lost outer outcome after both owners committed. Read-only: the
 * operation's bound qualification and release must equal the durable `:erasures`
 * record, the exact native receipt, the retained head and journal, the
 * independently current authority capture and the Access state and outbox now
 * open at the captured generation plus one. Any difference is a definitive
 * conflict; nothing is held again, replayed or re-signed.
 */
export async function verifyReleasedRestore(input: {
  relay: PoolClient;
  accessPool: Pool;
  accessClient: PoolClient;
  fuseki: FusekiClient;
  outerId: string;
  erasuresOperationId: string;
  authority: RetainedAuthorityCoverage;
  expectation: RestoredGraphReleaseExpectation;
  consumer: string;
  requestDigests: readonly string[];
}): Promise<void> {
  const { relay, accessPool, accessClient, fuseki, expectation } = input;
  const fence = (
    await accessClient.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true',
    )
  ).rows[0];
  if (fence?.open !== true || BigInt(fence.generation) < 1n) {
    throw new RestoreLineageConflict('Access is not open for this restore completion');
  }
  const captured = (BigInt(fence.generation) - 1n).toString();
  const record = await readErasuresRecord(relay, input.erasuresOperationId);
  if (
    !record ||
    record.consumer !== input.consumer ||
    !input.requestDigests.includes(record.requestDigest)
  ) {
    throw new RestoreLineageConflict('restore completion has no matching retained erasure record');
  }
  const bound = await readBindings(relay, input.outerId);
  if (bound.qualification !== qualificationRef(record, captured, expectation)) {
    throw new RestoreLineageConflict('restore completion differs from its durable qualification');
  }
  let coverage: RecoveryCoverage;
  try {
    coverage = openRecoveryPayload<RecoveryCoverage>(
      input.authority.sealedCoverage,
      input.authority.hmacKey,
      'graph-recovery-coverage',
    );
  } catch {
    throw new RestoreLineageConflict('independently current authority capture is invalid');
  }
  try {
    await assertCurrentRecoveryCoverageHead(relay, coverage);
  } catch {
    throw new RestoreLineageConflict(
      'signed authority capture is not the retained current capture',
    );
  }
  const effective = expectation.effective;
  if (
    coverage?.relay?.consumer !== record.consumer ||
    effective.dataEpoch !== coverage.priorDataEpoch ||
    effective.graphSequence !== coverage.priorSequence ||
    (effective.main &&
      (effective.main.dataEpoch !== coverage.relay.dataEpoch ||
        effective.main.sequence !== coverage.relay.sequence ||
        effective.main.streamScope !== coverage.relay.streamScope))
  ) {
    throw new RestoreLineageConflict('native release cut differs from signed current authority');
  }
  const retained = await frontier(relay, record.consumer);
  const current = (
    await relay.query<{
      consumer: string;
      coverage_digest: string;
      coverage_generation: string;
    }>(`SELECT consumer, coverage_digest,
      coverage_generation::text AS coverage_generation
    FROM relay.current_authority_coverage WHERE id = true FOR SHARE`)
  ).rows[0];
  if (
    !retained.head ||
    retained.head.generation !== record.coverageGeneration ||
    retained.journal !== record.erasureEpoch ||
    !current ||
    current.consumer !== record.consumer ||
    current.coverage_digest !== retained.head.coverage_digest ||
    current.coverage_generation !== retained.head.generation
  ) {
    throw new RestoreLineageConflict('a newer retained frontier needs reconciliation');
  }
  const reference = await releaseReference(
    relay,
    accessPool,
    accessClient,
    fuseki,
    record,
    bound.qualification,
    expectation,
    captured,
  );
  if (bound.release !== reference) {
    throw new RestoreLineageConflict('restore completion differs from its durable release binding');
  }
}
