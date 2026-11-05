import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { eraseAccountAuthoredItem } from './account-erasure-authored.ts';
import { markAccountErasureFound } from './account-erasure-progress.ts';
import { lockErasureFence } from './erasure-fence.ts';

export type OwnDraftSource = {
  author_account_id: string;
  thread_id: string;
  kind: 'discussion' | 'review';
  created_at: string;
  draft_state: 'draft' | 'other';
  draft_revision_id: string | null;
  draft_language: string | null;
  epoch: number;
  position: string;
};
export const OWN_DRAFT_REPAIR_PAGE = 20;
export const OWN_DRAFT_REPAIR_WORKFLOW = 'content.ownDrafts.repair';
const projector = '00000000-0000-4000-8000-000000000001';

/** Exact source home, released before the receiving author command. Language is
 * a locator projection of the canonical root; nested language marks stay in bytes.
 * Only draft maintenance reads the current document, capped by the native 2 MiB limit.
 */
export async function readOwnDraftSource(pool: Pool, postId: string): Promise<OwnDraftSource | null> {
  const route = routeOf(postId);
  if (route === null) throw new TypeError('Invalid draft identity');
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const partition = await readPartition(client, partitionOf(route));
      if (!partition || partition.writeState === 'moved') throw new Error('Content partition is unavailable');
      const result = await client.query<Omit<OwnDraftSource, 'epoch' | 'position'>>(
        `SELECT p.author_account_id,p.thread_id,t.kind,
          to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          CASE WHEN p.visibility='draft' AND p.availability='available'
            AND t.availability='available' AND t.visibility<>'taken_down' AND r.availability='available'
            THEN 'draft' ELSE 'other' END AS draft_state,
          p.head_revision_id AS draft_revision_id,
          CASE WHEN p.visibility='draft' AND p.availability='available' AND r.availability='available'
            THEN convert_from(r.body,'UTF8')::jsonb #>> '{doc,attrs,lang}' ELSE NULL END AS draft_language
         FROM content.post p
         JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
         JOIN content.revision r ON r.route=p.route AND r.revision_id=p.head_revision_id
           AND r.thread_id=p.thread_id AND r.post_id=p.post_id
         WHERE p.route=$1 AND p.post_id=$2`,
        [route, postId],
      );
      await client.query('COMMIT');
      return result.rows[0]
        ? { ...result.rows[0], epoch: partition.epoch, position: partition.position.toString() }
        : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** Receiving locator commit precedes source acknowledgement. A concurrent edit
 * leaves the new head pending; a retry can safely finish either side independently.
 */
export async function acknowledgeOwnDraftLocator(pool: Pool, postId: string, source: OwnDraftSource) {
  const route = routeOf(postId)!;
  const key = `${postId}:${source.epoch}:${source.position}`;
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: projector,
        kind: 'content.own-drafts.acknowledge',
        key,
        digest: createHash('sha256')
          .update(JSON.stringify([postId, source]))
          .digest(),
      },
    },
    async (tx) => {
      await tx.query(
        `UPDATE content.post SET draft_locator_pending=false
       WHERE route=$1 AND post_id=$2 AND head_revision_id=$3 AND draft_locator_pending`,
        [route, postId, source.draft_revision_id],
      );
      return { value: null, events: [{ type: 'com.rezics.content.own-drafts.repaired.v1', data: {} }] };
    },
  );
}

/** Uses the same native locator, account fence and cleanup path as live delivery.
 * Current source head order supersedes event order; no synthetic source event is emitted.
 */
