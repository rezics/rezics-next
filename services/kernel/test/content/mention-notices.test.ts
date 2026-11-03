import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDocument, serializeDocument } from '@rezics/document';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { contentNoticeEffects } from '../../src/content/relays.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { createContentNotificationDriver } from './notification-driver.ts';

let fixture: Awaited<ReturnType<typeof standingFixture>>;
beforeAll(async () => {
  fixture = await standingFixture();
  fixture.reader.options.max = 1;
  await fixture.reset();
});
afterAll(async () => fixture?.close());

function registeredMentionEffect() {
  const effects = contentNoticeEffects(
    fixture.pool,
    createContentWorkAccess(() => new Date(), fixture.pool),
  );
  expect(effects.map((effect) => effect.name)).toEqual(['content_mention_notice', 'content_reply_notice']);
  const mentions = effects.filter((effect) => effect.name === 'content_mention_notice');
  expect(mentions).toHaveLength(1);
  return mentions[0]!;
}

function event(
  threadId: string,
  postId: string,
  revisionId: string,
  actorId: string,
  type = 'com.rezics.content.post.published.v1',
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

async function publicRealm() {
  const route = 0x1234;
  const space = newId(route),
    realm = newId(route),
    spaceRevision = newId(route),
    realmRevision = newId(route);
  await fixture.reader.query('BEGIN');
  await fixture.reader.query(
    `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
     VALUES($1,$2,'active',$3,clock_timestamp(),$4)`,
    [route, space, spaceRevision, fixture.recipient],
  );
  await fixture.reader.query(
    `INSERT INTO community.space_revision(route,space_id,revision_id,title,summary,created_at,author)
     VALUES($1,$2,$3,'Mention space','',clock_timestamp(),$4)`,
    [route, space, spaceRevision, fixture.recipient],
  );
  await fixture.reader.query(
    `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
     VALUES($1,$2,$3,'active','public',$4,$5,clock_timestamp(),$6)`,
    [route, realm, space, newId(route), realmRevision, fixture.recipient],
  );
  await fixture.reader.query(
    `INSERT INTO community.realm_revision(route,realm_id,revision_id,title,summary,visibility,context_id,created_at,author)
     SELECT route,realm_id,head_revision_id,'Mention Realm','','public',context_id,clock_timestamp(),creator
     FROM community.realm WHERE route=$1 AND realm_id=$2`,
    [route, realm],
  );
  await fixture.reader.query('COMMIT');
  return realm;
}

async function postWithMentions(
  ids: string[],
  options: { replyRecipient?: string; boardVisibility?: string; realmId?: string } = {},
) {
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
    `INSERT INTO content.board(route,board_id,subject_id,title,realm_id,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Mentions',$4,$5,1,$2)`,
    [route, board, subject, options.realmId ?? null, options.boardVisibility ?? 'published'],
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
  return { thread, post, revision, board, opening, actor };
}

async function grantRead(accountId: string, action: string, resourceId: string) {
  await fixture.reader.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
    [routeOf(resourceId), resourceId, accountId, action],
  );
}

async function clearMentionPreference(accountId: string) {
  await fixture.reader.query('DELETE FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);
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
  await clearMentionPreference(recipient);
  const actor = fixture.actor;
  const more = Array.from({ length: 11 }, () => newId(0x1234));
  for (const accountId of more)
    await fixture.reader.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)`,
      [routeOf(accountId), accountId],
    );
  const { thread, post, revision } = await postWithMentions([recipient, ...more, recipient, actor, fixture.principal]);
  const effect = registeredMentionEffect();
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
  const { thread, post, revision, board, opening } = await postWithMentions(
    [actor, fixture.recipient, fixture.principal, unreadable, deleted],
    {
      replyRecipient: fixture.principal,
      boardVisibility: 'protected',
    },
  );
  for (const accountId of [actor, fixture.recipient, fixture.principal, deleted])
    for (const [action, resourceId] of [
      ['board:read', board],
      ['thread:read', thread],
      ['post:read', post],
      ['post:read', opening],
    ] as const) {
      await grantRead(accountId, action, resourceId);
    }
  await fixture.reader.query(
    `INSERT INTO access.account_preferences(route,account_id,spoiler_level,suitability,version,notifications)
    VALUES ($1,$2,0,'blur',1,'{"mention":false}'::jsonb) ON CONFLICT (route,account_id) DO UPDATE SET notifications=EXCLUDED.notifications`,
    [routeOf(fixture.recipient), fixture.recipient],
  );
  const effect = registeredMentionEffect();
  await effect.run(event(thread, post, revision, actor));
  expect(await notices()).toEqual([]);
});

test('replayed post events add no second notice', async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  await clearMentionPreference(fixture.recipient);
  const { thread, post, revision, actor } = await postWithMentions([fixture.recipient]);
  const source = event(thread, post, revision, actor);
  const effect = registeredMentionEffect();
  await effect.run(source);
  const first = await notices();
  await effect.run(source);
  expect(await notices()).toEqual(first);
});

test('mention effects accept only the closed first-publication source payload', async () => {
  const effect = registeredMentionEffect();
  expect(effect.types).toEqual(['com.rezics.content.post.published.v1']);
  const source = event(newId(0x1234), newId(0x1234), newId(0x1234), fixture.actor);
  for (const type of ['thread.created', 'post.created', 'revision.created'])
    await expect(effect.run({ ...source, type: `com.rezics.content.${type}.v1` })).rejects.toThrow(
      'Invalid mention source event',
    );
  await expect(effect.run({ ...source, data: { ...(source.data as object), unexpected: true } })).rejects.toThrow(
    'Invalid mention source event',
  );
});

test('mention notices use public Realm eligibility and withhold sends after Realm read authority is denied', async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  const recipient = fixture.principal;
  const realmId = await publicRealm();
  const effect = registeredMentionEffect();

  const readable = await postWithMentions([recipient], { realmId });
  await effect.run(event(readable.thread, readable.post, readable.revision, readable.actor));
  expect((await notices()).map((row) => row.post_id)).toEqual([readable.post]);

  const denied = await postWithMentions([recipient], { realmId });
  await fixture.reader.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES($1,$2,$3,'realm:read','resource','(,)',$3)`,
    [0x1234, realmId, recipient],
  );
  await effect.run(event(denied.thread, denied.post, denied.revision, denied.actor));
  expect((await notices()).map((row) => row.post_id)).toEqual([readable.post]);
});

