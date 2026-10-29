import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, type AuthService } from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { createSubjectThreadEffect } from '../../src/content/subject-thread-index.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://global-boards.auth.test';
const audience = 'https://global-boards.api.test';
const password = 'global boards integration password with enough entropy';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
const accountRoute = 0x3456;
const provisioned = new Set<string>();
const global = { route: 0, id: GLOBAL_CONTEXT };
let db: GrowthDatabase;
let authPool: Pool;
let authDatabaseName = '';
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let author: Person;
let outsider: Person;
let conceptId: string;

type Person = { accountId: string; bearer: string };
type CallOptions = { bearer?: string | undefined; key?: string; headers?: Record<string, string>; body?: unknown };
type CallResult = { response: Response; value: Record<string, any> };
type Board = { id: string; route: number; realmId: null; purpose: string; visibility: string };

async function issue(email: string, scopes: string[]) {
  const signed = await service.handler(
    new Request(issuer + '/signin', {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'global-boards-client', scope: scopes }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(issuer + '/token', {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scopes: string[]): Promise<Person> {
  const accountId = newId(accountRoute);
  const email = name + '@global-boards.test';
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)",
    [routeOf(accountId), accountId],
  );
  provisioned.add(accountId);
  await service.internal.provisionPassword({ authorization: accountId, email, password });
  await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(accountId),
    accountId,
  ]);
  return { accountId, bearer: await issue(email, scopes) };
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  const headers = new Headers(options.headers);
  if (options.bearer) headers.set('authorization', 'Bearer ' + options.bearer);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request('http://kernel.test' + path, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, value: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function grant(accountId: string, action: string, resource = global) {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$3) ON CONFLICT DO NOTHING`,
    [resource.route, resource.id, accountId, action],
  );
}

async function createBoard(purpose: 'discussion' | 'reviews', visibility = 'published', key = crypto.randomUUID()) {
  return call('POST', '/v1/boards', {
    bearer: governance.bearer,
    key,
    body: { conceptId, title: 'Global ' + purpose, purpose, visibility },
  });
}

async function snapshot() {
  return (
    await db.admin.query(`SELECT
    (SELECT count(*) FROM content.board) AS boards,
    (SELECT count(*) FROM access.resource_initialization) AS initialized,
    (SELECT count(*) FROM access.resource_role_grant) AS roles,
    (SELECT count(*) FROM access.resource_grant) AS grants,
    (SELECT count(*) FROM core.receipt) AS receipts,
    (SELECT count(*) FROM core.outbox) AS events,
    (SELECT count(*) FROM editorial.write_basis) AS bases,
    (SELECT coalesce(sum(position),0) FROM core.partition) AS position`)
  ).rows[0];
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  authDatabaseName = 'global_boards_auth_' + process.pid;
  await db.admin.query('CREATE DATABASE ' + authDatabaseName);
  const authUrl = new URL(db.url);
  authUrl.pathname = '/' + authDatabaseName;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'global-boards',
    alg: 'ES256',
  };
  service = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'global-boards-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(db.pool, routeOf(id)!, id);
        return account
          ? {
              accountId: account.accountId,
              kind: account.kind,
              state: account.state,
              authnEpoch: Number(account.minimumAuthnEpoch),
              automated: account.operatorAccountId !== null,
            }
          : null;
      },
      async authorizeProvisioning(reference) {
        if (!provisioned.delete(reference)) throw new Error('No fixture provisioning approval');
        return { accountId: reference };
      },
    }),
  });

  kernel = createKernel({
    requestDeadlineMs: 30_000,
    pool: db.pool,
    routeKey,
    tokens,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: issuer + '/.well-known/jwks.json',
          fetch: async () => service.handler(new Request(issuer + '/.well-known/jwks.json')),
        },
      }),
    writeRate: createWriteRateLimiter({
      secret: 'global-boards-private-write-rate-secret-32bytes',
      overrides: JSON.stringify({
        anonymous: { write: { maximum: 100000, seconds: 86400 } },
        'new-account': { write: { maximum: 100000, seconds: 86400 } },
      }),
    }),
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  await service.internal.registerClient({ clientId: 'global-boards-client', firstParty: true, scopes });
  governance = await person('governance', scopes);
  author = await person('author', scopes);
  outsider = await person('outsider', scopes);
  await bootstrapGovernance(db.pool, governance.accountId);
  await bootstrapRelease(db.pool, bundledRelease);
  await grant(governance.accountId, 'subject:create');
  await grant(governance.accountId, 'board:create');
  const concept = await call('POST', '/v1/subjects', {
    bearer: governance.bearer,
    key: crypto.randomUUID(),
    body: { type: 'skos:Concept', labels: { en: 'Global board concept without a scheme' } },
  });
  expect(concept.response.status).toBe(201);
  conceptId = concept.value.subject.id;
  await db.admin.query(
    `INSERT INTO access.exposure_opening("group",valid,transaction_id)
    VALUES ('personal_library',tstzrange('2020-01-01T00:00:00Z',NULL,'[)'),$1)`,
    [newId(0)],
  );
}, 60_000);

afterAll(async () => {
  await authPool?.end();
  if (authDatabaseName) await dropTestDatabase(db.admin, authDatabaseName);
  await db?.close();
});

async function postThread(board: Board, kind: 'review' | 'discussion', voteCitation?: unknown) {
  const result = await call('POST', '/v1/threads', {
    bearer: author.bearer,
    key: crypto.randomUUID(),
    body: {
      boardId: board.id,
      title: 'Global ' + kind,
      kind,
      subjectIds: [conceptId],
      body: fromPlainText('A Global ' + kind),
      licence: 'MIT',
      visibility: 'published',
      ...(voteCitation ? { voteCitation } : {}),
    },
  });
  expect(result.response.status).toBe(201);
  const thread = result.value.thread;
  const events: CloudEvent[] = [];
  const isCreated = (event: CloudEvent) =>
    event.type === 'com.rezics.content.thread.created.v1' &&
    (event.data as { threadId: string }).threadId === thread.id;
  do {
    const batch = await readBatch(db.pool, {
      partition: partitionOf(routeOf(thread.id)!),
      consumer: 'global_boards_http',
      apply: async (envelopes) => {
        events.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    });
    expect(batch.status).toBe('read');
    if (batch.status === 'read') expect(batch.envelopes).toBeGreaterThan(0);
  } while (!events.some(isCreated));
  const event = events.find(isCreated)!;
  await createBoardEffect(db.pool).run(event);
  await createSubjectThreadEffect(db.pool).run(event);
  return thread;
}

test.serial(
  'a governance account creates published and protected Global boards over HTTP and authors post reviews and discussions on them',
  async () => {
    // Count the complete HTTP creation at exactly these existing Global board populations.
    const statements: number[] = [];
    for (const scale of [1, 64, 512]) {
      const count = Number(
        (await db.admin.query('SELECT count(*) AS n FROM content.board WHERE realm_id IS NULL')).rows[0].n,
      );
      const ids = Array.from({ length: scale - count }, () => newId(routeOf(conceptId)!));
      await db.admin.query(
        `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
      SELECT $1,id,$2,'Unrelated Global board','published',1,id FROM unnest($3::uuid[]) AS id`,
        [routeOf(conceptId), conceptId, ids],
      );
      expect(
        Number((await db.admin.query('SELECT count(*) AS n FROM content.board WHERE realm_id IS NULL')).rows[0].n),
      ).toBe(scale);
      const measured = await capture(db, () => createBoard('discussion'));
      expect(measured.value.response.status).toBe(201);
      statements.push(costOf(measured.capture).statements);
    }
    expect(statements[0]).toBeGreaterThan(0);
    expect(new Set(statements).size).toBe(1);

    const publishedResult = await createBoard('reviews');
    expect(publishedResult.response.status).toBe(201);
    const published = publishedResult.value.board as Board;
    const boardEvents: CloudEvent[] = [];
    do {
      await readBatch(db.pool, {
        partition: partitionOf(published.route),
        consumer: 'global_board_events',
        apply: async (envelopes) => {
          boardEvents.push(...envelopes.flatMap((envelope) => envelope.events));
        },
      });
    } while (!boardEvents.some((event) => event.subject === published.id));
    const boardEvent = boardEvents.find((event) => event.subject === published.id)!;
    expect(boardEvent.type).toBe('com.rezics.content.board.created.v1');
    expect(boardEvent.data).toEqual({ boardId: published.id, realmId: null, conceptId, actorId: governance.accountId });
    expect(Value.Check(CONTENT_EVENTS['com.rezics.content.board.created.v1'], boardEvent.data)).toBe(true);

    expect(published).toMatchObject({
      realmId: null,
      route: routeOf(conceptId),
      purpose: 'reviews',
      visibility: 'published',
    });
    expect(publishedResult.response.headers.get('location')).toBe('/v1/boards/' + published.id);
    const protectedResult = await createBoard('reviews', 'protected');
    expect(protectedResult.response.status).toBe(201);
    const protectedBoard = protectedResult.value.board as Board;
    expect(protectedBoard).toMatchObject({
      realmId: null,
      route: routeOf(conceptId),
      purpose: 'reviews',
      visibility: 'protected',
    });
    const discussionResult = await createBoard('discussion');
    expect(discussionResult.response.status).toBe(201);
    const discussionBoard = discussionResult.value.board as Board;
    const protectedDiscussionResult = await createBoard('discussion', 'protected');
    expect(protectedDiscussionResult.response.status).toBe(201);
    const protectedDiscussion = protectedDiscussionResult.value.board as Board;

    for (const board of [published, discussionBoard, protectedBoard, protectedDiscussion]) {
      await grant(author.accountId, 'thread:create', board);
      await grant(author.accountId, 'board:read', board);
    }
    const vote = await call('PUT', `/v1/subjects/${conceptId}/ratings/${STANDARD_QUESTION_ID}/vote`, {
      bearer: author.bearer,
      key: crypto.randomUUID(),
      body: { units: 16 },
    });
    expect(vote.response.status).toBe(200);
    const citation = { questionId: STANDARD_QUESTION_ID, units: vote.value.units, revision: vote.value.revision };
    const review = await postThread(published, 'review', citation);
    const hiddenReview = await postThread(protectedBoard, 'review');
    const discussion = await postThread(discussionBoard, 'discussion');
    const hiddenDiscussion = await postThread(protectedDiscussion, 'discussion');
    expect(
      (await call('GET', '/v1/boards/' + published.id + '/threads')).value.threads.map((t: { id: string }) => t.id),
    ).toEqual([review.id]);
    expect(
      (await call('GET', '/v1/boards/' + discussionBoard.id + '/threads')).value.threads.map(
        (t: { id: string }) => t.id,
      ),
    ).toEqual([discussion.id]);
    const reviewRead = await call('GET', '/v1/threads/' + review.id);
    expect(reviewRead.response.status).toBe(200);
    expect(reviewRead.value.thread.firstPost.voteCitation).toEqual(citation);
    const reviewPath = `/v1/subjects/${conceptId}/threads?place=${GLOBAL_CONTEXT}&kind=review`;
    const discussionPath = `/v1/subjects/${conceptId}/threads?place=${GLOBAL_CONTEXT}&kind=discussion`;
    for (const bearer of [undefined, outsider.bearer]) {
      expect((await call('GET', reviewPath, { bearer })).value.threads.map((t: { id: string }) => t.id)).toEqual([
        review.id,
      ]);
      expect((await call('GET', discussionPath, { bearer })).value.threads.map((t: { id: string }) => t.id)).toEqual([
        discussion.id,
      ]);
      for (const [board, thread] of [
        [protectedBoard, hiddenReview],
        [protectedDiscussion, hiddenDiscussion],
      ] as const) {
        for (const path of [
          '/v1/boards/' + board.id,
          '/v1/boards/' + board.id + '/threads',
          '/v1/threads/' + thread.id,
        ]) {
          const hidden = await call('GET', path, { bearer });
          expect(hidden.response.status).toBe(404);
          expect(hidden.value.code).toBe('not_found');
          expect(hidden.response.headers.get(SESSION_HEADER)).toBeNull();
        }
      }
    }
    for (const board of [protectedBoard, protectedDiscussion]) await grant(outsider.accountId, 'board:read', board);
    for (const [board, thread] of [
      [protectedBoard, hiddenReview],
      [protectedDiscussion, hiddenDiscussion],
    ] as const) {
      expect((await call('GET', '/v1/boards/' + board.id, { bearer: outsider.bearer })).response.status).toBe(200);
      expect(
        (await call('GET', '/v1/boards/' + board.id + '/threads', { bearer: outsider.bearer })).value.threads.map(
          (t: { id: string }) => t.id,
        ),
      ).toEqual([thread.id]);
      expect((await call('GET', '/v1/threads/' + thread.id, { bearer: outsider.bearer })).response.status).toBe(200);
    }
    expect(
      (await call('GET', reviewPath, { bearer: outsider.bearer })).value.threads
        .map((t: { id: string }) => t.id)
        .sort(),
    ).toEqual([review.id, hiddenReview.id].sort());
  },
  120_000,
);

test.serial(
  'Global board creation is refused without board:create on Global Context and replays one board per idempotency key',
  async () => {
    const body = { conceptId, title: 'Global reviews', purpose: 'reviews', visibility: 'published' };
    // A board:create grant on a different place does not reach Global Context.
    await grant(outsider.accountId, 'board:create', { route: 0x5678, id: newId(0x5678) });
    const before = await snapshot();
    const denied = await call('POST', '/v1/boards', { bearer: outsider.bearer, key: crypto.randomUUID(), body });
    expect(denied.response.status).toBe(403);
    expect(denied.value.code).toBe('forbidden');
    expect(await snapshot()).toEqual(before);
    expect((await call('POST', '/v1/boards', { key: crypto.randomUUID(), body })).response.status).toBe(401);
    expect((await call('POST', '/v1/boards', { bearer: governance.bearer, body })).response.status).toBe(400);
    for (const invalid of [
      { ...body, realmId: null },
      { ...body, visibility: 'draft' },
      { ...body, purpose: undefined },
    ]) {
      expect(
        (await call('POST', '/v1/boards', { bearer: governance.bearer, key: crypto.randomUUID(), body: invalid }))
          .response.status,
      ).toBe(400);
    }
    const hiddenConcept = newId(routeOf(conceptId)!);
    await db.admin.query(
      `INSERT INTO semantic.subject(route,subject_id,type,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,'skos:Concept','hidden',1,$2)`,
      [routeOf(hiddenConcept), hiddenConcept],
    );
    const beforeHidden = await snapshot();
    const unreadable = await call('POST', '/v1/boards', {
      bearer: governance.bearer,
      key: crypto.randomUUID(),
      body: { ...body, conceptId: hiddenConcept },
    });
    expect(unreadable.response.status).toBe(403);
    expect(unreadable.value.code).toBe('forbidden');
    expect(await snapshot()).toEqual(beforeHidden);
    const key = crypto.randomUUID();
    const first = await createBoard('reviews', 'published', key);
    expect(first.response.status).toBe(201);
    const after = await snapshot();
    const replay = await createBoard('reviews', 'published', key);
    expect(replay.response.status).toBe(201);
    expect(replay.value.board).toEqual(first.value.board);
    expect(await snapshot()).toEqual(after);
    const second = await createBoard('reviews');
    expect(second.response.status).toBe(201);
    expect(second.value.board.id).not.toBe(first.value.board.id);
    const changed = await createBoard('discussion', 'published', key);
    expect(changed.response.status).toBe(422);
    expect(changed.value.code).toBe('idempotency_conflict');
  },
);
