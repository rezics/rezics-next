import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { standingFixture } from '../access/standing-fixture.ts';
import { createThread, revisePost } from '../../src/content/commands.ts';
import { createAppeal, resolveAppeal } from '../../src/content/appeals.ts';
import { restrictPostRevision } from '../../src/content/moderation.ts';
import { listPostRevisionHeaders } from '../../src/content/post-history-metadata.ts';
import { readPost, listPostRevisions, readPostMetadata, type PostEntry, type RetainContentRead } from '../../src/content/reads.ts';
import { newId, routeOf } from '../../src/route/route.ts';

let f: Awaited<ReturnType<typeof standingFixture>>;
let author: Awaited<ReturnType<typeof f.context>>['actor'];
let buyer: Awaited<ReturnType<typeof f.context>>['actor'];
let moderator: Awaited<ReturnType<typeof f.context>>['actor'];
const boardId = newId(0x9abc);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const commandContext = () => ({
  idempotencyKey: crypto.randomUUID(),
  requestId: crypto.randomUUID(),
  deadline: Date.now() + 30000,
});
const reads = () => ({ pool: f.pool, access: f.access, tokens, clock: () => new Date() });
const readContext = (actor: typeof author | { kind: 'anonymous' }) => ({ actor, deadline: Date.now() + 30000 });
const resource = (id: string) => ({ route: routeOf(id)!, id });

beforeAll(async () => {
  f = await standingFixture(['account:read']);
  author = (await f.context()).actor;
  buyer = (await f.context(f.principal)).actor;
  moderator = (await f.context(f.recipient)).actor;
  await f.reader.query(
    `INSERT INTO content.board
       (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Revision policy test','published',1,$2)`,
    [routeOf(boardId), boardId, newId(0x4321)],
  );
  await f.grant(author.accountId, 'thread:create', resource(boardId));
  await f.grant(author.accountId, 'board:read', resource(boardId));
});
afterAll(() => f?.close());

async function post(visibility: 'published' | 'draft' = 'published') {
  const created = await createThread(
    { pool: f.pool, access: f.access, routeKey: new Uint8Array(32).fill(8), clock: () => new Date() },
    author,
    {
      title: 'Ordinary revisions',
      body: fromPlainText('revision one'),
      licence: 'MIT',
      subjectIds: [],
      boardId,
      visibility,
    },
    commandContext(),
  );
  return created.value;
}

async function revise(value: Awaited<ReturnType<typeof post>>, text: string) {
  return (
    await revisePost(
      { pool: f.pool, access: f.access, routeKey: new Uint8Array(32).fill(8), clock: () => new Date() },
      author,
      { threadId: value.threadId, itemId: value.itemId, body: fromPlainText(text) },
      commandContext(),
    )
  ).value;
}

async function restrict(value: Awaited<ReturnType<typeof post>>, revisionId: string, mode: 'public' | 'hard') {
  await f.grant(moderator.accountId, 'moderation:takedown', resource(value.itemId));
  return restrictPostRevision(
    { pool: f.pool, access: f.access, routeKey: new Uint8Array(32).fill(8), clock: () => new Date() },
    moderator,
    { postId: value.itemId, revisionId, mode, reason: `Restrict ${mode} revision` },
    commandContext(),
  );
}

async function reverse(value: Awaited<ReturnType<typeof post>>, revisionId: string) {
  const decision = (
    await f.reader.query<{ decision_id: string }>(
      `SELECT decision_id FROM content.moderation_decision
       WHERE route=$1 AND target_kind='post' AND target_id=$2 AND revision_id=$3`,
      [routeOf(value.itemId), value.itemId, revisionId],
    )
  ).rows[0];
  if (!decision) throw new Error('Expected an exact Post revision decision');
  const appeal = await createAppeal(
    { pool: f.pool, access: f.access, clock: () => new Date() },
    author,
    decision.decision_id,
    'Please restore this exact revision',
    commandContext(),
  );
  return resolveAppeal(
    { pool: f.pool, access: f.access, clock: () => new Date() },
    moderator,
    appeal.value.id,
    { outcome: 'reverse', statement: 'The exact revision is restored' },
    commandContext(),
  );
}

