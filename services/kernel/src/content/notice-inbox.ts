import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { resourcePage, type Access, type Actor } from '../request/access.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

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
  kind: 'reply' | 'mention' | 'moderation_decision';
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
      `SELECT n.notice_id, n.kind, n.created_at, n.actor_id, n.thread_id, n.post_id, n.decision_id, n.report_id,
              (s.seen_notice_id IS NULL OR CASE WHEN seen.notice_id IS NULL THEN n.notice_id > s.seen_notice_id
                ELSE (n.created_at, n.notice_id) > (seen.created_at, s.seen_notice_id) END) AS unread
       FROM content.notice n
       LEFT JOIN content.notice_seen s ON s.route=n.route AND s.account_id=n.recipient_id
       LEFT JOIN content.notice seen ON seen.route=s.route AND seen.notice_id=s.seen_notice_id
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
  // Check current content state and the installed post:read formula in bounded route batches.
  const postIds = rows
    .filter((row) => row.post_id && (row.kind === 'reply' || row.kind === 'mention'))
    .map((row) => row.post_id as string);
  const readable = new Set<string>();
  const groups = new Map<number, string[]>();
  for (const id of new Set(postIds)) {
    const contentRoute = routeOf(id);
    if (contentRoute !== null) groups.set(contentRoute, [...(groups.get(contentRoute) ?? []), id]);
  }
  for (const [contentRoute, ids] of groups) {
    if (!dependencies.access?.preparePage || !dependencies.access.authorizePage || !dependencies.actor) continue;
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const page = resourcePage({ route: contentRoute, resourceType: 'content.post', ids: batch });
      const evidence = await dependencies.access.preparePage(dependencies.actor, 'post:read', page, {
        pool: dependencies.pool,
        deadline: dependencies.deadline ?? Date.now() + 3_000,
      });
      const allowed = await withConnection(dependencies.pool, async (client) => {
        const decision = await dependencies.access!.authorizePage!(
          client,
          dependencies.actor!,
          'post:read',
          page,
          evidence,
        );
        if (!decision) return [];
        const checked = await client.query(
          `SELECT p.post_id FROM content.post p
           JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
           JOIN content.board b ON b.route=t.route AND b.board_id=t.board_id
           WHERE p.route=$1 AND p.post_id=ANY($2::uuid[]) AND p.visibility IN ('published','protected')
             AND p.availability='available' AND t.visibility IN ('published','protected') AND b.visibility IN ('published','protected')`,
          [contentRoute, batch],
        );
        return checked.rows.map((row) => row.post_id as string);
      });
      allowed.forEach((id) => readable.add(id));
    }
  }
  const items: InboxItem[] = [];
  let lastScanned: Record<string, any> | undefined;
  let scanned = 0;
  for (const row of rows) {
    scanned++;
    lastScanned = row;
    if ((row.kind === 'reply' || row.kind === 'mention') && (!row.post_id || !readable.has(row.post_id))) continue;
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
          { epoch: 1, after: [new Date(lastScanned.created_at).toISOString(), lastScanned.notice_id] },
          dependencies.now?.() ?? new Date(),
        )
      : null;
  return { items, next };
}

export async function countUnreadNotices(pool: Pool, accountId: string): Promise<{ count: number; capped: boolean }> {
  const accountRoute = route(accountId);
  const rows = await withConnection(pool, async (client) => {
    const marker = await client.query(
      'SELECT seen_notice_id FROM content.notice_seen WHERE route=$1 AND account_id=$2',
      [accountRoute, accountId],
    );
    if (!marker.rows.length)
      return (
        await client.query(
          'SELECT notice_id FROM content.notice WHERE route=$1 AND recipient_id=$2 ORDER BY created_at,notice_id LIMIT 101',
          [accountRoute, accountId],
        )
      ).rows;
    const markerId = marker.rows[0]!.seen_notice_id as string;
    const markerNotice = await client.query('SELECT created_at FROM content.notice WHERE route=$1 AND notice_id=$2', [
      accountRoute,
      markerId,
    ]);
    const query = markerNotice.rows.length
      ? await client.query(
          'SELECT notice_id FROM content.notice WHERE route=$1 AND recipient_id=$2 AND (created_at,notice_id)>($3::timestamptz,$4::uuid) ORDER BY created_at,notice_id LIMIT 101',
          [accountRoute, accountId, markerNotice.rows[0]!.created_at, markerId],
        )
      : await client.query(
          'SELECT notice_id FROM content.notice WHERE route=$1 AND recipient_id=$2 AND notice_id>$3::uuid ORDER BY created_at,notice_id LIMIT 101',
          [accountRoute, accountId, markerId],
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
        'SELECT created_at FROM content.notice WHERE route=$1 AND recipient_id=$2 AND notice_id=$3 FOR SHARE',
        [accountRoute, accountId, noticeId],
      );
      if (target.rowCount !== 1) throw new RangeError('Unknown notice');
      const existing = await client.query(
        `SELECT old.created_at, seen.seen_notice_id AS notice_id FROM content.notice_seen seen
         LEFT JOIN content.notice old ON old.route=seen.route AND old.notice_id=seen.seen_notice_id
         WHERE seen.route=$1 AND seen.account_id=$2 FOR UPDATE OF seen`,
        [accountRoute, accountId],
      );
      if (
        !existing.rows.length ||
        (existing.rows[0]!.created_at === null
          ? noticeId > existing.rows[0]!.notice_id
          : new Date(target.rows[0]!.created_at).getTime() > new Date(existing.rows[0]!.created_at).getTime() ||
            (new Date(target.rows[0]!.created_at).getTime() === new Date(existing.rows[0]!.created_at).getTime() &&
              noticeId > existing.rows[0]!.notice_id))
      )
        await client.query(
          `INSERT INTO content.notice_seen (route,account_id,seen_notice_id,seen_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (route,account_id) DO UPDATE SET seen_notice_id=EXCLUDED.seen_notice_id,seen_at=EXCLUDED.seen_at
           WHERE EXISTS (
             SELECT 1 FROM content.notice target WHERE target.route=$1 AND target.notice_id=$3
               AND (EXISTS (SELECT 1 FROM content.notice old WHERE old.route=$1 AND old.notice_id=content.notice_seen.seen_notice_id
                            AND (old.created_at,old.notice_id) <= (target.created_at,target.notice_id))
                    OR (NOT EXISTS (SELECT 1 FROM content.notice old WHERE old.route=$1 AND old.notice_id=content.notice_seen.seen_notice_id)
                        AND target.notice_id > content.notice_seen.seen_notice_id)))`,
          [accountRoute, accountId, noticeId, at],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
