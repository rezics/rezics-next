import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(17);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(18)]]) };
const snapshot = (text: string) =>
  normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'moderation-paragraph' }, content: [{ type: 'text', text }] }],
    },
  });

// These assertions exercise the shared Access implementation, including the
// built-in content owner roles. Auth issuance is the existing standing fixture.
describe('moderation HTTP with migrated storage and current Access', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let fixture: Awaited<ReturnType<typeof standingFixture>>;
  let app: ReturnType<typeof createKernel>;
  const credentials = new Map<string, string>();
  const boardId = newId(0x4321);
  const reason = { reason: 'Policy violation' };

  beforeAll(async () => {
    db = await openGrowthDatabase();
    fixture = await standingFixture();
    await fixture.reset();
    const authenticate = fixture.access.authenticate;
    let issued = '';
    fixture.access.authenticate = (token, boundary) => {
      issued = token;
      return authenticate(token, { ...boundary, pool: db.pool });
    };
    try {
      for (const id of [fixture.actor, fixture.principal, fixture.recipient]) {
        await fixture.context(id);
        credentials.set(id, issued);
      }
    } finally {
      fixture.access.authenticate = authenticate;
    }
    app = createKernel({
      pool: db.pool,
      routeKey,
      tokens,
      access: fixture.access,
      writeRate: createWriteRateLimiter({ secret: 'moderation-http-fixture-secret-at-least-32-bytes' }),
    });
    await db.admin.query(
      `INSERT INTO content.board
       (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,'Moderation board','published',1,$4)`,
      [routeOf(boardId), boardId, newId(0x6789), randomUUID()],
    );
    await fixture.grant(fixture.actor, 'thread:create', { route: routeOf(boardId)!, id: boardId });
  });
  afterAll(async () => {
    await fixture?.close();
    await db?.close();
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    key = randomUUID(),
    account: string | null = fixture.actor,
  ) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(account === null ? {} : { authorization: `Bearer ${credentials.get(account)}` }),
          ...(method === 'POST' ? { 'idempotency-key': JSON.stringify(key) } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { response, body: await response.json() };
  }
  async function create(text = 'Authored erasure sentinel') {
    const result = await call('POST', '/v1/threads', {
      title: 'Erasure title sentinel',
      body: snapshot(text),
      licence: 'MIT',
      subjectIds: [],
      boardId,
      visibility: 'published',
    });
    expect(result.response.status).toBe(201);
    return result.body.thread;
  }
  async function grant(id: string, action: string, subject = fixture.principal) {
    await fixture.grant(subject, action, { route: routeOf(id)!, id });
  }
  async function effects() {
    // Administrative inspection is outside the measured production request.
    return Promise.all(
      ['content.thread', 'content.post', 'content.revision', 'core.receipt', 'core.outbox'].map(
        async (table) =>
          (await db.admin.query(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows,
      ),
    );
  }

  test('AIP takedown and erasure methods use shared helper and current authorization', async () => {
    const document = openApiDocument(app);
    const actions = actionCatalogue(app);
    for (const kind of ['boards', 'threads', 'posts']) {
      const internal = customMethod(`/v1/${kind}/:id`, 'takeDown');
      expect(app.routes.filter((route) => route.method === 'POST' && route.path === internal)).toHaveLength(1);
      const operation = document.paths[`/v1/${kind}/{id}:takeDown`]?.post;
      expect(operation?.['x-action']).toBe('moderation:takedown');
      expect(operation?.['x-rate-limit']).toEqual({ family: 'write', units: 1 });
      for (const status of [400, 401, 403, 404, 422, 429, 500, 503]) {
        expect(
          isProblemSchema(
            operation?.responses?.[status]?.content?.['application/problem+json']?.schema,
            document.components.schemas,
          ),
        ).toBe(true);
      }
    }
    expect(actions.get('moderation:takedown')?.anonymous).toBe(false);
    expect(actions.get('post:erase')?.anonymous).toBe(false);
    expect(actions.get('account:read')?.anonymous).toBe(false);
    for (const kind of ['threads', 'posts']) {
      expect(document.paths[`/v1/${kind}/{id}:erase`]?.post?.['x-action']).toBe('post:erase');
    }
    expect(document.paths['/v1/operations/{id}']?.get?.['x-action']).toBe('account:read');
    expect(Object.keys(document.paths).some((path) => path.includes('/$takeDown') || path.includes('/$erase'))).toBe(
      false,
    );

    const thread = await create();
    const postId = thread.firstPost.id;
    await grant(postId, 'moderation:takedown');
    const path = `/v1/posts/${postId}:takeDown`;
    const before = await effects();
    for (const body of [
      { ...reason, actorId: fixture.principal },
      { ...reason, action: 'post:erase' },
    ]) {
      const spoof = await call('POST', path, body, undefined, fixture.principal);
      expect(spoof.response.status).toBe(400);
      expect(spoof.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applied' });
      expect(spoof.response.headers.get(SESSION_HEADER)).toBeNull();
    }
    expect(await effects()).toEqual(before);
    // The author's post owner role includes erase, never moderation authority.
    for (const account of [fixture.actor, fixture.recipient]) {
      const denied = await call('POST', path, reason, undefined, account);
      expect(denied.response.status).toBe(403);
      expect(denied.response.headers.get(SESSION_HEADER)).toBeNull();
    }
    const internal = await call('POST', `/v1/posts/${postId}/$takeDown`, reason, undefined, fixture.principal);
    expect(internal.response.status).toBe(404);
    const result = await call('POST', path, reason, undefined, fixture.principal);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ securityRevision: expect.stringMatching(/^[1-9][0-9]*$/) });
    expect(result.response.headers.get(SESSION_HEADER)).toBeTruthy();
  });

  test('revoked replay returns no stored response', async () => {
    const thread = await create();
    await grant(thread.id, 'moderation:takedown');
    const path = `/v1/threads/${thread.id}:takeDown`;
    const key = randomUUID();
    const first = await call('POST', path, reason, key, fixture.principal);
    expect(first.response.status).toBe(200);
    const committed = await effects();
    const replay = await call('POST', path, reason, key, fixture.principal);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(await effects()).toEqual(committed);
    await db.admin.query(
      "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='moderation:takedown'",
      [thread.route, thread.id, fixture.principal],
    );
    const denied = await call('POST', path, reason, key, fixture.principal);
    expect(denied.response.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'forbidden', effect_status: 'not_applied' });
    expect(denied.body).not.toHaveProperty('securityRevision');
    expect(denied.response.headers.get(SESSION_HEADER)).toBeNull();
    expect(await effects()).toEqual(committed);
  });

  test('authorized exact erased revisions survive as tombstones without bytes', async () => {
    const thread = await create();
    const post = thread.firstPost;
    const revised = await call('POST', `/v1/posts/${post.id}/revisions`, { body: snapshot('Second erased sentinel') });
    expect(revised.response.status).toBe(200);
    const unrelated = await create('Unrelated retained sentinel');
    const erase = await call('POST', `/v1/posts/${post.id}:erase`, { reason: 'Author request' });
    expect(erase.response.status).toBe(200);
    expect(erase.response.headers.get(SESSION_HEADER)).toBeTruthy();
    await grant(thread.id, 'moderation:takedown');
    await grant(thread.id, 'thread:read');
    await grant(post.id, 'post:read');
    await grant(boardId, 'board:read');
    expect(
      (await call('POST', `/v1/threads/${thread.id}:takeDown`, reason, undefined, fixture.principal)).response.status,
    ).toBe(200);
    for (const revision of [post, revised.body.post]) {
      const path = `/v1/posts/${post.id}/revisions/${revision.revisionId}`;
      const exact = await call('GET', path, undefined, undefined, fixture.principal);
      expect(exact.response.status).toBe(200);
      expect(exact.body.post).toMatchObject({
        id: post.id,
        revisionId: revision.revisionId,
        sha256: revision.sha256,
        body: null,
        availability: 'erased',
      });
      expect(JSON.stringify(exact.body)).not.toContain('sentinel');
      const hidden = await call('GET', path, undefined, undefined, null);
      const missing = await call('GET', `/v1/posts/${newId(thread.route)}`, undefined, undefined, null);
      expect(hidden.response.status).toBe(404);
      expect({ ...hidden.body, request_id: null }).toEqual({ ...missing.body, request_id: null });
      expect(hidden.response.headers.get(SESSION_HEADER)).toBeNull();
    }
    expect((await call('GET', `/v1/posts/${unrelated.firstPost.id}`)).body.post.body).toEqual(unrelated.firstPost.body);
  });

  test('author erasure initiation returns a bounded Operation and anonymous status is concealed', async () => {
    const thread = await create();
    const initiated = await call('POST', `/v1/threads/${thread.id}:erase`, { authorId: fixture.actor });
    expect(initiated.response.status).toBe(202);
    expect(initiated.response.headers.get(SESSION_HEADER)).toBeTruthy();
    expect(initiated.body).toMatchObject({
      name: expect.stringMatching(/^operations\//),
      done: false,
      metadata: {
        type: 'content.author_erasure',
        threadId: thread.id,
        authorId: fixture.actor,
        processedPosts: 0,
        erasedRevisions: 0,
        steps: 0,
      },
    });
    expect(initiated.body.metadata).not.toHaveProperty('total');
    expect(initiated.body).not.toHaveProperty('response');
    expect(initiated.body).not.toHaveProperty('error');
    const status = await call('GET', `/v1/${initiated.body.name}`, undefined, undefined, null);
    expect(status.response.status).toBe(404);
    expect(status.body).toMatchObject({ code: 'not_found', effect_status: 'not_applicable' });
    expect(status.response.headers.get(SESSION_HEADER)).toBeNull();
  });

  test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
    const thread = await create('Fixed measured content');
    await grant(thread.id, 'moderation:takedown');
    const bytes = Buffer.from(JSON.stringify(snapshot('Unrelated distractor bytes')));
    const digest = createHash('sha256').update(bytes).digest();
    const report = await checkGrowth(db, {
      name: 'moderation HTTP exact target including current Access and same-partition history',
      scales: [32, 256, 2048],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        // The one grow method populates hot-partition content and ACL relations.
        // Seeding and native statistics maintenance are outside measurement.
        const client = await database.admin.connect();
        try {
          await client.query('BEGIN');
          for (let ordinal = previous; ordinal < scale; ordinal++) {
            const postId = newId(thread.route);
            const revisionId = newId(thread.route);
            const transaction = randomUUID();
            await client.query(
              `INSERT INTO content.post
               (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
               VALUES ($1,$2,$3,$4,$5,'published',1,$6)`,
              [thread.route, thread.id, postId, fixture.actor, revisionId, transaction],
            );
            await client.query(
              `INSERT INTO content.revision
               (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
               VALUES ($1,$2,$3,$4,$5,$6,'Unrelated distractor bytes','MIT','{}',$7,'available',$8)`,
              [thread.route, thread.id, postId, revisionId, bytes, digest, boardId, transaction],
            );
            await client.query(
              `INSERT INTO access.resource_grant
               (route,resource_id,subject_id,action,valid,transaction_id)
               VALUES ($1,$2,$3,'moderation:takedown','(,)',$4)`,
              [thread.route, postId, fixture.principal, transaction],
            );
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await database.admin.query('VACUUM (ANALYZE) content.post, content.revision, access.resource_grant');
      },
      async operation(_database, scale, repetition) {
        const result = await call(
          'POST',
          `/v1/threads/${thread.id}:takeDown`,
          reason,
          `growth-${scale}-${repetition}`,
          fixture.principal,
        );
        expect(result.response.status).toBe(200);
        expect(result.body.securityRevision).toMatch(/^[1-9][0-9]*$/);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.plans).toBeGreaterThan(0);
    }
    console.info(JSON.stringify(report));
  });
});
