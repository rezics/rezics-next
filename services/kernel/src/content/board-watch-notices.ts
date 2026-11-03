import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { accessClock } from '../access/access-clock.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventData } from './events.ts';
import { finalizeOptionalNotice, NOTICE_RETENTION_MS, withWritableNoticeRoute } from './notices.ts';
import { postReadableByAccount } from './reads.ts';

const published = 'com.rezics.content.post.published.v1';
export const BOARD_WATCH_RECIPIENT_BUDGET = 100;
export const BOARD_WATCH_STEP_DEADLINE_MS = 30_000;
type Source = ContentEventData<typeof published>;
type Input = { source: Source; route: number; epoch: number; position: string; eventId: string; time: Date };
type Opening = { board_id: string; active: boolean; published_at: string };
type Recipient = { route: number; watch_id: string; watcher_account_id: string; created_at: string };
type Work = { board_id: string; source_epoch: number; source_position: string; source_id: string;
  cursor_created_at: string | null; cursor_watch_id: string | null; done: boolean };

function sourceInput(event: CloudEvent): Input {
  if (event.type !== published || !Value.Check(CONTENT_EVENTS[published], event.data))
    throw new TypeError('Invalid board-watch publication event');
  const source = event.data as Source;
  const route = routeOf(source.itemId);
  const origin = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  const epoch = Number(origin?.[2]);
  const time = new Date(event.time);
  if (route === null || routeOf(source.threadId) !== route || routeOf(source.revisionId) !== route ||
      !origin || Number(origin[1]) !== partitionOf(route) || !Number.isSafeInteger(epoch) || epoch < 1 ||
      !/^[0-9]{1,19}$/.test(event.sequence) || BigInt(event.sequence) < 1n || BigInt(event.sequence) > 9223372036854775807n ||
      routeOf(event.id) === null || !Number.isFinite(time.getTime()))
    throw new TypeError('Invalid board-watch publication position');
  return { source, route, epoch, position: BigInt(event.sequence).toString(), eventId: event.id, time };
}

/** Exact original log position plus current originals, never board index/event presentation. */
async function readOpening(pool: Pool, input: Input, deadline: number): Promise<Opening | null> {
  return within(deadline, () => withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const partition = await readPartition(client, partitionOf(input.route));
    if (!partition || partition.writeState === 'moved') throw new Error('Content partition is unavailable');
    const result = await client.query<Opening>(
      `SELECT t.board_id::text,o.recorded_at::text AS published_at,
          (t.visibility IN ('published','protected') AND t.availability='available'
           AND p.visibility='published' AND p.availability='available' AND r.availability='available') AS active
       FROM core.outbox o
       JOIN content.thread t ON t.route=$1 AND t.thread_id=$2 AND t.first_post_id=$3
       JOIN content.post p ON p.route=t.route AND p.thread_id=t.thread_id AND p.post_id=t.first_post_id
       JOIN content.revision r ON r.route=p.route AND r.thread_id=p.thread_id AND r.post_id=p.post_id AND r.revision_id=$4
       WHERE o.partition_no=$5 AND o.epoch=$6 AND o.position=$7::bigint AND o.id=$8
         AND o.type='com.rezics.content.post.published.v1' AND o.payload_state='present'
         AND o.data->>'threadId'=$2::text AND o.data->>'itemId'=$3::text AND o.data->>'revisionId'=$4::text
         AND o.data->>'actorId'=$9::text AND p.author_account_id=$9::uuid
         AND date_trunc('milliseconds',o.recorded_at)=$10::timestamptz`,
      [input.route, input.source.threadId, input.source.itemId, input.source.revisionId,
        partitionOf(input.route), input.epoch, input.position, input.eventId, input.source.actorId, input.time.toISOString()],
    );
    return result.rows[0] ?? null;
  }));
}

