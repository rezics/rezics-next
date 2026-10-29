import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { notificationAllowed } from '../access/index.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS } from './events.ts';
import { writeNotices } from './notices.ts';
import readMentionSource from './read-mention-source.sql';
import { postReadableByAccount } from './reads.ts';

const postCreated = 'com.rezics.content.post.created.v1';
const MAX_MENTIONS = 10;

type MentionRow = {
  post_id: string;
  thread_id: string;
  actor_id: string;
  reply_to_post_id: string | null;
  parent_author_id: string | null;
  first_post_id: string;
  first_post_author_id: string;
  visibility: string;
  availability: string;
  thread_visibility: string;
  thread_availability: string;
  revision_id: string;
  body: Buffer | null;
  board_id: string;
  board_visibility: string;
};

function uniqueMentions(body: Buffer | null): string[] {
  if (!body) return [];
  const document = JSON.parse(body.toString('utf8')) as { doc?: unknown };
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    } else if (value && typeof value === 'object') {
      const node = value as { type?: unknown; attrs?: { accountId?: unknown }; content?: unknown };
      if (node.type === 'mention' && typeof node.attrs?.accountId === 'string' && !seen.has(node.attrs.accountId)) {
        seen.add(node.attrs.accountId);
        if (found.length < MAX_MENTIONS) found.push(node.attrs.accountId);
      }
      visit(node.content);
    }
  };
  visit(document.doc);
  return found;
}

async function readSource(client: PoolClient, route: number, postId: string, revisionId: string) {
  return readMentionSource.run(client, { route, post_id: postId, revision_id: revisionId });
}

/** The registered effects runner supplies the retryable, recorded DBOS step. */
export function createMentionNoticeEffect(pool: Pool, access: Access): Effect {
  return {
    name: 'content_mention_notice',
    types: [postCreated],
    async run(event: CloudEvent) {
      if (event.type !== postCreated || !ValueCheck(event.data)) throw new TypeError('Invalid mention source event');
      const data = event.data as { threadId: string; itemId: string; revisionId: string; actorId: string };
      const route = routeOf(data.itemId);
      if (route === null || routeOf(data.threadId) !== route || routeOf(data.revisionId) !== route) return;
      const deadline = Date.now() + 30_000;
      const row = await withConnection(pool, async (client) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const rows = await readSource(client, route, data.itemId, data.revisionId);
          await client.query('COMMIT');
          return rows as MentionRow | null;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(client, rollbackError as Error);
          }
          throw error;
        }
      });
      if (
        !row ||
        row.actor_id !== data.actorId ||
        row.thread_id !== data.threadId ||
        row.revision_id !== data.revisionId ||
        row.visibility !== 'published' ||
        row.availability !== 'available' ||
        !['published', 'protected'].includes(row.thread_visibility) ||
        row.thread_availability !== 'available' ||
        !['published', 'protected'].includes(row.board_visibility)
      )
        return;
      const excluded = new Set([row.actor_id, row.reply_to_post_id ? row.parent_author_id : row.first_post_author_id]);
      const recipients = uniqueMentions(row.body).filter((id) => !excluded.has(id));
      for (const recipientId of recipients) {
        const recipientRoute = routeOf(recipientId);
        if (recipientRoute === null) continue;
        const allowed = await withConnection(pool, async (connection) => {
          await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const partition = await readPartition(connection, partitionOf(recipientRoute));
            const preference =
              partition?.writeState === 'active'
                ? await notificationAllowed(connection, { recipient: recipientId, kind: 'mention' })
                : false;
            await connection.query('COMMIT');
            return preference;
          } catch (error) {
            try {
              await connection.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(connection, rollbackError as Error);
            }
            throw error;
          }
        });
        if (
          !allowed ||
          !(await postReadableByAccount({ pool, access }, recipientId, row.thread_id, row.post_id, { deadline }))
        )
          continue;
        await withConnection(pool, async (connection) => {
          await connection.query('BEGIN');
          try {
            const partition = await readPartition(connection, partitionOf(recipientRoute));
            if (!partition || partition.writeState !== 'active') {
              await connection.query('ROLLBACK');
              return;
            }
            await writeNotices(connection, [
              {
                recipientId,
                noticeId: newId(recipientRoute),
                kind: 'mention',
                actorId: row.actor_id,
                threadId: row.thread_id,
                postId: row.post_id,
                decisionId: null,
                reportId: null,
                sourceId: row.post_id,
                createdAt: new Date(event.time),
              },
            ]);
            await connection.query('COMMIT');
          } catch (error) {
            try {
              await connection.query('ROLLBACK');
            } catch (rollbackError) {
              discardConnection(connection, rollbackError as Error);
            }
            throw error;
          }
        });
      }
    },
  };
}

function ValueCheck(data: unknown): boolean {
  return Value.Check(CONTENT_EVENTS[postCreated], data);
}
