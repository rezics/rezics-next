import type { Pool, PoolClient } from 'pg';
import { enqueueIntent } from '../../command/operational.ts';
import { withConnection } from '../../database/pool.ts';
import type { FollowTargetType } from '../follow-model.ts';
import type { CountKey, CountReplacement } from '../contract/index.ts';
import { countRoute, countTransaction, ZERO_COUNT_KEY, type CountRuntime } from './follow-count-runtime.ts';
export { countRoute, countTransaction, ZERO_COUNT_KEY, type CountRuntime } from './follow-count-runtime.ts';
export type { CountKey, CountReplacement } from '../contract/index.ts';
type Client = Pick<PoolClient, 'query'>;

/** The owner counter is the all-writer mutex. Native account share serializes lifecycle;
 * this internal derived operation admits suspended/deleted states without active-account authority. */
export async function lockCountOwner(tx: Client, accountId: string) {
  const route = countRoute(accountId);
  const account = (
    await tx.query<{ state: string; authn_fenced: boolean }>(
      'SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE',
      [route, accountId],
    )
  ).rows[0];
  if (!account) throw new Error('Follow count source account is absent');
  if (account.state === 'deleted' && account.authn_fenced) return { route, active: false, terminal: true };
  await tx.query(
    `INSERT INTO library.follow_count_owner(route,account_id) VALUES($1,$2)
    ON CONFLICT(route,account_id) DO UPDATE SET observed_live_count=library.follow_count_owner.observed_live_count`,
    [route, accountId],
  );
  return {
    route,
    active: account.state === 'active' && !account.authn_fenced,
    terminal: account.state === 'deleted' && account.authn_fenced,
  };
}

/** Native bootstrap observes finite immutable keys; updates behind its cursor are already
 * represented by the installed trigger. Existing negatives/revisions always win first seeding. */
export async function bootstrapFollowCountOwner(deps: CountRuntime, accountId: string) {
  return countTransaction(deps, countRoute(accountId), 'library.follow-count.bootstrap', async (tx) => {
    const owner = await lockCountOwner(tx, accountId);
    if (owner.terminal) return { examined: 0, complete: false };
    const coverage = (
      await tx.query<{
        bootstrap_complete: boolean;
        bootstrap_started: boolean;
        bootstrap_upper: string | null;
        bootstrap_after: string | null;
      }>(
        'SELECT bootstrap_complete,bootstrap_started,bootstrap_upper,bootstrap_after FROM library.follow_count_owner WHERE route=$1 AND account_id=$2',
        [owner.route, accountId],
      )
    ).rows[0]!;
    if (coverage.bootstrap_complete) return { examined: 0, complete: true };
    let upper = coverage.bootstrap_upper;
    if (!coverage.bootstrap_started) {
      upper =
        (
          await tx.query<{ target_id: string }>(
            'SELECT target_id FROM library.follow WHERE route=$1 AND account_id=$2 ORDER BY target_id DESC LIMIT 1',
            [owner.route, accountId],
          )
        ).rows[0]?.target_id ?? null;
      await tx.query(
        'UPDATE library.follow_count_owner SET bootstrap_started=true,bootstrap_upper=$3 WHERE route=$1 AND account_id=$2',
        [owner.route, accountId, upper],
      );
    }
    const rows =
      upper === null
        ? []
        : (
            await tx.query<{ target_id: string; target_type: FollowTargetType; state: string }>(
              `SELECT target_id,target_type,state FROM library.follow WHERE route=$1 AND account_id=$2
       AND target_id>$3 AND target_id<=$4 ORDER BY target_id LIMIT 100`,
              [owner.route, accountId, coverage.bootstrap_after ?? ZERO_COUNT_KEY, upper],
            )
          ).rows;
    for (const row of rows) {
      const inserted = await tx.query(
        `INSERT INTO library.follow_count_source
        (route,account_id,target_type,target_id,revision,source_following,desired_eligible,pending_since)
        VALUES($1,$2,$3,$4,1,$5,$6,statement_timestamp()) ON CONFLICT DO NOTHING RETURNING source_following`,
        [
          owner.route,
          accountId,
          row.target_type,
          row.target_id,
          row.state === 'following',
          owner.active && row.state === 'following',
        ],
      );
      if (inserted.rowCount && row.state === 'following')
        await tx.query(
          'UPDATE library.follow_count_owner SET observed_live_count=observed_live_count+1 WHERE route=$1 AND account_id=$2',
          [owner.route, accountId],
        );
    }
    const complete = rows.length < 100;
    await tx.query(
      `UPDATE library.follow_count_owner SET bootstrap_complete=$3,bootstrap_after=$4 WHERE route=$1 AND account_id=$2`,
      [owner.route, accountId, complete, rows.at(-1)?.target_id ?? coverage.bootstrap_after],
    );
    if (!complete)
      await enqueueIntent(tx, {
        queue: 'maintenance',
        workflowName: 'library.followCountBootstrapOwner',
        workflowId: `library:follow-count:bootstrap:${accountId}:${upper}:${rows.at(-1)!.target_id}`,
        input: { accounts: [], accountId },
      });
    return { examined: rows.length, complete };
  });
}

