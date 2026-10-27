import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAuthService, type AuthService } from '@rezics/auth';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { createAccountsWorkModule } from '../../src/access/membership-work.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { communityWorkModule } from '../../src/community/work.ts';
import { createRealmMembership, readMembershipInitiator } from '../../src/community/membership.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { startWorker, type WorkerConfig } from '../../src/worker.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  capture,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://realm-boards.auth.test';
const audience = 'https://realm-boards.api.test';
const password = 'realm boards integration password with enough entropy';
const routeKey = new Uint8Array(32).fill(61);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(62)]]) };
const accountRoute = 0x3456;
const provisioned = new Set<string>();
const growthBody = Buffer.from(serializeDocument(fromPlainText('Fixed protected Realm read growth body')));
const growthBodySha256 = createHash('sha256').update(growthBody).digest();
const growingRelations = new Set([
  'access.account',
  'access.membership_inverse',
  'access.resource_grant',
  'access.resource_role_grant',
  'community.realm_member',
  'community.space',
  'community.space_revision',
  'community.realm',
  'community.realm_revision',
  'content.board',
  'content.board_thread',
  'content.thread',
  'content.post',
  'content.revision',
]);

let db: GrowthDatabase;
let authPool: Pool;
let authDatabaseName = '';
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let work: WorkClient;
let worker: Awaited<ReturnType<typeof startWorker>>;
let governance: Person;
let owner: Person;
let moderator: Person;
let nonmember: Person;
let publicRealm: Realm;
let protectedRealm: Realm;
let scopes: string[] = [];
let schemeId: string;
let otherSchemeId: string;
let conceptId: string;
let outsideConceptId: string;

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; headRevisionId: string };
type CallOptions = { bearer?: string; key?: string; headers?: Record<string, string>; body?: unknown };
type CallResult = { response: Response; value: Record<string, any> };
type Board = { id: string; route: number; title: string; visibility: string; realmId: string | null };

async function issue(email: string, scopes: string[]) {
  const signed = await service.handler(
    new Request(issuer + '/signin', {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-boards-client', scope: scopes }),
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
  const email = name + '@realm-boards.test';
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

async function grant(accountId: string, actions: string[]) {
  const body = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: accountId },
    actions,
    valid: '(,)',
  };
  const result = await call('POST', '/v1/grants', {
    bearer: governance.bearer,
    key: crypto.randomUUID(),
    body,
  });
  expect(result.response.status).toBe(201);
}

async function createSpace(title: string) {
  const result = await call('POST', '/v1/spaces', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { title, summary: title + ' summary' },
  });
  expect(result.response.status).toBe(201);
  return result.value.space as { spaceId: string };
}

async function createRealm(visibility: 'public' | 'protected', title: string): Promise<Realm> {
  const space = await createSpace(title + ' host');
  const result = await call('POST', '/v1/realms', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { spaceId: space.spaceId, title, summary: title + ' summary', visibility, contextId: GLOBAL_CONTEXT },
  });
  expect(result.response.status).toBe(201);
  return result.value.realm as Realm;
}

async function setBoardScheme(realm: Realm) {
  const result = await call('PUT', '/v1/realms/' + realm.realmId + '/boardScheme', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { schemeId },
  });
  expect(result.response.status).toBe(200);
  realm.headRevisionId = result.value.realm.headRevisionId;
}

async function grantModerator(realm: Realm) {
  const body = {
    resource: { route: routeOf(realm.realmId)!, id: realm.realmId },
    subject: { kind: 'account' as const, id: moderator.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  };
  const result = await call('POST', '/v1/roleGrants', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body,
  });
  expect(result.response.status).toBe(201);
}

async function createSubject(type: string, inScheme?: string) {
  const result = await call('POST', '/v1/subjects', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: {
      type,
      labels: { en: type },
      ...(inScheme === undefined
        ? {}
        : {
            statements: {
              'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: inScheme } }],
            },
          }),
    },
  });
  expect(result.response.status).toBe(201);
  return (result.value.subject as { id: string }).id;
}

