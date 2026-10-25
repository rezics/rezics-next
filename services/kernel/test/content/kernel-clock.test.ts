import { afterAll, beforeAll, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { reserveMedia } from '../../src/content/media.ts';
import { readBoard } from '../../src/content/reads.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { decodeCursor } from '../../src/tokens/cursor.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { capture, checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(41);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(42)]]) };
const at = Date.parse('2026-01-01T00:00:00Z');
const boardId = newId(0x4321);
const timedBoardId = newId(0x4321);
const subjectId = newId(0x6789);
const body = normalizeDocument({
  version: 'rezics-document-v1',
  profile: 'text',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'clock-paragraph' }, content: [{ type: 'text', text: 'Clock' }] }],
  },
});
const input = { body, licence: 'MIT', subjectIds: [subjectId] };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let actor: AccountActor;
let bearer: string;
let thread: { id: string; route: number; firstPost: { id: string } };
let now = at;
const clock = () => new Date(now);
const rate = createWriteRateLimiter({
  secret: 'kernel-clock-private-test-secret-at-least-32-bytes',
  overrides: JSON.stringify({
    'new-account': { write: { maximum: 100000, seconds: 86400 } },
    member: { write: { maximum: 100000, seconds: 86400 } },
  }),
});
const kernel = (serviceClock?: () => Date) =>
  createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: fixture.access,
    writeRate: rate,
    ...(serviceClock === undefined ? {} : { clock: serviceClock }),
  });
let app: ReturnType<typeof createKernel>;

async function call(
  target: ReturnType<typeof createKernel>,
  method: string,
  path: string,
  value?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await target.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(value === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...headers,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
  );
  return { response, value: await response.json() };
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  fixture = await standingFixture();
  await fixture.reset();
  const authenticate = fixture.access.authenticate;
  fixture.access.authenticate = (token, boundary) => {
    bearer = token;
    return authenticate(token, { ...boundary, pool: db.pool });
  };
  try {
    actor = (await fixture.context()).actor;
  } finally {
    fixture.access.authenticate = authenticate;
  }
  for (const id of [boardId, timedBoardId]) {
    await db.admin.query(
      `INSERT INTO content.board
       (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1,$2,$3,'Clock board','published',1,$4)`,
      [routeOf(id), id, subjectId, randomUUID()],
    );
    await fixture.grant(actor.accountId, 'board:read', { route: routeOf(id)!, id });
    await fixture.grant(
      actor.accountId,
      'thread:create',
      { route: routeOf(id)!, id },
      id === timedBoardId ? '[2026-01-01T00:00:00Z,2026-01-02T00:00:00Z)' : '(,)',
    );
  }
  app = kernel(clock);
  const created = await call(kernel(), 'POST', '/v1/threads', {
    ...input,
    boardId,
    visibility: 'published',
    title: 'Clock thread',
  });
  expect(created.response.status).toBe(201);
  thread = created.value.thread;
  for (const action of ['post:create', 'media:create'])
    await fixture.grant(actor.accountId, action, { route: thread.route, id: thread.id });
  const post = await call(kernel(), 'POST', `/v1/threads/${thread.id}/posts`, input);
  expect(post.response.status).toBe(201);
  const revision = await call(kernel(), 'POST', `/v1/posts/${thread.firstPost.id}/revisions`, input);
  expect(revision.response.status).toBe(200);
});

afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

test('one trusted kernel clock reaches native authoritative revision time and grant formula', async () => {
  now = at;
  const result = await call(
    app,
    'POST',
    '/v1/threads',
    { ...input, boardId: timedBoardId, visibility: 'published', title: 'At T' },
    {
      'x-command-time': '2099-01-01T00:00:00Z',
      'x-clock': '2099-01-01T00:00:00Z',
    },
  );
  expect(result.response.status).toBe(201);
  const stored = await db.admin.query(
    'SELECT recorded_at AS created_at FROM content.revision WHERE route=$1 AND revision_id=$2',
    [result.value.thread.firstPost.route, result.value.thread.firstPost.revisionId],
  );
  expect(stored.rows[0].created_at.getTime()).toBe(at);
  now = Date.parse('2026-01-03T00:00:00Z');
  const denied = await call(app, 'POST', '/v1/threads', {
    ...input,
    boardId: timedBoardId,
    visibility: 'published',
    title: 'After grant',
  });
  expect(denied.response.status).toBeGreaterThanOrEqual(400);
});

