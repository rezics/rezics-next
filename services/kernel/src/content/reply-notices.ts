import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { notificationAllowed } from '../access/index.ts';
import type { Access } from '../request/access.ts';
import type { Effect } from '../events/effects.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventData } from './events.ts';
import { writeNotices } from './notices.ts';
import { postReadableByAccount } from './reads.ts';
import readRecipient from './read-reply-notice-recipient.sql';

const postCreated = 'com.rezics.content.post.created.v1';

/** registerEffects records this entire outcome in its single effect.run DBOS step.
 * A denied send returns successfully, so workflow replay never reevaluates it. */
export function createReplyNoticeEffect(pool: Pool, access: Access): Effect {
  return {
    name: 'content_reply_notice',
    types: [postCreated],
    async run(event) {
      if (event.type !== postCreated || !Value.Check(CONTENT_EVENTS[postCreated], event.data))
        throw new TypeError('Invalid reply notice source event');
      const data = event.data as ContentEventData<typeof postCreated>;
      const route = routeOf(data.threadId);
      if (route === null || routeOf(data.itemId) !== route || routeOf(data.revisionId) !== route)
        throw new TypeError('Invalid reply notice content route');
      const recipient = await withConnection(pool, async (client) => {
        const anchor = await readPartition(client, partitionOf(route));
        if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
        return readRecipient.run(client, { route, thread_id: data.threadId, post_id: data.itemId });
      });
      if (!recipient || recipient.author_account_id === data.actorId) return;
      const accountId = recipient.author_account_id;
      if (!(await notificationAllowed(pool, { recipient: accountId, kind: 'reply' }))) return;
      if (
        !(await postReadableByAccount({ pool, access }, accountId, data.threadId, data.itemId, {
          deadline: Date.now() + 5000,
        }))
      )
        return;
      await writeNotices(pool, [
        {
          recipientId: accountId,
          noticeId: newId(routeOf(accountId)!),
          kind: 'reply',
          actorId: data.actorId,
          threadId: data.threadId,
          postId: data.itemId,
          sourceId: data.itemId,
          decisionId: null,
          reportId: null,
          createdAt: new Date(),
        },
      ]);
    },
  };
}
