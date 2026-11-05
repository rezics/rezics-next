import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import { Pool } from 'pg';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import * as nativeSystem from './support/native-system.ts';
import { closeContentThreadSystem, createContentThreadDriver, initializeContentThreadSystem } from './thread-driver.ts';

setDefaultTimeout(60_000);
type Driver = Awaited<ReturnType<typeof createContentThreadDriver>>;
type Fixture = Awaited<ReturnType<Driver['provision']>>;
type Item = NonNullable<Awaited<ReturnType<Driver['createPost']>>['value']>;
type Result<T> = { response: Response; value: T | null };
let system: nativeSystem.NativeContentSystem;
let admin: Pool;
let driver: Driver;
let fixture: Fixture;

beforeAll(async () => {
  // Observe the existing driver's real fixture construction so raw HTTP and
  // independent SQL inspection share it. The factory still runs unchanged.
  const create = nativeSystem.createNativeContentSystemWithWriteRateOverrides;
  const observation = spyOn(nativeSystem, 'createNativeContentSystemWithWriteRateOverrides').mockImplementation(
    async (...args) => {
      system = await create(...args);
      return system;
    },
  );
  try {
    await initializeContentThreadSystem();
  } finally {
    observation.mockRestore();
  }
  admin = new Pool({ ...system.database.pool.options, max: 1 });
});
beforeEach(async () => {
  driver = await createContentThreadDriver();
  fixture = await driver.provision();
});
afterEach(async () => {
  await driver?.close();
});
afterAll(async () => {
  await admin?.end();
  await closeContentThreadSystem();
});

const bytes = (body: DocumentSnapshot) => new TextEncoder().encode(serializeDocument(body));
const digest = (body: DocumentSnapshot) => createHash('sha256').update(bytes(body)).digest('hex');
const options = (key: string, actor: Fixture['owner'] | null = fixture.moderator) => ({
  actor,
  key: JSON.stringify(key),
});
function input(text: string, licence: string, subjectIds: string[]) {
  return {
    body: fromPlainText(`${text}: 漢字 e\u0301 é\t  \n  next  `),
    licence,
    subjectIds,
    boardId: fixture.board.id,
  };
}
function success<T>(result: Result<T>, status = 201): T {
  expect(result.response.status).toBe(status);
  expect(result.value).not.toBeNull();
  return result.value!;
}

async function assertItem(
  result: Result<Item>,
  expected: ReturnType<typeof input>,
  thread: { id: string; route: number },
  parentId: string | null,
  status = 201,
): Promise<Item> {
  const item = success(result, status);
  type WireItem = Item & { sha256: string };
  const wire = (await result.response.clone().json()) as { post: WireItem } | { thread: { firstPost: WireItem } };
  const raw = 'post' in wire ? wire.post : wire.thread.firstPost;
  expect(item).toMatchObject({
    threadId: thread.id,
    route: thread.route,
    authorId: fixture.moderator.id,
    parentId,
    licence: expected.licence,
    subjectIds: expected.subjectIds,
    boardId: expected.boardId,
  });
  expect(bytes(raw.body)).toEqual(bytes(expected.body));
  expect(raw.sha256).toBe(digest(expected.body));
  expect(bytes(item.body)).toEqual(bytes(expected.body));
  for (const id of [item.id, item.threadId, item.revisionId]) {
    expect(routeOf(id)).toBe(thread.route);
    expect(partitionOf(routeOf(id)!)).toBe(partitionOf(thread.route));
  }
  const evidence = await driver.inspect();
  expect(evidence.items.find((row) => row.id === item.id)).toEqual({
    id: item.id,
    threadId: thread.id,
    route: thread.route,
    parentId,
    authorId: fixture.moderator.id,
  });
  expect(evidence.revisions.find((row) => row.id === item.revisionId)).toMatchObject({
    itemId: item.id,
    threadId: thread.id,
    route: thread.route,
    body: bytes(expected.body),
    sha256: digest(expected.body),
    licence: expected.licence,
    subjectIds: expected.subjectIds,
    boardId: expected.boardId,
  });
  return item;
}

