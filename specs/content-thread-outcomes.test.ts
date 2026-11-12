import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ApiResult,
  ContentThreadDriver,
  Fixture,
  ItemView,
  ThreadInput,
  ThreadView,
} from './content-thread-driver';

setDefaultTimeout(30_000);
let documentText: typeof import('@rezics/document').documentText;
let fromPlainText: typeof import('@rezics/document').fromPlainText;
let serializeDocument: typeof import('@rezics/document').serializeDocument;
let driver: ContentThreadDriver;
let fixture: Fixture;
let current: ContentThreadDriver | undefined;
beforeEach(async () => {
  const location = process.env.CONTENT_THREAD_DRIVER;
  if (!location) throw new Error('Content thread outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('CONTENT_THREAD_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Content thread driver must use a file URL');
  // Keep the missing-driver outcome independent of workspace dependency setup.
  ({ documentText, fromPlainText, serializeDocument } = await import('@rezics/document'));
  const binding = await import(url.href);
  if (typeof binding.createContentThreadDriver !== 'function') {
    throw new Error('Content thread driver must export createContentThreadDriver');
  }
  current = driver = await binding.createContentThreadDriver();
  fixture = await driver.provision();
});
afterEach(async () => {
  const closing = current;
  current = undefined;
  await closing?.close();
});

const bytes = (body: Parameters<typeof serializeDocument>[0]) => new TextEncoder().encode(serializeDocument(body));
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const options = (key: string, actor = fixture.owner) => ({ actor, key: `"${key}"` });
function input(patch: Partial<ThreadInput> = {}): ThreadInput {
  return {
    title: 'Private authored title',
    body: fromPlainText('Authored body 漢字 e\u0301  \n  next'),
    licence: 'LicenseRef-Author-Permission',
    subjectIds: fixture.subjectIds,
    boardId: fixture.board.id,
    visibility: 'published',
    ...patch,
  };
}
function ok<T>(result: ApiResult<T>, status = 201): T {
  expect(result.response.status).toBe(status);
  expect(result.value).not.toBeNull();
  return result.value!;
}
async function create(patch: Partial<ThreadInput> = {}, key = 'create'): Promise<ThreadView> {
  return ok(await driver.create(input(patch), options(key)));
}
async function problem(result: ApiResult<unknown>, status: number) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  const { request_id: requestId, ...body } = await result.response.clone().json();
  expect(typeof requestId).toBe('string');
  return body;
}
async function hidden(result: ApiResult<unknown>, effect: 'not_applicable' | 'not_applied') {
  expect(await problem(result, 404)).toEqual({
    type: 'https://rezics.com/problems/not_found',
    title: 'Not Found',
    status: 404,
    code: 'not_found',
    retryable: false,
    effect_status: effect,
  });
  expect(result.response.headers.get('rezics-session-token')).toBeNull();
  expect(result.value).toBeNull();
}
async function unchanged(before: Awaited<ReturnType<ContentThreadDriver['inspect']>>) {
  expect(await driver.inspect()).toEqual(before);
}
function authorizedReceiptQuery(
  trace: Awaited<ReturnType<ContentThreadDriver['commandTrace']>>,
  action: string,
  resourceId: string,
) {
  const receipt = [...trace.queries].reverse().find((query) => query.statement.includes('FROM core.receipt'));
  expect(receipt).toBeDefined();
  if (!receipt) throw new Error('The command receipt query was not observed');
  const begin = [...trace.queries]
    .reverse()
    .find(
      (query) =>
        query.connectionId === receipt.connectionId &&
        query.index < receipt.index &&
        query.statement === 'BEGIN ISOLATION LEVEL SERIALIZABLE',
    );
  const authorization = trace.checks.find(
    (check) =>
      check.connectionId === receipt.connectionId &&
      check.statement > (begin?.index ?? Number.POSITIVE_INFINITY) &&
      check.statement < receipt.index &&
      check.action === action &&
      check.resourceId === resourceId,
  );
  expect(begin).toBeDefined();
  expect(authorization).toBeDefined();
  return receipt;
}
async function append(thread: ThreadView, key = 'post') {
  return ok(
    await driver.createPost(
      {
        threadId: thread.id,
        body: fromPlainText('Subsequent post'),
        licence: 'CC-BY-4.0',
      },
      options(key),
    ),
  );
}
async function reply(thread: ThreadView, parent: ItemView, key = 'reply') {
  return ok(
    await driver.reply(
      {
        threadId: thread.id,
        parentId: parent.id,
        body: fromPlainText('Nested reply'),
        licence: 'MIT',
      },
      options(key),
    ),
  );
}
/** A post id that was never created, on the same embedded route as `id`. */
function unusedIdOnRoute(id: string): string {
  const chars = id.split('');
  const current = chars[9];
  if (current === undefined || current === '-') throw new Error('Routed id has no mutable prefix');
  chars[9] = current === '0' ? '1' : '0';
  return chars.join('');
}

