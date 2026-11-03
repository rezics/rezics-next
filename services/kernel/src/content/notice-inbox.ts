import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import type { Access, Actor } from '../request/access.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { readPost } from './reads.ts';

export type InboxDependencies = {
  pool: Pool;
  tokens: KeyRing;
  access?: Access;
  actor?: Actor;
  deadline?: number;
  now?: () => Date;
};
export type InboxItem = Readonly<{
  id: string;
  kind: 'reply' | 'mention' | 'thread_watch' | 'moderation_decision';
  createdAt: string;
  actorId: string | null;
  threadId: string | null;
  postId: string | null;
  decisionId: string | null;
  reportId: string | null;
  unread: boolean;
}>;
const LIST_ROUTE = 'GET /v1/accounts/{accountId}/notifications';
export class InvalidInboxCursorError extends Error {}

function route(accountId: string): number {
  const value = routeOf(accountId);
  if (value === null) throw new TypeError('Invalid account id');
  return value;
}

export async function listNoticeInbox(
  dependencies: InboxDependencies,
  accountId: string,
  input: { limit: number; cursor?: string },
): Promise<{ items: InboxItem[]; next: string | null }> {
  const accountRoute = route(accountId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new RangeError('Invalid limit');
  const binding = { route: LIST_ROUTE, viewer: accountId, query: { limit: input.limit } } as const;
  let after: [string, string] | null = null;
  if (input.cursor !== undefined) {
    const value = await decodeListCursor(
      dependencies.tokens,
      binding,
      input.cursor,
      dependencies.now?.() ?? new Date(),
    );
    if (
      !value.ok ||
      value.epoch !== 1 ||
      value.after.length !== 2 ||
      typeof value.after[0] !== 'string' ||
      typeof value.after[1] !== 'string'
    )
      throw new InvalidInboxCursorError('Invalid list cursor');
    after = [value.after[0], value.after[1]];
  }
  const rows = await withConnection(dependencies.pool, async (client) => {
    const result = await client.query(
      `SELECT n.notice_id, n.kind, n.created_at, n.created_at::text AS created_at_key,
              n.actor_id, n.thread_id, n.post_id, n.decision_id, n.report_id,
              (s.seen_notice_id IS NULL OR
                (n.created_at, n.notice_id) > (s.seen_created_at, s.seen_notice_id)) AS unread
       FROM content.notice n
       LEFT JOIN content.notice_seen s ON s.route=n.route AND s.account_id=n.recipient_id
       WHERE n.route=$1 AND n.recipient_id=$2 AND
         (NOT $3::boolean OR (n.created_at,n.notice_id) < ($4::timestamptz,$5::uuid))
       ORDER BY n.created_at DESC,n.notice_id DESC LIMIT $6`,
      [
        accountRoute,
        accountId,
        after !== null,
        after?.[0] ?? 'infinity',
        after?.[1] ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        input.limit * 4,
      ],
    );
    return result.rows as Array<Record<string, any>>;
  });
  // The range is capped at 200 candidates. Read each distinct full post reference
  // through the installed native disclosure path in bounded concurrent batches;
  // this checks its current thread, reply ancestry, independent board and Realm at
  // the request's actual Access time. The returned content is used only as a proof.
  const content = new Map<string, { threadId: string; postId: string }>();
  for (const row of rows) {
    if ((row.kind !== 'reply' && row.kind !== 'mention' && row.kind !== 'thread_watch') || !row.post_id || !row.thread_id)
      continue;
    const key = `${row.thread_id}\u0000${row.post_id}`;
    content.set(key, { threadId: row.thread_id as string, postId: row.post_id as string });
  }
  const readable = new Set<string>();
  if (dependencies.access && dependencies.actor) {
    const candidates = [...content.entries()];
    const deadline = dependencies.deadline ?? Date.now() + 3_000;
    for (let offset = 0; offset < candidates.length; offset += 32) {
      await Promise.all(
        candidates.slice(offset, offset + 32).map(async ([key, candidate]) => {
          const result = await readPost(
            { pool: dependencies.pool, access: dependencies.access!, tokens: dependencies.tokens },
            candidate.threadId,
            candidate.postId,
            { actor: dependencies.actor!, deadline },
          );
          if (result.value) readable.add(key);
        }),
      );
    }
  }
  const items: InboxItem[] = [];
  let lastScanned: Record<string, any> | undefined;
  let scanned = 0;
  for (const row of rows) {
    scanned++;
    lastScanned = row;
    if (
      (row.kind === 'reply' || row.kind === 'mention' || row.kind === 'thread_watch') &&
      (!row.post_id || !row.thread_id || !readable.has(`${row.thread_id}\u0000${row.post_id}`))
    )
      continue;
    items.push({
      id: row.notice_id,
      kind: row.kind,
      createdAt: new Date(row.created_at).toISOString(),
      actorId: row.actor_id,
      threadId: row.thread_id,
      postId: row.post_id,
      decisionId: row.decision_id,
      reportId: row.report_id,
      unread: row.unread,
    });
    if (items.length === input.limit) break;
  }
  const next =
    lastScanned && (scanned < rows.length || rows.length === input.limit * 4)
      ? await encodeListCursor(
          dependencies.tokens,
          binding,
          { epoch: 1, after: [lastScanned.created_at_key, lastScanned.notice_id] },
          dependencies.now?.() ?? new Date(),
        )
      : null;
  return { items, next };
}

export async function countUnreadNotices(pool: Pool, accountId: string): Promise<{ count: number; capped: boolean }> {
  const accountRoute = route(accountId);
  const rows = await withConnection(pool, async (client) => {
    const marker = await client.query(
      `SELECT seen_notice_id, seen_created_at::text
       FROM content.notice_seen
       WHERE route=$1 AND account_id=$2`,
      [accountRoute, accountId],
    );
    if (!marker.rows.length)
      return (
        await client.query(
          `SELECT notice_id FROM content.notice
           WHERE route=$1 AND recipient_id=$2
           ORDER BY created_at,notice_id LIMIT 101`,
          [accountRoute, accountId],
        )
      ).rows;
    // Text keeps PostgreSQL timestamp precision across the driver boundary.
    // The tuple predicate seeks the existing recipient/creation index directly.
    const query = await client.query(
      `SELECT notice_id FROM content.notice
       WHERE route=$1 AND recipient_id=$2
         AND (created_at,notice_id)>($3::timestamptz,$4::uuid)
       ORDER BY created_at,notice_id LIMIT 101`,
      [accountRoute, accountId, marker.rows[0]!.seen_created_at, marker.rows[0]!.seen_notice_id],
    );
    return query.rows;
  });
  return { count: Math.min(rows.length, 100), capped: rows.length > 100 };
}

export async function markNoticesSeen(pool: Pool, accountId: string, noticeId: string, at = new Date()): Promise<void> {
  const accountRoute = route(accountId);
  if (routeOf(noticeId) !== accountRoute) throw new RangeError('Unknown notice');
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const target = await client.query(
        `SELECT notice_id FROM content.notice
         WHERE route=$1 AND recipient_id=$2 AND notice_id=$3
         FOR SHARE`,
        [accountRoute, accountId, noticeId],
      );
      if (target.rowCount !== 1) throw new RangeError('Unknown notice');
      // Keep the owned point alive until its exact database tuple is copied.
      // ON CONFLICT locks the recipient's single frontier and compares against
      // the latest committed tuple, including a simultaneous first mark.
      // No Date conversion, historical notice lookup or UUID-only fallback is
      // involved; retention may remove either point after this transaction.
      await client.query(
        `INSERT INTO content.notice_seen AS frontier
           (route,account_id,seen_notice_id,seen_created_at,seen_at)
         SELECT route,recipient_id,notice_id,created_at,$4
         FROM content.notice WHERE route=$1 AND recipient_id=$2 AND notice_id=$3
         ON CONFLICT (route,account_id) DO UPDATE
         SET seen_notice_id=EXCLUDED.seen_notice_id,
             seen_created_at=EXCLUDED.seen_created_at,
             seen_at=EXCLUDED.seen_at
         WHERE (frontier.seen_created_at,frontier.seen_notice_id)
             < (EXCLUDED.seen_created_at,EXCLUDED.seen_notice_id)`,
        [accountRoute, accountId, noticeId, at],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