async function repairLocator(pool: Pool, postId: string) {
  const source = await readOwnDraftSource(pool, postId);
  if (!source) return;
  const route = routeOf(source.author_account_id)!;
  const locator = `author_item:post:${route}:${postId}`;
  const digest = createHash('sha256')
    .update(JSON.stringify([postId, source]))
    .digest();
  const outcome = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: { actorAccountId: projector, kind: 'content.own-drafts.repair', key: digest.toString('hex'), digest },
    },
    async (tx) => {
      if (await lockErasureFence(tx, source.author_account_id)) {
        await recordLateErasureItem(tx, { accountId: source.author_account_id, participant: 'content', locator });
        await markAccountErasureFound(tx, source.author_account_id, 'content');
        return {
          value: true,
          events: [
            {
              type: 'com.rezics.access.account-updated.v1',
              subject: source.author_account_id,
              data: { accountId: source.author_account_id },
            },
          ],
        };
      }
      await tx.query(
        `INSERT INTO content.author_item AS indexed
        (route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,source_epoch,source_position,
         draft_state,draft_revision_id,draft_language)
       VALUES ($1,$2,'post',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (route,author_account_id,item_kind,item_id) DO UPDATE
       SET source_epoch=EXCLUDED.source_epoch,source_position=EXCLUDED.source_position,
           draft_state=EXCLUDED.draft_state,draft_revision_id=EXCLUDED.draft_revision_id,draft_language=EXCLUDED.draft_language
       WHERE ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
          OR (ROW(indexed.source_epoch,indexed.source_position)=ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
              AND indexed.draft_state='unknown')`,
        [
          route,
          source.author_account_id,
          postId,
          source.thread_id,
          source.kind,
          source.created_at,
          source.epoch,
          source.position,
          source.draft_state,
          source.draft_revision_id,
          source.draft_language,
        ],
      );
      return {
        value: false,
        events: [
          {
            type: 'com.rezics.content.author-item.projected.v1',
            subject: source.author_account_id,
            data: {
              authorAccountId: source.author_account_id,
              itemKind: 'post',
              itemId: postId,
              sourceEpoch: source.epoch,
              sourcePosition: source.position,
            },
          },
        ],
      };
    },
  );
  if (outcome.value) {
    await eraseAccountAuthoredItem({ pool }, source.author_account_id, 'post', postId);
    await resolveLateErasureItem({ pool }, { accountId: source.author_account_id, participant: 'content', locator });
  }
  await acknowledgeOwnDraftLocator(pool, postId, source);
}

type Frontier = { after_route: number; after_thread: string; after_post: string; complete: boolean };
/** A global locator census selects only 20 primary keys, then independently opens
 * their actual homes. No cross-home SQL join or retained foreign checkout is used.
 */
export async function repairOwnDraftPage(pool: Pool): Promise<{ complete: boolean; examined: number }> {
  const selected = await withConnection(pool, async (client) => {
    const progress = await client.query<Frontier>('SELECT * FROM content.own_draft_progress WHERE singleton=0');
    const frontier = progress.rows[0];
    if (!frontier) throw new Error('Draft locator coverage is unavailable');
    if (frontier.complete) return { frontier, keys: [] };
    const keys = await client.query<{ route: number; thread_id: string; post_id: string }>(
      `SELECT route,thread_id,post_id FROM content.post
       WHERE ROW(route,thread_id,post_id)>ROW($1::integer,$2::uuid,$3::uuid)
       ORDER BY route,thread_id,post_id LIMIT 20`,
      [frontier.after_route, frontier.after_thread, frontier.after_post],
    );
    return { frontier, keys: keys.rows };
  });
  if (selected.frontier.complete) return { complete: true, examined: 0 };
  // Failure leaves the entire source frontier unconsumed. Receiving receipts make
  // previously repaired keys exact retries on the next invocation.
  for (const key of selected.keys) await repairLocator(pool, key.post_id);
  const last = selected.keys.at(-1);
  const complete = selected.keys.length < OWN_DRAFT_REPAIR_PAGE;
  const key = JSON.stringify(selected.frontier);
  await runCommand(
    pool,
    {
      partition: 0,
      receipt: {
        actorAccountId: projector,
        kind: 'content.own-drafts.progress',
        key,
        digest: createHash('sha256')
          .update(JSON.stringify([selected.frontier, last, complete]))
          .digest(),
      },
    },
    async (tx) => {
      await tx.query(
        `UPDATE content.own_draft_progress SET after_route=$4,after_thread=$5,after_post=$6,complete=$7
       WHERE singleton=0 AND NOT complete AND after_route=$1 AND after_thread=$2 AND after_post=$3`,
        [
          selected.frontier.after_route,
          selected.frontier.after_thread,
          selected.frontier.after_post,
          last?.route ?? selected.frontier.after_route,
          last?.thread_id ?? selected.frontier.after_thread,
          last?.post_id ?? selected.frontier.after_post,
          complete,
        ],
      );
      return { value: null, events: [{ type: 'com.rezics.content.own-drafts.repaired.v1', data: {} }] };
    },
  );
  return { complete, examined: selected.keys.length };
}
