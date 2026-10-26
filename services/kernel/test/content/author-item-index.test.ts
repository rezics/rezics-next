import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthorItemEffect } from '../../src/content/author-item-index.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const db = await openGrowthDatabase();
db.pool.options.max = 1;
afterAll(() => db.close());
const threadRoute = 0x1234;
const authorRoute = 0x9abc;
const at = '2026-10-27T00:00:00.123456Z';
const threadType = 'com.rezics.content.thread.created.v1';
const postType = 'com.rezics.content.post.created.v1';
const erasedType = 'com.rezics.content.post.erased.v1';

function created(
  type: typeof threadType | typeof postType,
  author: string,
  thread: string,
  post: string,
  sequence = 1,
  kind: 'discussion' | 'review' = 'discussion',
): CloudEvent {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: `urn:rezics:log:${partitionOf(threadRoute)}.1`,
    type,
    subject: post,
    time: at,
    datacontenttype: 'application/json',
    sequence: String(sequence).padStart(19, '0'),
    data: {
      threadId: thread,
      itemId: post,
      revisionId: newId(threadRoute),
      actorId: author,
      placeId: newId(0x4567),
      kind,
      subjectIds: [],
      activityAt: at,
    },
  } as CloudEvent;
}
function erased(post: string, sequence = 2): CloudEvent {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: `urn:rezics:log:${partitionOf(threadRoute)}.1`,
    type: erasedType,
    subject: post,
    time: at,
    datacontenttype: 'application/json',
    sequence: String(sequence).padStart(19, '0'),
    data: { postId: post, securityRevision: '2' },
  } as CloudEvent;
}
async function rows(author: string) {
  return (
    await db.admin.query(
      `SELECT route, author_account_id::text, item_kind, item_id::text, thread_id::text,
    thread_kind, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    source_epoch, source_position::text FROM content.author_item
    WHERE route=$1 AND author_account_id=$2 ORDER BY item_kind, item_id`,
      [routeOf(author), author],
    )
  ).rows;
}
async function position() {
  return (
    await db.admin.query('SELECT position::text FROM core.partition WHERE partition_no=$1', [partitionOf(authorRoute)])
  ).rows;
}
async function storedPost(author: string) {
  const thread = newId(threadRoute),
    post = newId(threadRoute),
    revision = newId(threadRoute);
  const board = newId(0x5678);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO content.board
      (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,'Index board','published',1,$2)`,
      [routeOf(board), board, newId(0x6789)],
    );
    await client.query(
      `INSERT INTO content.thread
      (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,'Index fixture','published',1,$2)`,
      [threadRoute, thread, author, board],
    );
    await client.query(
      `INSERT INTO content.post
      (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
      [threadRoute, thread, post, author, revision],
    );
    await client.query(
      `INSERT INTO content.revision
      (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
      VALUES ($1,$2,$3,$4,$5,$6,'','MIT','{}',$7,'available',$3)`,
      [threadRoute, thread, post, revision, Buffer.from('body'), createHash('sha256').update('body').digest(), board],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { thread, post };
}

test('threads and replies retain author route, kind, creation time and containing thread', async () => {
  const author = newId(authorRoute),
    replyAuthor = newId(authorRoute + 1);
  const effect = createAuthorItemEffect(db.pool);
  for (const kind of ['discussion', 'review'] as const) {
    const thread = newId(threadRoute),
      opening = newId(threadRoute),
      reply = newId(threadRoute);
    await effect.run(created(threadType, author, thread, opening, 1, kind));
    await effect.run(created(postType, replyAuthor, thread, reply, 2, kind));
    expect(await rows(author)).toContainEqual({
      route: authorRoute,
      author_account_id: author,
      item_kind: 'thread',
      item_id: thread,
      thread_id: thread,
      thread_kind: kind,
      created_at: at,
      source_epoch: 1,
      source_position: '1',
    });
    expect(await rows(replyAuthor)).toContainEqual({
      route: authorRoute + 1,
      author_account_id: replyAuthor,
      item_kind: 'post',
      item_id: reply,
      thread_id: thread,
      thread_kind: kind,
      created_at: at,
      source_epoch: 1,
      source_position: '2',
    });
    expect((await rows(author)).some((row) => row.item_id === opening)).toBe(false);
  }
});

test('the opening post is represented only by its thread and replay changes no rows or position', async () => {
  const author = newId(authorRoute),
    thread = newId(threadRoute),
    opening = newId(threadRoute);
  const effect = createAuthorItemEffect(db.pool);
  const source = created(threadType, author, thread, opening);
  await effect.run(source);
  const before = await rows(author),
    beforePosition = await position();
  await effect.run(source);
  expect(await rows(author)).toEqual(before);
  expect(await position()).toEqual(beforePosition);
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ item_kind: 'thread', item_id: thread });
});

