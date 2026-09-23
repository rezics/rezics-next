import type { Pool } from 'pg';

export class PgRecoveryFrontierConflict extends Error {}

export interface PgRecoveryFrontier {
  systemIdentifier: string;
  flushedLsn: string;
  walFile: string;
}

/** Capture only after the owner is quiesced; store this outside its PostgreSQL backup. */
export async function capturePgRecoveryFrontier(pool: Pool): Promise<PgRecoveryFrontier> {
  const result = await pool.query<{ system_identifier: string; flushed_lsn: string; wal_file: string }>(
    `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
       pg_current_wal_flush_lsn()::text AS flushed_lsn,
       pg_walfile_name(pg_current_wal_flush_lsn()) AS wal_file`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row
    || !/^[0-9]+$/.test(row.system_identifier)
    || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(row.flushed_lsn)
    || !/^[0-9A-F]{24}$/i.test(row.wal_file)) {
    throw new PgRecoveryFrontierConflict('PostgreSQL source frontier is unavailable');
  }
  return { systemIdentifier: row.system_identifier,
    flushedLsn: row.flushed_lsn, walFile: row.wal_file };
}

/** A promoted isolated restore must have replayed through the recorded source LSN. */
export async function assertPgRecoveryFrontier(pool: Pool, frontier: PgRecoveryFrontier): Promise<void> {
  if (!/^[0-9]+$/.test(frontier?.systemIdentifier ?? '')
    || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(frontier?.flushedLsn ?? '')
    || !/^[0-9A-F]{24}$/i.test(frontier?.walFile ?? '')) {
    throw new PgRecoveryFrontierConflict('invalid PostgreSQL recovery frontier');
  }
  const result = await pool.query<{ system_identifier: string; recovering: boolean;
    replay_lsn: string | null; covered: boolean | null }>(
    `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
       pg_is_in_recovery() AS recovering,
       pg_last_wal_replay_lsn()::text AS replay_lsn,
       pg_last_wal_replay_lsn() >= $1::pg_lsn AS covered`, [frontier.flushedLsn]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.system_identifier !== frontier.systemIdentifier
    || row.recovering || !row.replay_lsn || row.covered !== true) {
    throw new PgRecoveryFrontierConflict('PostgreSQL restore did not reach retained WAL frontier');
  }
}
