import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import type { RecoveryCoverage } from '../work/restore-lineage.ts';

export class RecoveryCoverageHeadConflict extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(coverage: RecoveryCoverage): string {
  return createHash('sha256').update(JSON.stringify(canonical(coverage))).digest('hex');
}

/** Call only from a single quiesced capture writer, against the separately retained relay. */
export async function retainRecoveryCoverageHead(
  relay: Pool, sealedCoverage: string, hmacKey: string,
): Promise<void> {
  const coverage = openRecoveryPayload<RecoveryCoverage>(
    sealedCoverage, hmacKey, 'graph-recovery-coverage');
  if (!coverage?.relay?.consumer || !coverage.priorDataEpoch || !coverage.priorSequence) {
    throw new RecoveryCoverageHeadConflict('recovery coverage identity is unavailable');
  }
  const result = await relay.query(
    `INSERT INTO relay.recovery_coverage_head (consumer, coverage_digest)
     VALUES ($1, $2) ON CONFLICT (consumer) DO UPDATE SET
       coverage_digest = EXCLUDED.coverage_digest,
       generation = relay.recovery_coverage_head.generation + 1,
       captured_at = clock_timestamp()`,
    [coverage.relay.consumer, digest(coverage)]);
  if (result.rowCount !== 1) {
    throw new RecoveryCoverageHeadConflict('current recovery coverage was not retained');
  }
}

export async function assertCurrentRecoveryCoverageHead(
  relay: Pool | PoolClient, coverage: RecoveryCoverage,
): Promise<void> {
  const retained = await relay.query<{ coverage_digest: string }>(
    'SELECT coverage_digest FROM relay.recovery_coverage_head WHERE consumer = $1 FOR SHARE',
    [coverage.relay.consumer]);
  if (retained.rows.length !== 1 || retained.rows[0]?.coverage_digest !== digest(coverage)) {
    throw new RecoveryCoverageHeadConflict('signed recovery coverage is not the retained current capture');
  }
}
