import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import readPage from './account-erasure-authored-page.sql';
import markAuthorErased from './account-erasure-authored-mark.sql';
import disposeItem from './account-erasure-authored-item.sql';
import deleteItems from './account-erasure-authored-delete.sql';
import { noteAccountErasureFound } from './account-erasure-progress.ts';

export type AuthoredErasureCursor = Readonly<{ itemKind: string; itemId: string; revisionAfter?: string }>;
type Item = { item_kind: 'thread' | 'post'; item_id: string; thread_id: string };
type Disposition = {
  thread_id: string;
  erased_post_id: string | null;
  security_revision: string | null;
  revisions: number;
  cleared: number;
  titles: number;
  after_at: string | null;
  after_revision: string | null;
};
const START_ID = '00000000-0000-0000-0000-000000000000';
function route(id: string): number {
  const result = routeOf(id);
  if (result === null) throw new TypeError('Invalid authored erasure identity');
  return result;
}

/** Platform continuation of the committed erasure obligation. Snapshot receipts
 * freeze each key page before any item partition is entered. Item receipts then
 * preserve revision accounting and the continuation across partial commits.
 */
export async function eraseAccountAuthoredPage(
  deps: { pool: Pool },
  accountId: string,
  cursor: AuthoredErasureCursor | null,
): Promise<{ next: AuthoredErasureCursor | null; found: number }> {
  const accountRoute = route(accountId);
  if (cursor && cursor.itemKind !== 'post' && cursor.itemKind !== 'thread')
    throw new TypeError('Invalid authored erasure cursor');
  if (cursor) route(cursor.itemId);
  const after: [string, string] = cursor?.revisionAfter
    ? (JSON.parse(cursor.revisionAfter) as [string, string])
    : ['-infinity', START_ID];
  if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== 'string' || typeof after[1] !== 'string')
    throw new TypeError('Invalid revision cursor');
  if (cursor?.revisionAfter) route(after[1]);
  const key = createHash('sha256')
    .update(
      JSON.stringify([accountId, cursor?.itemKind ?? null, cursor?.itemId ?? null, cursor?.revisionAfter ?? null]),
    )
    .digest('hex');
  // A receipt namespace is not an initiator. Leaving basis absent attributes all
  // commands to the platform, including after the account's tokens are revoked.
  const command = <T>(partition: number, phase: string, body: Parameters<typeof runCommand<T>>[2]) =>
    runCommand(
      deps.pool,
      {
        partition,
        deadline: Date.now() + 120_000,
        receipt: {
          actorAccountId: accountId,
          kind: `content.account-erasure.authored.${phase}`,
          key,
          digest: createHash('sha256').update(`${key}:${phase}`).digest(),
        },
      },
      body,
    ).then((result) => result.value);

  const items = await command(partitionOf(accountRoute), 'page', async (tx) => {
    const obligation = await tx.query('SELECT 1 FROM access.erasure WHERE route=$1 AND account_id=$2', [
      accountRoute,
      accountId,
    ]);
    if (!obligation.rowCount) throw new Error('Account erasure obligation is missing');
    const parameters = {
      route: accountRoute,
      account_id: accountId,
      after_kind: cursor?.itemKind ?? '',
      after_id: cursor?.itemId ?? START_ID,
      resume: !!cursor?.revisionAfter,
    };
    const result = await tx.query<Item>(
      readPage.sql,
      readPage.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    return noEffect(result.rows);
  });
  if (items.length) await noteAccountErasureFound(deps, accountId, 'content');
  let remaining = 100;
  let found = items.length;
  let next: AuthoredErasureCursor | null = null;
  const completed: Item[] = [];
  for (const item of items) {
    // A later key in this snapshot cannot be skipped when the revision budget
    // was consumed by the previous item. The completed-item cursor excludes
    // only work that this step will delete from the account's locator.
    if (remaining === 0) {
      const last = completed.at(-1);
      if (last) next = { itemKind: last.item_kind, itemId: last.item_id };
      break;
    }
    const itemRoute = route(item.item_id);
    const resume = cursor?.revisionAfter && cursor.itemId === item.item_id && cursor.itemKind === item.item_kind;
    const parameters = {
      route: itemRoute,
      account_id: accountId,
      item_kind: item.item_kind,
      item_id: item.item_id,
      after_at: resume ? after[0] : '-infinity',
      after_revision: resume ? after[1] : START_ID,
      revision_limit: remaining,
    };
    const value = await command(partitionOf(itemRoute), `item.${item.item_kind}.${item.item_id}`, async (tx) => {
      const marked = await tx.query(
        markAuthorErased.sql,
        markAuthorErased.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      const result = await tx.query<Disposition>(
        disposeItem.sql,
        disposeItem.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      const row = result.rows[0];
      if (!row || (!row.erased_post_id && row.cleared === 0 && row.titles === 0 && !marked.rowCount))
        return noEffect(row ?? null);
      return {
        value: row,
        events: row.erased_post_id
          ? [
              {
                type: 'com.rezics.content.post.erased.v1',
                subject: row.erased_post_id,
                data: { postId: row.erased_post_id, securityRevision: row.security_revision, accountErasure: true },
              },
            ]
          : [
              {
                // Reuse the existing mechanical history-cleanup event, without claiming
                // that this retained post was erased or restoring any person's authority.
                type: 'com.rezics.content.moderation.erasure.v1',
                data: { threadId: row.thread_id, postIds: [], mediaIds: [] },
              },
            ],
      };
    });
    const revisions = value?.revisions ?? 0;
    found += revisions;
    remaining -= revisions;
    if (remaining === 0 && value?.after_at && value.after_revision) {
      next = {
        itemKind: item.item_kind,
        itemId: item.item_id,
        revisionAfter: JSON.stringify([value.after_at, value.after_revision]),
      };
      break;
    }
    completed.push(item);
    next = { itemKind: item.item_kind, itemId: item.item_id };
    if (remaining === 0) break;
  }
  if (completed.length)
    await command(partitionOf(accountRoute), 'delete', async (tx) => {
      const events = [];
      for (const item of completed) {
        const parameters = {
          route: accountRoute,
          account_id: accountId,
          item_kind: item.item_kind,
          item_id: item.item_id,
        };
        const result = await tx.query<{
          item_kind: string;
          item_id: string;
          source_epoch: number;
          source_position: string;
        }>(
          deleteItems.sql,
          deleteItems.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        for (const removed of result.rows)
          events.push({
            type: 'com.rezics.content.author-item.projected.v1',
            subject: accountId,
            data: {
              authorAccountId: accountId,
              itemKind: removed.item_kind,
              itemId: removed.item_id,
              sourceEpoch: removed.source_epoch,
              sourcePosition: removed.source_position,
            },
          });
      }
      return events.length ? { value: null, events } : noEffect(null);
    });
  // A full key page needs a subsequent empty range proof; no 51st key is read.
  if (completed.length === items.length && items.length < 50) next = null;
  return { next, found };
}

/** Applies one late author's item after the account-home fence has closed.
 * It uses the same disposition SQL as the bounded page and removes any earlier
 * locator only after the item partition has committed its disposition.
 */
export async function eraseAccountAuthoredItem(
  deps: { pool: Pool },
  accountId: string,
  itemKind: 'thread' | 'post',
  itemId: string,
): Promise<void> {
  const accountRoute = route(accountId);
  const itemRoute = route(itemId);
  let afterAt = '-infinity';
  let afterRevision = START_ID;
  for (;;) {
    const key = createHash('sha256')
      .update(JSON.stringify([accountId, itemKind, itemId, afterAt, afterRevision]))
      .digest('hex');
    const parameters = {
      route: itemRoute,
      account_id: accountId,
      item_kind: itemKind,
      item_id: itemId,
      after_at: afterAt,
      after_revision: afterRevision,
      revision_limit: 100,
    };
    const result = await runCommand(
      deps.pool,
      {
        partition: partitionOf(itemRoute),
        deadline: Date.now() + 120_000,
        receipt: {
          actorAccountId: accountId,
          kind: 'content.account-erasure.authored.late-item',
          key,
          digest: createHash('sha256').update(key).digest(),
        },
      },
      async (tx) => {
        const marked = await tx.query(
          markAuthorErased.sql,
          markAuthorErased.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        const disposed = await tx.query<Disposition>(
          disposeItem.sql,
          disposeItem.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        const row = disposed.rows[0];
        if (!row || (!row.erased_post_id && row.cleared === 0 && row.titles === 0 && !marked.rowCount))
          return noEffect(row ?? null);
        return {
          value: row,
          events: row.erased_post_id
            ? [
                {
                  type: 'com.rezics.content.post.erased.v1',
                  subject: row.erased_post_id,
                  data: { postId: row.erased_post_id, securityRevision: row.security_revision, accountErasure: true },
                },
              ]
            : [
                {
                  type: 'com.rezics.content.moderation.erasure.v1',
                  data: { threadId: row.thread_id, postIds: [], mediaIds: [] },
                },
              ],
        };
      },
    );
    const row = result.value;
    if (!row?.after_at || !row.after_revision) break;
    afterAt = row.after_at;
    afterRevision = row.after_revision;
  }
  await runCommand(
    deps.pool,
    {
      partition: partitionOf(accountRoute),
      deadline: Date.now() + 120_000,
      receipt: {
        actorAccountId: accountId,
        kind: 'content.account-erasure.authored.late-locator',
        key: createHash('sha256').update(`${accountId}:${itemKind}:${itemId}`).digest('hex'),
        digest: createHash('sha256').update(`${accountId}:${itemKind}:${itemId}:locator`).digest(),
      },
    },
    async (tx) => {
      const parameters = {
        route: accountRoute,
        account_id: accountId,
        item_kind: itemKind,
        item_id: itemId,
      };
      const result = await tx.query(
        deleteItems.sql,
        deleteItems.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      return result.rowCount
        ? {
            value: null,
            events: result.rows.map(
              (removed: { item_kind: string; item_id: string; source_epoch: number; source_position: string }) => ({
                type: 'com.rezics.content.author-item.projected.v1',
                subject: accountId,
                data: {
                  authorAccountId: accountId,
                  itemKind: removed.item_kind,
                  itemId: removed.item_id,
                  sourceEpoch: removed.source_epoch,
                  sourcePosition: removed.source_position,
                },
              }),
            ),
          }
        : noEffect(null);
    },
  );
}
