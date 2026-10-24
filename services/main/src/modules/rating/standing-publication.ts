import type { Pool } from 'pg';
import { lockRatingObservationTarget, RatingInventoryConflict, withInventoryClient } from './aggregate-inventory.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Native trigger work is at most the native slot and one retained projection
 * per changed head (so at most 200 slot deltas per 100-head reconstruction).
 * Remaining projections use this independent, explicitly bounded owner page. */
export const STANDING_PUBLICATION_COST = { projections: 100, slotRefreshesPerHead: 2, deadlineMs: 10_000 } as const;

export interface StandingTransitionCut {
  sourceWork: string;
  sourceMainVersion: string;
  survivorWork: string;
  survivorMainVersion: string;
  originalKey: string | null;
}

/** Commit BEFORE any graph identity effect. Never borrow an outer transaction:
 * a graph command can survive its caller's native rollback. Only the existing
 * journal's final completion settles this durable, conservative fence. A settled
 * fence may verify a replayed receipt, but cannot authorize a new graph effect. */
export async function fenceStandingRatingTransition(pool: Pool, taskKey: string, cut: StandingTransitionCut,
  signal = AbortSignal.timeout(STANDING_PUBLICATION_COST.deadlineMs)): Promise<'preparing' | 'pending' | 'finished'> {
  const taskId = /^editorial:[0-9a-f-]{36}:[1-9][0-9]*$/;
  if (!taskId.test(taskKey) || ![cut.sourceWork,cut.sourceMainVersion,cut.survivorWork,cut.survivorMainVersion].every(value => nativeId.test(value))
    || cut.sourceWork === cut.survivorWork || cut.sourceMainVersion === cut.survivorMainVersion
    || cut.originalKey !== null && (!taskId.test(cut.originalKey) || cut.originalKey === taskKey)) throw new RatingInventoryConflict('invalid merge cut');
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = (await client.query('SELECT open FROM access.recovery_fence WHERE id FOR SHARE')).rows[0];
    if (fence?.open !== true) throw new RatingInventoryConflict('Recovery fence changed');
    signal.throwIfAborted();
    const bound = await client.query(`INSERT INTO access.rating_standing_transition
      (task_key,source_work,source_main_version,survivor_work,survivor_main_version,original_key,finished)
      VALUES($1,$2,$3,$4,$5,$6,EXISTS (SELECT 1 FROM access.identity_merge_completion WHERE task_key=$1))
      ON CONFLICT (task_key) DO UPDATE SET source_work=EXCLUDED.source_work,source_main_version=EXCLUDED.source_main_version,
        survivor_work=EXCLUDED.survivor_work,survivor_main_version=EXCLUDED.survivor_main_version,original_key=EXCLUDED.original_key
      WHERE (rating_standing_transition.source_work IS NULL OR rating_standing_transition.source_work=EXCLUDED.source_work)
        AND (rating_standing_transition.survivor_work IS NULL OR rating_standing_transition.survivor_work=EXCLUDED.survivor_work)
        AND (rating_standing_transition.source_main_version IS NULL OR rating_standing_transition.source_main_version=EXCLUDED.source_main_version)
        AND (rating_standing_transition.survivor_main_version IS NULL OR rating_standing_transition.survivor_main_version=EXCLUDED.survivor_main_version)
        AND rating_standing_transition.original_key IS NOT DISTINCT FROM EXCLUDED.original_key
      RETURNING task_key,finished`, [taskKey,cut.sourceWork,cut.sourceMainVersion,cut.survivorWork,cut.survivorMainVersion,cut.originalKey]);
    if (bound.rows.length !== 1) throw new RatingInventoryConflict('Merge publication cut changed');
    // Discovery has the same page bound as delivery. Commit its cursor even
    // when another page is needed; graph effects are admitted only afterwards.
    const progress = (await client.query('SELECT steps,prepared FROM access.advance_rating_standing_transition($1,$2)',
      [taskKey,STANDING_PUBLICATION_COST.projections])).rows[0];
    if (!progress || typeof progress.prepared !== 'boolean') throw new RatingInventoryConflict('Merge publication preparation is unavailable');
    signal.throwIfAborted();
    await client.query('COMMIT');
    signal.throwIfAborted();
    return bound.rows[0].finished === true ? 'finished' : progress.prepared ? 'pending' : 'preparing';
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}

