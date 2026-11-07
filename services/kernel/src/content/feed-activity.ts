import type { Pool } from 'pg';
import { readAccount } from './access-port.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from './feed-source-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { feedSnapshot } from './feed-snapshot.ts';

export type FeedActivityTarget = Readonly<{ type: 'subject' | 'collection' | 'space'; id: string }>;
export type FeedActivityObject =
  | Readonly<{ owner: 'content'; kind: 'thread' | 'post'; route: number; id: string; threadId: string }>
  | Readonly<{ owner: 'semantic'; kind: string; route: number; id: string; realmId: string; publicationId: string }>
  | Readonly<{ owner: 'library'; kind: 'collection'; route: number; id: string }>;
export type ActivityRef = Readonly<{
  id: string;
  source: Readonly<{ partition: number; epoch: number; position: string; eventIndex: number }>;
  occurredAt: string;
  target: FeedActivityTarget;
  object: FeedActivityObject;
}>;
export type ActivityPage = Readonly<{ activities: readonly ActivityRef[]; next: string | null }>;
export type ActivityPageQuery = Readonly<{ cursor?: string; limit?: number }>;
export const FEED_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const FEED_REFERENCE_CAP = 2000;
export function feedRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Invalid feed locator');
  return route;
}
export function feedPageLimit(limit = 128): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Feed page limit must be 1..128');
  return limit;
}
export function validateActivity(activity: ActivityRef): void {
  const { source, object, target } = activity;
  if (
    activity.id !==
      `${source.partition}.${source.epoch}.${source.position}.${source.eventIndex}:${target.type}:${target.id}` ||
    !Number.isInteger(source.partition) ||
    source.partition < 0 ||
    source.partition > 4095 ||
    !Number.isInteger(source.epoch) ||
    source.epoch < 1 ||
    source.epoch > 2147483647 ||
    !/^[1-9][0-9]{0,18}$/.test(source.position) ||
    BigInt(source.position) > 9223372036854775807n ||
    !Number.isInteger(source.eventIndex) ||
    source.eventIndex < 0 ||
    source.eventIndex >= 1000 ||
    partitionOf(object.owner === 'semantic' ? feedRoute(object.realmId) : object.route) !== source.partition ||
    feedRoute(object.id) !== object.route ||
    !['subject', 'collection', 'space'].includes(target.type) ||
    !Number.isFinite(Date.parse(activity.occurredAt))
  )
    throw new TypeError('Invalid feed activity identity');
  feedRoute(target.id);
  if (object.owner === 'content' && feedRoute(object.threadId) !== object.route)
    throw new TypeError('Invalid feed thread anchor');
}

/** Candidate inventories carry no body, title, account permission or disclosure grant.
 * tokens is additive: exposed inventory/inbox cursors use the composed native ring. */