test('the same clock issues and expires both signed keyset cursors while real Auth remains valid', async () => {
  for (const [path, operation, postId] of [
    [`/v1/threads/${thread.id}/posts`, 'content.posts', null],
    [`/v1/posts/${thread.firstPost.id}/revisions`, 'content.revisions', thread.firstPost.id],
  ] as const) {
    now = at;
    const first = await call(app, 'GET', `${path}?limit=1`);
    expect(first.response.status).toBe(200);
    const cursor = first.value.next;
    expect(typeof cursor).toBe('string');
    const binding = { operation, parameters: { threadId: thread.id, postId, viewer: actor.accountId } };
    expect(decodeCursor(tokens, binding, cursor, at).ok).toBe(true);
    expect((await call(app, 'GET', `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`)).response.status).toBe(200);
    now = at + 15 * 60_000 + 1;
    const expired = await call(app, 'GET', `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`, undefined, {
      'x-command-time': new Date(at).toISOString(),
    });
    expect(expired.response.status).toBe(400);
    expect(expired.value.code).toBe('invalid_request');
    now = Date.parse('2099-01-01T00:00:00Z');
    expect((await call(app, 'GET', path)).response.status).toBe(200);
  }
});

test('system clock is the default and request fields cannot provide authoritative time', async () => {
  const before = Date.now();
  const result = await call(
    kernel(),
    'POST',
    '/v1/threads',
    { ...input, boardId, visibility: 'published', title: 'System time' },
    {
      'x-command-time': new Date(at).toISOString(),
    },
  );
  expect(result.response.status).toBe(201);
  const stored = await db.admin.query(
    'SELECT recorded_at AS created_at FROM content.revision WHERE route=$1 AND revision_id=$2',
    [result.value.thread.firstPost.route, result.value.thread.firstPost.revisionId],
  );
  expect(stored.rows[0].created_at.getTime()).toBeGreaterThanOrEqual(before);
  expect(stored.rows[0].created_at.getTime()).toBeLessThanOrEqual(Date.now());
  expect(
    (await call(app, 'POST', '/v1/threads', { ...input, boardId, visibility: 'published', title: 'Spoof', clock: at }))
      .response.status,
  ).toBe(400);
});