test('anonymous reads published thread post and reply but cannot create or revise', async () => {
  const thread = await create();
  const post = await append(thread);
  const child = await reply(thread, post);
  expect(ok(await driver.readThread(thread.id, null), 200)).toEqual(thread);
  for (const item of [thread.firstPost, post, child]) {
    expect(ok(await driver.readItem(thread.id, item.id, null), 200)).toEqual(item);
  }
  const before = await driver.inspect();
  await problem(await driver.create(input(), { actor: null, key: '"anonymous"' }), 401);
  await problem(
    await driver.revise(
      { threadId: thread.id, itemId: post.id, body: input().body },
      {
        actor: null,
        key: '"anonymous-edit"',
      },
    ),
    401,
  );
  await unchanged(before);
});

test('author creates first post subsequent post and nested replies on the immutable thread route', async () => {
  const thread = await create();
  const post = await append(thread);
  const child = await reply(thread, post);
  const nested = await reply(thread, child, 'nested');
  expect(thread).toMatchObject({
    title: input().title,
    authorId: fixture.owner.id,
    licence: input().licence,
    boardId: fixture.board.id,
    subjectIds: fixture.subjectIds,
  });
  for (const item of [thread.firstPost, post, child, nested]) {
    expect(item).toMatchObject({ threadId: thread.id, route: thread.route, authorId: fixture.owner.id });
  }
  expect(thread.firstPost.licence).toBe(input().licence);
  expect(post.licence).toBe('CC-BY-4.0');
  expect(child).toMatchObject({ parentId: post.id, licence: 'MIT' });
  expect(nested.parentId).toBe(child.id);
  expect(thread.firstPost.parentId).toBeNull();
  expect(post.parentId).toBeNull();
  const rows = await driver.inspect();
  expect(rows.semanticRows).toEqual([]);
  expect(rows.threads.find((row) => row.id === thread.id)).toMatchObject({
    route: thread.route,
    authorId: fixture.owner.id,
  });
  for (const item of [thread.firstPost, post, child, nested]) {
    expect(rows.items.find((row) => row.id === item.id)).toMatchObject({
      threadId: thread.id,
      route: thread.route,
      parentId: item.parentId,
      authorId: fixture.owner.id,
    });
    expect(rows.revisions.find((row) => row.id === item.revisionId)).toMatchObject({
      threadId: thread.id,
      route: thread.route,
    });
  }
});

