import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { isProblemSchema, openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import resourceRoles from '../../src/access/resource-roles.json';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';
import { seedReportGrowth, type ReportGrowthRow } from './support/report-growth.ts';

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
    fixture = await standingFixture([
      'realm:read',
      'realm:manage',
      'realm:ban',
      'realm:publish',
      'realm:participate',
      'realm:join',
      'board:create',
      'account:read',
    ]);
    const catalogue = resourceRoleCatalogue(fixture.access);
    if (!catalogue) throw new Error('Fixture Access has no resource role catalogue');
    const roles = catalogue.roles as Map<string, readonly string[]>;
    for (const [role, actions] of Object.entries(resourceRoles.roles))
      if (role.startsWith('community.realm.')) roles.set(role, actions);
    (catalogue.types as Map<string, Readonly<{ owner?: string; standing: readonly string[] }>>).set(
      'community.realm',
      resourceRoles.types['community.realm'],
    );
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
    await fixture.grant(fixture.actor, 'board:read', { route: routeOf(boardId)!, id: boardId });
    // Author erasure initiation requires the initiator's own account read as well as post:erase.
    await fixture.grant(fixture.actor, 'account:read', { route: routeOf(fixture.actor)!, id: fixture.actor });
  });
  afterAll(async () => {
    await fixture?.close();
    await db?.close();
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    key: string = randomUUID(),
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
  async function create(text = 'Authored erasure sentinel', targetBoard = boardId) {
    const result = await call('POST', '/v1/threads', {
      title: 'Erasure title sentinel',
      body: snapshot(text),
      licence: 'MIT',
      subjectIds: [],
      boardId: targetBoard,
      visibility: 'published',
    });
    expect(result.response.status).toBe(201);
    return result.body.thread;
  }
  async function createRealmBoard(title: string) {
    const route = 0x4321;
    const spaceId = newId(route);
    const spaceRevisionId = newId(route);
    const realmId = newId(route);
    const realmRevisionId = newId(route);
    const realmBoardId = newId(route);
    const transactionId = randomUUID();
    const createdAt = new Date().toISOString();
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(
        `INSERT INTO community.space (route,space_id,state,head_revision_id,created_at,creator)
         VALUES ($1,$2,'active',$3,$4,$5)`,
        [route, spaceId, spaceRevisionId, createdAt, fixture.actor],
      );
      await client.query(
        `INSERT INTO community.space_revision
         (route,space_id,revision_id,predecessor,title,summary,created_at,author)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`,
        [route, spaceId, spaceRevisionId, `${title} host`, `${title} host`, createdAt, fixture.actor],
      );
      await client.query(
        `INSERT INTO community.realm
         (route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
         VALUES ($1,$2,$3,'active','public',$4,$5,$6,$7)`,
        [route, realmId, spaceId, GLOBAL_CONTEXT, realmRevisionId, createdAt, fixture.actor],
      );
      await client.query(
        `INSERT INTO community.realm_revision
         (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
         VALUES ($1,$2,$3,NULL,$4,$5,'public',$6,$7,$8)`,
        [route, realmId, realmRevisionId, title, `${title} summary`, GLOBAL_CONTEXT, createdAt, fixture.actor],
      );
      await client.query(
        `INSERT INTO access.resource_initialization (route,resource_id,resource_type,creator_id,initialized_at)
         VALUES ($1,$2,'community.realm',$3,$4)`,
        [route, realmId, fixture.actor, createdAt],
      );
      await client.query(
        `INSERT INTO access.resource_role_grant
         (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
         VALUES ($1,$2,'identity',$3,'','community.realm.owner','(,)',$4)`,
        [route, realmId, fixture.actor, transactionId],
      );
      await client.query(
        `INSERT INTO content.board
         (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id,realm_id)
         VALUES ($1,$2,$3,$4,'published',1,$5,$6)`,
        [route, realmBoardId, newId(route), `${title} board`, transactionId, realmId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const realmRoute = routeOf(realmId)!;
    await fixture.grant(fixture.actor, 'realm:participate', { route: realmRoute, id: realmId });
    await grant(realmBoardId, 'board:read', fixture.actor);
    await grant(realmBoardId, 'thread:create', fixture.actor);
    return { realmId, route: realmRoute, boardId: realmBoardId };
  }
  async function grantRealmRole(
    realmId: string,
    accountId: string,
    role: 'community.realm.member' | 'community.realm.moderator',
  ) {
    const result = await call('POST', '/v1/roleGrants', {
      resource: { route: routeOf(realmId)!, id: realmId },
      subject: { kind: 'account', id: accountId },
      role,
      valid: '(,)',
    });
    expect(result.response.status).toBe(201);
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

  test('Realm owners and moderators can take down only content in their Realm', async () => {
    const realmA = await createRealmBoard('Moderation Realm A');
    const realmB = await createRealmBoard('Moderation Realm B');
    await grantRealmRole(realmA.realmId, fixture.principal, 'community.realm.moderator');
    await grantRealmRole(realmA.realmId, fixture.recipient, 'community.realm.member');

    const ownerThread = await create('Realm owner target', realmA.boardId);
    const ownerThreadTakedown = await call(
      'POST',
      `/v1/threads/${ownerThread.id}:takeDown`,
      reason,
      undefined,
      fixture.actor,
    );
    expect(ownerThreadTakedown.response.status).toBe(200);
    const ownerPostTakedown = await call(
      'POST',
      `/v1/posts/${ownerThread.firstPost.id}:takeDown`,
      reason,
      undefined,
      fixture.actor,
    );
    expect(ownerPostTakedown.response.status).toBe(200);

    const moderatorThread = await create('Realm moderator target', realmA.boardId);
    const memberThread = await create('Realm member target', realmA.boardId);
    for (const target of [memberThread.id, memberThread.firstPost.id]) {
      const denied = await call(
        'POST',
        `/v1/${target === memberThread.id ? 'threads' : 'posts'}/${target}:takeDown`,
        reason,
        undefined,
        fixture.recipient,
      );
      expect(denied.response.status).toBe(403);
    }
    const moderatorThreadTakedown = await call(
      'POST',
      `/v1/threads/${moderatorThread.id}:takeDown`,
      reason,
      undefined,
      fixture.principal,
    );
    expect(moderatorThreadTakedown.response.status).toBe(200);
    const moderatorPostTakedown = await call(
      'POST',
      `/v1/posts/${moderatorThread.firstPost.id}:takeDown`,
      reason,
      undefined,
      fixture.principal,
    );
    expect(moderatorPostTakedown.response.status).toBe(200);

    const outsideThread = await create('Realm B readable target', realmB.boardId);
    await grant(realmB.realmId, 'realm:read', fixture.principal);
    for (const [id, action] of [
      [realmB.boardId, 'board:read'],
      [outsideThread.id, 'thread:read'],
      [outsideThread.firstPost.id, 'post:read'],
    ] as const)
      await grant(id, action, fixture.principal);
    for (const [kind, id] of [
      ['threads', outsideThread.id],
      ['posts', outsideThread.firstPost.id],
    ] as const) {
      const denied = await call('POST', `/v1/${kind}/${id}:takeDown`, reason, undefined, fixture.principal);
      expect(denied.response.status).toBe(403);
    }
    const readableThread = await call(
      'GET',
      `/v1/threads/${outsideThread.id}`,
      undefined,
      undefined,
      fixture.principal,
    );
    expect(readableThread.response.status).toBe(200);
    expect(readableThread.body.thread.visibility).toBe('published');
    const readablePost = await call(
      'GET',
      `/v1/posts/${outsideThread.firstPost.id}`,
      undefined,
      undefined,
      fixture.principal,
    );
    expect(readablePost.response.status).toBe(200);
    expect(readablePost.body.post.visibility).toBe('published');
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
        sha256: null,
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
    const realm = await createRealmBoard('Growth measurement Realm');
    await grantRealmRole(realm.realmId, fixture.principal, 'community.realm.moderator');
    // One warm-up and five measured commands per scale, all starting published at revision 1.
    // Prepare every target before the first scale so target creation is not another growth axis.
    const thread = await create('Fixed measured content', realm.boardId);
    const targets: { id: string; route: number }[] = [thread];
    const templateThread = (
      await db.admin.query('SELECT * FROM content.thread WHERE route=$1 AND thread_id=$2', [thread.route, thread.id])
    ).rows[0]!;
    const templatePost = (
      await db.admin.query('SELECT * FROM content.post WHERE route=$1 AND post_id=$2', [
        thread.route,
        templateThread.first_post_id,
      ])
    ).rows[0]!;
    const templateRevision = (
      await db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2', [
        thread.route,
        templatePost.head_revision_id,
      ])
    ).rows[0]!;
    const templateInitializations = (
      await db.admin.query(
        'SELECT * FROM access.resource_initialization WHERE route=$1 AND resource_id=ANY($2::uuid[])',
        [thread.route, [thread.id, templatePost.post_id]],
      )
    ).rows;
    const templateRoles = (
      await db.admin.query(
        `SELECT route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id
         FROM access.resource_role_grant WHERE route=$1 AND resource_id=ANY($2::uuid[])`,
        [thread.route, [thread.id, templatePost.post_id]],
      )
    ).rows;
    // Clone native fixture state administratively; preparing spare targets must not consume write admission.
    await seed(
      db,
      {
        name: 'moderation-http-spares',
        hotPartition: thread.route >>> 4,
        hotShare: 1,
        rows() {
          const threadId = newId(thread.route);
          const postId = newId(thread.route);
          const revisionId = newId(thread.route);
          const transaction = randomUUID();
          const ids = new Map([
            [thread.id, threadId],
            [templatePost.post_id, postId],
          ]);
          targets.push({ id: threadId, route: thread.route });
          const identity = { thread_id: threadId, recorded_transaction_id: transaction };
          return {
            'content.thread': [{ ...templateThread, ...identity, first_post_id: postId }],
            'content.post': [{ ...templatePost, ...identity, post_id: postId, head_revision_id: revisionId }],
            'content.revision': [{ ...templateRevision, ...identity, post_id: postId, revision_id: revisionId }],
            'access.resource_initialization': templateInitializations.map((row) => ({
              ...row,
              resource_id: ids.get(row.resource_id)!,
            })),
            'access.resource_role_grant': templateRoles.map((row) => ({
              ...row,
              resource_id: ids.get(row.resource_id)!,
              transaction_id: transaction,
            })),
          };
        },
      },
      { from: 0, to: 17 },
    );
    const bytes = Buffer.from(JSON.stringify(snapshot('Unrelated distractor bytes')));
    const digest = createHash('sha256').update(bytes).digest();
    const report = await checkGrowth(db, {
      name: 'Realm-authorized moderation HTTP point command including current Access and same-partition history',
      scales: [32, 256, 2048],
      rule: 'series',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        // Start content, ACL and command history at 2,048 rows. Otherwise the tiny receipt
        // relation scans one more preceding command per run, confounding scale with write history.
        const commandRows: ReportGrowthRow[] = [];
        await seed(
          database,
          {
            name: 'moderation-http-history',
            hotPartition: thread.route >>> 4,
            hotShare: 1,
            rows({ ordinal }) {
              const historyThread = targets[ordinal % targets.length]!;
              const postId = newId(thread.route);
              const revisionId = newId(thread.route);
              const transaction = randomUUID();
              commandRows.push({
                reportId: newId(thread.route),
                reportRoute: thread.route,
                targetKind: 'post',
                targetId: postId,
                targetRoute: thread.route,
                createdAt: '2026-01-01T00:00:00.000Z',
                transactionId: transaction,
                idempotencyKey: randomUUID(),
                reporterAccountId: fixture.principal,
              });
              const metadata = {
                route: thread.route,
                author_account_id: fixture.actor,
                visibility: 'published',
                security_revision: 1,
                recorded_transaction_id: transaction,
              };
              return {
                'content.thread': [
                  {
                    ...metadata,
                    thread_id: newId(thread.route),
                    board_id: realm.boardId,
                    title: 'Unrelated thread',
                    first_post_id: null,
                  },
                ],
                'content.post': [
                  {
                    ...metadata,
                    thread_id: historyThread.id,
                    post_id: postId,
                    head_revision_id: revisionId,
                  },
                ],
                'content.revision': [
                  {
                    route: thread.route,
                    thread_id: historyThread.id,
                    post_id: postId,
                    revision_id: revisionId,
                    body: bytes,
                    body_sha256: digest,
                    search_text: 'Unrelated distractor bytes',
                    licence: 'MIT',
                    subject_ids: [],
                    board_id: realm.boardId,
                    availability: 'available',
                    recorded_transaction_id: transaction,
                  },
                ],
                'access.resource_grant': [
                  {
                    route: thread.route,
                    resource_id: postId,
                    subject_id: fixture.principal,
                    action: 'moderation:takedown',
                    valid: '(,)',
                    transaction_id: transaction,
                  },
                ],
              };
            },
          },
          { from: previous * 64, to: scale * 64 },
        );
        await seedReportGrowth(database.admin, commandRows, [], {
          projectTargets: false,
          commandEvents: { principalId: fixture.principal, principalKind: 'account', clientId: 'web' },
        });
      },
      async operation(_database, scale, repetition) {
        const result = await call(
          'POST',
          `/v1/threads/${targets[repetition]!.id}:takeDown`,
          reason,
          `growth-${scale}-${repetition}`,
          fixture.principal,
        );
        expect(result.response.status).toBe(200);
        expect(result.body.securityRevision).toMatch(/^[1-9][0-9]*$/);
        expect(result.body.securityRevision).toBe('2');
      },
    });
    expect(report.rule).toBe('series');
    expect(report.samples.map(({ scale }) => scale)).toEqual([32, 256, 2048]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.statements).toBeLessThanOrEqual(4096);
      expect(cost.rows).toBeGreaterThan(0);
      expect((cost as typeof cost & { plans: number }).plans).toBeGreaterThan(0);
    }
    console.info(JSON.stringify(report));
  });
});