test('sampled invalid Dates fail without effects and domain time cannot revive expired budgets', async () => {
  const before = await db.admin.query('SELECT count(*) FROM content.revision');
  const result = await call(
    kernel(() => new Date(NaN)),
    'POST',
    '/v1/threads',
    { ...input, boardId, visibility: 'published', title: 'Invalid' },
  );
  expect(result.response.status).toBe(500);
  expect((await db.admin.query('SELECT count(*) FROM content.revision')).rows).toEqual(before.rows);
  now = 0;
  await expect(
    readBoard({ pool: db.pool, access: fixture.access, tokens, ...{ clock } }, boardId, {
      actor,
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow();
  await expect(
    reserveMedia(
      { pool: db.pool, access: fixture.access, ...{ clock } },
      actor,
      {
        containerId: thread.id,
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: 256,
      },
      { idempotencyKey: randomUUID(), requestId: randomUUID(), deadline: Date.now() - 1 },
    ),
  ).rejects.toThrow();
});

test('media reservation uses the same native command clock with real account and parent checks', async () => {
  now = at;
  const actor = await fixture.access.authenticate(bearer, { pool: db.pool, deadline: Date.now() + 10_000 });
  const reserved = await reserveMedia(
    { pool: db.pool, access: fixture.access, ...{ clock } },
    actor,
    {
      containerId: thread.id,
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 256,
    },
    { idempotencyKey: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 10_000 },
  );
  const stored = await db.admin.query('SELECT created_at FROM content.media WHERE route=$1 AND media_id=$2', [
    thread.route,
    reserved.value.mediaId,
  ]);
  expect(stored.rows[0].created_at.getTime()).toBe(at);
});

test('fixed native command and actual pages retain their bounds at three informative scales', async () => {
  now = at;
  const bytes = Buffer.from(JSON.stringify(body));
  const digest = createHash('sha256').update(bytes).digest();
  const population: Population = {
    name: 'kernel-clock-content',
    hotPartition: partitionOf(thread.route),
    hotShare: 1,
    rows() {
      const postId = newId(thread.route),
        mediaId = newId(thread.route),
        revisionId = newId(thread.route),
        transaction = randomUUID();
      const accountId = newId(routeOf(actor.accountId)!);
      const principal = { subject_id: accountId, valid: '(,)', transaction_id: transaction };
      return {
        'content.board': [
          {
            route: routeOf(boardId),
            board_id: newId(routeOf(boardId)!),
            subject_id: subjectId,
            title: 'Neighbour',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transaction,
          },
        ],
        'content.thread': [
          {
            route: thread.route,
            thread_id: newId(thread.route),
            author_account_id: actor.accountId,
            board_id: boardId,
            title: 'Neighbour',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transaction,
          },
        ],
        'content.post': [
          {
            route: thread.route,
            thread_id: thread.id,
            post_id: postId,
            author_account_id: actor.accountId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transaction,
          },
        ],
        'content.revision': [
          {
            route: thread.route,
            thread_id: thread.id,
            post_id: postId,
            revision_id: revisionId,
            body: bytes,
            body_sha256: digest,
            search_text: 'Clock',
            licence: 'MIT',
            subject_ids: [],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: transaction,
          },
          {
            route: thread.route,
            thread_id: thread.id,
            post_id: thread.firstPost.id,
            revision_id: newId(thread.route),
            body: bytes,
            body_sha256: digest,
            search_text: 'Clock',
            licence: 'MIT',
            subject_ids: [],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: transaction,
          },
        ],
        'content.media': [
          {
            route: thread.route,
            media_id: mediaId,
            uploader_id: actor.accountId,
            container_id: thread.id,
            reservation_request_id: randomUUID(),
            purpose: 'post-image',
            media_type: 'image/png',
            byte_count: 256,
            key: `m/${mediaId}/original`,
            state: 'reserved',
            transaction_id: transaction,
          },
        ],
        'content.media_variant': [
          {
            route: thread.route,
            media_id: mediaId,
            format: 'webp',
            width: 320,
            height: 320,
            media_type: 'image/webp',
            byte_count: 256,
            sha256: digest.toString('hex'),
            key: `m/${mediaId}/webp-320`,
            transaction_id: transaction,
          },
        ],
        'access.account': [
          {
            route: routeOf(accountId),
            account_id: accountId,
            kind: 'actor',
            state: 'active',
            transaction_id: transaction,
          },
        ],
        'access.membership_inverse': [
          {
            route: routeOf(accountId),
            account_id: accountId,
            kind: 'organization',
            group_id: newId(thread.route),
            reservation_id: accountId,
            transaction_id: transaction,
          },
        ],
        'access.resource_grant': [{ route: thread.route, resource_id: thread.id, action: 'post:create', ...principal }],
        'access.resource_role_grant': [
          { route: thread.route, resource_id: thread.id, grant_role: 'content.thread.owner', ...principal },
        ],
        'access.resource_denial': [
          { route: thread.route, resource_id: thread.id, action: 'post:create', reason: 'resource', ...principal },
        ],
        'access.resource_initialization': [
          {
            route: thread.route,
            resource_id: mediaId,
            resource_type: 'content.media',
            creator_id: actor.accountId,
            initialized_at: new Date(at),
          },
        ],
        'core.receipt': [
          {
            partition_no: partitionOf(thread.route),
            principal_kind: 'account',
            principal_id: actor.accountId,
            command_kind: 'content.media.reserve',
            idempotency_key: transaction,
            request_digest: digest,
            epoch: 1,
            position: 1,
            transaction_id: transaction,
            response: { mediaId },
          },
        ],
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'kernel clock native command and content pages',
    scales: [256, 2048, 16384],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(database, population, { from: previous * 2, to: scale * 2 });
    },
    async operation() {
      const result = await call(app, 'POST', `/v1/threads/${thread.id}/posts`, input);
      expect(result.response.status).toBe(201);
      const actor = await fixture.access.authenticate(bearer, { pool: db.pool, deadline: Date.now() + 10_000 });
      await reserveMedia(
        { pool: db.pool, access: fixture.access, ...{ clock } },
        actor,
        {
          containerId: thread.id,
          purpose: 'post-image',
          mediaType: 'image/png',
          byteCount: 256,
        },
        { idempotencyKey: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 10_000 },
      );
      for (const path of [
        `/v1/threads/${thread.id}/posts?limit=1`,
        `/v1/posts/${thread.firstPost.id}/revisions?limit=1`,
      ]) {
        const page = await call(app, 'GET', path);
        expect(page.response.status).toBe(200);
        expect(page.value.next).toBeString();
      }
    },
  });
  for (const { cost } of report.samples) {
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.statements).toBeGreaterThan(0);
    for (const [relation, value] of Object.entries(cost.relations ?? {}))
      if (relation.startsWith('content.')) expect(value.sequentialScans).toBe(0);
  }
  const observed = await capture(db, () => call(app, 'POST', `/v1/threads/${thread.id}/posts`, input));
  expect(observed.value.response.status).toBe(201);
  expect(
    observed.capture.statements.filter((sql) => sql.includes('INSERT INTO access.write_rate_counter')),
  ).toHaveLength(1);
  console.info(JSON.stringify(report));
});