test('every thread post and reply preserves its own author declared licence subject references and board placement', async () => {
  const [a, b, c] = fixture.subjectIds;
  expect(new Set([a, b, c]).size).toBe(3);
  expect([a, b, c].every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  const thread = await create({ subjectIds: [a!] });
  const post = ok(
    await driver.createPost(
      {
        threadId: thread.id,
        body: fromPlainText('Post author references B and C'),
        licence: 'CC-BY-4.0',
        subjectIds: [b!, c!],
        boardId: fixture.board.id,
      },
      options('own-refs', fixture.other),
    ),
  );
  const child = ok(
    await driver.reply(
      {
        threadId: thread.id,
        parentId: post.id,
        body: fromPlainText('Reply author has no subject references'),
        licence: 'MIT',
        subjectIds: [],
        boardId: fixture.board.id,
      },
      options('empty-refs'),
    ),
  );
  const inherited = await append(thread, 'default-refs');
  const rows = await driver.inspect();
  expect(rows.semanticRows).toEqual([]);
  expect(thread).toMatchObject({ subjectIds: [a!], boardId: fixture.board.id, authorId: fixture.owner.id });
  for (const [item, subjectIds, licence, authorId] of [
    [thread.firstPost, [a!], 'LicenseRef-Author-Permission', fixture.owner.id],
    [post, [b!, c!], 'CC-BY-4.0', fixture.other.id],
    [child, [], 'MIT', fixture.owner.id],
    [inherited, [a!], 'CC-BY-4.0', fixture.owner.id],
  ] as const) {
    const metadata = { subjectIds: [...subjectIds], licence, boardId: fixture.board.id };
    expect(item).toMatchObject({ ...metadata, authorId, threadId: thread.id, route: thread.route });
    expect(rows.items.find((row) => row.id === item.id)).toMatchObject({
      authorId,
      threadId: thread.id,
      route: thread.route,
    });
    expect(rows.revisions.find((row) => row.id === item.revisionId)).toMatchObject({
      ...metadata,
      itemId: item.id,
      threadId: thread.id,
      route: thread.route,
      body: bytes(item.body),
    });
    expect(ok(await driver.readItem(thread.id, item.id, null, item.revisionId), 200)).toEqual(item);
    expect(ok(await driver.readItem(thread.id, item.id, null), 200)).toEqual(item);
    expect(ok(await driver.readItems(thread.id, null), 200).find((row) => row.id === item.id)).toEqual(item);
  }
  expect(child.parentId).toBe(post.id);
  expect(ok(await driver.readThread(thread.id, null), 200)).toEqual(thread);
});

test('revising metadata preserves old exact revision metadata and body-only edits preserve the new metadata', async () => {
  const [a, b, c] = fixture.subjectIds;
  const thread = await create({ subjectIds: [a!] });
  const oldBody = fromPlainText('Old post with author references');
  const old = ok(
    await driver.createPost(
      {
        threadId: thread.id,
        body: oldBody,
        licence: 'CC-BY-4.0',
        subjectIds: [b!],
        boardId: fixture.board.id,
      },
      options('metadata-post', fixture.other),
    ),
  );
  const before = await driver.inspect();
  const body = fromPlainText('New post with changed author references and licence');
  const updated = ok(
    await driver.revise(
      {
        threadId: thread.id,
        itemId: old.id,
        body,
        licence: 'MIT',
        subjectIds: [c!],
        boardId: fixture.board.id,
      },
      options('metadata-edit', fixture.other),
    ),
    200,
  );
  expect(updated.id).toBe(old.id);
  expect(updated.revisionId).not.toBe(old.revisionId);
  expect(updated).toMatchObject({
    body,
    licence: 'MIT',
    subjectIds: [c!],
    boardId: fixture.board.id,
    authorId: fixture.other.id,
    threadId: thread.id,
    route: thread.route,
    parentId: null,
  });
  const bodyOnly = ok(
    await driver.revise(
      {
        threadId: thread.id,
        itemId: old.id,
        body: fromPlainText('Body only after metadata edit'),
      },
      options('metadata-body-only', fixture.other),
    ),
    200,
  );
  expect(bodyOnly.revisionId).not.toBe(updated.revisionId);
  expect(bodyOnly).toMatchObject({
    id: old.id,
    licence: 'MIT',
    subjectIds: [c!],
    boardId: fixture.board.id,
    authorId: fixture.other.id,
  });
  const after = await driver.inspect();
  expect(after.threads).toEqual(before.threads);
  expect(after.items).toEqual(before.items);
  expect(after.semanticRows).toEqual([]);
  expect(after.revisions).toHaveLength(before.revisions.length + 2);
  for (const row of before.revisions) expect(after.revisions.find((next) => next.id === row.id)).toEqual(row);
  for (const [item, subjectIds, licence, expectedBody] of [
    [old, [b!], 'CC-BY-4.0', oldBody],
    [updated, [c!], 'MIT', body],
    [bodyOnly, [c!], 'MIT', bodyOnly.body],
  ] as const) {
    expect(after.revisions.find((row) => row.id === item.revisionId)).toMatchObject({
      itemId: old.id,
      threadId: thread.id,
      route: thread.route,
      subjectIds: [...subjectIds],
      licence,
      boardId: fixture.board.id,
      body: bytes(expectedBody),
    });
    expect(ok(await driver.readItem(thread.id, old.id, null, item.revisionId), 200)).toEqual(item);
  }
  expect(ok(await driver.readItem(thread.id, old.id, null), 200)).toEqual(bodyOnly);
  expect(ok(await driver.readHistory(thread.id, old.id, fixture.other), 200)).toEqual(
    expect.arrayContaining([old, updated, bodyOnly]),
  );
});

test('invalid subject IDs licences and conflicting item boards reject atomically without semantic dependencies', async () => {
  const thread = await create();
  const post = await append(thread);
  const before = await driver.inspect();
  const invalidMetadata = [
    { subjectIds: ['not-a-subject-id'] },
    { subjectIds: [''] },
    { licence: 'not-an-SPDX-licence' },
    { licence: 'MIT AND' },
  ];
  for (const [index, metadata] of invalidMetadata.entries()) {
    await problem(await driver.create(input(metadata), options(`invalid-thread-${index}`)), 400);
    await unchanged(before);
  }
  for (const [index, metadata] of [...invalidMetadata, { boardId: fixture.privateBoard.id }].entries()) {
    const item = { threadId: thread.id, body: fromPlainText('Rejected metadata'), licence: 'MIT', ...metadata };
    for (const result of [
      () => driver.createPost(item, options(`invalid-post-${index}`)),
      () => driver.reply({ ...item, parentId: post.id }, options(`invalid-reply-${index}`)),
      () => driver.revise({ ...item, itemId: post.id }, options(`invalid-edit-${index}`)),
    ]) {
      const rejected = await result();
      await problem(rejected, 400);
      expect(rejected.value).toBeNull();
      expect(rejected.response.headers.get('rezics-session-token')).toBeNull();
      await unchanged(before);
    }
  }
  await hidden(
    await driver.createPost(
      {
        threadId: fixture.unknownThread,
        body: fromPlainText('Missing thread'),
        licence: 'MIT',
        subjectIds: fixture.subjectIds,
      },
      options('missing-thread-refs'),
    ),
    'not_applied',
  );
  await unchanged(before);
});

test('identical idempotency payload replays IDs with one creation and publication event', async () => {
  const before = await driver.inspect();
  const request = input();
  const first = await driver.create(request, options('same'));
  const thread = ok(first);
  const committed = await driver.inspect();
  expect(committed.revisions.length - before.revisions.length).toBe(1);
  expect(committed.receipts.length - before.receipts.length).toBe(1);
  const creation = committed.outbox.filter(
    (row) => row.command === 'content.thread.create' && row.envelope.threadId === thread.id,
  );
  expect(creation.map((row) => row.eventType).sort()).toEqual(
    ['com.rezics.content.thread.created.v1', 'com.rezics.content.post.published.v1'].sort(),
  );
  expect(Object.fromEntries(creation.map((row) => [row.eventType, row.eventSequence]))).toEqual({
    'com.rezics.content.thread.created.v1': 0,
    'com.rezics.content.post.published.v1': 1,
  });
  expect(new Set(creation.map((row) => row.idempotencyKey)).size).toBe(1);
  expect(ok(await driver.create(request, options('same')))).toEqual(thread);
  const replayTrace = await driver.commandTrace();
  const replayReceipt = authorizedReceiptQuery(replayTrace, 'thread:create', fixture.board.id);
  expect(
    replayTrace.queries.some(
      (query) =>
        query.connectionId === replayReceipt.connectionId &&
        query.index > replayReceipt.index &&
        /INSERT INTO content\.(thread|post|revision)/.test(query.statement),
    ),
  ).toBe(false);
  expect(replayTrace.fences).toEqual([]);
  await unchanged(committed);
  const conflict = await driver.create({ ...request, title: 'Changed payload' }, options('same'));
  expect(await problem(conflict, 422)).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
  await unchanged(committed);
});

test('canonical property order preserves Unicode and authored whitespace and rejects invalid documents', async () => {
  const body = fromPlainText('漢字 e\u0301 é\t  \n  next  ');
  const reverseKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reverseKeys(entry)]),
      );
    }
    return value;
  };
  const reordered = reverseKeys(body);
  const thread = await create({ body });
  const post = ok(
    await driver.createPost({ threadId: thread.id, body: reordered, licence: 'MIT' }, options('reordered')),
  );
  const rows = await driver.inspect();
  const a = rows.revisions.find((row) => row.id === thread.firstPost.revisionId)!;
  const b = rows.revisions.find((row) => row.id === post.revisionId)!;
  expect(a.body).toEqual(bytes(body));
  expect(b.body).toEqual(a.body);
  expect(a.sha256).toBe(digest(bytes(body)));
  expect(b.sha256).toBe(a.sha256);
  expect(a.searchText).toBe(documentText(body));
  expect(b.searchText).toBe(documentText(body));
  expect(serializeDocument(ok(await driver.readItem(thread.id, post.id, null), 200).body)).toBe(
    serializeDocument(body),
  );
  const before = await driver.inspect();
  await problem(
    await driver.create(
      input({ body: { version: body.version, profile: 'text', doc: { type: 'unknown' } } }),
      options('invalid'),
    ),
    400,
  );
  await unchanged(before);
});