test('mention notices withhold a protected Realm post after its recipient is banned', async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  await clearMentionPreference(fixture.recipient);
  const realmId = await publicRealm();
  const protectedPost = await postWithMentions([fixture.recipient], {
    realmId,
    boardVisibility: 'protected',
  });
  for (const [action, resourceId] of [
    ['realm:read', realmId],
    ['board:read', protectedPost.board],
    ['thread:read', protectedPost.thread],
    ['post:read', protectedPost.post],
  ] as const)
    await grantRead(fixture.recipient, action, resourceId);
  const effect = registeredMentionEffect();

  await effect.run(event(protectedPost.thread, protectedPost.post, protectedPost.revision, protectedPost.actor));
  expect((await notices()).map((row) => row.post_id)).toEqual([protectedPost.post]);

  await fixture.reader.query(
    `INSERT INTO community.realm_ban(route,realm_id,account_id,valid,reason,actor,transaction_id)
     VALUES($1,$2,$3,tstzrange(clock_timestamp(),NULL,'[)'),'Mention notice test',$4,$4)`,
    [routeOf(realmId), realmId, fixture.recipient, fixture.actor],
  );
  const afterBan = await postWithMentions([fixture.recipient], {
    realmId,
    boardVisibility: 'protected',
  });
  for (const [action, resourceId] of [
    ['realm:read', realmId],
    ['board:read', afterBan.board],
    ['thread:read', afterBan.thread],
    ['post:read', afterBan.post],
  ] as const)
    await grantRead(fixture.recipient, action, resourceId);
  await effect.run(event(afterBan.thread, afterBan.post, afterBan.revision, afterBan.actor));
  expect((await notices()).map((row) => row.post_id)).toEqual([protectedPost.post]);
});

test('mention notices recheck current board and every post ancestor before sending', async () => {
  await fixture.reader.query('TRUNCATE content.notice');
  await clearMentionPreference(fixture.recipient);
  const effect = registeredMentionEffect();

  const boardChanged = await postWithMentions([fixture.recipient]);
  await fixture.reader.query(
    `UPDATE content.board SET visibility='protected',security_revision=security_revision+1
     WHERE route=$1 AND board_id=$2`,
    [routeOf(boardChanged.board), boardChanged.board],
  );
  await effect.run(event(boardChanged.thread, boardChanged.post, boardChanged.revision, boardChanged.actor));

  const ancestorChanged = await postWithMentions([fixture.recipient], { replyRecipient: fixture.principal });
  await fixture.reader.query(
    `UPDATE content.post SET visibility='taken_down',security_revision=security_revision+1
     WHERE route=$1 AND post_id=(SELECT first_post_id FROM content.thread WHERE route=$1 AND thread_id=$2)`,
    [routeOf(ancestorChanged.thread), ancestorChanged.thread],
  );
  await effect.run(
    event(ancestorChanged.thread, ancestorChanged.post, ancestorChanged.revision, ancestorChanged.actor),
  );
  expect(await notices()).toEqual([]);
});

test('a native first-publication mention reads the independent board anchor and reaches its recipient', async () => {
  const driver = await createContentNotificationDriver();
  try {
    const people = await driver.provision();
    let created: Awaited<ReturnType<typeof driver.createThread>>['value'] = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await driver.createThread(
        {
          boardId: people.publicBoardId,
          visibility: 'published',
          body: {
            version: 'rezics-document-v1',
            profile: 'blocks',
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'mention', attrs: { accountId: people.mentioned.id } }],
                },
              ],
            },
          },
        },
        { actor: people.author, key: JSON.stringify(`independent-board-mention-${attempt}`) },
      );
      expect(result.response.status).toBe(201);
      if (routeOf(result.value!.id) !== routeOf(people.publicBoardId)) {
        created = result.value;
        break;
      }
    }
    expect(created).not.toBeNull();
    await driver.effects('drain');
    const inbox = await driver.inbox(people.mentioned.id, people.mentioned, { limit: 50 });
    expect(inbox.response.status).toBe(200);
    expect(inbox.value!.items).toContainEqual(
      expect.objectContaining({
        kind: 'mention',
        actorId: people.author.id,
        target: { threadId: created!.id, postId: created!.firstPost.id },
      }),
    );
  } finally {
    await driver.close();
  }
}, 60_000);
