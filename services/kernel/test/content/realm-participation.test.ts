import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { fromPlainText } from '@rezics/document';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import { startConsentServer, type ConsentServer } from '../community/membership-fixture.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { GLOBAL_CONTEXT, bootstrapRelease } from '../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const issuer = 'https://realm-participation-content.auth.test';
const audience = 'https://realm-participation-content.api.test';
const password = 'realm content participation integration password';
const routeKey = new Uint8Array(32).fill(71);
const sessionKey = new Uint8Array(32).fill(72);
const tokens = { current: 1, keys: new Map([[1, sessionKey]]) };

let db: GrowthDatabase;
let pool: ReturnType<typeof createPool>;
let authPool: Pool;
let consent: ConsentServer;
let authDatabaseName = '';
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let work: WorkClient;
let worker: Bun.Subprocess | undefined;
let kernelWorkerEnvironment: Record<string, string>;
let governance: Person;
let owner: Person;
let moderator: Person;
let member: Person;
let banned: Person;
let protectedMember: Person;
let protectedNonmember: Person;
let publicRealm: Realm;
let protectedRealm: Realm;
let publicBoard: Board;
let protectedBoard: Board;
let scopes: string[] = [];
let conceptId: string;
let schemeId: string;
let participationEvaluations = 0;

type Person = { accountId: string; bearer: string };
type Realm = { realmId: string; headRevisionId: string };
type CallOptions = { bearer?: string; key?: string; headers?: Record<string, string>; body?: unknown };
type CallResult = { response: Response; value: Record<string, any> };
type Board = { id: string; route: number; title: string; visibility: string };

function workerStream(stream: ReadableStream<Uint8Array> | number | undefined): ReadableStream<Uint8Array> {
  if (typeof stream === 'number' || stream === undefined) throw new Error('Kernel worker pipes are not readable');
  return stream;
}

async function startKernelWorker(env: Record<string, string>): Promise<Bun.Subprocess> {
  const childEnv = workerTestEnv({ ...process.env, ...env });
  const child = Bun.spawn(['bun', 'src/worker.ts'], {
    cwd: resolve(import.meta.dir, '../..'),
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  let out = '';
  let err = '';
  const pump = async (stream: ReadableStream<Uint8Array>, target: 'out' | 'err') => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (target === 'out') out += text;
      else err += text;
    }
  };
  void pump(workerStream(child.stdout), 'out');
  void pump(workerStream(child.stderr), 'err');
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (out.includes('Worker ready')) return child;
    if (child.exitCode !== null) throw new Error(`Kernel worker exited ${child.exitCode}:\n${out}\n${err}`);
    await Bun.sleep(20);
  }
  child.kill();
  throw new Error(`Kernel worker did not become ready:\n${out}\n${err}`);
}

async function stopKernelWorker(child: Bun.Subprocess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const result = await Promise.race([
    child.exited.then(() => 'exited' as const),
    Bun.sleep(10_000).then(() => 'timeout' as const),
  ]);
  if (result === 'timeout') child.kill(9);
  await child.exited;
}

async function issue(email: string, scope: string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'realm-participation-content-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string): Promise<Person> {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@realm-participation-content.test`,
    password,
  });
  return {
    accountId: result.accountId,
    bearer: await issue(`${name}@realm-participation-content.test`, scopes),
  };
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  const headers = new Headers(options.headers);
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
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
    body: { title, summary: `${title} summary` },
  });
  expect(result.response.status).toBe(201);
  return result.value.space.spaceId as string;
}

async function createRealm(visibility: 'public' | 'protected', title: string): Promise<Realm> {
  const spaceId = await createSpace(`${title} host`);
  const result = await call('POST', '/v1/realms', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { spaceId, title, summary: `${title} summary`, visibility, contextId: GLOBAL_CONTEXT },
  });
  expect(result.response.status).toBe(201);
  return result.value.realm as Realm;
}

async function setBoardScheme(realm: Realm) {
  const result = await call('PUT', `/v1/realms/${realm.realmId}/boardScheme`, {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    headers: { 'if-match': JSON.stringify(realm.headRevisionId) },
    body: { schemeId },
  });
  expect(result.response.status).toBe(200);
  realm.headRevisionId = result.value.realm.headRevisionId;
}