test('PostgreSQL independently checks SHA-256 and two MiB body limit with lz4 bytea storage', async () => {
  const thread = await create();
  expect(await driver.storage()).toEqual({ schema: 'content', bodyType: 'bytea', compression: 'lz4' });
  const before = await driver.inspect();
  const body = bytes(fromPlainText('Direct database integrity probe'));
  const wrong = await driver.probeRevision(thread.firstPost.revisionId, body, '00'.repeat(32));
  expect(wrong.sqlstate).toBe('23514');
  expect(wrong.constraint.length).toBeGreaterThan(0);
  const huge = bytes(fromPlainText('x'.repeat(2 * 1024 * 1024)));
  expect(huge.byteLength).toBeGreaterThan(2 * 1024 * 1024);
  const oversized = await driver.probeRevision(thread.firstPost.revisionId, huge, digest(huge));
  expect(oversized.sqlstate).toBe('23514');
  expect(oversized.constraint.length).toBeGreaterThan(0);
  expect(oversized.constraint).not.toBe(wrong.constraint);
  await unchanged(before);
});

test('API rejects oversized document without partial thread revision receipt claim or outbox writes', async () => {
  await create();
  const before = await driver.inspect();
  await problem(
    await driver.create(input({ body: fromPlainText('漢'.repeat((2 * 1024 * 1024) / 3 + 1)) }), options('oversize')),
    413,
  );
  await unchanged(before);
});