async function loadPage(pool: Pool, input: Input, opening: Opening, deadline: number) {
  return withWritableNoticeRoute(pool, input.route, async (client) => {
    await client.query(
      `INSERT INTO content.board_watch_notice_work
       (route,post_id,board_id,thread_id,source_epoch,source_position,source_id,published_at,done)
       VALUES($1,$2,$3,$4,$5,$6::bigint,$7,$8::timestamptz,$9) ON CONFLICT(route,post_id) DO NOTHING`,
      [input.route,input.source.itemId,opening.board_id,input.source.threadId,input.epoch,input.position,input.eventId,opening.published_at,!opening.active],
    );
    const result = await client.query<Work>(
      `SELECT board_id::text,source_epoch,source_position::text,source_id::text,cursor_created_at::text,cursor_watch_id::text,done
       FROM content.board_watch_notice_work WHERE route=$1 AND post_id=$2 FOR UPDATE`,
      [input.route,input.source.itemId],
    );
    const work = result.rows[0];
    if (!work || work.board_id !== opening.board_id || work.source_epoch !== input.epoch ||
        work.source_position !== input.position || work.source_id !== input.eventId)
      throw new TypeError('Board-watch progress does not match its original publication');
    if (work.done) return { done: true, rows: [] as Recipient[] };
    const rows = await client.query<Recipient>(
      `SELECT route,watch_id::text,watcher_account_id::text,created_at::text FROM content.board_watch
       WHERE board_id=$1 AND watching AND created_at<$2::timestamptz
         AND ($3::timestamptz IS NULL OR (created_at,watch_id)>($3::timestamptz,$4::uuid))
       ORDER BY created_at,watch_id LIMIT $5`,
      [opening.board_id,opening.published_at,work.cursor_created_at,work.cursor_watch_id,BOARD_WATCH_RECIPIENT_BUDGET],
    );
    return { done: false, rows: rows.rows };
  }, deadline);
}

/** One finite native page; its range checkout is released before any recipient Access. */
export async function processBoardWatchNoticePage(pool: Pool, access: Access, event: CloudEvent) {
  const input = sourceInput(event);
  const clock = accessClock(access);
  const deadline = deadlineFor(BOARD_WATCH_STEP_DEADLINE_MS);
  if (input.time.getTime() < clock().getTime() - NOTICE_RETENTION_MS) return { done: true, scanned: 0 };
  const opening = await readOpening(pool, input, deadline);
  if (!opening) return { done: true, scanned: 0 };
  const page = await loadPage(pool, input, opening, deadline);
  if (page.done) return { done: true, scanned: 0 };
  for (const row of page.rows) {
    if (row.route !== routeOf(row.watcher_account_id) || row.route !== routeOf(row.watch_id))
      throw new TypeError('Board-watch recipient route mismatch');
    const current = await readOpening(pool, input, deadline);
    const readable = !!current?.active && current.board_id === opening.board_id &&
      row.watcher_account_id !== input.source.actorId &&
      await postReadableByAccount({ pool, access }, row.watcher_account_id, input.source.threadId, input.source.itemId, { deadline });
    await finalizeOptionalNotice(pool, {
      recipientId: row.watcher_account_id, noticeId: newId(row.route), kind: 'board_activity',
      actorId: input.source.actorId, threadId: input.source.threadId, postId: input.source.itemId,
      decisionId: null, reportId: null, sourceId: input.source.itemId, createdAt: input.time,
    }, readable, deadline, clock, { watchId: row.watch_id, boardId: opening.board_id, publishedAt: opening.published_at });
  }
  const last = page.rows.at(-1);
  const done = page.rows.length < BOARD_WATCH_RECIPIENT_BUDGET;
  await withWritableNoticeRoute(pool, input.route, async (client) => {
    if (last) {
      await client.query(
        `UPDATE content.board_watch_notice_work SET cursor_created_at=$3::timestamptz,cursor_watch_id=$4,done=$5
         WHERE route=$1 AND post_id=$2 AND NOT done
           AND (cursor_created_at IS NULL OR (cursor_created_at,cursor_watch_id)<=($3::timestamptz,$4::uuid))`,
        [input.route,input.source.itemId,last.created_at,last.watch_id,done],
      );
    } else {
      await client.query('UPDATE content.board_watch_notice_work SET done=true WHERE route=$1 AND post_id=$2 AND NOT done',
        [input.route,input.source.itemId]);
    }
  }, deadline);
  return { done, scanned: page.rows.length };
}

/** The existing default effects worker durably retries the original event until native progress is complete. */
export function createBoardWatchNoticeEffect(pool: Pool, access: Access): Effect {
  return { name: 'content_board_watch_notice', types: [published], async run(event) {
    while (!(await processBoardWatchNoticePage(pool, access, event)).done) { /* native committed keyset continuation */ }
  } };
}
