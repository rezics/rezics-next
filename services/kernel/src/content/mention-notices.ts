import { accessClock } from '../access/access-clock.ts';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { deadlineClient, within } from '../access/authenticate.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS } from './events.ts';
import { finalizeOptionalNotice } from './notices.ts';
import { deadlineFor } from '../request/deadline.ts';
import readMentionSource from './read-mention-source.sql';
import readBoard from './read-board.sql';
import { postReadableByAccount } from './reads.ts';

const postPublished = 'com.rezics.content.post.published.v1';
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
};
type BoardRow = {
  board_id: string;
  visibility: string;
  realm_id: string | null;
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
      const node = value as {
        type?: unknown;
        attrs?: { accountId?: unknown };
        content?: unknown;
      };
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
  return readMentionSource.run(client, {
    route,
    post_id: postId,
    revision_id: revisionId,
  });
}

async function readBoardMetadata(pool: Pool, boardId: string, deadline: number): Promise<BoardRow | null> {
  const boardRoute = routeOf(boardId);
  if (boardRoute === null) return null;
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partitionNo = partitionOf(boardRoute);
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const row = await readBoard.run(client, {
          route: boardRoute,
          id: boardId,
        });
        await client.query('COMMIT');
        return (row as BoardRow | null) ?? null;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** The registered effects runner supplies the retryable, recorded DBOS step. */
export function createMentionNoticeEffect(pool: Pool, access: Access): Effect {
  return {
    name: 'content_mention_notice',
    types: [postPublished],
    async run(event: CloudEvent) {
      if (
        event.type !== postPublished ||
        !Value.Check(CONTENT_EVENTS[postPublished], event.data)
      )
        throw new TypeError('Invalid mention source event');
      const data = event.data as {
        threadId: string;
        itemId: string;
        revisionId: string;
        actorId: string;
      };
      const route = routeOf(data.itemId);
      if (route === null || routeOf(data.threadId) !== route || routeOf(data.revisionId) !== route) return;
      const deadline = deadlineFor(30_000);
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
        row.revision_id !== data.revisionId
      )
        return;
      const excluded = new Set([row.actor_id, row.reply_to_post_id ? row.parent_author_id : row.first_post_author_id]);
      const recipients = uniqueMentions(row.body).filter((id) => !excluded.has(id));
      if (recipients.length === 0) return;
      const board = await readBoardMetadata(pool, row.board_id, deadline);
      const sourceReadable =
        row.visibility === 'published' &&
        row.availability === 'available' &&
        ['published', 'protected'].includes(row.thread_visibility) &&
        row.thread_availability === 'available' &&
        board?.board_id === row.board_id &&
        ['published', 'protected'].includes(board.visibility);
      for (const recipientId of recipients) {
        const recipientRoute = routeOf(recipientId);
        if (recipientRoute === null) continue;
        const readable =
          sourceReadable &&
          (await postReadableByAccount({ pool, access }, recipientId, row.thread_id, row.post_id, {
            deadline,
          }));
        await finalizeOptionalNotice(
          pool,
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
          readable,
          deadline,
          accessClock(access),
        );
      }
    },
  };
}
