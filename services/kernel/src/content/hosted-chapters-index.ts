import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { recordLateErasureItem, resolveLateErasureItem } from './access-port.ts';
import { eraseAccountAuthoredItem } from './account-erasure-authored.ts';
import { markAccountErasureFound } from './account-erasure-progress.ts';
import { lockErasureFence } from './erasure-fence.ts';

export const HOSTED_LOCATOR_REPAIR_PAGE = 20;
const projector = '00000000-0000-4000-8000-000000000001';
type HostedSource = {
  author_account_id: string;
  thread_id: string;
  kind: 'discussion' | 'review';
  created_at: string;
  eligible: boolean;
  security_revision: string;
  draft_state: 'draft' | 'other';
  draft_revision_id: string;
  draft_language: string | null;
  epoch: number;
  position: string;
};
type Frontier = { after_route: number; after_catalogue: string; complete: boolean };

/** Coverage is independent of the number of visible results. An undelivered
 * native creation prevents an empty page from claiming a complete inventory. */
export async function hostedLocatorCoverage(client: AccessClient, accountId: string): Promise<boolean> {
  const progress = await client.query<{ complete: boolean }>(
    'SELECT complete FROM content.hosted_owned_progress WHERE singleton=0',
  );
  const pending = await client.query(
    'SELECT 1 FROM content.post WHERE author_account_id=$1 AND hosted_locator_pending LIMIT 1',
    [accountId],
  );
  return progress.rows[0]?.complete === true && pending.rows.length === 0;
}

