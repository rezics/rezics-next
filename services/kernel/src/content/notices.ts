import type { Pool, PoolClient } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { CommandUnavailableError } from '../access/unavailable.ts';
import deleteAccountNoticePageSql from './delete-account-notices-page.sql';
import deleteNoticeSeen from './delete-account-notice-seen.sql';
import deleteExpiredPage from './delete-expired-notices-page.sql';
import noticePartitionState from './read-notice-partition-state.sql';
import writeNoticeRows from './write-notices.sql';

export const NOTICE_WRITE_LIMIT = 100;
export const NOTICE_PAGE_SIZE = 1000;
export const NOTICE_RETENTION_DAYS = 180;
export const NOTICE_RETENTION_MS = NOTICE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type NoticeKind = 'reply' | 'mention' | 'moderation_decision';

export type NoticeInput = Readonly<{
  recipientId: string;
  noticeId: string;
  kind: NoticeKind;
  actorId: string | null;
  threadId: string | null;
  postId: string | null;
  decisionId: string | null;
  reportId: string | null;
  sourceId: string;
  createdAt: Date;
}>;

type QueryClient = Pick<Pool | PoolClient, 'query'>;

async function withWritableNoticeRoute<T>(
  pool: Pool,
  route: number,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const partition = partitionOf(route);
      const state = await noticePartitionState.run(client, { partition_no: partition });
      if (!state) throw new CommandUnavailableError('deadline', partition);
      if (state.write_state === 'moved')
        throw new CommandUnavailableError('moved', partition, state.moved_to);
      if (state.write_state !== 'active') throw new CommandUnavailableError('fenced', partition);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

function requiredRoute(id: string, name: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError(`Invalid ${name}`);
  return route;
}

function validateNotice(notice: NoticeInput): number {
  const route = requiredRoute(notice.recipientId, 'notice recipient');
  if (requiredRoute(notice.noticeId, 'notice id') !== route)
    throw new TypeError('Notice id must use the recipient route');
  if (!['reply', 'mention', 'moderation_decision'].includes(notice.kind)) throw new TypeError('Invalid notice kind');
  requiredRoute(notice.sourceId, 'notice source');
  for (const [name, id] of [
    ['notice actor', notice.actorId],
    ['notice thread', notice.threadId],
    ['notice post', notice.postId],
    ['notice decision', notice.decisionId],
    ['notice report', notice.reportId],
  ] as const) {
    if (id !== null) requiredRoute(id, name);
  }
  if (!(notice.createdAt instanceof Date) || !Number.isFinite(notice.createdAt.getTime()))
    throw new TypeError('Invalid notice creation time');
  return route;
}

/** Insert at most 100 notices with one statement per recipient partition. */
export async function writeNotices(client: QueryClient, notices: readonly NoticeInput[]): Promise<number> {
  if (notices.length > NOTICE_WRITE_LIMIT) throw new RangeError(`Notice writes are limited to ${NOTICE_WRITE_LIMIT}`);
  const groups = new Map<number, Array<Record<string, unknown>>>();
  for (const notice of notices) {
    const route = validateNotice(notice);
    const partition = partitionOf(route);
    const rows = groups.get(partition) ?? [];
    rows.push({
      route,
      recipient_id: notice.recipientId,
      notice_id: notice.noticeId,
      kind: notice.kind,
      actor_id: notice.actorId,
      thread_id: notice.threadId,
      post_id: notice.postId,
      decision_id: notice.decisionId,
      report_id: notice.reportId,
      source_id: notice.sourceId,
      created_at: notice.createdAt.toISOString(),
    });
    groups.set(partition, rows);
  }

  let written = 0;
  for (const [partition, rows] of groups) {
    written += (
      await writeNoticeRows.run(client, {
        partition,
        notices: rows,
      })
    ).length;
  }
  return written;
}

/** Delete one index-seek page of expired notices. The cutoff is exclusive. */
export async function deleteExpiredNoticesPage(pool: Pool, route: number, cutoff: Date): Promise<number> {
  if (!Number.isSafeInteger(route) || route < 0 || route > 65535) throw new TypeError('Invalid notice route');
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError('Invalid notice cutoff');
  return withWritableNoticeRoute(
    pool,
    route,
    async (client) =>
      (await deleteExpiredPage.run(client, { route, cutoff: cutoff.toISOString() })).length,
  );
}

/** Delete one recipient-index page for the account being erased. */
export async function deleteAccountNoticePage(pool: Pool, accountId: string): Promise<number> {
  const route = requiredRoute(accountId, 'notice account');
  return withWritableNoticeRoute(
    pool,
    route,
    async (client) =>
      (await deleteAccountNoticePageSql.run(client, { route, account_id: accountId })).length,
  );
}

/** Remove the account's single inbox position marker after its notices are deleted. */
export async function deleteAccountNoticeSeen(pool: Pool, accountId: string): Promise<number> {
  const route = requiredRoute(accountId, 'notice account');
  return withWritableNoticeRoute(pool, route, async (client) =>
    (await deleteNoticeSeen.run(client, { route, account_id: accountId })) === null ? 0 : 1,
  );
}
