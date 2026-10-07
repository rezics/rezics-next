import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { reconcileNamePreferences } from './name-preferences.ts';
import {
  backfillPublicNameBatch,
  repairPublicNameBatch,
  PUBLIC_NAME_BACKFILL_PROFILE,
} from './names.ts';
import { nameBackfillCheckpoint, saveNameBackfillCheckpoint } from './backfill-checkpoint.ts';

/** Bounded operator turn; durable keysets and idempotent graph receipts resume
 * across crashes. Policies finish first, so private/unlisted legacy names are
 * never published. Native writes maintain both projections during migration. */
export async function backfillPublicNameProjections(
  env: WorkActivationEnvironment,
  pool: Pool,
  batches = 64,
  restart = false,
) {
  if (!Number.isSafeInteger(batches) || batches < 1 || batches > 100_000)
    throw new Error('Backfill batches must be between 1 and 100000');
  if (restart)
    await pool.query(
      `DELETE FROM access.public_name_backfill_checkpoint
    WHERE data_epoch=$1 AND profile=ANY($2::text[])`,
      [env.lineage.dataEpoch, ['agent-name-policy-v2', PUBLIC_NAME_BACKFILL_PROFILE]],
    );
  let processed = 0;
  const started = Date.now();
  for (let step = 0; step < batches && Date.now() - started < 480_000; step++) {
    const policies = await reconcileNamePreferences(env, pool);
    processed += policies.processed;
    if (!policies.complete) continue;
    const checkpoint = await nameBackfillCheckpoint(
      pool,
      env.lineage.dataEpoch,
      PUBLIC_NAME_BACKFILL_PROFILE,
    );
    if (checkpoint.complete) {
      if ((await repairPublicNameBatch(env)).complete)
        return { complete: true, processed, after: checkpoint.after };
      continue;
    }
    const result = await backfillPublicNameBatch(env, checkpoint.after);
    processed += result.processed;
    await saveNameBackfillCheckpoint(
      pool,
      env.lineage.dataEpoch,
      PUBLIC_NAME_BACKFILL_PROFILE,
      result.after,
      result.complete,
    );
    if (result.complete && (await repairPublicNameBatch(env)).complete)
      return { complete: true, processed, after: result.after };
  }
  return { complete: false, processed };
}
