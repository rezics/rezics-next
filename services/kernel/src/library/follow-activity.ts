import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { identityEpochStore } from '../semantic/identity-epoch-store.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { FeedActivityStore, FeedActivityTarget } from '../content/feed-activity.ts';
import { feedPageLimit, feedRoute } from '../content/feed-activity.ts';
import { readFollow } from './follow-store.ts';
import { resolveCountDestination, FollowCountUnavailableError } from './follow-count-target.ts';
import { requireFollowCountHealth } from './follow-count-health.ts';

export type FollowActivitySupport = Readonly<{ target: FeedActivityTarget; status: 'following' | 'not_following' | 'unavailable' }>;
export type FollowRecipientPage = Readonly<{ recipients: readonly { accountId: string }[]; next: string | null }>;

/** The inverse is only a candidate source. Every positive comes from an independent actor-home
 * follow read and current identity check; an incomplete redirected source never certifies absence. */
export function createFollowActivitySource(deps: {
  pool: Pool; clock?: KernelClock; tokens: KeyRing; workClient: WorkClient; activityStore: FeedActivityStore;
}) {
  const clock = deps.clock ?? systemClock;
  return {
    async pageRecipients(target: FeedActivityTarget, query: { cursor?: string; limit?: number }, deadline: number): Promise<FollowRecipientPage> {
      const limit = feedPageLimit(query.limit);
      const destination = await within(deadline, () => resolveCountDestination({ pool: deps.pool }, {
        targetType: target.type, targetId: target.id,
      }));
      const binding = { operation: 'library.follow.activity.recipients', parameters: {
        id: target.id, type: target.type, terminal: destination.targetId, epoch: destination.epoch?.toString() ?? '', limit,
      } };
      const cursor = query.cursor === undefined ? null : decodeCursor(deps.tokens, binding, query.cursor, clock().getTime());
      if (cursor && (!cursor.ok || cursor.after.length !== 1 || typeof cursor.after[0] !== 'string'))
        throw new ProblemError('invalid_cursor');
      // Readiness is owner-maintained constant metadata, never a recipient/partition census.
      await within(deadline, () => requireFollowCountHealth(deps.pool));
      const rows = await within(deadline, () => withConnection(deps.pool, async (connection) =>
        (await deadlineClient(connection, deadline).query<{ account_id: string }>(
          `SELECT account_id FROM library.follow_count_support WHERE route=$1 AND target_type=$2 AND target_id=$3
           AND account_id>$4 AND support>0 ORDER BY account_id LIMIT $5`,
          [destination.route, target.type, destination.targetId,
            cursor?.ok ? cursor.after[0] : '00000000-0000-0000-0000-000000000000', limit])).rows));
      const current = await within(deadline, () => resolveCountDestination({ pool: deps.pool }, { targetType: target.type, targetId: target.id }));
      if (destination.targetId !== current.targetId || destination.epoch !== current.epoch) throw new FollowCountUnavailableError();
      return { recipients: rows.map((row) => ({ accountId: row.account_id })), next: rows.length === limit
        ? encodeCursor(deps.tokens, binding, { epoch: 1, after: [rows.at(-1)!.account_id] }, clock().getTime()) : null };
    },
    async checkCurrentFollowSupport(actor: Actor, input: { targets: readonly FeedActivityTarget[] }, deadline: number): Promise<readonly FollowActivitySupport[]> {
      if (actor.kind !== 'account' || !actor.scopes.includes('follow:list')) throw new ProblemError('forbidden');
      if (input.targets.length > 3) throw new RangeError('At most three follow support targets');
      const route = feedRoute(actor.accountId);
      async function ownerRows(ids: readonly string[]) {
        return withConnection(deps.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const owner = await readAccount(client, route, actor.accountId);
            if (!owner || owner.kind !== 'actor' || owner.state !== 'active' || owner.fenced ||
              !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 || owner.minimumAuthnEpoch > BigInt(actor.authnEpoch))
              throw new ProblemError('forbidden');
            const result = (await client.query<{ target_id: string; target_type: string; state: string; reason: string }>(
              'SELECT target_id,target_type,state,reason FROM library.follow WHERE route=$1 AND account_id=$2 AND target_id=ANY($3::uuid[])',
              [route, actor.accountId, ids])).rows;
            await client.query('COMMIT');
            return result;
          } catch (error) { await client.query('ROLLBACK'); throw error; }
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
        if (mapping.state === 'absent') { result.push({ target, status: 'not_following' }); continue; }
        if (mapping.state !== 'mapped') { result.push({ target, status: 'unavailable' }); continue; }
        // An explicit native negative is immediate, independently of stale inverse support.
        if (exact?.state === 'unfollowed' && exact.reason === 'explicit') {
          result.push({ target, status: 'not_following' }); continue;
        }
        if (exact?.state === 'following') {
          const final = await within(deadline, () => identityEpochStore.readMapping(deps.pool, target.id));
          const native = await ownerRows([target.id]);
          result.push({ target, status: final.state === 'mapped' && final.epoch === mapping.epoch &&
            final.terminal === mapping.terminal && native.some((row) => row.target_id === target.id && row.target_type === 'subject' && row.state === 'following')
            ? 'following' : 'unavailable' });
          continue;
        }
        // A complete anchored candidate page may witness positive alias support, but a missing/stale
        // projection cannot prove a negative. Overflow remains unavailable, never truncated eligibility.
        const pairs = await withConnection(deps.pool, async (connection) =>
          (await deadlineClient(connection, deadline).query<{ original_id: string }>(
            `SELECT original_id FROM library.follow_count_pair WHERE route=$1 AND target_type='subject'
             AND target_id=$2 AND account_id=$3 ORDER BY original_id LIMIT 129`,
            [feedRoute(mapping.terminal), mapping.terminal, actor.accountId])).rows);
        if (pairs.length > 128 || pairs.length === 0) { result.push({ target, status: 'unavailable' }); continue; }
        const ids = pairs.map((pair) => pair.original_id);
        const mappings = await within(deadline, () => identityEpochStore.readMappings(deps.pool, ids));
        const originalRows = await ownerRows(ids);
        const positive = mappings.some((value) => value.state === 'mapped' && value.epoch === mapping.epoch &&
          value.terminal === mapping.terminal && originalRows.some((row) => row.target_id === value.original && row.target_type === 'subject' && row.state === 'following'));
        const final = await within(deadline, () => identityEpochStore.readMapping(deps.pool, target.id));
        result.push({ target, status: positive && final.state === 'mapped' && final.terminal === mapping.terminal && final.epoch === mapping.epoch
          ? 'following' : 'unavailable' });
      }
      return result;
    },
  };
}
export type FollowActivitySource = ReturnType<typeof createFollowActivitySource>;