async function snapshot() {
  const client = await admin.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Full rows include heads, visibility, body bytes, digests and media claims.
    // Inspect every content parent table, including any moderation side effects.
    const tables = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='content' AND c.relkind IN ('r','p') AND NOT c.relispartition
       ORDER BY name`,
    );
    const rows: Record<string, unknown[]> = {};
    for (const table of [...tables.rows.map((row) => row.name), 'core.receipt', 'core.outbox', 'core.partition']) {
      rows[table] = (await client.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
    }
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('a moderator authors a thread, post, nested reply and revision like any author with canonical bytes and digests', async () => {
  const [a, b, c] = fixture.subjectIds;
  const firstInput = input('Moderator opening', 'CC-BY-4.0', [a!]);
  const created = await driver.create(
    { ...firstInput, title: 'Moderator authored thread', visibility: 'published' },
    options('moderator-thread'),
  );
  const thread = success(created);
  expect(thread).toMatchObject({
    title: 'Moderator authored thread',
    authorId: fixture.moderator.id,
    licence: firstInput.licence,
    subjectIds: firstInput.subjectIds,
    boardId: firstInput.boardId,
  });
  await assertItem({ response: created.response, value: thread.firstPost }, firstInput, thread, null);
  expect((await driver.inspect()).threads.find((row) => row.id === thread.id)).toEqual({
    id: thread.id,
    route: thread.route,
    boardId: firstInput.boardId,
    authorId: fixture.moderator.id,
  });
  const postInput = input('Moderator post', 'MIT', [b!, c!]);
  const post = await assertItem(
    await driver.createPost({ ...postInput, threadId: thread.id }, options('moderator-post')),
    postInput,
    thread,
    null,
  );
  const replyInput = input('Moderator reply', 'CC0-1.0', []);
  const reply = await assertItem(
    await driver.reply({ ...replyInput, threadId: thread.id, parentId: post.id }, options('moderator-reply')),
    replyInput,
    thread,
    post.id,
  );
  const nestedInput = input('Moderator nested reply', 'Apache-2.0', [c!]);
  await assertItem(
    await driver.reply({ ...nestedInput, threadId: thread.id, parentId: reply.id }, options('moderator-nested')),
    nestedInput,
    thread,
    reply.id,
  );
  const before = await driver.inspect();
  const editInput = input('Moderator revised post', 'CC-BY-SA-4.0', [a!, c!]);
  const edited = await assertItem(
    await driver.revise({ ...editInput, threadId: thread.id, itemId: post.id }, options('moderator-edit')),
    editInput,
    thread,
    null,
    200,
  );
  expect(edited.id).toBe(post.id);
  expect(edited.revisionId).not.toBe(post.revisionId);
  const after = await driver.inspect();
  expect(after.revisions).toHaveLength(before.revisions.length + 1);
  for (const previous of before.revisions) {
    expect(after.revisions.find((row) => row.id === previous.id)).toEqual(previous);
  }
  await assertItem(
    await driver.readItem(thread.id, post.id, fixture.moderator, post.revisionId),
    postInput,
    thread,
    null,
    200,
  );
  await assertItem(await driver.readItem(thread.id, post.id, fixture.moderator), editInput, thread, null, 200);
  expect(
    success(await driver.readHistory(thread.id, post.id, fixture.moderator), 200)
      .map((row) => row.revisionId)
      .sort(),
  ).toEqual([post.revisionId, edited.revisionId].sort());
});

test('anonymous and suspended callers cannot post or reply and anonymous cannot take down, changing nothing', async () => {
  const thread = success(
    await driver.create(
      { ...input('Visible opening', 'MIT', fixture.subjectIds), title: 'Visible thread', visibility: 'published' },
      options('visible-thread', fixture.owner),
    ),
  );
  const post = success(
    await driver.createPost(
      { ...input('Visible post', 'MIT', []), threadId: thread.id },
      options('visible-post', fixture.owner),
    ),
  );
  success(await driver.readThread(thread.id, null), 200);
  success(await driver.readItem(thread.id, post.id, null), 200);
  const suspended = fixture.other;
  await driver.fixtures.suspend(suspended.id);
  const itemInput = { ...input('Refused authored bytes', 'CC-BY-4.0', fixture.subjectIds), threadId: thread.id };
  const attempts = [
    () => driver.createPost(itemInput, options('anonymous-post', null)),
    () => driver.reply({ ...itemInput, parentId: post.id }, options('anonymous-reply', null)),
    () => driver.createPost(itemInput, options('suspended-post', suspended)),
    () => driver.reply({ ...itemInput, parentId: post.id }, options('suspended-reply', suspended)),
    async () => ({
      response: await system.kernel.handle(
        new Request(`https://content.test/v1/threads/${thread.id}:takeDown`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify('anonymous-takedown') },
          body: JSON.stringify({ reason: 'Anonymous attempted takedown' }),
        }),
      ),
      value: null,
    }),
  ];
  for (const [index, attempt] of attempts.entries()) {
    const before = await snapshot();
    const result = await attempt();
    expect(result.response.status).toBe(401);
    expect(result.value).toBeNull();
    expect(result.response.headers.get('content-type')).toContain('application/problem+json');
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
    const problem = await result.response.clone().json();
    // An allowlist rules out nested body bytes, storage keys and digests too.
    const { request_id, ...fields } = problem;
    expect(typeof request_id).toBe('string');
    const anonymous = index < 2 || index === 4;
    expect(fields).toEqual({
      type: `https://rezics.com/problems/${anonymous ? 'authentication_required' : 'invalid_credentials'}`,
      title: anonymous ? 'Authentication Required' : 'Invalid Credentials',
      status: 401,
      code: anonymous ? 'authentication_required' : 'invalid_credentials',
      retryable: false,
      effect_status: 'not_applied',
    });
    expect(await snapshot()).toEqual(before);
  }
});
