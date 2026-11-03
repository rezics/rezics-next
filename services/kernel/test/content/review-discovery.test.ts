import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { erasePost } from '../../src/content/moderation.ts';
import { createReviewDiscoverySource } from '../../src/content/review-discovery.ts';
import { routeOf, newId, partitionOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const fixture = await standingFixture();
afterAll(() => fixture.close());

const routeKey = new Uint8Array(32).fill(73);
const request = () => ({
  idempotencyKey: Bun.randomUUIDv7(),
  deadline: Date.now() + 30_000,
  requestId: Bun.randomUUIDv7(),
});
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };

test('public review discovery refreshes the same thread and omits protected or removed reviews', async () => {
  const author = (await fixture.context()).actor;
  const subjectId = newId(0x6b30);
  await fixture.reader.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
    [routeOf(subjectId), subjectId],
  );
  const board = (
    await fixture.reader.query<{ route: number; board_id: string }>(
      "SELECT route, board_id FROM content.board WHERE realm_id IS NULL AND purpose = 'reviews'",
    )
  ).rows[0]!;
  await fixture.grant(author.accountId, 'thread:create', { route: board.route, id: board.board_id });

  const create = (reviewAuthor: typeof author, target: string, body: string) =>
    createThread(
      { pool: fixture.pool, access: fixture.access, routeKey },
      reviewAuthor,
      {
        kind: 'review',
        title: 'A public review title',
        body: fromPlainText(body),
        licence: 'MIT',
        subjectIds: [target],
        boardId: board.board_id,
        visibility: 'published',
      },
      request(),
    );
  const published = await create(author, subjectId, 'Current review excerpt.');
  const partition = partitionOf(routeOf(published.value.threadId)!);
  const source = createReviewDiscoverySource({ pool: fixture.pool, access: fixture.access, tokens }, () => ({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  }));

  const first = await source.read(partition, [published.value.threadId]);
  expect(first.reviews.map((item) => item.id)).toEqual([published.value.threadId]);
  expect(first.reviews[0]).toMatchObject({
    subjectId,
    title: 'A public review title',
    excerpt: 'Current review excerpt.',
  });
  expect((await source.hydrate(partition, [published.value.threadId])).reviews[0]).toMatchObject({
    authorId: author.accountId,
    excerpt: 'Current review excerpt.',
  });
  expect(await source.count(partition)).toMatchObject({ partition, position: first.position, unavailable: true });

  await fixture.reader.query(
    "UPDATE content.board SET visibility='protected', security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [board.route, board.board_id],
  );
  expect((await source.read(partition, [published.value.threadId])).reviews).toEqual([]);
  await fixture.reader.query(
    "UPDATE content.board SET visibility='published', security_revision=security_revision+1 WHERE route=$1 AND board_id=$2",
    [board.route, board.board_id],
  );

  const hiddenAuthor = (await fixture.context()).actor;
  await fixture.grant(hiddenAuthor.accountId, 'thread:create', { route: board.route, id: board.board_id });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const hiddenSubject = newId(0x6b32);
    await fixture.reader.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
       VALUES ($1,$2,'schema:Book',$2,'hidden',1)`,
      [routeOf(hiddenSubject), hiddenSubject],
    );
    await create(hiddenAuthor, hiddenSubject, `Hidden target ${ordinal}`);
  }
  const hiddenPartition = partitionOf(routeOf(hiddenAuthor.accountId)!);
  const sparse = await source.page(hiddenPartition, null, 1);
  expect(sparse.reviews).toEqual([]);
  expect(sparse.next).not.toBeNull();
  const terminal = await source.page(hiddenPartition, sparse.next, 1);
  expect(terminal).toMatchObject({ reviews: [], next: null });

  await revisePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    {
      threadId: published.value.threadId,
      itemId: published.value.itemId,
      body: fromPlainText('Revised review excerpt.'),
    } as never,
    request(),
  );
  expect((await source.read(partition, [published.value.threadId])).reviews[0]?.excerpt).toBe(
    'Revised review excerpt.',
  );

  await fixture.grant(author.accountId, 'post:erase', {
    route: routeOf(published.value.itemId)!,
    id: published.value.itemId,
  });
  await erasePost(
    { pool: fixture.pool, access: fixture.access, routeKey },
    author,
    { postId: published.value.itemId, reason: 'Author removed the review' },
    request(),
  );
  expect((await source.hydrate(partition, [published.value.threadId])).reviews).toEqual([]);
});