async function grantModerator(realm: Realm) {
  const result = await call('POST', '/v1/roleGrants', {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: {
      resource: { route: routeOf(realm.realmId)!, id: realm.realmId },
      subject: { kind: 'account', id: moderator.accountId },
      role: 'community.realm.moderator',
      valid: '(,)',
    },
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
  return result.value.subject.id as string;
}

async function createBoard(realm: Realm, title: string): Promise<Board> {
  const result = await call('POST', `/v1/realms/${realm.realmId}/boards`, {
    bearer: moderator.bearer,
    key: crypto.randomUUID(),
    body: { conceptId, title, visibility: 'published' },
  });
  expect(result.response.status).toBe(201);
  return result.value.board as Board;
}

async function settle(workflowId: string) {
  if (workflowId.startsWith('realm:ban:')) {
    await work.retrieveWorkflow(workflowId).getResult();
    return;
  }
  expect(await work.retrieveWorkflow(workflowId).getResult()).toBeUndefined();
}

async function joinPublic(realm: Realm, actor: Person) {
  const result = await call('POST', `/v1/realms/${realm.realmId}/membership`, {
    bearer: actor.bearer,
    key: crypto.randomUUID(),
  });
  expect(result.response.status).toBe(202);
  await settle(result.value.workflowId as string);
}

async function addProtectedMember(realm: Realm, actor: Person) {
  const result = await call('POST', `/v1/realms/${realm.realmId}/members`, {
    bearer: owner.bearer,
    key: crypto.randomUUID(),
    body: { accountId: actor.accountId },
  });
  expect(result.response.status).toBe(202);
  await settle(result.value.workflowId as string);
}

async function expectAnonymousAndNonmemberHidden(path: string, missingPath: string) {
  const reads = await Promise.all([
    call('GET', path),
    call('GET', path, { bearer: protectedNonmember.bearer }),
    call('GET', missingPath),
    call('GET', missingPath, { bearer: protectedNonmember.bearer }),
  ]);
  for (const result of reads) expect(result.response.status).toBe(404);
  const bodies = reads.map(({ value }) => {
    const { request_id: _requestId, ...body } = value;
    return body;
  });
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual(bodies[2]);
  expect(bodies[0]).toEqual(bodies[3]);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  db = await openGrowthDatabase(url);
  pool = db.pool;
  authDatabaseName = `realm_participation_content_auth_${process.pid}`;
  await db.admin.query(`CREATE DATABASE ${authDatabaseName}`);
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabaseName}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'realm-participation-content',
  };
  // Auth's current consent, served over HTTPS from this process: the worker restores initiators from it.
  const consentReader = createCurrentConsentReader({ database: authPool });
  consent = await startConsentServer(async (input) => (await consentReader.readCurrentConsent(input))?.scopes ?? null);
  kernelWorkerEnvironment = {
    DATABASE_URL: url,
    KERNEL_ROUTE_KEY: Buffer.from(routeKey).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.from(sessionKey).toString('base64url')}`,
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: audience,
    AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    STRIPE_SECRET_KEY: 'sk_test_realm_participation_content_worker',
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
    CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    CONTENT_R2_BUCKET: 'content-media',
    CONTENT_R2_ACCESS_KEY_ID: 'private-access-id',
    CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
    CONTENT_SOURCE_HOSTS: 'images.example.org',
    ...consent.env,
    OPENSEARCH_URL: '',
  };
  worker = await startKernelWorker(kernelWorkerEnvironment);
  work = await createWorkClient(url);
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    workClient: work,
    access: (config) => {
      const access = createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      });
      const authorize = access.authorize.bind(access);
      access.authorize = async (client, actor, action, resource, evidence, time) => {
        if (action === 'realm:participate') participationEvaluations++;
        return authorize(client, actor, action, resource, evidence, time);
      };
      return access;
    },
    writeRate: createWriteRateLimiter({ secret: 'realm-participation-content-write-secret-32bytes' }),
  });
  scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'realm-participation-content-auth-persistent-secret',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(70),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'realm-participation-content-auth',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'realm-participation-content-client', firstParty: true, scopes });
  await host.start();
  governance = await person('realm_participation_content_governance');
  owner = await person('realm_participation_content_owner');
  moderator = await person('realm_participation_content_moderator');
  member = await person('realm_participation_content_member');
  banned = await person('realm_participation_content_banned');
  protectedMember = await person('realm_participation_content_protected_member');
  protectedNonmember = await person('realm_participation_content_protected_nonmember');
  await bootstrapGovernance(pool, governance.accountId);
  await bootstrapRelease(pool, bundledRelease);
  await grant(owner.accountId, ['realm:create', 'space:create', 'subject:create']);
  schemeId = await createSubject('skos:ConceptScheme');
  conceptId = await createSubject('skos:Concept', schemeId);
  publicRealm = await createRealm('public', 'Content participation public Realm');
  protectedRealm = await createRealm('protected', 'Content participation protected Realm');
  await setBoardScheme(publicRealm);
  await setBoardScheme(protectedRealm);
  await grantModerator(publicRealm);
  await grantModerator(protectedRealm);
  await joinPublic(publicRealm, member);
  await joinPublic(publicRealm, banned);
  await joinPublic(publicRealm, moderator);
  await addProtectedMember(protectedRealm, protectedMember);
  await addProtectedMember(protectedRealm, moderator);
  publicBoard = await createBoard(publicRealm, 'Public participation board');
  protectedBoard = await createBoard(protectedRealm, 'Protected participation board');
  const ban = await call('PUT', `/v1/realms/${publicRealm.realmId}/bans/${banned.accountId}`, {
    bearer: moderator.bearer,
    key: crypto.randomUUID(),
    body: { reason: 'Fixture ban for content participation' },
  });
  expect(ban.response.status).toBe(200);
  if (typeof ban.value.ban.workflowId === 'string') await settle(ban.value.ban.workflowId);
  await stopKernelWorker(worker);
  worker = undefined;
}, 120_000);

afterAll(async () => {
  await stopKernelWorker(worker);
  await consent?.close();
  await work?.close();
  await host?.stop();
  if (!host) await authPool?.end();
  if (authDatabaseName) await dropTestDatabase(db!.admin, authDatabaseName);
  await db?.close();
});

function contentBody(text: string) {
  return { body: fromPlainText(text), licence: 'MIT', subjectIds: [] };
}

function problemSnapshot(result: CallResult) {
  const { request_id: _requestId, ...body } = result.value;
  return {
    status: result.response.status,
    headers: [...result.response.headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
    body,
  };
}

async function expectUnknownEquivalent(
  targetRequest: Promise<CallResult>,
  missingRequest: Promise<CallResult>,
  expectedStatus = 404,
) {
  const [target, missing] = await Promise.all([targetRequest, missingRequest]);
  expect(target.response.status).toBe(expectedStatus);
  expect(missing.response.status).toBe(expectedStatus);
  expect(problemSnapshot(target)).toEqual(problemSnapshot(missing));
}

test.serial('public Realm participants write content while a banned account keeps public reads', async () => {
  const threadCheck = participationEvaluations;
  const created = await call('POST', '/v1/threads', {
    bearer: member.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'Member thread in a public Realm',
      ...contentBody('A member writes in a public Realm.'),
      boardId: publicBoard.id,
      visibility: 'published',
    },
  });
  expect(created.response.status).toBe(201);
  expect(participationEvaluations - threadCheck).toBe(1);
  const threadId = created.value.thread.id as string;

  const postCheck = participationEvaluations;
  const post = await call('POST', `/v1/threads/${threadId}/posts`, {
    bearer: member.bearer,
    key: crypto.randomUUID(),
    body: contentBody('A member replies in a public Realm.'),
  });
  expect(post.response.status).toBe(201);
  expect(participationEvaluations - postCheck).toBe(1);

  const reactionCheck = participationEvaluations;
  const reaction = await call('PUT', `/v1/threads/${threadId}/reaction`, {
    bearer: member.bearer,
    key: crypto.randomUUID(),
    body: { kind: 'like' },
  });
  expect(reaction.response.status).toBe(200);
  expect(participationEvaluations - reactionCheck).toBe(1);

  const mediaCheck = participationEvaluations;
  const media = await call('POST', '/v1/media', {
    bearer: member.bearer,
    key: crypto.randomUUID(),
    body: {
      containerId: threadId,
      purpose: 'post-image',
      mediaType: 'image/png',
      byteCount: 256,
      sha256: 'a'.repeat(64),
    },
  });
  expect(media.response.status).toBe(201);
  expect(participationEvaluations - mediaCheck).toBe(1);

  const publicRead = await call('GET', `/v1/threads/${threadId}`, { bearer: banned.bearer });
  expect(publicRead.response.status).toBe(200);
  const deniedWrites = [
    await call('POST', '/v1/threads', {
      bearer: banned.bearer,
      key: crypto.randomUUID(),
      body: {
        title: 'Banned thread attempt',
        ...contentBody('A banned account cannot create a thread.'),
        boardId: publicBoard.id,
        visibility: 'published',
      },
    }),
    await call('POST', `/v1/threads/${threadId}/posts`, {
      bearer: banned.bearer,
      key: crypto.randomUUID(),
      body: contentBody('A banned account cannot create a post.'),
    }),
    await call('PUT', `/v1/threads/${threadId}/reaction`, {
      bearer: banned.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    }),
    await call('POST', '/v1/media', {
      bearer: banned.bearer,
      key: crypto.randomUUID(),
      body: {
        containerId: threadId,
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: 256,
        sha256: 'b'.repeat(64),
      },
    }),
  ];
  expect(deniedWrites.map(({ response }) => response.status)).toEqual([403, 403, 403, 403]);
});

test.serial('protected Realm members write and anonymous callers and nonmembers see identical 404s', async () => {
  const created = await call('POST', '/v1/threads', {
    bearer: protectedMember.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'Member thread in a protected Realm',
      ...contentBody('A member writes in a protected Realm.'),
      boardId: protectedBoard.id,
      visibility: 'published',
    },
  });
  expect(created.response.status).toBe(201);
  const threadId = created.value.thread.id as string;
  const postId = created.value.thread.firstPost.id as string;

  await expectAnonymousAndNonmemberHidden(
    `/v1/realms/${protectedRealm.realmId}/boards`,
    `/v1/realms/${newId(routeOf(protectedRealm.realmId)!)}/boards`,
  );
  await expectAnonymousAndNonmemberHidden(
    `/v1/boards/${protectedBoard.id}`,
    `/v1/boards/${newId(protectedBoard.route)}`,
  );
  await expectAnonymousAndNonmemberHidden(`/v1/threads/${threadId}`, `/v1/threads/${newId(routeOf(threadId)!)}`);
  await expectAnonymousAndNonmemberHidden(`/v1/posts/${postId}`, `/v1/posts/${newId(routeOf(postId)!)}`);
});

test.serial('protected Realm content writes hide unreadable targets and owner addition enables them', async () => {
  const created = await call('POST', '/v1/threads', {
    bearer: protectedMember.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'Protected thread for write concealment',
      ...contentBody('A member creates a thread for the write concealment check.'),
      boardId: protectedBoard.id,
      visibility: 'published',
    },
  });
  expect(created.response.status).toBe(201);
  const threadId = created.value.thread.id as string;
  const unknownBoardId = newId(protectedBoard.route);
  const unknownThreadId = newId(routeOf(threadId)!);

  await expectUnknownEquivalent(
    call('POST', '/v1/threads', {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: {
        title: 'Outsider thread attempt',
        ...contentBody('An outsider tries to create a thread.'),
        boardId: protectedBoard.id,
        visibility: 'published',
      },
    }),
    call('POST', '/v1/threads', {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: {
        title: 'Unknown board thread attempt',
        ...contentBody('An outsider tries to create a thread on an unknown board.'),
        boardId: unknownBoardId,
        visibility: 'published',
      },
    }),
  );
  await expectUnknownEquivalent(
    call('POST', `/v1/threads/${threadId}/posts`, {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: contentBody('An outsider replies to a protected thread.'),
    }),
    call('POST', `/v1/threads/${unknownThreadId}/posts`, {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: contentBody('An outsider replies to an unknown thread.'),
    }),
  );
  await expectUnknownEquivalent(
    call('PUT', `/v1/threads/${threadId}/reaction`, {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    }),
    call('PUT', `/v1/threads/${unknownThreadId}/reaction`, {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: { kind: 'like' },
    }),
  );
  await expectUnknownEquivalent(
    call('POST', '/v1/reports', {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: { target: { kind: 'thread', id: threadId }, reason: 'spam' },
    }),
    call('POST', '/v1/reports', {
      bearer: protectedNonmember.bearer,
      key: crypto.randomUUID(),
      body: { target: { kind: 'thread', id: unknownThreadId }, reason: 'spam' },
    }),
  );

  const publiclyReadable = await call('POST', '/v1/threads', {
    bearer: member.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'Public thread for banned writer',
      ...contentBody('A member creates a public thread for the ban check.'),
      boardId: publicBoard.id,
      visibility: 'published',
    },
  });
  expect(publiclyReadable.response.status).toBe(201);
  const publicThreadId = publiclyReadable.value.thread.id as string;
  expect((await call('GET', `/v1/threads/${publicThreadId}`, { bearer: banned.bearer })).response.status).toBe(200);
  const bannedReply = await call('POST', `/v1/threads/${publicThreadId}/posts`, {
    bearer: banned.bearer,
    key: crypto.randomUUID(),
    body: contentBody('A banned member cannot reply in a readable Realm.'),
  });
  expect(bannedReply.response.status).toBe(403);
  worker = await startKernelWorker(kernelWorkerEnvironment);
  try {
    await addProtectedMember(protectedRealm, protectedNonmember);
  } finally {
    await stopKernelWorker(worker);
    worker = undefined;
  }
  const admittedThread = await call('POST', '/v1/threads', {
    bearer: protectedNonmember.bearer,
    key: crypto.randomUUID(),
    body: {
      title: 'Owner-added member thread',
      ...contentBody('An owner-added member can create a thread.'),
      boardId: protectedBoard.id,
      visibility: 'published',
    },
  });
  expect(admittedThread.response.status).toBe(201);
  expect(
    (
      await call('POST', `/v1/threads/${threadId}/posts`, {
        bearer: protectedNonmember.bearer,
        key: crypto.randomUUID(),
        body: contentBody('An owner-added member can reply.'),
      })
    ).response.status,
  ).toBe(201);
  expect(
    (
      await call('PUT', `/v1/threads/${threadId}/reaction`, {
        bearer: protectedNonmember.bearer,
        key: crypto.randomUUID(),
        body: { kind: 'like' },
      })
    ).response.status,
  ).toBe(200);
  expect(
    (
      await call('POST', '/v1/reports', {
        bearer: protectedNonmember.bearer,
        key: crypto.randomUUID(),
        body: { target: { kind: 'thread', id: threadId }, reason: 'spam' },
      })
    ).response.status,
  ).toBe(201);
});

test.serial('a content write has constant participation cost as unrelated Realms, members and bans grow', async () => {
  const route = routeOf(publicBoard.id)!;
  const growthRoute = route;
  const syntheticAccount = newId(growthRoute);
  const emptyBody = new Uint8Array();
  const emptyBodyHash = new Uint8Array(createHash('sha256').update(emptyBody).digest());
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     VALUES ($1,$2,'actor','active',$3,true)`,
    [growthRoute, syntheticAccount, newId(growthRoute)],
  );
  const population: Population = {
    name: `realm-content-participation-neighbours-${crypto.randomUUID()}`,
    hotPartition: partitionOf(growthRoute),
    hotShare: 1,
    rows({ ordinal }) {
      const spaceId = newId(growthRoute);
      const spaceRevisionId = newId(growthRoute);
      const realmId = newId(growthRoute);
      const realmRevisionId = newId(growthRoute);
      const threadId = newId(growthRoute);
      const postId = newId(growthRoute);
      const revisionId = newId(growthRoute);
      const reservationId = newId(growthRoute);
      const transactionId = newId(growthRoute);
      const at = '2020-01-01T00:00:00.000Z';
      return {
        'access.account': [
          {
            route: growthRoute,
            account_id: transactionId,
            kind: 'actor',
            state: 'active',
            transaction_id: transactionId,
          },
        ],
        'access.resource_initialization': [
          {
            route: growthRoute,
            resource_id: threadId,
            resource_type: 'content.thread',
            creator_id: syntheticAccount,
            initialized_at: at,
          },
          {
            route: growthRoute,
            resource_id: postId,
            resource_type: 'content.post',
            creator_id: syntheticAccount,
            initialized_at: at,
          },
        ],
        'core.receipt': [
          {
            partition_no: partitionOf(growthRoute),
            principal_kind: 'account',
            principal_id: syntheticAccount,
            command_kind: 'content.thread.create',
            idempotency_key: transactionId,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: 1,
            transaction_id: transactionId,
            response: {},
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partitionOf(growthRoute),
            transaction_id: transactionId,
            epoch: 1,
            position: 1_000_000 + ordinal,
            principal_kind: 'account',
            principal_id: syntheticAccount,
            client_id: 'growth-fixture',
            requested_by: null,
          },
        ],
        'core.outbox': [
          {
            partition_no: partitionOf(growthRoute),
            position: 1_000_000 + ordinal,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: transactionId,
            type: 'com.rezics.content.thread.created.v1',
            subject: threadId,
            data: {},
          },
        ],
        'access.membership_inverse': [
          {
            route: growthRoute,
            account_id: syntheticAccount,
            kind: 'realm',
            group_id: realmId,
            reservation_id: reservationId,
            transaction_id: transactionId,
            source_transaction_id: transactionId,
          },
        ],
        'access.resource_role_grant': [
          ...[threadId, postId].map((id, index) => ({
            route: growthRoute,
            resource_id: id,
            subject_kind: 'identity',
            subject_id: syntheticAccount,
            subject_role: '',
            grant_role: index === 0 ? 'content.thread.owner' : 'content.post.owner',
            valid: '[2020-01-01 00:00:00+00,infinity)',
            transaction_id: transactionId,
          })),
          {
            route: growthRoute,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: realmId,
            subject_role: 'member',
            grant_role: 'community.realm.member',
            valid: '[2020-01-01 00:00:00+00,infinity)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route: growthRoute,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: syntheticAccount,
            subject_role: '',
            action: 'realm:read',
            valid: '[2020-01-01 00:00:00+00,infinity)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_denial': ['realm:join', 'realm:participate'].map((action) => ({
          route: growthRoute,
          resource_id: realmId,
          subject_id: syntheticAccount,
          subject_role: '',
          action,
          reason: 'realm_ban',
          valid: '[2020-01-01 00:00:00+00,infinity)',
          transaction_id: transactionId,
        })),
        'community.space': [
          {
            route: growthRoute,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: at,
            creator: syntheticAccount,
          },
        ],
        'community.space_revision': [
          {
            route: growthRoute,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: `Neighbour host ${ordinal}`,
            summary: '',
            created_at: at,
            author: syntheticAccount,
          },
        ],
        'community.realm': [
          {
            route: growthRoute,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: realmRevisionId,
            created_at: at,
            creator: syntheticAccount,
          },
        ],
        'community.realm_revision': [
          {
            route: growthRoute,
            realm_id: realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: `Neighbour Realm ${ordinal}`,
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: at,
            author: syntheticAccount,
          },
        ],
        'community.realm_member': [
          {
            route: growthRoute,
            realm_id: realmId,
            account_id: syntheticAccount,
            role: 'member',
            valid: '[2020-01-01 00:00:00+00,infinity)',
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'community.realm_ban': [
          {
            route: growthRoute,
            realm_id: realmId,
            account_id: syntheticAccount,
            valid: '[2020-01-01 00:00:00+00,infinity)',
            reason: 'Neighbour ban',
            actor: syntheticAccount,
            transaction_id: transactionId,
          },
        ],
        'content.thread': [
          {
            route: growthRoute,
            thread_id: threadId,
            author_account_id: syntheticAccount,
            board_id: publicBoard.id,
            title: `Neighbour thread ${ordinal}`,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
            first_post_id: postId,
            availability: 'available',
          },
        ],
        'content.post': [
          {
            route: growthRoute,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: syntheticAccount,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
            availability: 'available',
          },
        ],
        'content.revision': [
          {
            route: growthRoute,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body: emptyBody,
            body_sha256: emptyBodyHash,
            search_text: '',
            licence: 'MIT',
            subject_ids: [],
            board_id: publicBoard.id,
            availability: 'available',
            recorded_transaction_id: transactionId,
            recorded_at: at,
            media_ids: [],
          },
        ],
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'content write participation with unrelated Realms, members and bans',
    rule: 'series',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    async grow(database, scale, previous) {
      // Start every growing write/Access/C relation on its indexed production plan.
      const baseline = 4096;
      await seed(database, population, { from: previous === 0 ? 0 : baseline + previous, to: baseline + scale });
    },
    async operation(_database, _scale, repetition) {
      const before = participationEvaluations;
      const result = await call('POST', '/v1/threads', {
        bearer: member.bearer,
        key: crypto.randomUUID(),
        body: {
          title: `Fixed participation growth thread ${repetition}`,
          ...contentBody('A fixed content participation growth write.'),
          boardId: publicBoard.id,
          visibility: 'published',
        },
      });
      expect(result.response.status).toBe(201);
      expect(participationEvaluations - before).toBe(1);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  for (const { cost } of report.samples) {
    for (const [name, relation] of Object.entries(cost.relations ?? {})) {
      if (name.startsWith('community.') || name.startsWith('access.resource_') || name === 'access.membership_inverse')
        expect(relation.sequentialScans).toBe(0);
    }
  }
});
