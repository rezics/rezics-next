import type { Pool } from 'pg';
import { lockRatingObservationTarget, RatingInventoryConflict, withInventoryClient } from './aggregate-inventory.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Native trigger work is at most the native slot and one retained projection
 * per changed head (so at most 200 slot deltas per 100-head reconstruction).
 * Remaining projections use this independent, explicitly bounded owner page. */
export const STANDING_PUBLICATION_COST = { projections: 100, slotRefreshesPerHead: 2, deadlineMs: 10_000 } as const;

/** Commit BEFORE any graph identity effect. Never borrow an outer transaction:
 * a graph command can survive its caller's native rollback. Only the existing
 * journal's final completion removes this durable, conservative fence. */
export async function fenceStandingRatingTransition(pool: Pool, taskKey: string,
  signal = AbortSignal.timeout(STANDING_PUBLICATION_COST.deadlineMs)): Promise<void> {
  if (!/^editorial:[0-9a-f-]{36}:[1-9][0-9]*$/.test(taskKey)) throw new RatingInventoryConflict('invalid merge task');
  return withInventoryClient(pool, signal, async client => { try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = (await client.query('SELECT open FROM access.recovery_fence WHERE id FOR SHARE')).rows[0];
    if (fence?.open !== true) throw new RatingInventoryConflict('Recovery fence changed');
    signal.throwIfAborted();
    await client.query(`INSERT INTO access.rating_standing_transition(task_key)
      SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM access.identity_merge_completion WHERE task_key=$1)
      ON CONFLICT DO NOTHING`, [taskKey]);
    signal.throwIfAborted();
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}

/** Resume one retained-projection page. The source gate precedes the job lock,
 * as in admission/reconstruction, so a new source seal resets the cursor only
 * before or after this whole page. Selections added behind the cursor already
 * refresh their own slot; removals likewise subtract their own contribution.
 * Pending pages and interrupted identity tasks keep ALL standing reads held,
 * rather than publishing an exact-looking mixture from any affected component. */
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
      FROM access.rating_standing_refresh ${input.context === undefined ? '' : 'WHERE context=$1'}
      ORDER BY context,origin_main_version,origin_slot LIMIT 1`, input.context === undefined ? [] : [input.context])).rows[0];
    const job = await pending();
    let refreshed = 0;
    if (job) {
      signal.throwIfAborted();
      await client.query('SELECT 1 FROM access.scope_gate WHERE id=$1 FOR SHARE', [`rating:observe:${job.context}`]);
      await lockRatingObservationTarget(client, job.context, job.origin_main_version);
      const key = [job.context, job.origin_main_version, job.origin_slot];
      const current = (await client.query(`SELECT after_main_version,after_principal_id
        FROM access.rating_standing_refresh WHERE context=$1 AND origin_main_version=$2 AND origin_slot=$3 FOR UPDATE`, key)).rows[0];
      if (current) {
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
    signal.throwIfAborted();
    await client.query('SELECT access.prune_rating_standing_changes()');
    signal.throwIfAborted();
    await client.query('COMMIT');
    signal.throwIfAborted();
    // An AFTER trigger appended this transaction's publication change. Its xid
    // can settle only after COMMIT; inspect readiness in a fresh snapshot.
    const state = (await client.query(`SELECT p.pending,p.generation,f.generation AS recovery_generation,
      NOT EXISTS (SELECT 1 FROM access.rating_standing_refresh ${input.context === undefined ? '' : 'WHERE context=$1'}
        LIMIT 1) AS complete FROM access.rating_standing_publication() p CROSS JOIN access.recovery_fence f WHERE f.id AND f.open`,
    input.context === undefined ? [] : [input.context])).rows[0];
    if (!state || state.recovery_generation !== fence.generation) throw new RatingInventoryConflict('Standing publication fence is unavailable');
    signal.throwIfAborted();
    return { refreshed, complete: state.complete === true, publicationReady: String(state.pending) === '0',
      recoveryGeneration: String(fence.generation), publicationGeneration: String(state.generation) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } });
}
