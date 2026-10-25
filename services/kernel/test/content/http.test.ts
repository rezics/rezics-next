import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { PROBLEMS, problemResponse, ProblemError } from '../../src/http/problem.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const actor: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: newId(0x5678),
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
// Only transport uses this narrow fixture. Persona outcomes require the real Auth/Access driver.
const access: Access = {
  async authenticate() {
    return actor;
  },
  async authorize() {
    return true;
  },
};
const contractPool = createPool('postgres://kernel.invalid/content-contract');
afterAll(() => contractPool.end());
const kernel = () => createKernel({ pool: contractPool, routeKey, tokens, access });
const routes = [
  ['POST', '/v1/threads', 'thread:create', 201],
  ['GET', '/v1/threads/:id', 'thread:read', 200],
  ['POST', '/v1/threads/:id/posts', 'post:create', 201],
  ['GET', '/v1/threads/:id/posts', 'post:read', 200],
  ['GET', '/v1/posts/:id', 'post:read', 200],
  ['POST', '/v1/posts/:id/revisions', 'post:revise', 200],
  ['GET', '/v1/posts/:id/revisions', 'post:read', 200],
  ['GET', '/v1/posts/:id/revisions/:revisionId', 'post:read', 200],
  ['GET', '/v1/boards/:id', 'board:read', 200],
] as const;

test('content HTTP mounts thread post reply and revision operations once with generated typed contracts', () => {
  for (const app of [kernel(), kernel()]) {
    const document = openApiDocument(app);
    const actions = actionCatalogue(app);
    for (const [method, path, action, success] of routes) {
      expect(app.routes.filter((route) => route.method === method && route.path === path)).toHaveLength(1);
      const operation = document.paths[path.replace(/:([^/]+)/g, '{$1}')]?.[method.toLowerCase()];
      expect(operation).toBeDefined();
      expect(operation?.['x-action']).toBe(action);
      expect(operation?.operationId).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
      expect(operation?.responses?.[success]?.content?.['application/json']?.schema).toBeDefined();
      expect(actions.get(action)?.anonymous).toBe(method === 'GET');
      if (method === 'POST') {
        expect(operation?.operationId).toBe(action.replace(':', '.'));
        expect(operation?.['x-rate-limit']).toEqual({ family: 'write', units: 1 });
      }
    }
    expect(actions.has('subject:create')).toBe(true);
    expect(actions.has('subject:read')).toBe(true);
  }
});

test('every route has real action schema and RFC9457 errors', () => {
  const document = openApiDocument(kernel());
  for (const [method, path] of routes) {
    const operation = document.paths[path.replace(/:([^/]+)/g, '{$1}')]?.[method.toLowerCase()];
    expect(operation).toBeDefined();
    const responses = operation!.responses!;
    for (const status of method === 'POST' ? [400, 401, 403, 404, 413, 422, 500, 503] : [400, 401, 404, 500, 503]) {
      const schema = responses[status]?.content?.['application/problem+json']?.schema;
      expect(isProblemSchema(schema, document.components.schemas)).toBe(true);
    }
    if (method === 'POST') {
      const body = operation!.requestBody?.content?.['application/json']?.schema;
      expect(body).toBeDefined();
      expect(JSON.stringify(body)).toContain('additionalProperties');
      expect(operation!.security).toEqual([{ bearerAuth: [] }]);
    } else {
      expect(operation!.security).toContainEqual({});
    }
  }
});

test('shared oversized content problem has the approved nonretryable 413 contract', async () => {
  expect(PROBLEMS).toHaveProperty('content_too_large', {
    status: 413,
    title: 'Content Too Large',
    retryable: false,
  });
  const response = problemResponse(new ProblemError('content_too_large' as keyof typeof PROBLEMS), {
    method: 'POST',
    id: randomUUID(),
  });
  expect(response.status).toBe(413);
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  expect(await response.json()).toMatchObject({
    code: 'content_too_large',
    title: 'Content Too Large',
    retryable: false,
    effect_status: 'not_applied',
  });
});

const snapshot = (text: string) =>
  normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'http-paragraph' }, content: [{ type: 'text', text }] }],
    },
  });

