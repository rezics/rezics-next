import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../../src/semantic/definitions.ts';
import type { CloudEvent, Envelope } from '../../../src/events/log.ts';
import { createNativeContentSystemWithWriteRateOverrides, nativeOperator } from './native-system.ts';
import {
  grantAccountActions,
  grantResource,
  installRealmMember,
  provisionNativeDiscussionBoard,
} from './native-board-host.ts';

const WRITE_RATE_OVERRIDES = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});

export async function replyNoticeFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for native reply notices');
  const system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl, namespace: `reply_notice_${randomUUID().replaceAll('-', '')}` },
    WRITE_RATE_OVERRIDES,
  );
  try {
    await bootstrapRelease(system.database.pool, bundledRelease);
    const operator = nativeOperator(system);
    const board = await provisionNativeDiscussionBoard(system.kernel, operator, { label: 'Reply notice' });
    const recipient = system.actors.author;
    const actor = system.actors.other;
    const principal = system.actors.moderator;
    const credentials = new Map<string, string>([
      [recipient.actor.accountId, recipient.bearer],
      [actor.actor.accountId, actor.bearer],
      [principal.actor.accountId, principal.bearer],
    ]);
    for (const id of credentials.keys()) {
      await grantAccountActions(system.kernel, operator, grantResource(board.id), id, ['board:read', 'thread:create']);
      await installRealmMember(system.database.pool, board.realmId, id);
    }
    const originalQuery = system.database.pool.query.bind(system.database.pool);
    system.database.pool.query = new Proxy(originalQuery, {
      apply(query, client, args) {
        if (typeof args[0] === 'string') {
          args[0] = args[0].replace(
            /^UPDATE content\.thread SET visibility=('draft'|'published') WHERE /,
            'UPDATE content.thread SET visibility=$1,security_revision=security_revision+1 WHERE ',
          );
        }
        return Reflect.apply(query, client, args);
      },
    }) as typeof system.database.pool.query;
    async function call(account: string, method: string, path: string, payload?: unknown, key: string = randomUUID()) {
      const response = await system.kernel.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${credentials.get(account)}`,
            'idempotency-key': JSON.stringify(key),
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        }),
      );
      const responseBody = response.status === 204 ? null : await response.text();
      const value = responseBody === null ? null : JSON.parse(responseBody);
      return {
        status: response.status,
        value,
        headers: response.headers,
        responseBytes: responseBody === null ? 0 : Buffer.byteLength(responseBody, 'utf8'),
      };
    }
    async function thread(
      author = recipient.actor.accountId,
      visibility: 'published' | 'draft' = 'published',
      boardId = board.id,
    ) {
      const result = await call(author, 'POST', '/v1/threads', {
        title: 'Reply notices',
        body: fromPlainText('Opening post'),
        licence: 'MIT',
        subjectIds: [],
        boardId,
        visibility,
      });
      expect(result).toMatchObject({ status: 201 });
      const value = result.value.thread as { id: string; firstPost: { id: string; revisionId: string } };
      for (const id of credentials.keys()) {
        await grantAccountActions(system.kernel, operator, grantResource(value.id), id, ['thread:read', 'post:create']);
        await grantAccountActions(system.kernel, operator, grantResource(value.firstPost.id), id, ['post:read']);
      }
      return value;
    }
    async function post(threadId: string, author = actor.actor.accountId, parentId?: string) {
      const result = await call(author, 'POST', `/v1/threads/${threadId}/posts`, {
        body: fromPlainText('Reply body'),
        licence: 'MIT',
        subjectIds: [],
        ...(parentId === undefined ? {} : { parentId }),
      });
      expect(result).toMatchObject({ status: 201 });
      const value = result.value.post as { id: string; revisionId: string };
      for (const id of credentials.keys())
        await grantAccountActions(system.kernel, operator, grantResource(value.id), id, ['post:read']);
      return value;
    }
    async function envelope(postId: string): Promise<Envelope> {
      const { rows } = await system.database.pool.query(
        "SELECT * FROM core.outbox WHERE type='com.rezics.content.post.published.v1' AND data->>'itemId'=$1",
        [postId],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const event: CloudEvent = {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        type: row.type,
        time: new Date(row.recorded_at).toISOString(),
        datacontenttype: 'application/json',
        sequence: String(row.position).padStart(19, '0'),
        subject: row.subject,
        data: row.data,
      };
      const events: CloudEvent[] = [];
      events[row.event_seq] = event;
      return { partition: row.partition_no, epoch: row.epoch, position: BigInt(row.position), events };
    }
    async function notices(postId: string) {
      return (
        await system.database.pool.query(
          'SELECT recipient_id,kind,actor_id,thread_id,post_id,source_id FROM content.notice WHERE source_id=$1',
          [postId],
        )
      ).rows;
    }
    return {
      db: { pool: system.database.pool, admin: system.database.pool },
      accounts: {
        actor: actor.actor.accountId,
        recipient: recipient.actor.accountId,
        principal: principal.actor.accountId,
        access: system.access,
      },
      boardId: board.id,
      call,
      thread,
      post,
      envelope,
      notices,
      async close() {
        await system.close();
      },
    };
  } catch (error) {
    await system.close();
    throw error;
  }
}

export type ReplyNoticeFixture = Awaited<ReturnType<typeof replyNoticeFixture>>;
