import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDocument, serializeDocument } from '@rezics/document';
import { createMentionNoticeEffect } from '../../src/content/mention-notices.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';

let fixture: Awaited<ReturnType<typeof standingFixture>>;
beforeAll(async () => {
  fixture = await standingFixture();
  fixture.reader.options.max = 1;
  await fixture.reset();
});
afterAll(async () => fixture?.close());

function event(
  threadId: string,
  postId: string,
  revisionId: string,
  actorId: string,
  type = 'com.rezics.content.post.created.v1',
): CloudEvent {
  const route = routeOf(threadId)!;
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: `urn:rezics:log:${partitionOf(route)}.1`,
    type,
    subject: postId,
    time: '2026-10-30T00:00:00.000Z',
    datacontenttype: 'application/json',
    sequence: '0000000000000000001',
    data: {
      threadId,
      itemId: postId,
      revisionId,
      actorId,
      placeId: newId(0x4567),
      kind: 'discussion',
      subjectIds: [],
      activityAt: '2026-10-30T00:00:00.000Z',
    },
  } as CloudEvent;
}

async function postWithMentions(ids: string[], options: { replyRecipient?: string; boardVisibility?: string } = {}) {
  const route = 0x1234;
  const actor = fixture.actor;
  const board = newId(route),
    thread = newId(route),
    post = newId(route),
    revision = newId(route),
    subject = newId(route);
  const opening = options.replyRecipient ? newId(route) : post;
  const doc = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'mentions' },
          content: ids.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
        },
      ],
    },
  });
  const body = Buffer.from(serializeDocument(doc));
  const digest = createHash('sha256').update(body).digest();
  await fixture.reader.query('BEGIN');
  await fixture.reader.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Mentions',$4,1,$2)`,
    [route, board, subject, options.boardVisibility ?? 'published'],
  );
  await fixture.reader.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id)
     VALUES ($1,$2,$3,$4,'Mentions','published',1,$2,$5)`,
    [route, thread, actor, board, opening],
  );
  if (options.replyRecipient) {
    const openingRevision = newId(route);
    const openingBody = Buffer.from(
      serializeDocument(
        normalizeDocument({
          version: 'rezics-document-v1',
          profile: 'text',
          doc: {
            type: 'doc',
            content: [{ type: 'paragraph', attrs: { id: 'opening' }, content: [{ type: 'text', text: 'Opening' }] }],
          },
        }),
      ),
    );
    await fixture.reader.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id) VALUES($1,$2,$3,$4,$5,'published',1,$3)`,
      [route, thread, opening, options.replyRecipient, openingRevision],
    );
    await fixture.reader.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id) VALUES($1,$2,$3,$4,$5,$6,'','MIT','{}',$7,'available',$3)`,
      [route, thread, opening, openingRevision, openingBody, createHash('sha256').update(openingBody).digest(), board],
    );
  }
  await fixture.reader.query(
    `INSERT INTO content.post(route,thread_id,post_id,reply_to_post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,'published',1,$3)`,
    [route, thread, post, options.replyRecipient ? opening : null, actor, revision],
  );
  await fixture.reader.query(
    `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,'','MIT','{}',$7,'available',$3)`,
    [route, thread, post, revision, body, digest, board],
  );
  await fixture.reader.query('COMMIT');
  return { thread, post, revision, board, actor };
}

async function notices() {
  return (
    await fixture.reader.query(`SELECT recipient_id::text,actor_id::text,thread_id::text,post_id::text,source_id::text
    FROM content.notice WHERE kind='mention' ORDER BY recipient_id,post_id`)
  ).rows;
}

test("a mention in a post's first published revision notifies each mentioned account up to ten, and a later revision notifies nobody", async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  const recipient = fixture.recipient;
  const actor = fixture.actor;
  const more = Array.from({ length: 11 }, () => newId(0x1234));
  for (const accountId of more)
    await fixture.reader.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)`,
      [routeOf(accountId), accountId],
    );
  const { thread, post, revision, board } = await postWithMentions([
    recipient,
    ...more,
    recipient,
    actor,
    fixture.principal,
  ]);
  for (const accountId of [recipient, ...more.slice(0, 9)]) {
    await fixture.grant(accountId, 'thread:read', { route: 0x1234, id: thread });
    await fixture.grant(accountId, 'post:read', { route: 0x1234, id: post });
    await fixture.grant(accountId, 'board:read', { route: 0x1234, id: board });
  }
  const effect = createMentionNoticeEffect(fixture.pool, fixture.access);
  const created = event(thread, post, revision, actor);
  await effect.run(created);
  await effect.run({ ...created, id: randomUUID() });
  expect((await notices()).map((row) => row.recipient_id).sort()).toEqual([recipient, ...more.slice(0, 9)].sort());
  const revised = event(thread, post, newId(0x1234), actor, 'com.rezics.content.revision.created.v1');
  expect(effect.types).not.toContain(revised.type);
  expect((await notices()).map((row) => row.post_id)).toEqual(Array.from({ length: 10 }, () => post));
});

test("a mentioned account who cannot read the post, turned mentions off, is deleted, is the actor or is the post's reply recipient receives no mention notice", async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  const actor = fixture.actor;
  const unreadable = newId(0x1234),
    deleted = newId(0x1234);
  await fixture.reader.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)`,
    [routeOf(unreadable), unreadable],
  );
  await fixture.reader.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','deleted',$2)`,
    [routeOf(deleted), deleted],
  );
  const { thread, post, revision } = await postWithMentions(
    [actor, fixture.recipient, fixture.principal, unreadable, deleted],
    {
      replyRecipient: fixture.principal,
      boardVisibility: 'protected',
    },
  );
  await fixture.reader.query(
    `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,version,notifications)
    VALUES ($1,$2,0,'blur',1,'{"mention":false}'::jsonb) ON CONFLICT (route,account_id) DO UPDATE SET notifications=EXCLUDED.notifications`,
    [routeOf(fixture.recipient), fixture.recipient],
  );
  await fixture.reader.query(`UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2`, [
    routeOf(fixture.principal),
    fixture.principal,
  ]);
  const effect = createMentionNoticeEffect(fixture.pool, fixture.access);
  await effect.run(event(thread, post, revision, actor));
  expect(await notices()).toEqual([]);
});

test('replayed post events add no second notice', async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  const { thread, post, revision, actor } = await postWithMentions([fixture.recipient]);
  const source = event(thread, post, revision, actor);
  const effect = createMentionNoticeEffect(fixture.pool, fixture.access);
  await effect.run(source);
  const first = await notices();
  await effect.run(source);
  expect(await notices()).toEqual(first);
});
