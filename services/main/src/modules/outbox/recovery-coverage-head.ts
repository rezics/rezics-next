import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { openRecoveryPayload } from '../../../../account/src/recovery-envelope.ts';
import { assertRecoveryCoverage, type RecoveryCoverage } from '../work/restore-lineage.ts';

export class RecoveryCoverageHeadConflict extends Error {}

export interface RecoveryCoverageHeadOptions {
  /** Operator-configured private custody directory; the signed reference contains only a digest. */
  attachmentDirectory?: string;
}

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
  relay: Pool | PoolClient, sealedCoverage: string, hmacKey: string,
  options: RecoveryCoverageHeadOptions = {},
): Promise<void> {
  const coverage = openRecoveryPayload<RecoveryCoverage>(
    sealedCoverage, hmacKey, 'graph-recovery-coverage');
  if (!coverage?.relay?.consumer || !coverage.priorDataEpoch || !coverage.priorSequence) {
    throw new RecoveryCoverageHeadConflict('recovery coverage identity is unavailable');
  }
  assertRecoveryCoverage(coverage);
  if (!coverage.erasureJournal) {
    throw new RecoveryCoverageHeadConflict('recovery coverage lacks its signed erasure journal frontier');
  }
  if (coverage.nativeAccessErasure) {
    const reference = coverage.nativeAccessErasure;
    if (!options.attachmentDirectory) {
      throw new RecoveryCoverageHeadConflict('native Access attachment directory is not configured');
    }
    const path = join(resolve(options.attachmentDirectory), `${reference.ciphertextDigest}.gpg`);
    let stat;
    try { stat = lstatSync(path); }
    catch { throw new RecoveryCoverageHeadConflict('encrypted native Access attachment is incomplete'); }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || stat.size !== Number(reference.ciphertextBytes)) {
      throw new RecoveryCoverageHeadConflict('encrypted native Access attachment is incomplete');
    }
    const hash = createHash('sha256');
    try { for await (const chunk of createReadStream(path)) hash.update(chunk); }
    catch { throw new RecoveryCoverageHeadConflict('encrypted native Access attachment is unreadable'); }
    if (hash.digest('hex') !== reference.ciphertextDigest) {
      throw new RecoveryCoverageHeadConflict('encrypted native Access attachment digest differs from C1');
    }
  }

  const borrowed = 'release' in relay;
  const client = borrowed ? relay as PoolClient : await (relay as Pool).connect();
  let savepoint = false;
  try {
    if (!borrowed) await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    else {
      const isolation = (await client.query<{ value: string }>(
        "SELECT current_setting('transaction_isolation') AS value")).rows[0]?.value;
      const readOnly = (await client.query<{ value: string }>(
        "SELECT current_setting('transaction_read_only') AS value")).rows[0]?.value;
      if (isolation !== 'read committed' || readOnly !== 'off') {
        throw new RecoveryCoverageHeadConflict('borrowed recovery head requires an active writable READ COMMITTED transaction');
      }
    }
    await client.query('SAVEPOINT recovery_coverage_head_publish');
    savepoint = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
    const liveEpoch = (await client.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]?.epoch ?? null;
    if (liveEpoch !== coverage.erasureJournal.epoch) {
      throw new RecoveryCoverageHeadConflict('relay erasure journal moved after current coverage capture');
    }
    const result = await client.query(
    `INSERT INTO relay.recovery_coverage_head (consumer, coverage_digest, erasure_epoch)
     VALUES ($1, $2, $3) ON CONFLICT (consumer) DO UPDATE SET
       erasure_epoch = EXCLUDED.erasure_epoch,
       coverage_digest = EXCLUDED.coverage_digest,
       generation = relay.recovery_coverage_head.generation + 1,
       captured_at = clock_timestamp()`,
    [coverage.relay.consumer, digest(coverage), coverage.erasureJournal.epoch]);
    if (result.rowCount !== 1) {
      throw new RecoveryCoverageHeadConflict('current recovery coverage was not retained');
    }
    await client.query('RELEASE SAVEPOINT recovery_coverage_head_publish');
    savepoint = false;
    if (!borrowed) await client.query('COMMIT');
  } catch (error) {
    if (savepoint) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT recovery_coverage_head_publish');
        await client.query('RELEASE SAVEPOINT recovery_coverage_head_publish');
      } catch { /* preserve publication failure */ }
    }
    if (!borrowed) { try { await client.query('ROLLBACK'); } catch { /* preserve publication failure */ } }
    throw error instanceof RecoveryCoverageHeadConflict ? error
      : new RecoveryCoverageHeadConflict('current recovery coverage was not retained');
  } finally {
    if (!borrowed) client.release();
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
