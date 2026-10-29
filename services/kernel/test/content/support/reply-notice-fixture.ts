import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import type { CloudEvent, Envelope } from '../../../src/events/log.ts';
import { standingFixture } from '../../access/standing-fixture.ts';
import { openGrowthDatabase } from '../../support/growth.ts';

export async function replyNoticeFixture() {
  const db = await openGrowthDatabase();
  // Privileged scenario visibility changes still advance the schema's security revision.
  // Keep this storage bookkeeping in the fixture, alongside the native-route setup.
  db.admin.query = new Proxy(db.admin.query, {
    apply(query, client, args) {
      if (typeof args[0] === 'string') {
        args[0] = args[0].replace(
          /^UPDATE content\.thread SET visibility=('draft'|'published') WHERE /,
          'UPDATE content.thread SET visibility=$1,security_revision=security_revision+1 WHERE ',
        );
      }
      return Reflect.apply(query, client, args);
    },
  });
  const accounts = await standingFixture(['account:update', 'realm:read', 'realm:participate']);
  await accounts.reset();
  const credentials = new Map<string, string>();
  const authenticate = accounts.access.authenticate;
  accounts.access.authenticate = (token, boundary) => {
    // Capture only fixture-issued credentials for native route calls.
    credentials.set(current, token);
    return authenticate(token, { ...boundary, pool: db.pool });
  };
  let current = '';
  try {
    for (const id of [accounts.actor, accounts.principal, accounts.recipient]) {
      current = id;
      await accounts.context(id);
    }
  } finally {
    accounts.access.authenticate = authenticate;
  }
  const app = createKernel({
    pool: db.pool,
    access: accounts.access,
    routeKey: new Uint8Array(32).fill(17),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(18)]]) },
    writeRate: createWriteRateLimiter({ secret: 'reply-notice-fixture-secret-at-least-32-bytes' }),
  });
  const boardId = newId(0x4321);
  await db.admin.query(
    `INSERT INTO content.board (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Reply board','published',1,$4)`,
    [routeOf(boardId), boardId, newId(0x6789), randomUUID()],
  );
  for (const id of credentials.keys()) {
    await accounts.grant(id, 'board:read', { route: routeOf(boardId)!, id: boardId });
    await accounts.grant(id, 'thread:create', { route: routeOf(boardId)!, id: boardId });
    await accounts.grant(id, 'account:update', { route: routeOf(id)!, id });
  }
  async function call(account: string, method: string, path: string, body?: unknown) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credentials.get(account)}`,
          'idempotency-key': JSON.stringify(randomUUID()),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const value = await response.json();
    return { status: response.status, value };
  }
  async function thread(author = accounts.recipient, visibility: 'published' | 'draft' = 'published', board = boardId) {
    const result = await call(author, 'POST', '/v1/threads', {
      title: 'Reply notices',
      body: fromPlainText('Opening post'),
      licence: 'MIT',
      subjectIds: [],
      boardId: board,
      visibility,
    });
    expect(result).toMatchObject({ status: 201 });
    const value = result.value.thread as { id: string; firstPost: { id: string; revisionId: string } };
    for (const id of credentials.keys()) {
      await accounts.grant(id, 'thread:read', { route: routeOf(value.id)!, id: value.id });
      await accounts.grant(id, 'post:read', { route: routeOf(value.id)!, id: value.firstPost.id });
      await accounts.grant(id, 'post:create', { route: routeOf(value.id)!, id: value.id });
    }
    return value;
  }
  async function post(threadId: string, author = accounts.actor, parentId?: string) {
    const result = await call(author, 'POST', `/v1/threads/${threadId}/posts`, {
      body: fromPlainText('Reply body'),
      licence: 'MIT',
      subjectIds: [],
      ...(parentId === undefined ? {} : { parentId }),
    });
    expect(result).toMatchObject({ status: 201 });
    const value = result.value.post as { id: string; revisionId: string };
    for (const id of credentials.keys())
      await accounts.grant(id, 'post:read', { route: routeOf(value.id)!, id: value.id });
    return value;
  }
  async function envelope(postId: string): Promise<Envelope> {
    const { rows } = await db.admin.query(
      "SELECT * FROM core.outbox WHERE type='com.rezics.content.post.created.v1' AND data->>'itemId'=$1",
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
      await db.admin.query(
        'SELECT recipient_id,kind,actor_id,thread_id,post_id,source_id FROM content.notice WHERE source_id=$1',
        [postId],
      )
    ).rows;
  }
  return {
    db,
    accounts,
    boardId,
    call,
    thread,
    post,
    envelope,
    notices,
    async close() {
      await accounts.close();
      await db.close();
    },
  };
}
