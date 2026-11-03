import type { Pool, PoolClient } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { notificationAllowed } from '../access/preferences.ts';
import { readAccount } from '../access/account-data.ts';
import readFinalization from './notice-read-finalization.sql';
import recordFinalization from './notice-record-finalization.sql';
import deleteFinalizations from './notice-delete-finalizations.sql';
import expireFinalizations from './notice-expire-finalizations.sql';
import { deadlineClient, within } from '../access/authenticate.ts';
import deleteAccountNoticePageSql from './delete-account-notices-page.sql';
import eraseAccountNoticePageSql from './account-notice-erasure-page.sql';
import deleteNoticeSeen from './delete-account-notice-seen.sql';
import deleteAccountThreadWatchPage from './delete-account-thread-watch-page.sql';
import deleteExpiredPage from './delete-expired-notices-page.sql';
import noticePartitionState from './read-notice-partition-state.sql';
import writeNoticeRows from './write-notices.sql';
import watchNoticeIsActive from './watch-active-at-send.sql';
import deleteWatchNoticeWorkPage from './delete-watch-notice-work-page.sql';

export const NOTICE_WRITE_LIMIT = 100;
export const NOTICE_PAGE_SIZE = 1000;
export const NOTICE_RETENTION_DAYS = 180;
export const NOTICE_RETENTION_MS = NOTICE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type NoticeKind = 'reply' | 'mention' | 'thread_watch' | 'moderation_decision';

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