test('ID-only post erasure reads the author before the author command and replay cannot restore the row', async () => {
  const author = newId(authorRoute),
    { thread, post } = await storedPost(author);
  const effect = createAuthorItemEffect(db.pool);
  const source = created(postType, author, thread, post);
  await effect.run(source);
  expect(await rows(author)).toHaveLength(1);
  const removal = erased(post);
  await effect.run(removal);
  const beforePosition = await position();
  await effect.run(removal);
  await effect.run(source);
  expect(await rows(author)).toEqual([]);
  expect(await position()).toEqual(beforePosition);
});

test('erasing an opening post preserves its thread candidate and missing posts change nothing', async () => {
  const author = newId(authorRoute),
    { thread, post } = await storedPost(author);
  const effect = createAuthorItemEffect(db.pool);
  await effect.run(created(threadType, author, thread, post));
  const before = await rows(author),
    beforePosition = await position();
  await effect.run(erased(post));
  await effect.run(erased(newId(threadRoute)));
  expect(await rows(author)).toEqual(before);
  expect(await position()).toEqual(beforePosition);
});

test('source guards reject older positions and accept a newer epoch', async () => {
  const author = newId(authorRoute),
    thread = newId(threadRoute),
    post = newId(threadRoute);
  const effect = createAuthorItemEffect(db.pool);
  await effect.run(created(threadType, author, thread, post, 5));
  const before = await rows(author),
    beforePosition = await position();
  await effect.run(created(threadType, author, thread, post, 4));
  expect(await rows(author)).toEqual(before);
  expect(await position()).toEqual(beforePosition);
  const next = created(threadType, author, thread, post, 1);
  await effect.run({ ...next, source: `urn:rezics:log:${partitionOf(threadRoute)}.2` });
  expect(await rows(author)).toMatchObject([{ source_epoch: 2, source_position: '1' }]);
});

test('an older erasure cannot delete a newer indexed post', async () => {
  const author = newId(authorRoute),
    { thread, post } = await storedPost(author);
  const effect = createAuthorItemEffect(db.pool);
  await effect.run(created(postType, author, thread, post, 5));
  const before = await rows(author),
    beforePosition = await position();
  await effect.run(erased(post, 4));
  expect(await rows(author)).toEqual(before);
  expect(await position()).toEqual(beforePosition);
});

test('invalid source envelopes and payloads are rejected before writes', async () => {
  const effect = createAuthorItemEffect(db.pool);
  const source = created(threadType, newId(authorRoute), newId(threadRoute), newId(threadRoute));
  const beforePosition = await position();
  for (const invalid of [
    { ...source, source: 'urn:rezics:log:1.1' },
    { ...source, sequence: '0' },
    { ...source, subject: newId(threadRoute) },
    { ...source, data: {} },
    { ...source, type: 'com.rezics.content.revision.created.v1' },
  ]) {
    await expect(effect.run(invalid as CloudEvent)).rejects.toThrow(TypeError);
  }
  const missingSubject = erased(newId(threadRoute));
  delete missingSubject.subject;
  await expect(effect.run(missingSubject)).rejects.toThrow(TypeError);
  expect(await position()).toEqual(beforePosition);
});

test('author item index', async () => {
  const author = newId(authorRoute),
    effect = createAuthorItemEffect(db.pool);
  const population: Population = {
    name: `author-items-${randomUUID()}`,
    hotPartition: partitionOf(authorRoute),
    hotShare: 1,
    rows: () => {
      const thread = newId(threadRoute);
      return {
        'content.author_item': [
          {
            route: authorRoute,
            author_account_id: author,
            item_kind: 'thread',
            item_id: thread,
            thread_id: thread,
            thread_kind: 'discussion',
            created_at: at,
            source_epoch: 1,
            source_position: '1',
          },
        ],
      };
    },
  };
  // Keep command receipt probes indexed even at the first scale; incidental command history is not I.
  await seed(
    db,
    {
      name: `${population.name}-receipts`,
      hotPartition: partitionOf(authorRoute),
      hotShare: 1,
      rows: ({ ordinal, partition }) => ({
        'core.receipt': [
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: '00000000-0000-4000-8000-000000000001',
            command_kind: 'content.author-item.project',
            idempotency_key: `${population.name}-${ordinal}`,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: ordinal + 1,
            transaction_id: newId(authorRoute),
            response: {},
          },
        ],
      }),
    },
    { from: 0, to: 4096 },
  );
  const measured: Awaited<ReturnType<typeof storedPost>>[] = [];
  const spare: Awaited<ReturnType<typeof storedPost>>[] = [];
  for (let index = 0; index < 18; index++) {
    const probe = await storedPost(author);
    (index < 15 ? measured : spare).push(probe);
  }
  const apply = async (probe: Awaited<ReturnType<typeof storedPost>>) => {
    await effect.run(created(threadType, author, probe.thread, newId(threadRoute)));
    await effect.run(created(postType, author, probe.thread, probe.post));
    await effect.run(erased(probe.post));
  };
  const report = await checkGrowth(db, {
    name: 'author item index',
    scales: [64, 512, 4096],
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) => seed(database, population, { from: previous, to: scale }),
    warmup: async () => apply(spare.shift()!),
    operation: async () => apply(measured.shift()!),
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});
