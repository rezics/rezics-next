import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  discloseNoticeCandidates,
  type NoticeActor,
  type NoticeCandidate,
  type NoticeOpenAction,
  type NoticeTarget,
} from './notice-disclosure.ts';

export type InboxDependencies = Readonly<{
  pool: Pool;
  tokens: KeyRing;
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
  deadline?: number;
  now?: () => Date;
}>;

export type InboxItem = Readonly<{
  id: string;
  kind: NoticeCandidate['kind'];
  createdAt: string;
  actorId: string | null;
  actor: NoticeActor;
  threadId: string | null;
  postId: string | null;
  decisionId: string | null;
  reportId: string | null;
  target: NoticeTarget;
  summary: string;
  actions: Readonly<{
    open: NoticeOpenAction;
    markSeen: Readonly<{ method: 'POST'; path: string }>;
  }>;
  unread: boolean;
}>;

export type UnreadNoticeSummary = Readonly<{
  count: number;
  capped: boolean;
  basis: 'current-visible-unread' | 'current-visible-lower-bound';
  witness: Readonly<{ kind: 'current-disclosure'; at: string }>;
}>;

const LIST_ROUTE = 'GET /v1/accounts/{accountId}/notifications';
const CANDIDATE_FACTOR = 4;
const SUMMARY_CANDIDATE_LIMIT = 200;
export class InvalidInboxCursorError extends Error {}
export class InboxViewerUnavailableError extends Error {}

function route(accountId: string): number {
  const value = routeOf(accountId);
  if (value === null) throw new TypeError('Invalid account id');
  return value;
}

function readerActor(dependencies: InboxDependencies, accountId: string): Extract<Actor, { kind: 'account' }> {
  const actor = dependencies.actor;
  if (actor.kind !== 'account' || actor.accountId !== accountId || routeOf(accountId) === null)
    throw new InboxViewerUnavailableError('Current Inbox viewer is unavailable');
  return actor;
}

/** Recheck account status, authn epoch and account:read after source hydration. */
export async function assertCurrentInboxViewer(
  dependencies: InboxDependencies,
  accountId: string,
): Promise<void> {
  const actor = readerActor(dependencies, accountId);
  const accountRoute = route(accountId);
  const deadline = dependencies.deadline ?? Date.now() + 3_000;
  const check = await accessCheck(
    dependencies.access,
    actor,
    'account:read',
    { route: accountRoute, id: accountId },
    { pool: dependencies.pool, deadline },
  );
  const current = await within(deadline, () => withConnection(dependencies.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const account = await readAccount(client, accountRoute, accountId);
    return !!(
      account &&
      account.accountId === accountId &&
      account.kind === 'actor' &&
      account.state === 'active' &&
      !account.fenced &&
      Number.isSafeInteger(actor.authnEpoch) &&
      actor.authnEpoch > 0 &&
      BigInt(actor.authnEpoch) >= account.minimumAuthnEpoch &&
      (await check(client))
    );
  }));
  if (!current) throw new InboxViewerUnavailableError('Current Inbox viewer is unavailable');
}

function dependenciesForDisclosure(dependencies: InboxDependencies) {
  return {
    pool: dependencies.pool,
    access: dependencies.access,
    tokens: dependencies.tokens,
    routeKey: dependencies.routeKey,
    actor: dependencies.actor,
    deadline: dependencies.deadline ?? Date.now() + 3_000,
  };
}

function unreadSql(): string {
  return `NOT EXISTS (
           SELECT 1 FROM content.notice_ack AS ack
           WHERE ack.route=n.route AND ack.account_id=n.recipient_id AND ack.notice_id=n.notice_id
         ) AND (s.seen_notice_id IS NULL OR
           (n.created_at,n.notice_id) > (s.seen_created_at,s.seen_notice_id))`;
}