test('revision appends immutable bytes and search text while exact old revision stays readable', async () => {
  const thread = await create();
  const old = thread.firstPost;
  const before = await driver.inspect();
  const body = fromPlainText('Replacement body with new search text');
  const updated = ok(await driver.revise({ threadId: thread.id, itemId: old.id, body }, options('revise')), 200);
  expect(updated.id).toBe(old.id);
  expect(updated.revisionId).not.toBe(old.revisionId);
  expect(updated).toMatchObject({
    threadId: thread.id,
    route: thread.route,
    authorId: old.authorId,
    licence: old.licence,
  });
  expect(updated).toMatchObject({ subjectIds: old.subjectIds, boardId: old.boardId });
  const after = await driver.inspect();
  expect(after.threads).toEqual(before.threads);
  expect(after.revisions.length).toBe(before.revisions.length + 1);
  for (const row of before.revisions) expect(after.revisions.find((next) => next.id === row.id)).toEqual(row);
  expect(after.revisions.find((row) => row.id === updated.revisionId)).toMatchObject({
    body: bytes(body),
    sha256: digest(bytes(body)),
    searchText: documentText(body),
    route: thread.route,
  });
  expect(ok(await driver.readItem(thread.id, old.id, null, old.revisionId), 200)).toEqual(old);
  expect(ok(await driver.readItem(thread.id, old.id, null), 200)).toEqual(updated);
  expect(
    ok(await driver.readHistory(thread.id, old.id, fixture.owner), 200)
      .map((item) => item.revisionId)
      .sort(),
  ).toEqual([old.revisionId, updated.revisionId].sort());
});

test('non-author and moderator cannot revise another author and body authorId cannot spoof identity', async () => {
  const thread = await create();
  const before = await driver.inspect();
  for (const actor of [fixture.other, fixture.moderator]) {
    await problem(
      await driver.revise(
        { threadId: thread.id, itemId: thread.firstPost.id, body: input().body },
        options(actor.id, actor),
      ),
      403,
    );
  }
  await problem(
    await driver.create(input({ authorId: fixture.owner.id }), options('spoof-create', fixture.other)),
    400,
  );
  await problem(
    await driver.revise(
      {
        threadId: thread.id,
        itemId: thread.firstPost.id,
        body: input().body,
        authorId: fixture.other.id,
      },
      options('spoof-edit'),
    ),
    400,
  );
  await unchanged(before);
  const own = ok(await driver.create(input(), options('other-own', fixture.other)));
  expect(own.authorId).toBe(fixture.other.id);
  expect(own.firstPost.authorId).toBe(fixture.other.id);
  ok(
    await driver.revise(
      { threadId: own.id, itemId: own.firstPost.id, body: fromPlainText('Own edit') },
      options('own-edit', fixture.other),
    ),
    200,
  );
});

test('suspended account authentication denies create and edit with previously valid credentials', async () => {
  const thread = await create();
  await driver.fixtures.suspend(fixture.owner.id);
  const before = await driver.inspect();
  await problem(await driver.create(input(), options('suspended-create')), 401);
  await problem(
    await driver.revise(
      { threadId: thread.id, itemId: thread.firstPost.id, body: input().body },
      options('suspended-edit'),
    ),
    401,
  );
  await unchanged(before);
  expect(ok(await driver.create(input(), options('active-control', fixture.other))).authorId).toBe(fixture.other.id);
});

