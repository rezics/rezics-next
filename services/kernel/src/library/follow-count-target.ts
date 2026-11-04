import type { CommandTransaction } from '../command/command.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { partitionOf } from '../route/route.ts';
import { workStepDeadline } from './command-support.ts';
import {
  acknowledgeFollowCount,
  countRoute,
  countTransaction,
  lockCountOwner,
  reconcileFollowCountSource,
  type CountKey,
  type CountReplacement,
  type CountRuntime,
} from './follow-count-source.ts';

export type CountDestination = { targetId: string; route: number; epoch: bigint | null };
export class FollowCountUnavailableError extends Error {
  constructor(message = 'Private follow counts are not ready') {
    super(message);
    this.name = 'FollowCountUnavailableError';
  }
}
export class FollowCountTargetAbsentError extends Error {}
export async function resolveCountDestination(
  deps: Pick<CountRuntime, 'pool'>,
  key: Pick<CountKey, 'targetType' | 'targetId'>,
): Promise<CountDestination> {
  if (key.targetType !== 'subject') return { targetId: key.targetId, route: countRoute(key.targetId), epoch: null };
  const mapping = await identityEpochStore.readMapping(deps.pool, key.targetId);
  if (mapping.state === 'absent') throw new FollowCountTargetAbsentError();
  if (mapping.state !== 'mapped') throw new FollowCountUnavailableError('Current count identity is unavailable');
  return { targetId: mapping.terminal, route: countRoute(mapping.terminal), epoch: mapping.epoch };
}
async function lockFollower(tx: CommandTransaction, partition: number, accountId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`follow-count:${partition}:${accountId}`]);
}

/** One target transaction accepts current replacements, including first negatives. */
export async function applyFollowCount(
  deps: CountRuntime,
  replacement: CountReplacement,
  destination: CountDestination,
) {
  const partition = partitionOf(destination.route);
  return (
    await runCommand(deps.pool, { partition, deadline: workStepDeadline() }, async (tx) => {
      await lockFollower(tx, partition, replacement.accountId);
      const fenced = await tx.query(
        'SELECT 1 FROM library.follow_count_terminal_follower WHERE partition_no=$1 AND account_id=$2',
        [partition, replacement.accountId],
      );
      if (fenced.rowCount) return noEffect({ fenced: true });
      if (replacement.targetType === 'subject') {
        if (destination.epoch === null) throw new FollowCountUnavailableError();
        await identityEpochStore.admitHomeEffect(tx, {
          kind: 'follow-count',
          original: replacement.targetId,
          terminal: destination.targetId,
          epoch: destination.epoch,
        });
      }
      const target = [destination.route, replacement.targetType, destination.targetId];
      // The single total lock also orders concurrent support changes for this target.
      const total = await tx.query(
        'SELECT total FROM library.follow_count_total WHERE route=$1 AND target_type=$2 AND target_id=$3 FOR UPDATE',
        target,
      );
      if (!total.rowCount) throw new FollowCountUnavailableError('Target total has not been initialized');
      const args = [...target, replacement.accountId, replacement.targetId];
      const previous = (
        await tx.query<{ revision: string; eligible: boolean }>(
          `SELECT revision::text,eligible FROM library.follow_count_pair
      WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4 AND original_id=$5 FOR UPDATE`,
          args,
        )
      ).rows[0];
      if (previous) {
        const comparison = BigInt(replacement.revision) - BigInt(previous.revision);
        if (comparison < 0n) return noEffect({ fenced: false });
        if (comparison === 0n) {
          if (previous.eligible !== replacement.eligible)
            throw new Error('Conflicting equal follow replacement revision');
          return noEffect({ fenced: false });
        }
      }
      await tx.query(
        `INSERT INTO library.follow_count_support(route,target_type,target_id,account_id,support)
      VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING`,
        args.slice(0, 4),
      );
      const support = (
        await tx.query<{ support: string }>(
          `SELECT support::text FROM library.follow_count_support
      WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4 FOR UPDATE`,
          args.slice(0, 4),
        )
      ).rows[0]!;
      const before = BigInt(support.support);
      const after = before + BigInt(Number(replacement.eligible) - Number(previous?.eligible ?? false));
      await tx.query(
        `INSERT INTO library.follow_count_pair(route,target_type,target_id,account_id,original_id,revision,eligible)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(route,target_type,target_id,account_id,original_id)
      DO UPDATE SET revision=EXCLUDED.revision,eligible=EXCLUDED.eligible`,
        [...args, replacement.revision, replacement.eligible],
      );
      await tx.query(
        `UPDATE library.follow_count_support SET support=$5 WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4`,
        [...args.slice(0, 4), after.toString()],
      );
      if ((before === 0n) !== (after === 0n))
        await tx.query(
          `UPDATE library.follow_count_total SET total=total+$4
      WHERE route=$1 AND target_type=$2 AND target_id=$3`,
          [...target, after === 0n ? -1 : 1],
        );
      return {
        value: { fenced: false },
        events: [
          {
            type: 'com.rezics.library.follow-count.applied.v1',
            subject: replacement.accountId,
            data: { targetId: replacement.targetId },
          },
        ],
      };
    })
  ).value;
}