async function createBoard(realm: Realm, subjectId: string, bearer = moderator.bearer) {
  return call('POST', '/v1/realms/' + realm.realmId + '/boards', {
    bearer,
    key: crypto.randomUUID(),
    body: { conceptId: subjectId, title: 'Board for ' + subjectId, visibility: 'published' },
  });
}

async function writeSnapshot() {
  const result = await db.admin.query(`SELECT
    (SELECT count(*)::integer FROM content.board) AS boards,
    (SELECT count(*)::integer FROM access.resource_initialization) AS initialized,
    (SELECT count(*)::integer FROM access.resource_role_grant) AS roles,
    (SELECT count(*)::integer FROM access.resource_grant) AS grants,
    (SELECT count(*)::integer FROM core.receipt) AS receipts,
    (SELECT count(*)::integer FROM core.outbox) AS events,
    (SELECT count(*)::integer FROM editorial.write_basis) AS bases,
    (SELECT coalesce(sum(position), 0)::text FROM core.partition) AS position`);
  return result.rows[0];
}

async function expectHiddenAsMissing(path: string, missingPath: string, token?: string) {
  const hidden = await call('GET', path, token === undefined ? {} : { bearer: token });
  const missing = await call('GET', missingPath, token === undefined ? {} : { bearer: token });
  expect(hidden.response.status).toBe(404);
  expect(missing.response.status).toBe(404);
  const { request_id: _hiddenRequest, ...hiddenBody } = hidden.value;
  const { request_id: _missingRequest, ...missingBody } = missing.value;
  expect(hiddenBody).toEqual(missingBody);
  expect(hidden.response.headers.get(SESSION_HEADER)).toBeNull();
}

async function settleMembership(workflowId: string) {
  expect(await work.retrieveWorkflow(workflowId).getResult()).toBeUndefined();
}