test('missing cross-thread and cross-route containment references fail atomically', async () => {
  const thread = await create();
  const sibling = await create({}, 'sibling');
  const before = await driver.inspect();
  for (const parentId of [fixture.unknownItem, sibling.firstPost.id, fixture.foreignItem.id]) {
    const result = await driver.reply(
      { threadId: thread.id, parentId, body: input().body, licence: 'MIT' },
      options(parentId),
    );
    await hidden(result, 'not_applied');
    await unchanged(before);
  }
  const wrongRoute = await driver.revise(
    {
      threadId: fixture.foreignThread.id,
      itemId: unusedIdOnRoute(fixture.foreignThread.id),
      body: input().body,
    },
    options('wrong-route'),
  );
  await hidden(wrongRoute, 'not_applied');
  await unchanged(before);
  expect(fixture.foreignThread.route).not.toBe(thread.route);
  expect((await reply(thread, thread.firstPost)).parentId).toBe(thread.firstPost.id);
});

async function concealed(thread: ThreadView, child: ItemView) {
  for (const actor of [null, fixture.other]) {
    await hidden(await driver.readThread(thread.id, actor), 'not_applicable');
    await hidden(await driver.readItems(thread.id, actor), 'not_applicable');
    for (const item of [thread.firstPost, child]) {
      await hidden(await driver.readItem(thread.id, item.id, actor), 'not_applicable');
      await hidden(await driver.readItem(thread.id, item.id, actor, item.revisionId), 'not_applicable');
      await hidden(await driver.readHistory(thread.id, item.id, actor), 'not_applicable');
    }
    const list = await driver.readList(thread.boardId, actor);
    expect(ok(list, 200).some((entry) => entry.id === thread.id)).toBe(false);
    const raw = JSON.stringify(await list.response.clone().json());
    for (const secret of [thread.id, thread.title, child.id, child.revisionId]) expect(raw).not.toContain(secret);
  }
}

test('draft thread hides descendants history exact revisions and lists while owner reads draft', async () => {
  const thread = await create({ visibility: 'draft' });
  const child = await reply(thread, thread.firstPost);
  await concealed(thread, child);
  expect(ok(await driver.readThread(thread.id, fixture.owner), 200)).toEqual(thread);
  expect(ok(await driver.readItem(thread.id, child.id, fixture.owner, child.revisionId), 200)).toEqual(child);
});

test('protected and taken-down thread final checks hide previously published descendants', async () => {
  const thread = await create();
  const child = await reply(thread, thread.firstPost);
  expect(ok(await driver.readItem(thread.id, child.id, null), 200)).toEqual(child);
  for (const state of ['protected', 'taken_down'] as const) {
    await driver.fixtures.visibility(thread.id, state);
    await concealed(thread, child);
  }
});

test('draft protected and taken-down parent hides nested reply and exact history despite public thread', async () => {
  const thread = await create();
  const parent = await append(thread);
  const child = await reply(thread, parent);
  expect(ok(await driver.readItem(thread.id, child.id, null), 200)).toEqual(child);
  for (const state of ['draft', 'protected', 'taken_down'] as const) {
    await driver.fixtures.visibility(parent.id, state);
    for (const actor of [null, fixture.other]) {
      const visibleThread = await driver.readThread(thread.id, actor);
      ok(visibleThread, 200);
      const listed = await driver.readItems(thread.id, actor);
      const visibleItems = ok(listed, 200);
      expect(visibleItems.some((item) => item.id === parent.id || item.id === child.id)).toBe(false);
      const raw = JSON.stringify([await visibleThread.response.clone().json(), await listed.response.clone().json()]);
      for (const secret of [parent.id, child.id, parent.revisionId, child.revisionId])
        expect(raw).not.toContain(secret);
      for (const item of [parent, child]) {
        await hidden(await driver.readItem(thread.id, item.id, actor), 'not_applicable');
        await hidden(await driver.readItem(thread.id, item.id, actor, item.revisionId), 'not_applicable');
        await hidden(await driver.readHistory(thread.id, item.id, actor), 'not_applicable');
      }
    }
    if (state === 'draft') expect(ok(await driver.readItem(thread.id, child.id, fixture.owner), 200)).toEqual(child);
  }
});

