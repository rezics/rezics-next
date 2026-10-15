import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import { accessOutboxCoverage, accessStateCoverage } from '../work/access-recovery-coverage.ts';
import { readRestoredGraphReleaseProof, RestoreLineageConflict, type RecoveryCoverage,
  assertRestoreAuthorityBaseline, type RestoredGraphReleaseExpectation } from '../work/restore-lineage.ts';
import type { OwnerRestoreEvidence } from './reconcile.ts';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { assertCurrentRecoveryCoverageHead } from '../outbox/recovery-coverage-head.ts';
import { verifyReleasedRestore } from '../owner/restore-release-binding.ts';

export class ErasureAuthorityCoverageConflict extends Error {}

export interface RetainedAuthorityCoverage {
  /** Signed after the last admitted Access change; kept outside the restored owners. */
  sealedCoverage: string;
  hmacKey: string;
}

/** Authenticate the existing retained head/global pointer without comparing restored Access. */
export async function assertRetainedAuthorityCapture(relay: Pool | PoolClient,
  consumer: string, evidence: RetainedAuthorityCoverage): Promise<RecoveryCoverage> {
  let coverage: RecoveryCoverage;
  try { coverage = openRecoveryPayload<RecoveryCoverage>(
    evidence.sealedCoverage, evidence.hmacKey, 'graph-recovery-coverage'); }
  catch (error) { throw new ErasureAuthorityCoverageConflict('signed Access coverage is unavailable', { cause: error }); }
  if (coverage?.relay?.consumer !== consumer
    || !/^[0-9]+$/.test(coverage.accessOutboxCount ?? '')
    || !/^[0-9a-f]{64}$/.test(coverage.accessOutboxDigest ?? '')
    || !/^[0-9]+$/.test(coverage.accessStateCount ?? '')
    || !/^[0-9a-f]{64}$/.test(coverage.accessStateDigest ?? '')) {
    throw new ErasureAuthorityCoverageConflict('signed Access coverage is invalid');
  }
  try { await assertCurrentRecoveryCoverageHead(relay, coverage); }
  catch (error) { throw new ErasureAuthorityCoverageConflict('signed Access coverage is not retained', { cause: error }); }
  const current = (await relay.query<{ consumer: string; coverage_digest: string;
    coverage_generation: string }>(`SELECT consumer, coverage_digest,
      coverage_generation::text AS coverage_generation
    FROM relay.current_authority_coverage WHERE id = true FOR SHARE`)).rows[0];
  const head = (await relay.query<{ coverage_digest: string; generation: string }>(
    `SELECT coverage_digest, generation::text AS generation FROM relay.recovery_coverage_head
     WHERE consumer = $1 FOR SHARE`, [consumer])).rows[0];
  if (!current || !head || current.consumer !== consumer
    || current.coverage_digest !== head.coverage_digest
    || current.coverage_generation !== head.generation) {
    throw new ErasureAuthorityCoverageConflict('a newer retained authority capture supersedes this restore');
  }
  return coverage;
}

/**
 * Offline full Access comparison. Cost is O(Access rows + outbox rows), paged by
 * the owner coverage scanner; no restored route opens while it runs.
 * A supplied Access client keeps the caller's transaction; both scans finish
 * before this operation returns or rejects.
 */