describe('content HTTP with native database adapters', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let app: ReturnType<typeof createKernel>;
  const boardId = newId(0x4321);
  const subjectIds = [newId(0x6789)];
  const input = (text = 'HTTP canonical content') => ({
    title: 'HTTP thread',
    body: snapshot(text),
    licence: 'CC-BY-SA-4.0',
    subjectIds,
    boardId,
    visibility: 'published',
  });

  beforeAll(async () => {
    db = await openGrowthDatabase();
    app = createKernel({ pool: db.pool, routeKey, tokens, access });
    await db.admin.query(
      `INSERT INTO content.board
         (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'HTTP board', 'public', 1, $4)`,
      [routeOf(boardId), boardId, subjectIds[0], randomUUID()],
    );
  });
  afterAll(async () => {
    await db?.close();
  });

  async function call(method: string, path: string, body?: unknown, key: string = randomUUID(), authenticated = true) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(authenticated ? { authorization: 'Bearer content-http-fixture' } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { response, body: await response.json() };
  }

  async function create(text?: string, key?: string) {
    const result = await call('POST', '/v1/threads', input(text), key);
    expect(result.response.status).toBe(201);
    expect(result.response.headers.get('location')).toBe(`/v1/threads/${result.body.thread.id}`);
    expect(result.response.headers.get(SESSION_HEADER)).toBeTruthy();
    return result.body.thread;
  }

  async function effects() {
    // Inspection is outside measured operations, in the check runner's isolated file database.
    return Promise.all(
      ['content.thread', 'content.post', 'content.revision', 'core.receipt', 'core.outbox'].map(
        async (table) =>
          (await db.admin.query(`SELECT to_jsonb(row) AS value FROM ${table} AS row ORDER BY to_jsonb(row)::text`))
            .rows,
      ),
    );
  }

  test('canonical oversized body returns 413 without effects', async () => {
    const before = await effects();
    const result = await call('POST', '/v1/threads', input('x'.repeat(2 * 1024 * 1024)));
    expect(result.response.status).toBe(413);
    expect(result.body).toMatchObject({ code: 'content_too_large', retryable: false, effect_status: 'not_applied' });
    expect(result.response.headers.get('location')).toBeNull();
    expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
    expect(await effects()).toEqual(before);
  });

  test('native thread post reply and revisions retain exact stored metadata and body-only defaults', async () => {
    const thread = await create();
    expect((await call('GET', `/v1/boards/${boardId}`, undefined, undefined, false)).body.board.id).toBe(boardId);
    expect((await call('GET', `/v1/threads/${thread.id}`, undefined, undefined, false)).body.thread).toEqual(thread);
    const postInput = { body: snapshot('Post bytes'), licence: 'MIT', subjectIds: [], boardId };
    const postResult = await call('POST', `/v1/threads/${thread.id}/posts`, postInput);
    expect(postResult.response.status).toBe(201);
    const post = postResult.body.post;
    expect(post).toMatchObject({ ...postInput, authorId: actor.accountId, threadId: thread.id, parentId: null });
    const reply = await call('POST', `/v1/threads/${thread.id}/posts`, { ...postInput, parentId: post.id });
    expect(reply.response.status).toBe(201);
    expect(reply.body.post.parentId).toBe(post.id);
    const revised = await call('POST', `/v1/posts/${post.id}/revisions`, { body: snapshot('New bytes') });
    expect(revised.response.status).toBe(200);
    expect(revised.body.post).toMatchObject({ licence: 'MIT', subjectIds: [], boardId, body: snapshot('New bytes') });
    expect(revised.body.post.revisionId).not.toBe(post.revisionId);
    const exact = await call('GET', `/v1/posts/${post.id}/revisions/${post.revisionId}`);
    expect(exact.response.status).toBe(200);
    expect(exact.body.post).toEqual(post);
    const history = await call('GET', `/v1/posts/${post.id}/revisions?limit=1`);
    expect(history.response.status).toBe(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.next).toEqual(expect.any(String));
    const page = await call('GET', `/v1/threads/${thread.id}/posts?limit=1`);
    expect(page.response.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.next).toEqual(expect.any(String));
    expect((await call('GET', `/v1/threads/${thread.id}/posts?limit=101`)).response.status).toBe(400);
    const stored = await db.admin.query(
      'SELECT body, licence, subject_ids, board_id FROM content.revision WHERE route = $1 AND thread_id = $2 AND post_id = $3 AND revision_id = $4',
      [post.route, thread.id, post.id, post.revisionId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.parse(stored.rows[0].body.toString())).toEqual(post.body);
    expect(stored.rows[0]).toMatchObject({ licence: 'MIT', subject_ids: [], board_id: boardId });
  });

  test('replay hydrates the receipt revision through current disclosure after edit and erasure', async () => {
    const key = randomUUID();
    const thread = await create('Replay original sentinel', key);
    const path = `/v1/posts/${thread.firstPost.id}/revisions`;
    const revised = await call('POST', path, { body: snapshot('Replay current sentinel') });
    expect(revised.response.status).toBe(200);
    const beforeReplay = await effects();
    expect((await call('POST', '/v1/threads', input('Replay original sentinel'), key)).body.thread.firstPost).toEqual(
      thread.firstPost,
    );
    expect(await effects()).toEqual(beforeReplay);
    await db.admin.query(
      "UPDATE content.revision SET body = NULL, search_text = NULL, availability = 'erased' WHERE route = $1 AND thread_id = $2 AND post_id = $3",
      [thread.route, thread.id, thread.firstPost.id],
    );
    const erasedEffects = await effects();
    const replay = await call('POST', '/v1/threads', input('Replay original sentinel'), key);
    expect(replay.response.status).toBe(201);
    expect(replay.body.thread.firstPost).toMatchObject({
      id: thread.firstPost.id,
      revisionId: thread.firstPost.revisionId,
      availability: 'erased',
      body: null,
    });
    expect(JSON.stringify(replay.body)).not.toContain('Replay original sentinel');
    expect(await effects()).toEqual(erasedEffects);
  });

  test('spoof fields reject atomically and concealed resources match missing404 without session or location', async () => {
    const before = await effects();
    const spoof = await call('POST', '/v1/threads', { ...input(), authorId: actor.accountId });
    expect(spoof.response.status).toBe(400);
    expect(spoof.body.code).toBe('invalid_request');
    expect(await effects()).toEqual(before);
    const thread = await create();
    await db.admin.query("UPDATE content.thread SET visibility = 'taken_down' WHERE route = $1 AND thread_id = $2", [
      thread.route,
      thread.id,
    ]);
    const hidden = await call('GET', `/v1/threads/${thread.id}`, undefined, undefined, false);
    const missing = await call('GET', `/v1/threads/${newId(thread.route)}`, undefined, undefined, false);
    expect(hidden.response.status).toBe(404);
    expect(missing.response.status).toBe(404);
    expect({ ...hidden.body, request_id: null }).toEqual({ ...missing.body, request_id: null });
    for (const result of [hidden, missing]) {
      expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
      expect(result.response.headers.get('location')).toBeNull();
    }
  });

  test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
    const thread = await create('Fixed measured bytes');
    // The measured read includes production Access, including its anonymous eligibility checks.
    const reader = createKernel({ pool: db.pool, routeKey, tokens });
    const bytes = Buffer.from(JSON.stringify(snapshot('Unrelated seeded bytes')));
    const digest = createHash('sha256').update(bytes).digest();
    const report = await checkGrowth(db, {
      name: 'content HTTP bounded page with production Access and hot-partition distractors',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        // One seed method; setup and ANALYZE are deliberately outside capture.
        const client = await database.admin.connect();
        try {
          await client.query('BEGIN');
          for (let ordinal = previous; ordinal < scale; ordinal++) {
            const postId = newId(thread.route);
            const revisionId = newId(thread.route);
            const transaction = randomUUID();
            await client.query(
              `INSERT INTO content.post
                 (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision, recorded_transaction_id)
               VALUES ($1, $2, $3, $4, $5, 'public', 1, $6)`,
              [thread.route, thread.id, postId, actor.accountId, revisionId, transaction],
            );
            await client.query(
              `INSERT INTO content.revision
                 (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids, board_id, availability, recorded_transaction_id)
               VALUES ($1, $2, $3, $4, $5, $6, 'Unrelated seeded bytes', 'MIT', '{}', $7, 'available', $8)`,
              [thread.route, thread.id, postId, revisionId, bytes, digest, boardId, transaction],
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await database.admin.query('VACUUM (ANALYZE) content.post, content.revision');
      },
      async operation() {
        // This app and its actual Access use the observed db.pool; P=2 and H remain fixed.
        const response = await reader.handle(new Request(`http://kernel.test/v1/threads/${thread.id}/posts?limit=2`));
        expect(response.status).toBe(200);
        expect((await response.json()).items).toHaveLength(2);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.rows).toBeGreaterThan(0);
    }
    console.info(JSON.stringify(report));
  });
});