test('private container chain hides published content even when anonymous public read succeeds', async () => {
  const publicThread = await create();
  ok(await driver.readThread(publicThread.id, null), 200);
  const thread = await create({ boardId: fixture.privateBoard.id }, 'private');
  const child = await reply(thread, thread.firstPost);
  expect(ok(await driver.readThread(thread.id, fixture.owner), 200)).toEqual(thread);
  for (const actor of [null, fixture.other]) {
    await hidden(await driver.readThread(thread.id, actor), 'not_applicable');
    await hidden(await driver.readItems(thread.id, actor), 'not_applicable');
    await hidden(await driver.readList(fixture.privateBoard.id, actor), 'not_applicable');
    await hidden(await driver.readItem(thread.id, child.id, actor, child.revisionId), 'not_applicable');
    await hidden(await driver.readHistory(thread.id, child.id, actor), 'not_applicable');
  }
});

test('unknown and hidden resources have identical RFC 9457 problems with no existence hints', async () => {
  const thread = await create({ boardId: fixture.privateBoard.id, visibility: 'draft' });
  expect(ok(await driver.readThread(thread.id, fixture.owner), 200)).toEqual(thread);
  for (const actor of [null, fixture.other]) {
    for (const result of [
      await driver.readThread(thread.id, actor),
      await driver.readThread(fixture.unknownThread, actor),
      await driver.readItem(thread.id, thread.firstPost.id, actor, thread.firstPost.revisionId),
      await driver.readItem(fixture.unknownThread, fixture.unknownItem, actor, thread.firstPost.revisionId),
      await driver.readHistory(fixture.unknownThread, fixture.unknownItem, actor),
    ])
      await hidden(result, 'not_applicable');
  }
});

test('parent create grant authorizes before receipt and body with no new-ID grant and one write partition', async () => {
  const response = await driver.create(input(), options('parent-grant'));
  const thread = ok(response);
  const trace = await driver.commandTrace();
  const receipt = authorizedReceiptQuery(trace, 'thread:create', fixture.board.id);
  const body = trace.queries.find(
    (query) =>
      query.connectionId === receipt.connectionId &&
      query.index > receipt.index &&
      query.statement.startsWith('INSERT INTO content.thread'),
  );
  const fence = trace.fences.find((query) => query.connectionId === receipt.connectionId);
  expect(body).toBeDefined();
  expect(fence).toBeDefined();
  expect(receipt.index).toBeLessThan(body!.index);
  expect(body!.index).toBeLessThan(fence!.statement);
  const check = trace.checks.find((entry) => entry.action === 'thread:create');
  expect(check).toMatchObject({ resourceId: fixture.board.id, partition: fixture.board.route >>> 4 });
  expect(Number.isFinite(Date.parse(check!.at))).toBe(true);
  expect(Number.isInteger(check!.statement)).toBe(true);
  expect(check!.statement).toBeGreaterThan(0);
  expect(trace.checks.some((entry) => entry.resourceId === thread.id)).toBe(false);
  expect(trace.fences.map((entry) => entry.partition)).toEqual([thread.route >>> 4]);
  const session = await driver.session(response.response, fixture.owner);
  expect(session.token.length).toBeGreaterThan(0);
  expect(response.response.headers.get('rezics-session-token')).toBe(session.token);
  expect(session.partitions).toEqual([thread.route >>> 4]);
  const before = await driver.inspect();
  await driver.fixtures.revokeParentCreate(fixture.owner.id, fixture.board.id);
  await problem(await driver.create(input(), options('revoked-new')), 403);
  await unchanged(before);
});

test('revoked parent grant denies identical replay before receipt without stored response disclosure', async () => {
  const request = input();
  const thread = ok(await driver.create(request, options('revoke-replay')));
  const before = await driver.inspect();
  expect(
    before.outbox
      .filter((row) => row.command === 'content.thread.create' && row.envelope.threadId === thread.id)
      .map((row) => row.eventType)
      .sort(),
  ).toEqual(['com.rezics.content.thread.created.v1', 'com.rezics.content.post.published.v1'].sort());
  await driver.fixtures.revokeParentCreate(fixture.owner.id, fixture.board.id);
  const denied = await driver.create(request, options('revoke-replay'));
  expect(await problem(denied, 403)).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
  expect(denied.value).toBeNull();
  expect(denied.response.headers.get('location')).toBeNull();
  expect(denied.response.headers.get('rezics-session-token')).toBeNull();
  const raw = JSON.stringify(await denied.response.clone().json());
  for (const secret of [thread.id, thread.title, thread.authorId, thread.firstPost.id, thread.firstPost.revisionId]) {
    expect(raw).not.toContain(secret);
  }
  const trace = await driver.commandTrace();
  expect(trace.queries.some((query) => query.statement.includes('FROM core.receipt'))).toBe(false);
  expect(trace.queries.some((query) => /INSERT INTO content\.(thread|post|revision)/.test(query.statement))).toBe(
    false,
  );
  expect(trace.fences).toEqual([]);
  await unchanged(before);
  expect(ok(await driver.readThread(thread.id, fixture.owner), 200)).toEqual(thread);
  expect(ok(await driver.create(request, options('still-authorized', fixture.other))).authorId).toBe(fixture.other.id);
});