test('public-only and hard restrictions are exact, revalidated across Post history and reversed under appeal authority', async () => {
  const value = await post();
  const second = await revise(value, 'revision two');
  const third = await revise(value, 'revision three');
  const readsDeps = reads();
  const target = resource(value.itemId);
  await f.grant(author.accountId, 'post:read', target);
  await f.grant(author.accountId, 'post:revise', target);
  await f.grant(buyer.accountId, 'post:read', target);

  await restrict(value, second.revisionId, 'public');
  expect(
    (await readPost(readsDeps, value.threadId, value.itemId, readContext({ kind: 'anonymous' }), second.revisionId)).value,
  ).toBeNull();
  expect(
    (
      await readPost(readsDeps, value.threadId, value.itemId, readContext(author), second.revisionId)
    ).value?.body,
  ).not.toBeNull();
  expect(
    (await readPost(readsDeps, value.threadId, value.itemId, readContext(buyer), second.revisionId)).value?.body,
  ).not.toBeNull();
  await reverse(value, second.revisionId);
  expect(
    (
      await readPost(readsDeps, value.threadId, value.itemId, readContext({ kind: 'anonymous' }), second.revisionId)
    ).value?.body,
  ).not.toBeNull();

  let retained: Parameters<RetainContentRead<PostEntry>>[0] | undefined;
  const prepared = await readPost(
    readsDeps,
    value.threadId,
    value.itemId,
    readContext(author),
    second.revisionId,
    (current) => {
      retained = current;
    },
  );
  expect(prepared.value?.body).not.toBeNull();
  await restrict(value, second.revisionId, 'hard');

  for (const viewer of [{ kind: 'anonymous' as const }, author, buyer])
    expect(
      (await readPost(readsDeps, value.threadId, value.itemId, readContext(viewer), second.revisionId)).value,
    ).toBeNull();
  for (const viewer of [author, buyer])
    expect(
      (await readPostMetadata(readsDeps, value.threadId, value.itemId, readContext(viewer), second.revisionId)).value,
    ).toBeNull();

  const publicRead = readContext({ kind: 'anonymous' });
  for (const revisionId of [value.revisionId, third.revisionId]) {
    expect((await readPost(readsDeps, value.threadId, value.itemId, publicRead, revisionId)).value?.body).not.toBeNull();
    expect((await readPostMetadata(readsDeps, value.threadId, value.itemId, publicRead, revisionId)).value).not.toBeNull();
  }
  const defaultRead = (await readPost(readsDeps, value.threadId, value.itemId, publicRead)).value;
  expect(defaultRead && 'revisionId' in defaultRead ? defaultRead.revisionId : null).toBe(third.revisionId);
  expect(
    (await readPostMetadata(readsDeps, value.threadId, value.itemId, readContext(buyer), second.revisionId)).value,
  ).toBeNull();

  for (const viewer of [publicRead.actor, author, buyer]) {
    const history = await listPostRevisions(readsDeps, value.threadId, value.itemId, readContext(viewer), undefined, 20);
    expect(history.entries.map((revision) => revision.id)).toEqual([value.revisionId, third.revisionId]);
    const headers = await listPostRevisionHeaders(
      readsDeps,
      value.threadId,
      value.itemId,
      readContext(viewer),
      undefined,
      20,
    );
    expect(headers.revisions.map((revision) => revision.revisionId)).toEqual([value.revisionId, third.revisionId]);
  }
  expect(retained).toBeDefined();
  expect((await retained!()).value).toBeNull();

  await reverse(value, second.revisionId);
  expect(
    (
      await readPost(readsDeps, value.threadId, value.itemId, readContext(buyer), second.revisionId)
    ).value?.body,
  ).not.toBeNull();
  const restriction = await f.reader.query<{ lifted_at: Date | null }>(
    `SELECT lifted_at FROM content.post_revision_restriction
     WHERE route=$1 AND revision_id=$2 ORDER BY restricted_at DESC LIMIT 1`,
    [routeOf(value.itemId), second.revisionId],
  );
  expect(restriction.rows[0]?.lifted_at).not.toBeNull();
});

test('explicit private drafts remain private and readable to their author', async () => {
  const value = await post('draft');
  const target = resource(value.itemId);
  await f.grant(author.accountId, 'post:read', target);
  await f.grant(author.accountId, 'thread:read', resource(value.threadId));
  expect((await readPost(reads(), value.threadId, value.itemId, readContext(author), value.revisionId)).value?.body)
    .not.toBeNull();
  expect(
    (
      await readPost(reads(), value.threadId, value.itemId, readContext({ kind: 'anonymous' }), value.revisionId)
    ).value,
  ).toBeNull();
});
