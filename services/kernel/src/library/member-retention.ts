import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  noEffect,
  normalizeCommandKey,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
} from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { workStepDeadline } from './command-support.ts';
import duePage from './member-retention-due-page.sql';
import purge from './member-retention-purge.sql';

export type DueMemberDeletionKey = Readonly<{
  purgeAfter: string;
  route: number;
  collectionId: string;
  memberId: string;
  deletionId: string;
}>;

function checkKey(key: DueMemberDeletionKey): void {
  if (
    partitionOf(key.route) < 0 ||
    !/^[0-9a-f-]{36}$/.test(key.collectionId) ||
    !/^[0-9a-f-]{36}$/.test(key.memberId) ||
    !/^[0-9a-f-]{36}$/.test(key.deletionId)
  )
    throw new TypeError('Invalid retained member locator');
}

export async function pageDueMemberDeletions(
  client: Pick<PoolClient, 'query'>,
  input: { partition: number; cutoff: string; after?: DueMemberDeletionKey; limit: number },
): Promise<DueMemberDeletionKey[]> {
  if (
    !Number.isInteger(input.partition) ||
    input.partition < 0 ||
    input.partition >= 4096 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new RangeError('Invalid member retention page bounds');
  if (input.after) {
    checkKey(input.after);
    if (partitionOf(input.after.route) !== input.partition) throw new RangeError('Member cursor partition mismatch');
  }
  return duePage.run(client, {
    partition_no: input.partition,
    cutoff: input.cutoff,
    after_purge_after: input.after?.purgeAfter ?? null,
    after_route: input.after?.route ?? null,
    after_collection_id: input.after?.collectionId ?? null,
    after_member_id: input.after?.memberId ?? null,
    page_limit: input.limit,
  });
}

export class MemberPurgeNotDueError extends Error {}

export async function purgeExpiredMemberDeletion(
  { pool, clock, deadline = workStepDeadline() }: { pool: Pool; clock?: KernelClock; deadline?: number },
  key: DueMemberDeletionKey,
): Promise<CommandOutcome<{ purged: boolean }>> {
  checkKey(key);
  const { route, collectionId, memberId, deletionId, purgeAfter } = key;
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw new CommandUnavailableError('deadline', partitionOf(route));
  const partition = partitionOf(route);
  const curator = await pool.query<{ curator_account_id: string }>(
    'SELECT curator_account_id FROM library.collection WHERE route=$1 AND collection_id=$2',
    [route, collectionId],
  );
  const actorAccountId = curator.rows[0]?.curator_account_id;
  if (!actorAccountId) throw new Error('Member retention parent is missing');
  let present = false;
  const authorization: CommandAuthorization = {
    action: 'library:member-retention-maintenance',
    resource: Object.freeze({ route, id: collectionId }),
    denied: () => new Error('Stale member deletion episode'),
    async authorize(tx, attempt) {
      const found = await tx.query(
        `SELECT member.member_id, member.deletion_id, member.purge_after, member.purge_after<= $5::timestamptz AS due
           FROM library.collection_member member JOIN library.collection collection
             ON collection.route=member.route AND collection.collection_id=member.collection_id
          WHERE member.route=$1 AND member.collection_id=$2 AND member.member_id=$3
            AND member.deletion_id=$4 AND member.purge_after=$6::timestamptz FOR UPDATE OF member,collection`,
        [route, collectionId, memberId, deletionId, authoritativeTimeValue(attempt.time), purgeAfter],
      );
      present = found.rows.length > 0;
      if (present && !found.rows[0].due) throw new MemberPurgeNotDueError('Member retention deadline has not elapsed');
      return 'execute';
    },
  };
  const kind = 'library.collection.member.retention.purge';
  return runCommand<{ purged: boolean }>(
    pool,
    {
      partition,
      deadline,
      clock,
      authorization,
      receipt: {
        actorAccountId,
        kind,
        key: normalizeCommandKey({ kind: 'account', id: actorAccountId }, deletionId),
        digest: createHash('sha256')
          .update(JSON.stringify([kind, route, collectionId, memberId, deletionId, purgeAfter]))
          .digest(),
      },
    },
    async (tx, command) => {
      const result = await purge.run(tx, {
        route,
        collection_id: collectionId,
        member_id: memberId,
        deletion_id: deletionId,
        expected_purge_after: purgeAfter,
        time: authoritativeTimeValue(command.time),
      });
      if (!result && present) throw new Error('Locked due member episode failed its exact native CAS');
      if (!result) return noEffect({ purged: false });
      return {
        value: { purged: true },
        events: [
          {
            type: 'com.rezics.library.collection.member.purged.v1',
            subject: collectionId,
            data: { memberId, deletionId },
          },
        ],
      };
    },
  );
}
