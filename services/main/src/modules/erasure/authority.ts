import type { Pool, PoolClient } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import { accessOutboxCoverage, accessStateCoverage } from '../work/access-recovery-coverage.ts';
import type { RecoveryCoverage } from '../work/restore-lineage.ts';
import { assertCurrentRecoveryCoverageHead } from '../outbox/recovery-coverage-head.ts';

export class ErasureAuthorityCoverageConflict extends Error {}

export interface RetainedAuthorityCoverage {
  /** Signed after the last admitted Access change; kept outside the restored owners. */
  sealedCoverage: string;
  hmacKey: string;
}

/**
 * Offline full Access comparison. Cost is O(Access rows + outbox rows), paged by
 * the owner coverage scanner; no restored route opens while it runs.
 */
export async function assertRetainedAuthorityCoverage(relay: Pool | PoolClient, access: Pool,
  consumer: string, evidence: RetainedAuthorityCoverage): Promise<void> {
  let coverage: RecoveryCoverage;
  try { coverage = openRecoveryPayload<RecoveryCoverage>(
    evidence.sealedCoverage, evidence.hmacKey, 'graph-recovery-coverage'); }
  catch { throw new ErasureAuthorityCoverageConflict('signed Access coverage is unavailable'); }
  if (coverage?.relay?.consumer !== consumer
    || !/^[0-9]+$/.test(coverage.accessOutboxCount ?? '')
    || !/^[0-9a-f]{64}$/.test(coverage.accessOutboxDigest ?? '')
    || !/^[0-9]+$/.test(coverage.accessStateCount ?? '')
    || !/^[0-9a-f]{64}$/.test(coverage.accessStateDigest ?? '')) {
    throw new ErasureAuthorityCoverageConflict('signed Access coverage is invalid');
  }
  try { await assertCurrentRecoveryCoverageHead(relay, coverage); }
  catch { throw new ErasureAuthorityCoverageConflict('signed Access coverage is not retained'); }
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
  const fence = (await access.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0];
  if (fence?.open !== false) {
    throw new ErasureAuthorityCoverageConflict('restored Access recovery fence is open');
  }
  const [outbox, state] = await Promise.all([
    accessOutboxCoverage(access), accessStateCoverage(access),
  ]);
  if (outbox.count !== coverage.accessOutboxCount || outbox.digest !== coverage.accessOutboxDigest
    || state.count !== coverage.accessStateCount || state.digest !== coverage.accessStateDigest) {
    throw new ErasureAuthorityCoverageConflict('restored Access authority differs from retained coverage');
  }
}