/** Saved work carries locators only. Each attempt releases the source before target checkout. */
export async function deliverFollowCount(deps: CountRuntime, key: CountKey) {
  const destination = await resolveCountDestination(deps, key);
  const replacement = await reconcileFollowCountSource(deps, key);
  if (!replacement) return;
  const staged = await countTransaction(
    deps,
    countRoute(key.accountId),
    'library.follow-count.destination',
    async (tx) => {
      const owner = await lockCountOwner(tx, key.accountId);
      if (owner.terminal) return false;
      const current = await tx.query(
        `SELECT 1 FROM library.follow_count_source WHERE route=$1 AND account_id=$2
      AND target_type=$3 AND target_id=$4 AND revision=$5`,
        [owner.route, key.accountId, key.targetType, key.targetId, replacement.revision],
      );
      if (!current.rowCount) return false;
      await tx.query(
        `INSERT INTO library.follow_count_destination(route,account_id,target_type,original_id,destination_route,destination_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [owner.route, key.accountId, key.targetType, key.targetId, destination.route, destination.targetId],
      );
      return true;
    },
  );
  if (!staged) return;
  await applyFollowCount(deps, replacement, destination);
  await acknowledgeFollowCount(deps, replacement);
}

/** Terminal-only local receiving withdrawal. The installed fence outlives every saved packet. */
export async function withdrawFollowCountDestination(
  deps: CountRuntime,
  accountId: string,
  destination: { route: number; targetType: string; targetId: string; originalId: string },
) {
  const accountRoute = countRoute(accountId);
  // Real terminal authority is read at its native home, released before the target.
  const terminal = await countTransaction(
    deps,
    accountRoute,
    'library.follow-count.terminal-authority',
    async (tx) => (await lockCountOwner(tx, accountId)).terminal,
  );
  if (!terminal) throw new Error('Follow count withdrawal requires terminal account authority');
  await runCommand(
    deps.pool,
    { partition: partitionOf(destination.route), deadline: workStepDeadline() },
    async (tx) => {
      await lockFollower(tx, partitionOf(destination.route), accountId);
      const fence = await tx.query(
        `INSERT INTO library.follow_count_terminal_follower(partition_no,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING account_id`,
        [partitionOf(destination.route), accountId],
      );
      const args = [destination.route, destination.targetType, destination.targetId, accountId];
      await tx.query(
        'SELECT total FROM library.follow_count_total WHERE route=$1 AND target_type=$2 AND target_id=$3 FOR UPDATE',
        args.slice(0, 3),
      );
      const pair = (
        await tx.query<{ eligible: boolean }>(
          `DELETE FROM library.follow_count_pair WHERE route=$1 AND target_type=$2
      AND target_id=$3 AND account_id=$4 AND original_id=$5 RETURNING eligible`,
          [...args, destination.originalId],
        )
      ).rows[0];
      if (pair?.eligible) {
        const support = (
          await tx.query<{ support: string }>(
            `UPDATE library.follow_count_support SET support=support-1
        WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4 RETURNING support::text`,
            args,
          )
        ).rows[0];
        if (!support) throw new Error('Missing follow support during terminal withdrawal');
        if (BigInt(support.support) === 0n)
          await tx.query(
            `UPDATE library.follow_count_total SET total=total-1 WHERE route=$1 AND target_type=$2 AND target_id=$3`,
            args.slice(0, 3),
          );
      }
      await tx.query(
        `DELETE FROM library.follow_count_support WHERE route=$1 AND target_type=$2 AND target_id=$3 AND account_id=$4 AND support=0`,
        args,
      );
      return fence.rowCount || pair
        ? {
            value: null,
            events: [{ type: 'com.rezics.library.follow-count.withdrawn.v1', subject: accountId, data: {} }],
          }
        : noEffect(null);
    },
  );
}
