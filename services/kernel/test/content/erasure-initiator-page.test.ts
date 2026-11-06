import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import {
  erasePostLogicalAsInitiator,
  erasePostLogicalPageAsInitiator,
  type ErasureInitiator,
} from '../../src/content/erase-post.ts';
import { readErasureInitiator } from '../../src/content/erasure-initiator.ts';
import { beginAuthorErasure } from '../../src/content/operations.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';

let fixture: Awaited<ReturnType<typeof standingFixture>>;
const route = 0x6798;
const context = () => ({
  deadline: Date.now() + 10_000,
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
});
const dependencies = () => ({ clock: () => new Date(), pool: fixture.pool, access: fixture.access });

beforeAll(async () => {
  fixture = await standingFixture(['account:read']);
});

afterAll(async () => {
  await fixture?.close();
});

async function scope(posts: number) {
  const actor = (await fixture.context()).actor;
  const threadId = newId(route);
  const boardId = newId(route);
  const ids = Array.from({ length: posts }, () => newId(route)).sort();
  const body = Buffer.from(serializeDocument(fromPlainText('Private historical text')));
  const tx = await fixture.reader.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO content.thread
     (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Erasure fixture','published',1,$2)`,
      [route, threadId, actor.accountId, boardId],
    );
    for (const postId of ids) {
      const head = newId(route);
      await tx.query(
        `INSERT INTO content.post
       (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,
        recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3,'2026-01-01T00:00:00Z')`,
        [route, threadId, postId, actor.accountId, head],
      );
      await tx.query(
        `INSERT INTO content.revision
       (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,
        board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),'Private historical text','MIT','{}',$6,'available',$3)`,
        [route, threadId, postId, head, body, boardId],
      );
    }
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  for (const id of ids) await fixture.grant(actor.accountId, 'post:erase', { route, id });
  await fixture.grant(actor.accountId, 'account:read', { route: routeOf(actor.accountId)!, id: actor.accountId });
  const created = await beginAuthorErasure(
    {
      ...dependencies(),
      clock: () => new Date(),
      workflows: {
        async enqueue() {
          throw new Error('Only the durable relay may enqueue');
        },
        async status() {
          throw new Error('No status read during initiation');
        },
      },
    },
    actor,
    { threadId, authorId: actor.accountId },
    context(),
  );
  const initiator: ErasureInitiator = {
    kind: 'durable-initiator',
    operation: {
      route,
      id: created.value.operationId,
      kind: 'content.author-erasure',
      sourceId: created.value.operationId,
    },
    accountId: actor.accountId,
    clientId: actor.clientId,
    requestedBy: actor.requestedBy,
    restorer: createInitiatorRestorer({
      ...dependencies(),
      readConsent: fixture.readConsent,
      async readOperation(client, operation, time) {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const record = await readErasureInitiator(client, operation, time);
          await client.query('COMMIT');
          return record;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    }),
  };
  return { ids, initiator, threadId };
}

async function postState(ids: readonly string[]) {
  return (
    await fixture.reader.query(
      `SELECT post_id,availability,security_revision::text FROM content.post
       WHERE route=$1 AND post_id=ANY($2::uuid[]) ORDER BY post_id`,
      [route, ids],
    )
  ).rows;
}

test('a logical erasure page run as a restored durable initiator executes and erases every post in the page', async () => {
  const { ids, initiator, threadId } = await scope(3);
  const result = await erasePostLogicalPageAsInitiator(
    dependencies(),
    initiator,
    { postIds: ids, threadId, reason: 'Erase author history' },
    context(),
  );
  expect(result.value).toEqual({ postIds: ids, processedPosts: ids.length, erasedRevisions: ids.length });
  expect(await postState(ids)).toEqual(
    ids.map((post_id) => ({ post_id, availability: 'erased', security_revision: '2' })),
  );
});

test('a single logical erasure run as a restored durable initiator executes', async () => {
  const { ids, initiator } = await scope(1);
  const postId = ids[0]!;
  const result = await erasePostLogicalAsInitiator(
    dependencies(),
    initiator,
    { postId, reason: 'Erase author history' },
    context(),
  );
  expect(result.value).toEqual({ postId, securityRevision: '2' });
  expect(await postState(ids)).toEqual([{ post_id: postId, availability: 'erased', security_revision: '2' }]);
});

test('a restored initiator without post:erase on one post of a page is denied and the whole page rolls back', async () => {
  const { ids, initiator, threadId } = await scope(3);
  // Keep the first post (and restoration anchor) authorized; deny a later point.
  await fixture.reader.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='post:erase'",
    [route, ids[1], initiator.accountId],
  );
  const before = await fixture.snapshot(route);
  await expect(
    erasePostLogicalPageAsInitiator(
      dependencies(),
      initiator,
      { postIds: ids, threadId, reason: 'Erase author history' },
      context(),
    ),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await postState(ids)).toEqual(
    ids.map((post_id) => ({ post_id, availability: 'available', security_revision: '1' })),
  );
  expect(await fixture.snapshot(route)).toEqual(before);
});