export async function listNoticeInbox(
  dependencies: InboxDependencies,
  accountId: string,
  input: { limit: number; cursor?: string },
): Promise<{ items: InboxItem[]; next: string | null }> {
  const accountRoute = route(accountId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new RangeError('Invalid limit');
  const actor = readerActor(dependencies, accountId);
  await assertCurrentInboxViewer(dependencies, accountId);
  const binding = {
    route: LIST_ROUTE,
    viewer: accountId,
    query: { limit: input.limit, clientId: actor.clientId, authnEpoch: actor.authnEpoch },
  } as const;
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
      value.epoch !== 2 ||
      value.after.length !== 2 ||
      typeof value.after[0] !== 'string' ||
      typeof value.after[1] !== 'string'
    )
      throw new InvalidInboxCursorError('Invalid list cursor');
    after = [value.after[0], value.after[1]];
  }
  const candidateLimit = Math.min(input.limit * CANDIDATE_FACTOR, 200);
  const rows = await withConnection(dependencies.pool, async (client) => {
    const result = await client.query(
      `SELECT n.notice_id, n.kind, n.created_at, n.created_at::text AS created_at_key,
              n.source_id, n.actor_id, n.thread_id, n.post_id, n.decision_id, n.report_id,
              ${unreadSql()} AS unread
       FROM content.notice AS n
       LEFT JOIN content.notice_seen AS s ON s.route=n.route AND s.account_id=n.recipient_id
       WHERE n.route=$1 AND n.recipient_id=$2 AND
         (NOT $3::boolean OR (n.created_at,n.notice_id) < ($4::timestamptz,$5::uuid))
       ORDER BY n.created_at DESC,n.notice_id DESC LIMIT $6`,
      [
        accountRoute,
        accountId,
        after !== null,
        after?.[0] ?? 'infinity',
        after?.[1] ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        candidateLimit,
      ],
    );
    return result.rows as NoticeCandidate[];
  });

  const projections = await discloseNoticeCandidates(dependenciesForDisclosure(dependencies), accountId, rows, {
    actorLimit: input.limit,
  });
  const items: InboxItem[] = [];
  let lastScanned: NoticeCandidate | undefined;
  let scanned = 0;
  for (const row of rows) {
    scanned++;
    lastScanned = row;
    const projection = projections.get(row.notice_id);
    if (projection) {
      items.push({
        id: row.notice_id,
        kind: row.kind,
        createdAt: new Date(row.created_at).toISOString(),
        actorId: projection.actorId,
        actor: projection.actor,
        threadId: projection.target.state === 'available' ? projection.target.threadId : null,
        postId: projection.target.state === 'available' ? projection.target.postId : null,
        decisionId: projection.decisionId,
        reportId: projection.reportId,
        target: projection.target,
        summary: projection.summary,
        actions: {
          open: projection.open,
          markSeen: {
            method: 'POST',
            path: `/v1/accounts/${accountId}/notifications/${row.notice_id}:markSeen`,
          },
        },
        unread: row.unread,
      });
      if (items.length === input.limit) break;
    }
  }
  await assertCurrentInboxViewer(dependencies, accountId);
  const next =
    lastScanned && (scanned < rows.length || rows.length === candidateLimit)
      ? await encodeListCursor(
          dependencies.tokens,
          binding,
          { epoch: 2, after: [lastScanned.created_at_key, lastScanned.notice_id] },
          dependencies.now?.() ?? new Date(),
        )
      : null;
  return { items, next };
}

export async function countUnreadNotices(
  dependencies: InboxDependencies,
  accountId: string,
): Promise<UnreadNoticeSummary> {
  const accountRoute = route(accountId);
  await assertCurrentInboxViewer(dependencies, accountId);
  const rows = await withConnection(dependencies.pool, async (client) => {
    const result = await client.query(
      `SELECT n.notice_id, n.kind, n.created_at, n.created_at::text AS created_at_key,
              n.source_id, n.actor_id, n.thread_id, n.post_id, n.decision_id, n.report_id,
              true AS unread
       FROM content.notice AS n
       LEFT JOIN content.notice_seen AS s ON s.route=n.route AND s.account_id=n.recipient_id
       WHERE n.route=$1 AND n.recipient_id=$2 AND ${unreadSql()}
      ORDER BY n.created_at,n.notice_id LIMIT $3`,
      [accountRoute, accountId, SUMMARY_CANDIDATE_LIMIT + 1],
    );
    return result.rows as NoticeCandidate[];
  });
  const truncated = rows.length > SUMMARY_CANDIDATE_LIMIT;
  const candidates = rows.slice(0, SUMMARY_CANDIDATE_LIMIT);
  const visible = await discloseNoticeCandidates(
    dependenciesForDisclosure(dependencies),
    accountId,
    candidates,
    { includeActors: false },
  );
  await assertCurrentInboxViewer(dependencies, accountId);
  const count = Math.min(visible.size, 100);
  const capped = truncated || visible.size > 100;
  return {
    count,
    capped,
    basis: truncated ? 'current-visible-lower-bound' : 'current-visible-unread',
    witness: { kind: 'current-disclosure', at: (dependencies.now?.() ?? new Date()).toISOString() },
  };
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

/** Exact one-item acknowledgement, independent from the monotonic bulk frontier. */
export async function acknowledgeNotice(pool: Pool, accountId: string, noticeId: string, at = new Date()): Promise<void> {
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
      await client.query(
        `INSERT INTO content.notice_ack(route,account_id,notice_id,acknowledged_at)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(route,account_id,notice_id) DO NOTHING`,
        [accountRoute, accountId, noticeId, at],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