async function startMembershipWorker() {
  let membership: ReturnType<typeof createRealmMembership>;
  const workerAccess = createAccess({
    actions: actionCatalogue(kernel),
    auth: {
      issuer,
      audience,
      jwksUrl: issuer + '/.well-known/jwks.json',
      fetch: async () => service.handler(new Request(issuer + '/.well-known/jwks.json')),
    },
    realmRoleReader: (client, input) => membership.roleReader(client, input),
  });
  membership = createRealmMembership({
    pool: db.pool,
    access: workerAccess,
    referenceKeys: tokens,
    restorer: createInitiatorRestorer({
      pool: db.pool,
      access: workerAccess,
      readOperation: readMembershipInitiator,
      readConsent: async ({ actorAccountId, clientId }) => ({ actorAccountId, clientId, scopes }),
    }),
  });
  const config: WorkerConfig = {
    databaseUrl: db.url,
    executorId: 'realm-boards-test-' + process.pid,
    poolSize: 10,
  };
  worker = await startWorker(config, [createAccountsWorkModule({ realm: membership }), communityWorkModule], {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: issuer + '/.well-known/jwks.json',
    KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.from(tokens.keys.get(1)!).toString('base64url')}`,
  });
}

function relationPlanNodes(value: unknown, relation: string): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => relationPlanNodes(entry, relation));
  const record = value as Record<string, unknown>;
  const matches = record['Relation Name'] === relation ? [record] : [];
  return matches.concat(...Object.values(record).map((entry) => relationPlanNodes(entry, relation)));
}

function accessGrowthRows(input: {
  route: number;
  accountId: string;
  resourceId: string;
  realmId: string;
  reservationId: string;
  transactionId: string;
}) {
  const { route, accountId, resourceId, realmId, reservationId, transactionId } = input;
  return {
    'access.account': [{ route, account_id: accountId, kind: 'actor', state: 'active', transaction_id: transactionId }],
    'access.membership_inverse': [
      {
        route,
        account_id: accountId,
        kind: 'realm',
        group_id: realmId,
        reservation_id: reservationId,
        transaction_id: transactionId,
      },
    ],
    'access.resource_grant': [
      {
        route,
        resource_id: resourceId,
        subject_id: accountId,
        subject_role: '',
        action: 'board:read',
        valid: '(,)',
        transaction_id: transactionId,
      },
    ],
    'access.resource_role_grant': [
      {
        route,
        resource_id: realmId,
        subject_kind: 'identity',
        subject_id: accountId,
        subject_role: '',
        grant_role: 'community.realm.member',
        valid: '(,)',
        transaction_id: transactionId,
      },
    ],
    'community.realm_member': [
      {
        route,
        realm_id: realmId,
        account_id: accountId,
        role: 'member',
        valid: '(,)',
        reservation_id: reservationId,
        transaction_id: transactionId,
      },
    ],
  };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  db = await openGrowthDatabase(url);
  work = await createWorkClient(db.url, db.pool);
  authDatabaseName = 'realm_boards_auth_' + process.pid;
  await db.admin.query('CREATE DATABASE ' + authDatabaseName);
  const authUrl = new URL(url);
  authUrl.pathname = '/' + authDatabaseName;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-boards',
    alg: 'ES256',
  };
  service = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'realm-boards-auth-persistent-secret-32bytes',
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
  const rateLimit = createWriteRateLimiter({
    secret: 'realm-boards-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100000, seconds: 86400 } },
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
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
    writeRate: rateLimit,
    workClient: work,
  });
  scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  await service.internal.registerClient({ clientId: 'realm-boards-client', firstParty: true, scopes });
  governance = await person('boards_governance', scopes);
  owner = await person('boards_owner', scopes);
  moderator = await person('boards_moderator', scopes);
  nonmember = await person('boards_nonmember', scopes);
  await bootstrapGovernance(db.pool, governance.accountId);
  await bootstrapRelease(db.pool, bundledRelease);
  await grant(owner.accountId, ['realm:create', 'space:create', 'subject:create']);
  schemeId = await createSubject('skos:ConceptScheme');
  otherSchemeId = await createSubject('skos:ConceptScheme');
  conceptId = await createSubject('skos:Concept', schemeId);
  outsideConceptId = await createSubject('skos:Concept', otherSchemeId);
  publicRealm = await createRealm('public', 'Public board Realm');
  protectedRealm = await createRealm('protected', 'Protected board Realm');
  await setBoardScheme(publicRealm);
  await setBoardScheme(protectedRealm);
  await grantModerator(publicRealm);
  await grantModerator(protectedRealm);
}, 60_000);

afterAll(async () => {
  await worker?.stop();
  await work?.close();
  await authPool?.end();
  if (authDatabaseName) await dropTestDatabase(db!.admin, authDatabaseName);
  await db?.close();
});

test.serial('a Realm moderator creates one scheme Concept board and threads list on it', async () => {
  const publicCreated = await createBoard(publicRealm, conceptId);
  expect(publicCreated.response.status).toBe(201);
  const board = publicCreated.value.board as Board;
  const boardId = board.id;
  const boardRoute = board.route;
  expect(structuredClone(board)).toMatchObject({
    id: expect.any(String),
    route: routeOf(boardId),
    title: 'Board for ' + conceptId,
    visibility: 'published',
    realmId: publicRealm.realmId,
  });
  const read = await call('GET', '/v1/boards/' + boardId);
  expect(read.response.status).toBe(200);
  expect(read.value.board).toMatchObject({ id: boardId, realmId: publicRealm.realmId });
  const initialized = await db.admin.query(
    `SELECT 1 FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='content.board.owner' AND upper_inf(valid)`,
    [boardRoute, boardId, moderator.accountId],
  );
  expect(initialized.rowCount).toBe(1);

  const threadCreated = await call('POST', '/v1/threads', {
    bearer: moderator.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'A thread for the Realm concept',
      body: fromPlainText('The thread belongs on this board.'),
      licence: 'MIT',
      subjectIds: [],
      boardId,
      visibility: 'published',
    },
  });
  expect(threadCreated.response.status).toBe(201);
  const threadId = threadCreated.value.thread.id as string;
  const threads = await call('GET', '/v1/boards/' + boardId + '/threads');
  expect(threads.response.status).toBe(200);
  expect(threads.value.threads.map((thread: { id: string }) => thread.id)).toContain(threadId);

  const listed = await call('GET', '/v1/realms/' + publicRealm.realmId + '/boards');
  expect(listed.response.status).toBe(200);
  expect(listed.value.items).toContainEqual(expect.objectContaining({ id: boardId, realmId: publicRealm.realmId }));
  expect(listed.value.next).toBeNull();

  const beforeOutside = await writeSnapshot();
  const outside = await createBoard(publicRealm, outsideConceptId);
  expect(outside.response.status).toBe(403);
  expect(await writeSnapshot()).toEqual(beforeOutside);

  const beforeDuplicate = await writeSnapshot();
  const duplicate = await createBoard(publicRealm, conceptId);
  expect(duplicate.response.status).toBe(409);
  expect(await writeSnapshot()).toEqual(beforeDuplicate);

  const beforeNonmember = await writeSnapshot();
  const refused = await createBoard(publicRealm, conceptId, nonmember.bearer);
  expect(refused.response.status).toBe(403);
  expect(await writeSnapshot()).toEqual(beforeNonmember);

  const sameConceptInAnotherRealm = await createBoard(protectedRealm, conceptId);
  expect(sameConceptInAnotherRealm.response.status).toBe(201);
});

test.serial(
  'protected Realm board listings and thread lists are the same 404 for anonymous and non-members',
  async () => {
    const protectedConceptId = await createSubject('skos:Concept', schemeId);
    const created = await createBoard(protectedRealm, protectedConceptId);
    expect(created.response.status).toBe(201);
    const board = created.value.board as Board;
    const missingRealm = '/v1/realms/' + newId(routeOf(protectedRealm.realmId)!) + '/boards';
    const missingBoard = '/v1/boards/' + newId(board.route) + '/threads';
    for (const token of [undefined, nonmember.bearer]) {
      await expectHiddenAsMissing('/v1/realms/' + protectedRealm.realmId + '/boards', missingRealm, token);
      await expectHiddenAsMissing('/v1/boards/' + board.id + '/threads', missingBoard, token);
      await expectHiddenAsMissing('/v1/boards/' + board.id, '/v1/boards/' + newId(board.route), token);
      const hiddenBoard = await call('GET', '/v1/boards/' + board.id, token === undefined ? {} : { bearer: token });
      expect(hiddenBoard.response.status).toBe(404);
      expect(JSON.stringify(hiddenBoard.value)).not.toContain(protectedRealm.realmId);
    }
    const suspended = await person(
      'realm_boards_suspended',
      [...actionCatalogue(kernel).keys()].filter((action) => action !== 'media:complete'),
    );
    const suspension = await call('POST', `/v1/accounts/${suspended.accountId}:suspend`, {
      bearer: governance.bearer,
      key: crypto.randomUUID(),
      body: { reason: 'Suspended board creator fixture' },
    });
    expect(suspension.response.status).toBe(200);
    const suspendedConceptId = await createSubject('skos:Concept', schemeId);
    const beforeSuspended = await writeSnapshot();
    const refusedSuspended = await call('POST', `/v1/realms/${publicRealm.realmId}/boards`, {
      bearer: suspended.bearer,
      key: crypto.randomUUID(),
      body: {
        conceptId: suspendedConceptId,
        title: 'Board for suspended creator',
        visibility: 'published',
      },
    });
    expect(refusedSuspended.response.status).toBe(401);
    expect(await writeSnapshot()).toEqual(beforeSuspended);
  },
);

test.serial('a settled protected Realm member reads its boards, threads and posts', async () => {
  const subjectId = await createSubject('skos:Concept', schemeId);
  const createdBoard = await createBoard(protectedRealm, subjectId);
  expect(createdBoard.response.status).toBe(201);
  const board = createdBoard.value.board as Board;
  const protectedMember = await person('boards_protected_member', scopes);
  await startMembershipWorker();

  const added = await call('POST', `/v1/realms/${protectedRealm.realmId}/members`, {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { accountId: protectedMember.accountId },
  });
  expect(added.response.status).toBe(202);
  await settleMembership(added.value.workflowId as string);

  const membership = await db.admin.query(
    `SELECT 1 FROM community.realm_member
     WHERE route=$1 AND realm_id=$2 AND account_id=$3 AND valid @> clock_timestamp()`,
    [routeOf(protectedRealm.realmId), protectedRealm.realmId, protectedMember.accountId],
  );
  expect(membership.rowCount).toBe(1);
  const memberGrant = await db.admin.query(
    `SELECT 1 FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2 AND grant_role='community.realm.member' AND upper_inf(valid)`,
    [routeOf(protectedRealm.realmId), protectedRealm.realmId],
  );
  expect(memberGrant.rowCount).toBe(1);

  const threadCreated = await call('POST', '/v1/threads', {
    bearer: protectedMember.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'A thread in the protected Realm',
      body: fromPlainText('The member can read this thread.'),
      licence: 'MIT',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
  });
  expect(threadCreated.response.status).toBe(201);
  const threadId = threadCreated.value.thread.id as string;
  const postCreated = await call('POST', `/v1/threads/${threadId}/posts`, {
    bearer: protectedMember.bearer,
    key: crypto.randomUUID(),
    body: { body: fromPlainText('The member can read this post.'), licence: 'MIT', subjectIds: [] },
  });
  expect(postCreated.response.status).toBe(201);
  const postId = postCreated.value.post.id as string;

  const protectedPaths = [
    [`/v1/boards/${board.id}`, `/v1/boards/${newId(board.route)}`],
    [`/v1/threads/${threadId}`, `/v1/threads/${newId(routeOf(threadId)!)}`],
    [`/v1/posts/${postId}`, `/v1/posts/${newId(routeOf(postId)!)}`],
  ] as const;
  const capturedThreadRead = await capture(db, () =>
    call('GET', `/v1/threads/${threadId}`, { bearer: protectedMember.bearer }),
  );
  expect(capturedThreadRead.value.response.status).toBe(200);
  expect(
    capturedThreadRead.capture.statements.filter((statement) => statement.includes('community.realm_member')),
  ).toHaveLength(1);
  for (const [path] of protectedPaths) {
    const readable = await call('GET', path, { bearer: protectedMember.bearer });
    expect(readable.response.status).toBe(200);
  }

  for (const [path, missingPath] of protectedPaths) {
    await expectHiddenAsMissing(path, missingPath, nonmember.bearer);
  }

  const readPopulation: Population = {
    name: 'protected-realm-thread-read-' + crypto.randomUUID(),
    hotPartition: partitionOf(routeOf(threadId)!),
    hotShare: 1,
    rows({ route }) {
      const unrelatedBoardId = newId(route);
      const unrelatedRealmId = newId(route);
      const spaceId = newId(route);
      const spaceRevisionId = newId(route);
      const realmRevisionId = newId(route);
      const accountId = newId(route);
      const unrelatedThreadId = newId(route);
      const unrelatedPostId = newId(route);
      const unrelatedRevisionId = newId(route);
      const transactionId = newId(route);
      return {
        ...accessGrowthRows({
          route,
          accountId,
          resourceId: unrelatedBoardId,
          realmId: unrelatedRealmId,
          reservationId: newId(route),
          transactionId,
        }),
        'community.space': [
          {
            route,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: new Date('2020-06-01T00:00:00Z'),
            creator: accountId,
          },
        ],
        'community.space_revision': [
          {
            route,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: 'Unrelated protected-read growth host',
            summary: '',
            created_at: new Date('2020-06-01T00:00:00Z'),
            author: accountId,
          },
        ],
        'community.realm': [
          {
            route,
            realm_id: unrelatedRealmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: realmRevisionId,
            created_at: new Date('2020-06-01T00:00:00Z'),
            creator: accountId,
          },
        ],
        'community.realm_revision': [
          {
            route,
            realm_id: unrelatedRealmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: 'Unrelated protected-read growth Realm',
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: new Date('2020-06-01T00:00:00Z'),
            author: accountId,
          },
        ],
        'content.board': [
          {
            route,
            board_id: unrelatedBoardId,
            realm_id: unrelatedRealmId,
            subject_id: newId(route),
            title: 'Unrelated protected-read growth board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: new Date('2020-06-01T00:00:00Z'),
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: unrelatedThreadId,
            author_account_id: owner.accountId,
            board_id: unrelatedBoardId,
            title: 'Unrelated protected-read growth thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            first_post_id: unrelatedPostId,
            availability: 'available',
          },
        ],
        'content.post': [
          {
            route,
            thread_id: unrelatedThreadId,
            post_id: unrelatedPostId,
            reply_to_post_id: null,
            author_account_id: owner.accountId,
            head_revision_id: unrelatedRevisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: new Date('2020-06-01T00:00:00Z'),
            availability: 'available',
          },
        ],
        'content.revision': [
          {
            route,
            thread_id: unrelatedThreadId,
            post_id: unrelatedPostId,
            revision_id: unrelatedRevisionId,
            body: growthBody,
            body_sha256: growthBodySha256,
            search_text: 'Fixed protected Realm read growth body',
            licence: 'MIT',
            subject_ids: [],
            board_id: unrelatedBoardId,
            availability: 'available',
            recorded_transaction_id: transactionId,
            recorded_at: new Date('2020-06-01T00:00:00Z'),
            media_ids: [],
          },
        ],
      };
    },
  };
  // Growth model: grow grants, memberships, other Realms and their boards, and threads on other boards at 500 × scale; keep the protected Realm, board, and read fixed.
  const report = await checkGrowth(db, {
    name: 'Protected Realm member thread read',
    scales: [8, 32, 128],
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, readPopulation, {
        from: 500 * previous,
        to: 500 * scale,
      });
    },
    async operation() {
      const result = await call('GET', `/v1/threads/${threadId}`, { bearer: protectedMember.bearer });
      expect(result.response.status).toBe(200);
      return result;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([8, 32, 128]);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBeLessThanOrEqual(4096);
    for (const [name, relation] of Object.entries(cost.relations ?? {}))
      if (growingRelations.has(name)) expect(relation.sequentialScans).toBe(0);
  }
  console.info(JSON.stringify(report));

  const left = await call('DELETE', `/v1/realms/${protectedRealm.realmId}/membership`, {
    bearer: protectedMember.bearer,
  });
  expect(left.response.status).toBe(202);
  await settleMembership(left.value.workflowId as string);
  for (const [path, missingPath] of protectedPaths) {
    await expectHiddenAsMissing(path, missingPath, protectedMember.bearer);
  }
});

test.serial('board reads authorize with no planner method settings', async () => {
  if (!worker) await startMembershipWorker();

  const subjectId = await createSubject('skos:Concept', schemeId);
  const createdBoard = await createBoard(protectedRealm, subjectId);
  expect(createdBoard.response.status).toBe(201);
  const board = createdBoard.value.board as Board;
  const member = await person('boards_planner_member', scopes);
  const added = await call('POST', `/v1/realms/${protectedRealm.realmId}/members`, {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { accountId: member.accountId },
  });
  expect(added.response.status).toBe(202);
  await settleMembership(added.value.workflowId as string);

  const threadCreated = await call('POST', '/v1/threads', {
    bearer: member.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'A thread for planner-free board reads',
      body: fromPlainText('A protected Realm member can read this thread.'),
      licence: 'MIT',
      subjectIds: [],
      boardId: board.id,
      visibility: 'published',
    },
  });
  expect(threadCreated.response.status).toBe(201);

  const route = routeOf(protectedRealm.realmId)!;
  const rowCount = 500 * 8;
  const accountIds = Array.from({ length: rowCount }, () => newId(route));
  const grants = accountIds.map((subjectId) => {
    const resourceId = newId(route);
    return { resource_id: resourceId, subject_id: subjectId, transaction_id: newId(route) };
  });
  const memberships = accountIds.map((accountId) => ({
    account_id: accountId,
    reservation_id: newId(route),
    transaction_id: newId(route),
  }));
  const inverseMemberships = memberships.map(({ account_id, reservation_id, transaction_id }) => ({
    account_id,
    group_id: protectedRealm.realmId,
    reservation_id,
    transaction_id,
  }));
  const roleGrants = accountIds.map((subject_id) => ({
    resource_id: protectedRealm.realmId,
    subject_id,
    transaction_id: newId(route),
  }));
  await db.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     SELECT $1, account_id, 'actor', 'active', account_id
     FROM jsonb_to_recordset($2::jsonb) AS rows(account_id uuid)`,
    [route, JSON.stringify(accountIds.map((account_id) => ({ account_id })))],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, subject_role, action, valid, transaction_id)
     SELECT $1, resource_id, subject_id, '', 'board:read', '(,)'::tstzrange, transaction_id
     FROM jsonb_to_recordset($2::jsonb) AS rows(resource_id uuid, subject_id uuid, transaction_id uuid)`,
    [route, JSON.stringify(grants)],
  );
  await db.admin.query(
    `INSERT INTO access.resource_role_grant(route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
     SELECT $1, resource_id, 'identity', subject_id, '', 'community.realm.member', '(,)'::tstzrange, transaction_id
     FROM jsonb_to_recordset($2::jsonb) AS rows(resource_id uuid, subject_id uuid, transaction_id uuid)`,
    [route, JSON.stringify(roleGrants)],
  );
  await db.admin.query(
    `INSERT INTO access.membership_inverse(route, account_id, kind, group_id, reservation_id, transaction_id)
     SELECT $1, account_id, 'realm', group_id, reservation_id, transaction_id
     FROM jsonb_to_recordset($2::jsonb) AS rows(account_id uuid, group_id uuid, reservation_id uuid, transaction_id uuid)`,
    [route, JSON.stringify(inverseMemberships)],
  );
  await db.admin.query(
    `INSERT INTO community.realm_member(route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     SELECT $1, $2, account_id, 'member', '(,)'::tstzrange, reservation_id, transaction_id
     FROM jsonb_to_recordset($3::jsonb) AS rows(account_id uuid, reservation_id uuid, transaction_id uuid)`,
    [route, protectedRealm.realmId, JSON.stringify(memberships)],
  );
  await db.admin.query(
    'ANALYZE access.account, access.membership_inverse, access.resource_grant, access.resource_role_grant, community.realm_member',
  );

  // Seed grants and other member rows at 500 × 8, keeping the protected Realm, board, and page fixed.
  const reads = await capture(db, async () => {
    const boardRead = await call('GET', `/v1/boards/${board.id}`, { bearer: member.bearer });
    const realmBoards = await call('GET', `/v1/realms/${protectedRealm.realmId}/boards`, { bearer: member.bearer });
    const boardThreads = await call('GET', `/v1/boards/${board.id}/threads`, { bearer: member.bearer });
    expect(boardRead.response.status).toBe(200);
    expect(realmBoards.response.status).toBe(200);
    expect(realmBoards.value.items.map((item: Board) => item.id)).toContain(board.id);
    expect(boardThreads.response.status).toBe(200);
    expect(boardThreads.value.threads.map((thread: { id: string }) => thread.id)).toContain(
      threadCreated.value.thread.id,
    );
  });

  expect(reads.capture.statements.join('\n')).not.toMatch(/\b(SET|set_config)\b[^;]*\benable_/is);
  const grantScans = relationPlanNodes(reads.capture.plans, 'resource_grant');
  expect(grantScans.length).toBeGreaterThan(0);
  expect(grantScans.map((node) => node['Index Name'])).toContain('resource_grant_pkey');
});

test.serial(
  'Realm board keyset listing stays bounded as other Realms add boards',
  async () => {
    const route = routeOf(publicRealm.realmId)!;
    const createdAt = '2026-10-25T00:00:00.000Z';
    const population: Population = {
      name: 'realm-boards-other-realms',
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows({ ordinal, route: threadRoute }) {
        const spaceId = newId(route);
        const spaceRevisionId = newId(route);
        const realmId = newId(route);
        const realmRevisionId = newId(route);
        const boardId = newId(route);
        const accountId = newId(route);
        const reservationId = newId(route);
        const transactionId = newId(route);
        const threadId = newId(threadRoute);
        const postId = newId(threadRoute);
        const revisionId = newId(threadRoute);
        return {
          ...accessGrowthRows({
            route,
            accountId,
            resourceId: boardId,
            realmId,
            reservationId,
            transactionId,
          }),
          'community.space': [
            {
              route,
              space_id: spaceId,
              state: 'active',
              head_revision_id: spaceRevisionId,
              created_at: createdAt,
              creator: owner.accountId,
            },
          ],
          'community.space_revision': [
            {
              route,
              space_id: spaceId,
              revision_id: spaceRevisionId,
              predecessor: null,
              title: 'Unrelated board host',
              summary: '',
              created_at: createdAt,
              author: owner.accountId,
            },
          ],
          'community.realm': [
            {
              route,
              realm_id: realmId,
              space_id: spaceId,
              state: 'active',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              head_revision_id: realmRevisionId,
              created_at: createdAt,
              creator: owner.accountId,
            },
          ],
          'community.realm_revision': [
            {
              route,
              realm_id: realmId,
              revision_id: realmRevisionId,
              predecessor: null,
              title: 'Unrelated board Realm',
              summary: '',
              visibility: 'public',
              context_id: GLOBAL_CONTEXT,
              created_at: createdAt,
              author: owner.accountId,
            },
          ],
          'content.board': [
            {
              route,
              board_id: boardId,
              realm_id: realmId,
              subject_id: conceptId,
              title: 'Unrelated board',
              visibility: 'published',
              security_revision: 1,
              recorded_transaction_id: transactionId,
              created_at: new Date(createdAt),
            },
          ],
          'content.thread': [
            {
              route: threadRoute,
              thread_id: threadId,
              author_account_id: accountId,
              board_id: boardId,
              title: 'Unrelated Realm listing thread',
              visibility: 'published',
              security_revision: 1,
              recorded_transaction_id: transactionId,
              created_at: new Date(createdAt),
              first_post_id: postId,
              availability: 'available',
            },
          ],
          'content.post': [
            {
              route: threadRoute,
              thread_id: threadId,
              post_id: postId,
              reply_to_post_id: null,
              author_account_id: accountId,
              head_revision_id: revisionId,
              visibility: 'published',
              security_revision: 1,
              recorded_transaction_id: transactionId,
              created_at: new Date(createdAt),
              availability: 'available',
            },
          ],
          'content.revision': [
            {
              route: threadRoute,
              thread_id: threadId,
              post_id: postId,
              revision_id: revisionId,
              body: growthBody,
              body_sha256: growthBodySha256,
              search_text: 'Fixed protected Realm read growth body',
              licence: 'MIT',
              subject_ids: [],
              board_id: boardId,
              availability: 'available',
              recorded_transaction_id: transactionId,
              recorded_at: new Date(createdAt),
              media_ids: [],
            },
          ],
          'content.board_thread': [
            {
              route,
              board_id: boardId,
              thread_id: threadId,
              created_at: new Date(createdAt),
              last_activity_at: new Date(createdAt),
              score: 0,
              active_rank: 0,
              hot_rank: 0,
              rank_refreshed_at: new Date(createdAt),
              source_epoch: 1,
              source_position: ordinal + 1,
              source_revision_id: revisionId,
            },
          ],
        };
      },
    };
    // Growth model: grow grants, memberships, other Realms and their boards, and threads on other boards at 500 × scale; keep the listed Realm and page fixed.
    const report = await checkGrowth(db, {
      name: 'Realm board listing',
      scales: [8, 32, 128],
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        await seed({ pool: database.pool, admin: database.admin }, population, {
          from: 500 * previous,
          to: 500 * scale,
        });
      },
      async operation() {
        const result = await call('GET', '/v1/realms/' + publicRealm.realmId + '/boards?limit=1');
        expect(result.response.status).toBe(200);
        expect(result.value.items.map((item: Board) => item.id)).toHaveLength(1);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([8, 32, 128]);
    for (const { cost } of report.samples)
      for (const [name, relation] of Object.entries(cost.relations ?? {}))
        if (growingRelations.has(name)) expect(relation.sequentialScans).toBe(0);
    console.info(JSON.stringify(report));
  },
  300_000,
);