export function createFeedActivityStore(deps: { pool: Pool; clock: KernelClock; tokens: KeyRing }) {
  const clock = deps.clock;
  async function page(
    anchor: FeedActivityTarget | { accountId: string },
    query: ActivityPageQuery & { boundary?: string },
    deadline: number,
  ): Promise<ActivityPage> {
    const limit = feedPageLimit(query.limit);
    const inbox = 'accountId' in anchor;
    const id = inbox ? anchor.accountId : anchor.id;
    const binding = {
      operation: inbox ? 'content.feed.inbox' : 'content.feed.target',
      parameters: {
        id,
        type: inbox ? 'account' : anchor.type,
        limit,
      },
    };
    const now = clock();
    const cursor = query.cursor === undefined ? null : decodeCursor(deps.tokens, binding, query.cursor, now.getTime());
    if (
      cursor &&
      (!cursor.ok ||
        cursor.epoch !== 1 ||
        cursor.after.length !== 3 ||
        cursor.after.some((value) => typeof value !== 'string'))
    )
      throw new ProblemError('invalid_cursor');
    const after = cursor?.ok ? (cursor.after as string[]) : null;
    const boundary = after?.[2] ?? query.boundary ?? now.toISOString();
    const cutoff = new Date(now.getTime() - FEED_RETENTION_MS).toISOString();
    const activities = await feedSnapshot(deps.pool, feedRoute(id), deadline, async (client) => {
      const rows = await client.query<{ activity: ActivityRef; at: string; id: string }>(
        inbox
          ? `SELECT activity, to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, activity_id AS id
           FROM content.feed_inbox WHERE route=$1 AND account_id=$2 AND occurred_at>$3 AND occurred_at<=$4
           AND ($5::text IS NULL OR (occurred_at,activity_id)<($5::timestamptz,$6::text))
           ORDER BY occurred_at DESC,activity_id DESC LIMIT $7`
          : `SELECT activity, to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, activity_id AS id
           FROM content.feed_activity WHERE route=$1 AND target_id=$2 AND target_type=$8 AND occurred_at>$3 AND occurred_at<=$4
           AND ($5::text IS NULL OR (occurred_at,activity_id)<($5::timestamptz,$6::text))
           ORDER BY occurred_at DESC,activity_id DESC LIMIT $7`,
        [
          feedRoute(id),
          id,
          cutoff,
          boundary,
          after?.[0] ?? null,
          after?.[1] ?? '',
          limit,
          ...(!inbox ? [anchor.type] : []),
        ],
      );
      return rows.rows;
    });
    const last = activities.at(-1);
    return {
      activities: activities.map((row) => row.activity),
      next:
        last && activities.length === limit
          ? encodeCursor(deps.tokens, binding, { epoch: 1, after: [last.at, last.id, boundary] }, now.getTime())
          : null,
    };
  }
  return {
    pageTargetActivity: (target: FeedActivityTarget, query: ActivityPageQuery, deadline: number) =>
      page(target, query, deadline),
    pageFollowingActivity: (accountId: string, query: ActivityPageQuery & { boundary?: string }, deadline: number) =>
      page({ accountId }, query, deadline),
    async recordTargetActivity(activity: ActivityRef, deadline: number): Promise<void> {
      validateActivity(activity);
      const route = feedRoute(activity.target.id);
      await runCommand(deps.pool, { partition: partitionOf(route), deadline }, async (tx, attempt) => {
        if (Date.parse(activity.occurredAt) <= Date.parse(authoritativeTimeValue(attempt.time)) - FEED_RETENTION_MS)
          return noEffect(null);
        const inserted = await tx.query(
          `INSERT INTO content.feed_activity(route,target_type,target_id,activity_id,occurred_at,activity)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING activity_id`,
          [route, activity.target.type, activity.target.id, activity.id, activity.occurredAt, activity],
        );
        return inserted.rowCount
          ? {
              value: null,
              events: [{ type: 'com.rezics.content.feed.indexed.v1', subject: activity.target.id, data: {} }],
            }
          : noEffect(null);
      });
    },
    async applyFollowingActivity(
      input: { accountId: string; reasonTarget: FeedActivityTarget; activity: ActivityRef },
      deadline: number,
    ): Promise<void> {
      validateActivity(input.activity);
      if (input.reasonTarget.id !== input.activity.target.id || input.reasonTarget.type !== input.activity.target.type)
        throw new TypeError('Feed reason differs from activity target');
      const route = feedRoute(input.accountId);
      await runCommand(deps.pool, { partition: partitionOf(route), deadline }, async (tx, attempt) => {
        // Serialize lifecycle and all deliveries to this home. No foreign read occurs in this transaction.
        const account = await tx.query(
          `SELECT state,authn_fenced FROM access.account
          WHERE route=$1 AND account_id=$2 FOR SHARE`,
          [route, input.accountId],
        );
        if (account.rows[0]?.state !== 'active' || account.rows[0]?.authn_fenced) return noEffect(null);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`content.feed:${input.accountId}`]);
        const cutoff = new Date(Date.parse(authoritativeTimeValue(attempt.time)) - FEED_RETENTION_MS).toISOString();
        if (Date.parse(input.activity.occurredAt) <= Date.parse(cutoff)) return noEffect(null);
        const inserted = await tx.query(
          `INSERT INTO content.feed_inbox(route,account_id,activity_id,occurred_at,activity)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING activity_id`,
          [route, input.accountId, input.activity.id, input.activity.occurredAt, input.activity],
        );
        if (!inserted.rowCount) return noEffect(null);
        await tx.query(
          `DELETE FROM content.feed_inbox WHERE route=$1 AND account_id=$2 AND activity_id IN (
          SELECT activity_id FROM content.feed_inbox WHERE route=$1 AND account_id=$2
          ORDER BY occurred_at DESC,activity_id DESC OFFSET 2000 LIMIT 1)`,
          [route, input.accountId],
        );
        return {
          value: null,
          events: [{ type: 'com.rezics.content.feed.delivered.v1', subject: input.accountId, data: {} }],
        };
      });
    },
  };
}
export type FeedActivityStore = ReturnType<typeof createFeedActivityStore>;

/** Repeated by the existing account erasure phase; never acknowledges foreign or Library stores. */
export async function eraseFeedInboxPage(pool: Pool, accountId: string, deadline: number): Promise<number> {
  const route = feedRoute(accountId);
  return (
    await runCommand(pool, { partition: partitionOf(route), deadline }, async (tx, attempt) => {
      const owner = await readAccount(tx, route, accountId);
      if (owner?.state !== 'deleted') throw new Error('Feed erasure requires terminal account');
      const deleted = await tx.query(
        `DELETE FROM content.feed_inbox WHERE route=$1 AND account_id=$2 AND activity_id IN
      (SELECT activity_id FROM content.feed_inbox WHERE route=$1 AND account_id=$2 ORDER BY activity_id LIMIT 128) RETURNING activity_id`,
        [route, accountId],
      );
      return deleted.rowCount
        ? {
            value: deleted.rowCount,
            events: [{ type: 'com.rezics.content.feed.erased.v1', subject: accountId, data: {} }],
          }
        : noEffect(0);
    })
  ).value;
}