/** Every target attempt re-reads current source, even a delayed first positive. */
export async function reconcileFollowCountSource(deps: CountRuntime, key: CountKey): Promise<CountReplacement | null> {
  return countTransaction(deps, countRoute(key.accountId), 'library.follow-count.reconcile', async (tx) => {
    const owner = await lockCountOwner(tx, key.accountId);
    if (owner.terminal) return null;
    const args = [owner.route, key.accountId, key.targetType, key.targetId];
    const source = (
      await tx.query<{ revision: string; source_following: boolean; desired_eligible: boolean }>(
        `SELECT revision::text,source_following,desired_eligible FROM library.follow_count_source
       WHERE route=$1 AND account_id=$2 AND target_type=$3 AND target_id=$4 FOR UPDATE`,
        args,
      )
    ).rows[0];
    if (!source) return null; // Unobserved absence cannot authorize a revision or target.
    const raw = (
      await tx.query<{ state: string; target_type: string }>(
        'SELECT state,target_type FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=$3',
        [owner.route, key.accountId, key.targetId],
      )
    ).rows[0];
    const following = raw?.target_type === key.targetType && raw.state === 'following';
    const eligible = owner.active && following;
    let revision = source.revision;
    if (source.source_following !== following || source.desired_eligible !== eligible) {
      const updated = await tx.query<{ revision: string }>(
        `UPDATE library.follow_count_source SET revision=revision+1,
        source_following=$5,desired_eligible=$6,pending_since=LEAST(pending_since,statement_timestamp())
        WHERE route=$1 AND account_id=$2 AND target_type=$3 AND target_id=$4 RETURNING revision::text`,
        [...args, following, eligible],
      );
      revision = updated.rows[0]!.revision;
      if (source.source_following !== following)
        await tx.query(
          `UPDATE library.follow_count_owner
        SET observed_live_count=observed_live_count+$3 WHERE route=$1 AND account_id=$2`,
          [owner.route, key.accountId, following ? 1 : -1],
        );
    }
    return { ...key, revision, eligible };
  });
}

export async function acknowledgeFollowCount(deps: CountRuntime, replacement: CountReplacement) {
  return countTransaction(deps, countRoute(replacement.accountId), 'library.follow-count.ack', async (tx) => {
    await lockCountOwner(tx, replacement.accountId);
    await tx.query(
      `UPDATE library.follow_count_source SET pending_since=NULL
      WHERE route=$1 AND account_id=$2 AND target_type=$3 AND target_id=$4 AND revision=$5`,
      [
        countRoute(replacement.accountId),
        replacement.accountId,
        replacement.targetType,
        replacement.targetId,
        replacement.revision,
      ],
    );
  });
}

export async function pendingFollowCountKeys(pool: Pool, partition: number): Promise<CountKey[]> {
  return withConnection(pool, async (tx) =>
    (
      await tx.query<{ account_id: string; target_type: FollowTargetType; target_id: string }>(
        `SELECT account_id,target_type,target_id FROM library.follow_count_source WHERE partition_no=$1
     AND pending_since IS NOT NULL ORDER BY pending_since,route,account_id,target_type,target_id LIMIT 100`,
        [partition],
      )
    ).rows.map((row) => ({ accountId: row.account_id, targetType: row.target_type, targetId: row.target_id })),
  );
}