test('commands carry session headers and transactional outbox envelopes and injected failure rolls back all effects', async () => {
  const before = await driver.inspect();
  const response = await driver.create(input(), options('transaction'));
  const thread = ok(response);
  authorizedReceiptQuery(await driver.commandTrace(), 'thread:create', fixture.board.id);
  const session = await driver.session(response.response, fixture.owner);
  expect(session.token.length).toBeGreaterThan(0);
  expect(response.response.headers.get('rezics-session-token')).toBe(session.token);
  const postResponse = await driver.createPost(
    { threadId: thread.id, body: fromPlainText('With session'), licence: 'MIT' },
    {
      ...options('session-post'),
      session: session.token,
    },
  );
  const post = ok(postResponse);
  authorizedReceiptQuery(await driver.commandTrace(), 'post:create', thread.id);
  expect((await driver.session(postResponse.response, fixture.owner)).partitions).toEqual([thread.route >>> 4]);
  const childResponse = await driver.reply(
    {
      threadId: thread.id,
      parentId: post.id,
      body: fromPlainText('Reply effect'),
      licence: 'MIT',
    },
    options('effect-reply'),
  );
  const child = ok(childResponse);
  authorizedReceiptQuery(await driver.commandTrace(), 'post:create', thread.id);
  const editResponse = await driver.revise(
    { threadId: thread.id, itemId: post.id, body: fromPlainText('Edited effect') },
    options('effect-edit'),
  );
  const edited = ok(editResponse, 200);
  authorizedReceiptQuery(await driver.commandTrace(), 'post:revise', post.id);
  for (const result of [childResponse, editResponse]) {
    expect((await driver.session(result.response, fixture.owner)).partitions).toEqual([thread.route >>> 4]);
  }
  const after = await driver.inspect();
  const effects = after.outbox.filter((row) => !before.outbox.some((old) => old.id === row.id));
  const publicationType = 'com.rezics.content.post.published.v1';
  const publications = effects.filter((row) => row.eventType === publicationType);
  const nativeEvents = effects.filter((row) => row.eventType !== publicationType);
  expect(publications).toHaveLength(3);
  expect(nativeEvents).toHaveLength(4);
  const expected = [
    [thread.firstPost, 'content.thread.create', 'com.rezics.content.thread.created.v1', true],
    [post, 'content.post.create', 'com.rezics.content.post.created.v1', true],
    [child, 'content.post.create', 'com.rezics.content.post.created.v1', true],
    [edited, 'content.post.revise', 'com.rezics.content.revision.created.v1', false],
  ] as const;
  for (const [item, command, eventType, wasPublished] of expected) {
    const effect = nativeEvents.find(
      (row) =>
        row.command === command &&
        row.eventType === eventType &&
        row.envelope.threadId === thread.id &&
        row.envelope.revisionId === item.revisionId,
    );
    expect(effect).toBeDefined();
    expect(effect).toMatchObject({
      partition: thread.route >>> 4,
      envelope: {
        threadId: thread.id,
        itemId: item.id,
        revisionId: item.revisionId,
        actorId: fixture.owner.id,
      },
    });
    expect(after.receipts.some((row) => row.key === effect!.idempotencyKey && row.command === command)).toBe(true);
    const publication = publications.find((row) => row.envelope.revisionId === item.revisionId);
    if (wasPublished) {
      expect(publication).toMatchObject({ command, idempotencyKey: effect!.idempotencyKey });
    } else {
      expect(publication).toBeUndefined();
    }
  }
  const retryInput = input();
  await driver.fixtures.failBeforeOutbox();
  const failed = await driver.create(retryInput, options('rollback'));
  await problem(failed, 503);
  expect(failed.response.headers.get('rezics-session-token')).toBeNull();
  await unchanged(after);
  ok(await driver.create(retryInput, options('rollback')));
});