export async function assertRetainedAuthorityCoverage(relay: Pool | PoolClient, access: Pool,
  consumer: string, evidence: RetainedAuthorityCoverage, accessClient?: PoolClient,
  release?: { fuseki: FusekiClient; graphRelease: RestoredGraphReleaseExpectation;
    capturedGeneration: string;
    ownerRestore?: OwnerRestoreEvidence;
    /**
     * The running outer operation whose HMAC-bound qualification and release
     * findings authorize the opened captured+1 phase. The comparison below is
     * then against the coverage that verified finding recorded, never a caller
     * value. An opened fence requires this binding even when the covered rows
     * happen to equal the signed pre-release coverage.
     */
    binding?: { outerReconciliationId: string; erasuresReconciliationId?: string } }): Promise<void> {
  const graphRelease = release ? structuredClone(release.graphRelease) : undefined;
  const coverage = await assertRetainedAuthorityCapture(relay, consumer, evidence);
  const fence = (await (accessClient ?? access).query<{ open: boolean; generation: string }>(
    'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id = true')).rows[0];
  if (release) {
    if (release.ownerRestore) {
      if (!('release' in relay)) throw new ErasureAuthorityCoverageConflict('two-cut release needs the held relay client');
      try {
        const base = openRecoveryPayload<RecoveryCoverage>(release.ownerRestore.baseCoverageEnvelope,
          evidence.hmacKey, 'graph-recovery-coverage');
        await assertRestoreAuthorityBaseline(relay, {
          sealedCoverage: release.ownerRestore.baseCoverageEnvelope,
          retainedAuthorityCoverage: evidence.sealedCoverage, hmacKey: evidence.hmacKey }, base,
        { graphRelease: graphRelease!, ownerRestore: release.ownerRestore });
        if (release.capturedGeneration !== release.ownerRestore.baseFenceGeneration)
          throw new RestoreLineageConflict('release generation differs from signed C0');
      } catch (error) {
        throw new ErasureAuthorityCoverageConflict('two-cut native release relation is invalid', { cause: error });
      }
    }
    const effective = graphRelease!.effective;
    if (!accessClient || !/^(0|[1-9][0-9]{0,18})$/.test(release.capturedGeneration)
      || !release.ownerRestore && (effective.dataEpoch !== coverage.priorDataEpoch
      || effective.graphSequence !== coverage.priorSequence
      || effective.main && (effective.main.dataEpoch !== coverage.relay.dataEpoch
        || effective.main.sequence !== coverage.relay.sequence
        || effective.main.streamScope !== coverage.relay.streamScope))
      || !(await readRestoredGraphReleaseProof(release.fuseki, graphRelease!))) {
      throw new ErasureAuthorityCoverageConflict('native release differs from signed retained authority');
    }
  }
  if (!fence || (fence.open === true
    ? !release || fence.generation !== (BigInt(release.capturedGeneration) + 1n).toString()
    : fence.open !== false || release && fence.generation !== release.capturedGeneration)) {
    throw new ErasureAuthorityCoverageConflict('restored Access recovery fence is open');
  }
  let expected = { outboxCount: coverage.accessOutboxCount, outboxDigest: coverage.accessOutboxDigest,
    stateCount: coverage.accessStateCount, stateDigest: coverage.accessStateDigest };
  if (fence.open && !release?.binding) {
    throw new ErasureAuthorityCoverageConflict('opened Access differs from retained coverage without a release binding');
  }
  if (release?.binding) {
    if (fence.open !== true) {
      throw new ErasureAuthorityCoverageConflict('a release binding needs the opened Access fence');
    }
    try {
      const post = await verifyReleasedRestore({ relay, accessClient: accessClient!, fuseki: release.fuseki, key: evidence.hmacKey,
        outerId: release.binding.outerReconciliationId,
        ...(release.binding.erasuresReconciliationId === undefined ? {}
          : { erasuresReconciliationId: release.binding.erasuresReconciliationId }),
        expectation: graphRelease!, coverage,
        authority: createHash('sha256').update(evidence.sealedCoverage).digest('hex'),
        capturedGeneration: release.capturedGeneration,
        ...(release.ownerRestore ? { ownerRestore: release.ownerRestore } : {}) });
      expected = { outboxCount: post.outbox.count, outboxDigest: post.outbox.digest,
        stateCount: post.state.count, stateDigest: post.state.digest };
    } catch (error) {
      if (error instanceof RestoreLineageConflict) throw new ErasureAuthorityCoverageConflict(error.message, { cause: error });
      throw error;
    }
  }
  const [outbox, state] = accessClient
    ? [await accessOutboxCoverage(access, accessClient), await accessStateCoverage(access, accessClient, coverage.accessStateProfile ?? 'access-state-v5')]
    : await Promise.all([accessOutboxCoverage(access), accessStateCoverage(access, undefined, coverage.accessStateProfile ?? 'access-state-v5')]);
  if (outbox.count !== expected.outboxCount || outbox.digest !== expected.outboxDigest
    || state.count !== expected.stateCount || state.digest !== expected.stateDigest) {
    throw new ErasureAuthorityCoverageConflict(release?.binding
      ? 'Access differs from the coverage its release binding recorded'
      : 'restored Access authority differs from retained coverage');
  }
  if (release && !(await readRestoredGraphReleaseProof(release.fuseki, graphRelease!))) {
    throw new ErasureAuthorityCoverageConflict('native release changed during authority comparison');
  }
}
