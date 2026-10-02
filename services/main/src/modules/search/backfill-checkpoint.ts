import type { Pool } from 'pg';

export async function nameBackfillCheckpoint(pool: Pool, epoch: string, profile: string) {
  const row = (
    await pool.query<{ after_resource: string; complete: boolean }>(
      `SELECT after_resource, complete FROM access.public_name_backfill_checkpoint
     WHERE data_epoch=$1 AND profile=$2`,
      [epoch, profile],
    )
  ).rows[0];
  return { after: row?.after_resource ?? '', complete: row?.complete ?? false };
}

/** A lost checkpoint replays the committed graph receipt. Concurrent runners
 * cannot move the durable key backwards. */
export async function saveNameBackfillCheckpoint(
  pool: Pool,
  epoch: string,
  profile: string,
  after: string,
  complete: boolean,
) {
  await pool.query(
    `INSERT INTO access.public_name_backfill_checkpoint
    (data_epoch,profile,after_resource,complete) VALUES ($1,$2,$3,$4)
    ON CONFLICT (data_epoch,profile) DO UPDATE SET
      after_resource=GREATEST(access.public_name_backfill_checkpoint.after_resource,EXCLUDED.after_resource),
      complete=access.public_name_backfill_checkpoint.complete OR EXCLUDED.complete,
      updated_at=clock_timestamp()`,
    [epoch, profile, after, complete],
  );
}