export async function withWritableNoticeRoute<T>(
  pool: Pool,
  route: number,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const partition = partitionOf(route);
      const state = await noticePartitionState.run(client, {
        partition_no: partition,
      });
      if (!state) throw new CommandUnavailableError('deadline', partition);
      if (state.write_state === 'moved') throw new CommandUnavailableError('moved', partition, state.moved_to);
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
  if (!['reply', 'mention', 'thread_watch', 'moderation_decision'].includes(notice.kind))
    throw new TypeError('Invalid notice kind');
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

/** Finalize an optional send only after independently released resource Access.
 * Native recipient writers must update core.partition before committing. Its
 * shared lock prevents a preference or account writer from committing between
 * the READ COMMITTED authority read and this notice's COMMIT. No source checkout
 * or Access work may run inside this recipient transaction.
 * A recipient/source decision commits atomically with the insert or refusal;
 * even a failed multi-recipient effect cannot reevaluate an earlier refusal.
 */
export async function finalizeOptionalNotice(
  pool: Pool,
  notice: NoticeInput & { kind: 'reply' | 'mention' | 'thread_watch' },
  readable: boolean,
  deadline: number,
  clock: KernelClock = systemClock,
  watch?: Readonly<{ watchId: string; threadId: string; publishedAt: Date }>,
): Promise<void> {
  const route = validateNotice(notice);
  // A redrive older than the retained decision horizon cannot reopen a send.
  if (notice.createdAt.getTime() < clock().getTime() - NOTICE_RETENTION_MS) return;
  await within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        const partition = partitionOf(route);
        const state = await noticePartitionState.run(client, {
          partition_no: partition,
        });
        if (!state) throw new CommandUnavailableError('deadline', partition);
        if (state.write_state === 'moved') throw new CommandUnavailableError('moved', partition, state.moved_to);
        if (state.write_state !== 'active') throw new CommandUnavailableError('fenced', partition);
        const key = {
          route,
          recipient_id: notice.recipientId,
          kind: notice.kind,
          source_id: notice.sourceId,
        };
        if (!(await readFinalization.run(client, key))) {
          // This owner port is solely the terminal erasure fence, never preference
          // authority. Do not recreate recipient records after account erasure.
          const account = await readAccount(client, route, notice.recipientId);
          if (account && account.state !== 'deleted') {
            const allowed = await notificationAllowed(client, {
              recipient: notice.recipientId,
              kind: notice.kind,
            });
            const watching =
              watch === undefined ||
              (await watchNoticeIsActive.run(client, {
                route,
                thread_id: watch.threadId,
                watch_id: watch.watchId,
                watcher_account_id: notice.recipientId,
                published_at: watch.publishedAt.toISOString(),
              })) !== null;
            const sent = readable && allowed && watching;
            const claimed = await recordFinalization.run(client, {
              ...key,
              sent,
              created_at: notice.createdAt.toISOString(),
            });
            if (claimed && sent) await writeNotices(client, [notice]);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** Delete one index-seek page of expired notices. The cutoff is exclusive. */
export async function deleteExpiredNoticesPage(pool: Pool, route: number, cutoff: Date): Promise<number> {
  if (!Number.isSafeInteger(route) || route < 0 || route > 65535) throw new TypeError('Invalid notice route');
  if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) throw new TypeError('Invalid notice cutoff');
  return withWritableNoticeRoute(pool, route, async (client) => {
    const deleted = (
      await deleteExpiredPage.run(client, {
        route,
        cutoff: cutoff.toISOString(),
      })
    ).length;
    const finalized = (
      await expireFinalizations.run(client, {
        route,
        cutoff: cutoff.toISOString(),
        limit: NOTICE_PAGE_SIZE - deleted,
      })
    ).length;
    const work = (
      await deleteWatchNoticeWorkPage.run(client, {
        route,
        cutoff: cutoff.toISOString(),
        limit: NOTICE_PAGE_SIZE - deleted - finalized,
      })
    ).length;
    return deleted + finalized + work;
  });
}

/** Delete one recipient-index page for the account being erased. */
export async function deleteAccountNoticePage(pool: Pool, accountId: string): Promise<number> {
  const route = requiredRoute(accountId, 'notice account');
  return withWritableNoticeRoute(pool, route, async (client) => {
    const deleted = (
      await deleteAccountNoticePageSql.run(client, {
        route,
        account_id: accountId,
      })
    ).length;
    const finalized = (
      await deleteFinalizations.run(client, {
        route,
        recipient_id: accountId,
        limit: NOTICE_PAGE_SIZE - deleted,
      })
    ).length;
    const watches = (
      await deleteAccountThreadWatchPage.run(client, {
        route,
        account_id: accountId,
        limit: NOTICE_PAGE_SIZE - deleted - finalized,
      })
    ).length;
    return deleted + finalized + watches;
  });
}

/** Remove the account's single inbox position marker after its notices are deleted. */
export async function deleteAccountNoticeSeen(pool: Pool, accountId: string): Promise<number> {
  const route = requiredRoute(accountId, 'notice account');
  return withWritableNoticeRoute(pool, route, async (client) =>
    (await deleteNoticeSeen.run(client, { route, account_id: accountId })) === null ? 0 : 1,
  );
}

export type NoticeErasureCursor = string;

type NoticeErasurePageCursor = {
  version: 1;
  accountId: string;
  stage: 'notices' | 'finalizations' | 'watches';
  noticeAfter: { createdAt: string; noticeId: string } | null;
  finalizationAfter: { createdAt: string; kind: string; sourceId: string } | null;
};

type NoticeErasurePage = {
  found: number;
  nextStage: 'notices' | 'finalizations' | 'watches' | null;
  done: boolean;
  pending: number;
  noticeCreatedAt: string | null;
  noticeId: string | null;
  finalizationCreatedAt: string | null;
  finalizationKind: string | null;
  finalizationSourceId: string | null;
};

function readNoticeErasureCursor(value: string | null, accountId: string): NoticeErasurePageCursor {
  if (value === null) {
    return {
      version: 1,
      accountId,
      stage: 'notices',
      noticeAfter: null,
      finalizationAfter: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('Invalid notice erasure cursor');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('accountId' in parsed) ||
    parsed.accountId !== accountId ||
    !('stage' in parsed) ||
    (parsed.stage !== 'notices' && parsed.stage !== 'finalizations' && parsed.stage !== 'watches') ||
    !('noticeAfter' in parsed) ||
    !('finalizationAfter' in parsed)
  )
    throw new TypeError('Invalid notice erasure cursor');

  const validNoticeAfter = (after: unknown): after is NoticeErasurePageCursor['noticeAfter'] =>
    after === null ||
    (typeof after === 'object' &&
      !Array.isArray(after) &&
      after !== null &&
      'createdAt' in after &&
      typeof after.createdAt === 'string' &&
      Number.isFinite(Date.parse(after.createdAt)) &&
      'noticeId' in after &&
      typeof after.noticeId === 'string' &&
      routeOf(after.noticeId) === routeOf(accountId));
  const validFinalizationAfter = (after: unknown): after is NoticeErasurePageCursor['finalizationAfter'] =>
    after === null ||
    (typeof after === 'object' &&
      !Array.isArray(after) &&
      after !== null &&
      'createdAt' in after &&
      typeof after.createdAt === 'string' &&
      Number.isFinite(Date.parse(after.createdAt)) &&
      'kind' in after &&
      typeof after.kind === 'string' &&
      ['reply', 'mention', 'thread_watch', 'moderation_decision'].includes(after.kind) &&
      'sourceId' in after &&
      typeof after.sourceId === 'string' &&
      routeOf(after.sourceId) !== null);

  if (!validNoticeAfter(parsed.noticeAfter) || !validFinalizationAfter(parsed.finalizationAfter))
    throw new TypeError('Invalid notice erasure cursor');
  if (
    (parsed.stage === 'notices' && parsed.finalizationAfter !== null) ||
    (parsed.stage === 'finalizations' && parsed.noticeAfter !== null) ||
    (parsed.stage === 'watches' && (parsed.noticeAfter !== null || parsed.finalizationAfter !== null))
  )
    throw new TypeError('Invalid notice erasure cursor');
  return parsed as NoticeErasurePageCursor;
}

/** Delete one bounded recipient-index page and retain a real keyset cursor for all remaining work. */
export async function eraseAccountNoticesPage(
  deps: { pool: Pool },
  accountId: string,
  after: NoticeErasureCursor | null,
): Promise<{ next: NoticeErasureCursor | null; found: number; pending: number }> {
  const route = requiredRoute(accountId, 'notice account');
  const cursor = readNoticeErasureCursor(after, accountId);
  return withWritableNoticeRoute(deps.pool, route, async (client) => {
    const page = (await eraseAccountNoticePageSql.run(client, {
      route,
      account_id: accountId,
      stage: cursor.stage,
      notice_after_created_at: cursor.noticeAfter?.createdAt ?? null,
      notice_after_id: cursor.noticeAfter?.noticeId ?? null,
      finalization_after_created_at: cursor.finalizationAfter?.createdAt ?? null,
      finalization_after_kind: cursor.finalizationAfter?.kind ?? null,
      finalization_after_id: cursor.finalizationAfter?.sourceId ?? null,
    })) as NoticeErasurePage;
    if (!page) throw new Error('Notice erasure page returned no status');
    if (
      !Number.isSafeInteger(page.found) ||
      page.found < 0 ||
      page.found > 50 ||
      !Number.isSafeInteger(page.pending) ||
      page.pending < 0 ||
      page.done !== (page.nextStage === null) ||
      page.done !== (page.pending === 0)
    )
      throw new Error('Notice erasure page returned an invalid completion status');
    let next: NoticeErasureCursor | null = null;
    if (!page.done) {
      const nextStage = page.nextStage;
      if (nextStage === null) throw new Error('Notice erasure page has pending work without a next stage');
      next = JSON.stringify({
        version: 1,
        accountId,
        stage: nextStage,
        noticeAfter:
          nextStage === 'notices' && page.noticeCreatedAt !== null && page.noticeId !== null
            ? { createdAt: page.noticeCreatedAt, noticeId: page.noticeId }
            : null,
        finalizationAfter:
          nextStage === 'finalizations' &&
          cursor.stage === 'finalizations' &&
          page.finalizationCreatedAt !== null &&
          page.finalizationKind !== null &&
          page.finalizationSourceId !== null
            ? {
                createdAt: page.finalizationCreatedAt,
                kind: page.finalizationKind,
                sourceId: page.finalizationSourceId,
              }
            : null,
      } satisfies NoticeErasurePageCursor);
    }
    return { next, found: Number(page.found), pending: Number(page.pending) };
  });
}