/** Resume one retained-projection page. The source gate precedes the job lock,
 * as in admission/reconstruction, so a new source seal resets the cursor only
 * before or after this whole page. Selections added behind the cursor already
 * refresh their own slot; removals likewise subtract their own contribution.
 * Only components with stale effective contributions wait for an origin job.
 * Completed unmerges also remove revoked inherited selections in bounded pages;
 * their retained ancestry prevents an unrelated witness from attesting them. */
export async function refreshStandingRatingProjections(pool: Pool,
  input: { context?: string; limit?: number } = {},
  signal = AbortSignal.timeout(STANDING_PUBLICATION_COST.deadlineMs)) {
  const limit = input.limit ?? STANDING_PUBLICATION_COST.projections;
  if (input.context !== undefined && !nativeId.test(input.context) || !Number.isInteger(limit)
    || limit < 1 || limit > STANDING_PUBLICATION_COST.projections) {
    throw new RatingInventoryConflict('invalid standing publication page');
  }
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = (await client.query('SELECT open,generation FROM access.recovery_fence WHERE id FOR SHARE')).rows[0];
    if (fence?.open !== true) throw new RatingInventoryConflict('Recovery fence changed');
    const pending = async () => (await client.query(`SELECT context,origin_main_version,origin_slot
      FROM access.rating_standing_refresh WHERE phase<>'prepared' ${input.context === undefined ? '' : 'AND context=$1'}
      ORDER BY context,origin_main_version,origin_slot LIMIT 1`, input.context === undefined ? [] : [input.context])).rows[0];
    const job = await pending();
    let refreshed = 0;
    if (job) {
      signal.throwIfAborted();
      await client.query('SELECT 1 FROM access.scope_gate WHERE id=$1 FOR SHARE', [`rating:observe:${job.context}`]);
      await lockRatingObservationTarget(client, job.context, job.origin_main_version);
      const key = [job.context, job.origin_main_version, job.origin_slot];
      const current = (await client.query(`SELECT after_main_version,after_principal_id,phase
        FROM access.rating_standing_refresh WHERE context=$1 AND origin_main_version=$2 AND origin_slot=$3 FOR UPDATE`, key)).rows[0];
      if (current?.phase === 'invalidate') {
        signal.throwIfAborted();
        await client.query('SELECT access.advance_rating_standing_invalidation($1,$2,$3,$4)', [...key,limit]);
      } else if (current && current.phase !== 'prepared') {
        const rows = (await client.query(`SELECT main_version,principal_id FROM access.rating_merge_selection
          WHERE context=$1 AND origin_main_version=$2 AND origin_slot=$3
            AND (main_version,principal_id)>($4,$5::uuid)
          ORDER BY main_version,principal_id LIMIT $6`,
        [...key, current.after_main_version, current.after_principal_id, limit + 1])).rows;
        for (const row of rows.slice(0, limit)) {
          signal.throwIfAborted();
          await client.query('SELECT access.refresh_rating_standing_slot($1,$2,$3::uuid)', [job.context, row.main_version, row.principal_id]);
          refreshed++;
        }
        signal.throwIfAborted();
        if (rows.length > limit) {
          const last = rows[limit - 1]!;
          await client.query(`UPDATE access.rating_standing_refresh SET after_main_version=$4,after_principal_id=$5
            WHERE context=$1 AND origin_main_version=$2 AND origin_slot=$3`, [...key, last.main_version, last.principal_id]);
        } else {
          await client.query('DELETE FROM access.rating_standing_refresh WHERE context=$1 AND origin_main_version=$2 AND origin_slot=$3', key);
        }
      }
    }
    if (!job) {
      signal.throwIfAborted();
      const cleanup = (await client.query('SELECT access.cleanup_rating_standing_projections($1,$2) AS refreshed',
        [input.context ?? null,limit])).rows[0];
      refreshed = Number(cleanup?.refreshed ?? 0);
    }
    signal.throwIfAborted();
    await client.query('COMMIT');
    signal.throwIfAborted();
    // Report continuation exhaustion, not a global availability policy. Reads
    // independently recheck their own component, identity cut and revocation.
    const state = (await client.query(`SELECT f.generation AS recovery_generation,
      access.rating_standing_continuation_complete($1) AS complete
      FROM access.recovery_fence f WHERE f.id AND f.open`, [input.context ?? null])).rows[0];
    if (!state || state.recovery_generation !== fence.generation) throw new RatingInventoryConflict('Standing publication fence is unavailable');
    signal.throwIfAborted();
    return { refreshed, complete: state.complete === true, recoveryGeneration: String(fence.generation) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}
