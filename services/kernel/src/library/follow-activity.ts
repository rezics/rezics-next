import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { within } from '../access/authenticate.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { decodeCursor, encodeCursor } from '../content/feed-source-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { FeedActivityStore, FeedActivityTarget } from '../content/feed-activity.ts';
import { feedPageLimit, feedRoute } from '../content/feed-activity.ts';
import { feedSnapshot } from '../content/feed-snapshot.ts';
import {
  resolveCountDestination,
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
} from './follow-count-target.ts';
import { requireFollowCountHealth } from './follow-count-health.ts';

export type FollowActivitySupport = Readonly<{
  target: FeedActivityTarget;
  status: 'following' | 'not_following' | 'unavailable';
}>;
export type FollowRecipientPage = Readonly<{ recipients: readonly { accountId: string }[]; next: string | null }>;

/** The inverse is only a candidate source. Every positive comes from an independent actor-home
 * follow read and current identity check; an incomplete redirected source never certifies absence. */
export function createFollowActivitySource(deps: {
  pool: Pool;
  clock?: KernelClock;
  tokens: KeyRing;
  workClient: WorkClient;
  activityStore: FeedActivityStore;
}) {
  const clock = deps.clock ?? systemClock;
  return {
    async pageRecipients(
      target: FeedActivityTarget,
      query: { cursor?: string; limit?: number },
      deadline: number,
    ): Promise<FollowRecipientPage> {
      const limit = feedPageLimit(query.limit);
      const resolve = () =>
        within(deadline, () =>
          resolveCountDestination(
            { pool: deps.pool },
            {
              targetType: target.type,
              targetId: target.id,
            },
          ),
        );
      let destination;
      try {
        destination = await resolve();
      } catch (error) {
        if (error instanceof FollowCountTargetAbsentError) return { recipients: [], next: null };
        throw error;
      }
      const binding = {
        operation: 'library.follow.activity.recipients',
        parameters: {
          id: target.id,
          type: target.type,
          limit,
        },
      };
      const cursor =
        query.cursor === undefined ? null : decodeCursor(deps.tokens, binding, query.cursor, clock().getTime());
      if (
        cursor &&
        (!cursor.ok ||
          cursor.epoch !== 1 ||
          cursor.after.length !== 3 ||
          cursor.after.some((value) => typeof value !== 'string'))
      )
        throw new ProblemError('invalid_cursor');
      // A current identity change restarts this bounded candidate walk. Keeping the old account
      // frontier against a new inverse would skip recipients; repeated deliveries are idempotent.
      const after =
        cursor?.ok &&
        cursor.after[0] === destination.targetId &&
        cursor.after[1] === (destination.epoch?.toString() ?? '')
          ? cursor.after[2]
          : '00000000-0000-0000-0000-000000000000';
      // Readiness is owner-maintained constant metadata, never a recipient/partition census.
      await within(deadline, () => requireFollowCountHealth(deps.pool));
      const rows = await feedSnapshot(
        deps.pool,
        destination.route,
        deadline,
        async (client) =>
          (
            await client.query<{ account_id: string }>(
              `SELECT account_id FROM library.follow_count_support WHERE route=$1 AND target_type=$2 AND target_id=$3
           AND account_id>$4 AND support>0 ORDER BY account_id LIMIT $5`,
              [destination.route, target.type, destination.targetId, after, limit],
            )
          ).rows,
      );
      const current = await resolve();
      if (destination.targetId !== current.targetId || destination.epoch !== current.epoch)
        throw new FollowCountUnavailableError();
      return {
        recipients: rows.map((row) => ({ accountId: row.account_id })),
        next:
          rows.length === limit
            ? encodeCursor(
                deps.tokens,
                binding,
                {
                  epoch: 1,
                  after: [destination.targetId, destination.epoch?.toString() ?? '', rows.at(-1)!.account_id],
                },
                clock().getTime(),
              )
            : null,
      };
    },
    async checkCurrentFollowSupport(
      actor: Actor,
      input: { targets: readonly FeedActivityTarget[] },
      deadline: number,
    ): Promise<readonly FollowActivitySupport[]> {
      if (actor.kind !== 'account' || !actor.scopes.includes('follow:list')) throw new ProblemError('forbidden');
      if (input.targets.length > 3) throw new RangeError('At most three follow support targets');
      const accountActor = actor;
      const route = feedRoute(accountActor.accountId);
      async function ownerRows(ids: readonly string[]) {
        return feedSnapshot(deps.pool, route, deadline, async (client) => {
          const owner = await readAccount(client, route, accountActor.accountId);
          if (
            !owner ||
            owner.kind !== 'actor' ||
            owner.state !== 'active' ||
            owner.fenced ||
            !Number.isSafeInteger(accountActor.authnEpoch) ||
            accountActor.authnEpoch < 1 ||
            owner.minimumAuthnEpoch > BigInt(accountActor.authnEpoch)
          )
            throw new ProblemError('forbidden');
          const result = (
            await client.query<{ target_id: string; target_type: string; state: string; reason: string }>(
              'SELECT target_id,target_type,state,reason FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=ANY($3::uuid[])',
              [route, accountActor.accountId, ids],
            )
          ).rows;
          return result;
        });
      }
      const direct = await ownerRows(input.targets.map((target) => target.id));
      const result: FollowActivitySupport[] = [];
      for (const target of input.targets) {
        const exact = direct.find((row) => row.target_id === target.id && row.target_type === target.type);
        if (target.type !== 'subject') {
          result.push({ target, status: exact?.state === 'following' ? 'following' : 'not_following' });
          continue;
        }
        const mapping = await within(deadline, () => identityEpochStore.readMapping(deps.pool, target.id));
        if (mapping.state === 'absent') {
          result.push({ target, status: 'not_following' });
          continue;
        }
        if (mapping.state !== 'mapped') {
          result.push({ target, status: 'unavailable' });
          continue;
        }
        // An explicit native negative is immediate, independently of stale inverse support.
        if (exact?.state === 'unfollowed' && exact.reason === 'explicit') {
          result.push({ target, status: 'not_following' });
          continue;
        }
        if (exact?.state === 'following') {
          const final = await within(deadline, () => identityEpochStore.readMapping(deps.pool, target.id));
          const native = await ownerRows([target.id]);
          result.push({
            target,
            status:
              final.state === 'mapped' &&
              final.epoch === mapping.epoch &&
              final.terminal === mapping.terminal &&
              native.some(
                (row) => row.target_id === target.id && row.target_type === 'subject' && row.state === 'following',
              )
                ? 'following'
                : 'unavailable',
          });
          continue;
        }
        // A complete anchored candidate page may witness positive alias support, but a missing/stale
        // projection cannot prove a negative. Overflow remains unavailable, never truncated eligibility.
        const pairs = await feedSnapshot(
          deps.pool,
          feedRoute(mapping.terminal),
          deadline,
          async (client) =>
            (
              await client.query<{ original_id: string }>(
                `SELECT original_id FROM library.follow_count_pair WHERE route=$1 AND target_type='subject'
             AND target_id=$2 AND account_id=$3 ORDER BY original_id LIMIT 101`,
                [feedRoute(mapping.terminal), mapping.terminal, actor.accountId],
              )
            ).rows,
        );
        if (pairs.length > 100 || pairs.length === 0) {
          result.push({ target, status: 'unavailable' });
          continue;
        }
        const ids = pairs.map((pair) => pair.original_id);
        const mappings = await within(deadline, () => identityEpochStore.readMappings(deps.pool, ids));
        const originalRows = await ownerRows(ids);
        const finalMappings = await within(deadline, () => identityEpochStore.readMappings(deps.pool, ids));
        const finalRows = await ownerRows(ids);
        const positive = mappings.some(
          (value) =>
            value.state === 'mapped' &&
            value.epoch === mapping.epoch &&
            value.terminal === mapping.terminal &&
            finalMappings.some(
              (current) =>
                current.state === 'mapped' &&
                current.original === value.original &&
                current.terminal === value.terminal &&
                current.epoch === value.epoch,
            ) &&
            originalRows.some(
              (row) => row.target_id === value.original && row.target_type === 'subject' && row.state === 'following',
            ) &&
            finalRows.some(
              (row) => row.target_id === value.original && row.target_type === 'subject' && row.state === 'following',
            ),
        );
        const final = await within(deadline, () => identityEpochStore.readMapping(deps.pool, target.id));
        result.push({
          target,
          status:
            positive && final.state === 'mapped' && final.terminal === mapping.terminal && final.epoch === mapping.epoch
              ? 'following'
              : 'unavailable',
        });
      }
      return result;
    },
  };
}
export type FollowActivitySource = ReturnType<typeof createFollowActivitySource>;
