import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { accessClock } from '../access/access-clock.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventData } from './events.ts';
import { finalizeOptionalNotice, NOTICE_RETENTION_MS, withWritableNoticeRoute } from './notices.ts';
import { postReadableByAccount } from './reads.ts';
import readWatchSource from './watch-read-source.sql';
import readWatchPage from './watch-read-page.sql';

const postPublished = 'com.rezics.content.post.published.v1';
const WATCH_PAGE_SIZE = 100;

type WatchSource = ContentEventData<typeof postPublished>;
type WatchRow = { route: number; watch_id: string; watcher_account_id: string; created_at: string };
type WorkRow = {
  thread_id: string;
  published_at: Date;
  cursor_created_at: string | null;
  cursor_watch_id: string | null;
  done: boolean;
};

function validateEvent(event: CloudEvent): { source: WatchSource; route: number; publishedAt: Date } {
  if (event.type !== postPublished || !Value.Check(CONTENT_EVENTS[postPublished], event.data))
    throw new TypeError('Invalid thread-watch notice source event');
  const source = event.data as WatchSource;
  const route = routeOf(source.itemId);
  const publishedAt = new Date(event.time);
  if (
    route === null ||
    routeOf(source.threadId) !== route ||
    routeOf(source.revisionId) !== route ||
    !Number.isFinite(publishedAt.getTime())
  )
    throw new TypeError('Invalid thread-watch notice source identity');
  return { source, route, publishedAt };
}

async function loadPage(
  pool: Pool,
  input: ReturnType<typeof validateEvent>,
): Promise<{ rows: WatchRow[]; done: boolean }> {
  const { source, route, publishedAt } = input;
  return withWritableNoticeRoute(pool, route, async (client) => {
    await client.query(
      `INSERT INTO content.thread_watch_notice_work(route,post_id,thread_id,published_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (route,post_id) DO NOTHING`,
      [route, source.itemId, source.threadId, publishedAt.toISOString()],
    );
    const progress = await client.query<WorkRow>(
      `SELECT thread_id::text, published_at, cursor_created_at::text, cursor_watch_id::text, done
       FROM content.thread_watch_notice_work
       WHERE route=$1 AND post_id=$2 FOR UPDATE`,
      [route, source.itemId],
    );
    const work = progress.rows[0];
    if (!work || work.thread_id !== source.threadId || work.published_at.getTime() !== publishedAt.getTime())
      throw new TypeError('Thread-watch notice progress does not match its source');
    if (work.done) return { rows: [], done: true };
    const rows = (await readWatchPage.run(client, {
      thread_id: source.threadId,
      actor_id: source.actorId,
      published_at: publishedAt.toISOString(),
      cursor_created_at: work.cursor_created_at,
      cursor_watch_id: work.cursor_watch_id,
      limit: WATCH_PAGE_SIZE,
    })) as WatchRow[];
    return { rows, done: false };
  });
}

async function advancePage(pool: Pool, route: number, postId: string, rows: readonly WatchRow[]): Promise<boolean> {
  const last = rows.at(-1);
  const done = rows.length < WATCH_PAGE_SIZE;
  await withWritableNoticeRoute(pool, route, async (client) => {
    if (last) {
      await client.query(
        `UPDATE content.thread_watch_notice_work
         SET cursor_created_at=$3::timestamptz,cursor_watch_id=$4::uuid,done=$5
         WHERE route=$1 AND post_id=$2 AND NOT done
           AND (cursor_created_at IS NULL OR (cursor_created_at,cursor_watch_id) <= ($3::timestamptz,$4::uuid))`,
        [route, postId, last.created_at, last.watch_id, done],
      );
    } else {
      await client.query(
        `UPDATE content.thread_watch_notice_work SET done=true WHERE route=$1 AND post_id=$2 AND NOT done`,
        [route, postId],
      );
    }
  });
  return done;
}

async function sourceIsReply(pool: Pool, input: ReturnType<typeof validateEvent>): Promise<boolean> {
  const { source, route } = input;
  return withConnection(pool, async (client) => {
    const anchor = await readPartition(client, partitionOf(route));
    if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
    const rows = await readWatchSource.run(client, {
      route,
      thread_id: source.threadId,
      post_id: source.itemId,
      revision_id: source.revisionId,
      actor_id: source.actorId,
    });
    return rows !== null;
  });
}

/** The outer effect is a durable DBOS step; each keyset page commits progress after its recipient decisions. */
export function createThreadWatchNoticeEffect(pool: Pool, access: Access): Effect {
  return {
    name: 'content_thread_watch_notice',
    types: [postPublished],
    async run(event) {
      const input = validateEvent(event);
      const clock = accessClock(access);
      if (input.publishedAt.getTime() < clock().getTime() - NOTICE_RETENTION_MS) return;
      if (!(await sourceIsReply(pool, input))) return;
      const readableDeps = { pool, access };
      for (;;) {
        const page = await loadPage(pool, input);
        if (page.done) return;
        for (const row of page.rows) {
          if (row.route !== routeOf(row.watcher_account_id) || row.route !== routeOf(row.watch_id))
            throw new TypeError('Thread-watch recipient identity does not match its route');
          const deadline = deadlineFor(30_000);
          const readable = await postReadableByAccount(
            readableDeps,
            row.watcher_account_id,
            input.source.threadId,
            input.source.itemId,
            { deadline },
          );
          await finalizeOptionalNotice(
            pool,
            {
              recipientId: row.watcher_account_id,
              noticeId: newId(routeOf(row.watcher_account_id)!),
              kind: 'thread_watch',
              actorId: input.source.actorId,
              threadId: input.source.threadId,
              postId: input.source.itemId,
              decisionId: null,
              reportId: null,
              sourceId: input.source.itemId,
              createdAt: input.publishedAt,
            },
            readable,
            deadline,
            clock,
            {
              watchId: row.watch_id,
              threadId: input.source.threadId,
              publishedAt: input.publishedAt,
            },
          );
        }
        if (await advancePage(pool, input.route, input.source.itemId, page.rows)) return;
        if (page.rows.length === 0) return;
      }
    },
  };
}