async function readHostedSource(pool: Pool, catalogueId: string): Promise<HostedSource | null> {
  const route = routeOf(catalogueId)!;
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const partition = await readPartition(client, partitionOf(route));
      if (!partition || partition.writeState === 'moved') throw new Error('Content partition is unavailable');
      const result = await client.query<Omit<HostedSource, 'epoch' | 'position'>>(
        `SELECT p.author_account_id,p.thread_id,t.kind,
           to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           p.availability='available' AND NOT p.author_erased AS eligible,p.security_revision::text,
           CASE WHEN p.visibility='draft' AND p.availability='available'
             AND t.availability='available' AND t.visibility<>'taken_down' AND r.availability='available'
             THEN 'draft' ELSE 'other' END AS draft_state,
           p.head_revision_id AS draft_revision_id,
           CASE WHEN p.visibility='draft' AND p.availability='available' AND r.availability='available'
             THEN convert_from(r.body,'UTF8')::jsonb #>> '{doc,attrs,lang}' ELSE NULL END AS draft_language
         FROM content.hosted_catalogue c
         JOIN content.post p ON p.route=c.route AND p.thread_id=c.thread_id AND p.post_id=c.catalogue_id
         JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
         JOIN content.revision r ON r.route=p.route AND r.thread_id=p.thread_id
           AND r.post_id=p.post_id AND r.revision_id=p.head_revision_id
         WHERE c.route=$1 AND c.catalogue_id=$2`,
        [route, catalogueId],
      );
      await client.query('COMMIT');
      const source = result.rows[0];
      return source ? { ...source, epoch: partition.epoch, position: partition.position.toString() } : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** The only replicated fact is native catalogue membership. Post creation time
 * and ownership come from the original Post, never a structure editor or event
 * actor. Advancing the watermark also carries current draft metadata so a delayed
 * Post event cannot erase restored membership or overwrite newer draft state. */
async function projectHostedLocator(pool: Pool, catalogueId: string) {
  const source = await readHostedSource(pool, catalogueId);
  if (!source) return false;
  const authorRoute = routeOf(source.author_account_id)!;
  const locator = `author_item:post:${authorRoute}:${catalogueId}`;
  const digest = createHash('sha256')
    .update(JSON.stringify([catalogueId, source]))
    .digest();
  const outcome = await runCommand(
    pool,
    {
      partition: partitionOf(authorRoute),
      receipt: {
        actorAccountId: projector,
        kind: 'content.hosted-catalogue.locator',
        key: digest.toString('hex'),
        digest,
      },
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
      if (source.eligible) {
        await tx.query(
          `INSERT INTO content.author_item AS indexed
             (route,author_account_id,item_kind,item_id,thread_id,thread_kind,created_at,
              source_epoch,source_position,hosted_catalogue,draft_state,draft_revision_id,draft_language)
           VALUES ($1,$2,'post',$3,$4,$5,$6,$7,$8,true,$9,$10,$11)
           ON CONFLICT (route,author_account_id,item_kind,item_id) DO UPDATE
             SET hosted_catalogue=true,
               source_epoch=CASE WHEN ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                 THEN EXCLUDED.source_epoch ELSE indexed.source_epoch END,
               source_position=CASE WHEN ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                 THEN EXCLUDED.source_position ELSE indexed.source_position END,
               draft_state=CASE WHEN ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                   OR (ROW(indexed.source_epoch,indexed.source_position)=ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                     AND indexed.draft_state='unknown') THEN EXCLUDED.draft_state ELSE indexed.draft_state END,
               draft_revision_id=CASE WHEN ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                   OR (ROW(indexed.source_epoch,indexed.source_position)=ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                     AND indexed.draft_state='unknown') THEN EXCLUDED.draft_revision_id ELSE indexed.draft_revision_id END,
               draft_language=CASE WHEN ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                   OR (ROW(indexed.source_epoch,indexed.source_position)=ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
                     AND indexed.draft_state='unknown') THEN EXCLUDED.draft_language ELSE indexed.draft_language END
           WHERE ROW(indexed.source_epoch,indexed.source_position)<ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
             OR NOT indexed.hosted_catalogue
             OR (ROW(indexed.source_epoch,indexed.source_position)=ROW(EXCLUDED.source_epoch,EXCLUDED.source_position)
               AND indexed.draft_state='unknown')`,
          [
            authorRoute,
            source.author_account_id,
            catalogueId,
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
      }
      return {
        value: false,
        events: [{ type: 'com.rezics.content.hosted-catalogue.locator-repaired.v1', data: {} }],
      };
    },
  );
  if (outcome.value) {
    await eraseAccountAuthoredItem({ pool }, source.author_account_id, 'post', catalogueId);
    await resolveLateErasureItem({ pool }, { accountId: source.author_account_id, participant: 'content', locator });
  }
  // Membership is permanent; release edits do not invalidate its acknowledgement.
  // A replacement partition must be observed again before clearing its obligation.
  const sourceRoute = routeOf(catalogueId)!;
  const acknowledged = await runCommand(
    pool,
    {
      partition: partitionOf(sourceRoute),
      receipt: {
        actorAccountId: projector,
        kind: 'content.hosted-catalogue.locator-acknowledge',
        key: digest.toString('hex'),
        digest,
      },
    },
    async (tx) => {
      const current = await readPartition(tx, partitionOf(sourceRoute));
      if (current?.epoch !== source.epoch) throw new Error('Content partition changed during hosted locator repair');
      const result = await tx.query(
        `UPDATE content.post SET hosted_locator_pending=false
         WHERE route=$1 AND post_id=$2 AND head_revision_id=$3 AND security_revision=$4`,
        [sourceRoute, catalogueId, source.draft_revision_id, source.security_revision],
      );
      return {
        value: (result.rowCount ?? 0) > 0,
        events: [{ type: 'com.rezics.content.hosted-catalogue.locator-repaired.v1', data: {} }],
      };
    },
  );
  return acknowledged.value;
}

/** At most 20 pending source keys and 20 census keys per maintenance step. The
 * existing own-drafts schedule owns retries; no per-request census or new timer.
 * All source checkouts close before author-partition commands, even with max=1. */
export async function repairHostedCataloguePage(pool: Pool): Promise<{ complete: boolean; examined: number }> {
  const selected = await withConnection(pool, async (client) => {
    const progress = await client.query<Frontier>('SELECT * FROM content.hosted_owned_progress WHERE singleton=0');
    const frontier = progress.rows[0]!;
    const pending = await client.query<{ post_id: string }>(
      'SELECT post_id FROM content.post WHERE hosted_locator_pending ORDER BY route,post_id LIMIT 20',
    );
    const census = frontier.complete
      ? []
      : (
          await client.query<{ route: number; catalogue_id: string }>(
            `SELECT route,catalogue_id FROM content.hosted_catalogue
       WHERE ROW(route,catalogue_id)>ROW($1::integer,$2::uuid)
       ORDER BY route,catalogue_id LIMIT 20`,
            [frontier.after_route, frontier.after_catalogue],
          )
        ).rows;
    return { frontier, pending: pending.rows, census };
  });
  const keys = new Set([
    ...selected.pending.map((row) => row.post_id),
    ...selected.census.map((row) => row.catalogue_id),
  ]);
  let acknowledged = true;
  for (const id of keys) acknowledged = (await projectHostedLocator(pool, id)) && acknowledged;
  const complete = selected.frontier.complete || selected.census.length < HOSTED_LOCATOR_REPAIR_PAGE;
  if (!selected.frontier.complete) {
    const last = selected.census.at(-1);
    const key = JSON.stringify(selected.frontier);
    await runCommand(
      pool,
      {
        partition: 0,
        receipt: {
          actorAccountId: projector,
          kind: 'content.hosted-catalogue.locator-progress',
          key,
          digest: createHash('sha256')
            .update(JSON.stringify([selected.frontier, last, complete]))
            .digest(),
        },
      },
      async (tx) => {
        await tx.query(
          `UPDATE content.hosted_owned_progress SET after_route=$3,after_catalogue=$4,complete=$5
           WHERE singleton=0 AND NOT complete AND after_route=$1 AND after_catalogue=$2`,
          [
            selected.frontier.after_route,
            selected.frontier.after_catalogue,
            last?.route ?? selected.frontier.after_route,
            last?.catalogue_id ?? selected.frontier.after_catalogue,
            complete,
          ],
        );
        return {
          value: null,
          events: [{ type: 'com.rezics.content.hosted-catalogue.locator-repaired.v1', data: {} }],
        };
      },
    );
  }
  return {
    complete: complete && acknowledged && selected.pending.length < HOSTED_LOCATOR_REPAIR_PAGE,
    examined: keys.size,
  };
}
