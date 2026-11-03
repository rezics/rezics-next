import { afterAll, expect, test } from 'bun:test';
import { normalizeDocument, serializeDocument } from '@rezics/document';
import { createMentionNoticeEffect } from '../../src/content/mention-notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth } from '../support/growth.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

const fPromise = replyNoticeFixture();
afterAll(async () => (await fPromise).close());

test('first-ten mentions use production first-publication events while unrelated post history grows', async () => {
  const f = await fPromise;
  const thread = await f.thread();
  const recipients = Array.from({ length: 10 }, () => newId(0x3456));
  const accountRoute = routeOf(recipients[0]!);
  expect(accountRoute).not.toBeNull();
  await f.db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) AS accounts(id)
     ON CONFLICT DO NOTHING`,
    [accountRoute, recipients],
  );
  for (const recipient of recipients) {
    await f.accounts.grant(recipient, 'thread:read', { route: routeOf(thread.id)!, id: thread.id });
    await f.accounts.grant(recipient, 'board:read', { route: routeOf(f.boardId)!, id: f.boardId });
  }

  const document = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'notice-mentions' },
          content: recipients.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
        },
      ],
    },
  });
  const body = JSON.parse(serializeDocument(document));
  const postEvent = async () => {
    const created = await f.call(f.accounts.actor, 'POST', `/v1/threads/${thread.id}/posts`, {
      body,
      licence: 'MIT',
      subjectIds: [],
    });
    expect(created.status).toBe(201);
    const postId = created.value.post.id as string;
    for (const recipient of recipients)
      await f.accounts.grant(recipient, 'post:read', { route: routeOf(postId)!, id: postId });
    return { postId, event: (await f.envelope(postId)).events.find(Boolean)! };
  };
  const effect = createMentionNoticeEffect(f.db.pool, createContentWorkAccess(() => new Date(), f.db.pool));
  const [samplePost, revision] = await Promise.all([
    f.db.admin.query<{ post_id: string; head_revision_id: string; author_account_id: string }>(
      `SELECT post_id,head_revision_id,author_account_id FROM content.post
       WHERE route=$1 AND thread_id=$2 ORDER BY post_id LIMIT 1`,
      [routeOf(thread.id), thread.id],
    ),
    f.db.admin.query<{ body: Uint8Array; body_sha256: Uint8Array; board_id: string }>(
      `SELECT body,body_sha256,board_id FROM content.revision
       WHERE route=$1 AND thread_id=$2 ORDER BY revision_id LIMIT 1`,
      [routeOf(thread.id), thread.id],
    ),
  ]);
  const sourcePost = samplePost.rows[0]!;
  const sourceRevision = revision.rows[0]!;
  let selected: Awaited<ReturnType<typeof postEvent>> | undefined;
  const report = await checkGrowth(f.db, {
    name: 'Production first-publication mention delivery',
    scales: [16, 64, 256],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    warmups: 1,
    grow: async (db, scale, previous) => {
      const count = scale - previous;
      const postIds = Array.from({ length: count }, () => newId(routeOf(thread.id)!));
      const revisionIds = postIds.map(() => newId(routeOf(thread.id)!));
      if (count === 0) return;
      await db.admin.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,
                                 security_revision,recorded_transaction_id)
         SELECT $1,$2,posts.post_id,$4,posts.revision_id,'published',1,posts.post_id
         FROM unnest($3::uuid[],$5::uuid[]) AS posts(post_id,revision_id)`,
        [routeOf(thread.id), thread.id, postIds, sourcePost.author_account_id, revisionIds],
      );
      await db.admin.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,
                                      subject_ids,board_id,availability,recorded_transaction_id)
         SELECT $1,$2,posts.post_id,posts.revision_id,$4,$5,'','MIT','{}',$6,'available',posts.post_id
         FROM unnest($3::uuid[],$7::uuid[]) AS posts(post_id,revision_id)`,
        [
          routeOf(thread.id),
          thread.id,
          postIds,
          sourceRevision.body,
          sourceRevision.body_sha256,
          sourceRevision.board_id,
          revisionIds,
        ],
      );
    },
    warmup: async () => effect.run((await postEvent()).event),
    prepare: async () => {
      selected = await postEvent();
    },
    operation: async (_db, _scale, _repetition) => {
      const sample = selected;
      if (!sample) throw new Error('Production mention event was not prepared');
      await effect.run(sample.event);
      return sample.postId;
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([16, 64, 256]);
  expect(await f.notices(selected!.postId)).toHaveLength(10);
  console.info(JSON.stringify(report));
});
