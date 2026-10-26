import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, type AuthService } from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const issuer = 'https://realm-boards.auth.test';
const audience = 'https://realm-boards.api.test';
const password = 'realm boards integration password with enough entropy';
const routeKey = new Uint8Array(32).fill(61);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(62)]]) };
const accountRoute = 0x3456;
const provisioned = new Set<string>();

let db: GrowthDatabase;
let authPool: Pool;
let authDatabaseName = '';
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let governance: Person;
let owner: Person;
let moderator: Person;
let nonmember: Person;
let publicRealm: Realm;
let protectedRealm: Realm;
let schemeId: string;
let otherSchemeId: string;
let conceptId: string;
let outsideConceptId: string;

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; headRevisionId: string };
type CallOptions = { bearer?: string; key?: string; headers?: Record<string, string>; body?: unknown };
type CallResult = { response: Response; value: Record<string, any> };
type Board = { id: string; route: number; title: string; visibility: string };

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

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  db = await openGrowthDatabase(url);
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
    trustedAccess: {
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
    },
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
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
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
  await authPool?.end();
  if (authDatabaseName) await db?.admin.query('DROP DATABASE IF EXISTS ' + authDatabaseName + ' WITH (FORCE)');
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
  });
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
  expect(listed.value.items.map((item: Board) => item.id)).toContain(boardId);
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

test.serial(
  'Realm board keyset listing stays bounded as other Realms add boards',
  async () => {
    const route = routeOf(publicRealm.realmId)!;
    const createdAt = '2026-10-25T00:00:00.000Z';
    const population: Population = {
      name: 'realm-boards-other-realms',
      hotPartition: partitionOf(route),
      hotShare: 1,
      rows() {
        const spaceId = newId(route);
        const spaceRevisionId = newId(route);
        const realmId = newId(route);
        const realmRevisionId = newId(route);
        const boardId = newId(route);
        return {
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
              recorded_transaction_id: newId(route),
            },
          ],
        };
      },
    };
    const report = await checkGrowth(db, {
      name: 'Realm board listing',
      scales: [256, 1024, 4096],
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
      },
      async operation() {
        const result = await call('GET', '/v1/realms/' + publicRealm.realmId + '/boards?limit=1');
        expect(result.response.status).toBe(200);
        expect(result.value.items.map((item: Board) => item.id)).toHaveLength(1);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
    for (const { cost } of report.samples)
      for (const relation of Object.values(cost.relations ?? {})) expect(relation.sequentialScans).toBe(0);
    console.info(JSON.stringify(report));
  },
  300_000,
);
