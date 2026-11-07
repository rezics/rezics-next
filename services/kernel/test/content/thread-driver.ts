import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createHash } from 'node:crypto';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool, type Pool as PgPool } from 'pg';
import type {
  ApiResult,
  ContentThreadDriver,
  Evidence,
  Fixture,
  ItemInput,
  ItemView,
  Persona,
  RevisionRow,
  ThreadInput,
  ThreadView,
  Visibility,
  WriteOptions,
} from '../../../../specs/content-thread-driver.ts';
import permissionRead from '../../src/access/permission-check.sql';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';
import fenceStatement from '../../src/command/fence.sql';
import readReceipt from '../../src/command/read-receipt.sql';
import insertPost from '../../src/content/create-post.sql';
import insertRevision from '../../src/content/create-revision.sql';
import insertThread from '../../src/content/create-thread.sql';
import { threadTarget } from '../../src/content/commands.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { observeSql, permissionResourceId, type SqlObserver } from './support/sql-observer.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const AUDIENCE = 'https://content.test';
const MEASURED_KEYS = 24;
const suiteDrivers = new Set<ContentThreadDriver>();
let suiteSystemPromise: Promise<NativeContentSystem> | undefined;
const suiteWriteRateOverrides = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});

/** Case-owned SQL observers stop before measured growth starts a host on its observed pool. */
async function releaseSuiteDrivers(): Promise<void> {
  const drivers = [...suiteDrivers];
  await Promise.all(drivers.map((driver) => driver.close()));
}
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Credential = { bearer: string; actor: AccountActor };
type Stage = 'authorize' | 'receipt' | 'body' | 'write';
type ProductItem = {
  id: string;
  threadId: string;
  route: number;
  revisionId: string;
  authorId: string;
  licence: string;
  subjectIds: string[];
  boardId: string;
  parentId: string | null;
  body: ItemView['body'];
};
type ProductThread = {
  id: string;
  route: number;
  title: string;
  authorId: string;
  licence: string;
  subjectIds: string[];
  boardId: string;
  firstPost: ProductItem;
};
type RevisionSource = {
  route: number;
  thread_id: string;
  post_id: string;
  search_text: string;
  licence: string;
  subject_ids: string[];
  board_id: string;
  media_ids: string[];
  availability: string;
};

function personaOf(credential: Credential): Persona {
  return { id: credential.actor.accountId, bearer: credential.bearer };
}

function routedId(id: string): string {
  if (!CANONICAL_UUID.test(id) || routeOf(id) === null) throw new Error('Content id is not a routed UUID');
  return id;
}

function requestFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter((entry) => entry[1] !== undefined));
}

function writeCall(
  options: WriteOptions,
  body: Record<string, unknown>,
): { key: string; session?: string; body: Record<string, unknown> } {
  const call: { key: string; session?: string; body: Record<string, unknown> } = { key: options.key, body };
  if (options.session !== undefined) call.session = options.session;
  return call;
}

function postgresFailure(error: unknown): { code: string; constraint: string } | undefined {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return undefined;
  const constraint = 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : '';
  return { code: error.code, constraint };
}

function itemView(value: ProductItem): ItemView {
  if (!Array.isArray(value.subjectIds)) throw new Error('Content item is missing subjectIds');
  return {
    id: value.id,
    threadId: value.threadId,
    route: value.route,
    revisionId: value.revisionId,
    authorId: value.authorId,
    licence: value.licence,
    subjectIds: [...value.subjectIds],
    boardId: value.boardId,
    parentId: value.parentId,
    body: value.body,
  };
}

function threadView(value: ProductThread): ThreadView {
  if (!Array.isArray(value.subjectIds) || !value.firstPost) throw new Error('Content thread is missing its first post');
  return {
    id: value.id,
    route: value.route,
    title: value.title,
    authorId: value.authorId,
    licence: value.licence,
    subjectIds: [...value.subjectIds],
    boardId: value.boardId,
    firstPost: itemView(value.firstPost),
  };
}

function byteValue(value: unknown): Uint8Array {
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error('Revision body is not stored bytea');
}

function hexValue(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'string') return value;
  throw new Error('Revision digest is not stored bytea');
}

function textIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Stored subject ids are missing');
  return value.map((id) => {
    if (typeof id !== 'string') throw new Error('Stored subject id is not text');
    return id;
  });
}

function parameter(record: { parameters: readonly unknown[] }, names: readonly string[], name: string): unknown {
  const index = names.indexOf(name);
  if (index < 0) throw new Error(`SQL parameter ${name} is not bound`);
  return record.parameters[index];
}

function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error('Permission time is not a timestamp');
}

function databaseName(prefix: string): string {
  const name = `${prefix}${crypto.randomUUID().replaceAll('-', '')}`;
  if (!/^[a-z][a-z0-9]+$/.test(name)) throw new Error('Generated database name is not a safe identifier');
  return name;
}

function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.href;
}

function namedUrl(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.href;
}

async function boardCommand<T>(
  kernel: ReturnType<typeof createKernel>,
  actor: Credential,
  method: 'POST' | 'PUT',
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await kernel.handle(
    new Request(`${AUDIENCE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${actor.bearer}`,
        'content-type': 'application/json',
        [IDEMPOTENCY_HEADER]: JSON.stringify(crypto.randomUUID()),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    throw new Error(`Board fixture ${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function provisionBoard(
  kernel: ReturnType<typeof createKernel>,
  creator: Credential,
  subjectCreator: Credential,
  visibility: 'published' | 'protected',
  label: string,
): Promise<{ id: string; route: number }> {
  const { space } = await boardCommand<{ space: { spaceId: string } }>(kernel, creator, 'POST', '/v1/spaces', {
    title: `${label} space`,
    summary: `${label} board fixture`,
  });
  const { realm } = await boardCommand<{ realm: { realmId: string; headRevisionId: string } }>(
    kernel,
    creator,
    'POST',
    '/v1/realms',
    {
      spaceId: space.spaceId,
      title: `${label} realm`,
      summary: `${label} board fixture`,
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
  );
  const { subject: scheme } = await boardCommand<{ subject: { id: string } }>(
    kernel,
    subjectCreator,
    'POST',
    '/v1/subjects',
    { type: 'skos:ConceptScheme', labels: { en: `${label} scheme` } },
  );
  const { subject: concept } = await boardCommand<{ subject: { id: string } }>(
    kernel,
    subjectCreator,
    'POST',
    '/v1/subjects',
    {
      type: 'skos:Concept',
      labels: { en: `${label} concept` },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
      },
    },
  );
  await boardCommand(
    kernel,
    creator,
    'PUT',
    `/v1/realms/${realm.realmId}/boardScheme`,
    { schemeId: scheme.id },
    { 'if-match': JSON.stringify(realm.headRevisionId) },
  );
  const { board } = await boardCommand<{ board: { id: string; route: number } }>(
    kernel,
    creator,
    'POST',
    `/v1/realms/${realm.realmId}/boards`,
    { conceptId: concept.id, title: `${label} board`, visibility },
  );
  return { id: board.id, route: board.route };
}

/** The measured kernel must use the already-open growth pool. Cloning that database
 * would require disconnecting the observer that records the request. */
export async function openMeasuredThreadCreate(database: { url: string; pool: PgPool; admin: PgPool }): Promise<{
  grow(db: { admin: PgPool }, scale: number, previous: number): Promise<void>;
  operation(db: { pool: PgPool }, scale: number, repetition: number): Promise<number>;
  close(): Promise<void>;
}> {
  await closeContentThreadSystem();
  const authName = databaseName('contentauth');
  const maintainer = new Pool({ connectionString: maintenanceUrl(database.url) });
  const authPool = new Pool({ connectionString: namedUrl(database.url, authName) });
  // Auth ends this pool on start failure and again on stop. Share one close.
  const endAuthPool = authPool.end.bind(authPool);
  let authEnding: Promise<void> | undefined;
  authPool.end = () => (authEnding ??= endAuthPool());
  let authCreated = false;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      const release = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      if (host) await release(() => host!.stop());
      await release(() => authPool.end());
      if (authCreated) await release(() => dropTestDatabase(maintainer, authName));
      await release(() => maintainer.end());
      if (errors.length) throw new AggregateError(errors, 'Measured content cleanup failed');
    })());

  try {
    await createAuthDatabase(database.url, authName);
    authCreated = true;

    const namespace = authName;
    const issuer = `https://${namespace}.auth.test`;
    const routeKey = crypto.getRandomValues(new Uint8Array(32));
    const tokenKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    const referenceKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
    const clock = () => new Date();
    let nativeAuth: AuthService;
    const kernel = createKernel({
      receiptKeys: testReceiptKeys(),
      pool: database.pool,
      routeKey,
      tokens: tokenKeys,
      clock,
      content: { cursorNow: () => clock().getTime() },
      access: () => access,
      writeRate: createWriteRateLimiter({ secret: crypto.randomUUID() + crypto.randomUUID(), overrides: '{}' }),
      ratePeer: () => '127.0.0.1',
    });
    const actions = actionCatalogue(kernel);
    const access = (await import('../../src/access/index.ts')).createAccess({
      actions,
      auth: {
        issuer,
        audience: AUDIENCE,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: (input, init) => nativeAuth.handler(new Request(input, init)),
      },
    });
    const proofs = createNativeWorkflowProofPorts({ database: authPool });
    const bindings = createNativeAccountBindings({
      pool: database.pool,
      access,
      actions: new Map([...LIFECYCLE_ACTIONS, ['account:manage', { anonymous: false }], ...actions]),
      routeKey,
      clock,
      referenceKeys,
      auth: () => nativeAuth,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
        barriers: createBarrierProofVerifier({ database: authPool }),
      },
    });
    const pair = await generateKeyPair('ES256', { extractable: true });
    const privateKey = { ...(await exportJWK(pair.privateKey)), kid: namespace };
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience: AUDIENCE,
      secret: crypto.randomUUID() + crypto.randomUUID(),
      signing: { activeKid: privateKey.kid, privateKeys: [privateKey] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      stagingKey: crypto.getRandomValues(new Uint8Array(32)),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: namespace,
    });
    nativeAuth = host.service;
    const ordinaryClient = { id: `${namespace}_ordinary` };
    const scopes = [...actions.keys()].filter((action) => action !== 'media:complete').sort();
    await nativeAuth.internal.registerClient({ clientId: ordinaryClient.id, firstParty: true, scopes });
    await host.start();

    const password = crypto.randomUUID() + crypto.randomUUID();
    const requestAuth = async (path: string, body: unknown, cookie = '') => {
      const response = await nativeAuth.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
      if (!response.ok) throw new Error(`Measured Auth ${path} denied (${response.status}): ${await response.text()}`);
      return response;
    };
    const issue = async (accountId: string): Promise<Credential> => {
      const signed = await requestAuth('/signin', {
        account_id: accountId,
        password,
        client_id: ordinaryClient.id,
        scope: scopes,
      });
      const cookie = signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const token = await requestAuth('/token', {}, cookie);
      const { access_token: bearer } = (await token.json()) as { access_token: string };
      const actor = await access.authenticate(bearer, { pool: database.pool, deadline: Date.now() + 10_000 });
      if (actor.kind !== 'account') throw new Error('Measured Auth did not authenticate an account');
      return { bearer, actor };
    };
    const person = async (name: string) => {
      const { accountId } = await host!.workflows.register({
        key: name,
        handle: name,
        email: `${name}@content.test`,
        password,
      });
      return issue(accountId);
    };
    const governance = await person('governance');
    await bootstrapGovernance(database.pool, governance.actor.accountId);
    await bootstrapRelease(database.pool, bundledRelease);
    const author = await person('author');
    const grant = await kernel.handle(
      new Request(`${AUDIENCE}/v1/grants`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${governance.bearer}`,
          'content-type': 'application/json',
          [IDEMPOTENCY_HEADER]: JSON.stringify(crypto.randomUUID()),
        },
        body: JSON.stringify({
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: author.actor.accountId },
          actions: ['space:create', 'realm:create'],
          valid: '(,)',
        }),
      }),
    );
    if (grant.status !== 201) throw new Error(`Measured parent grant failed (${grant.status}): ${await grant.text()}`);

    const board = await provisionBoard(kernel, author, governance, 'published', 'Measured');

    const keys: string[] = [];
    const keyRoutes: number[] = [];
    let hotPartition = -1;
    // Precompute fresh idempotency keys that share a write partition. Rows are
    // distributed across the exact routes that those keys produce.
    for (let attempt = 0; keys.length < MEASURED_KEYS && attempt < 8_000_000; attempt++) {
      const key = `growth-${attempt}`;
      const route = threadTarget(routeKey, author.actor.accountId, key).route;
      const partition = partitionOf(route);
      if (hotPartition < 0) hotPartition = partition;
      if (partition === hotPartition) {
        keys.push(key);
        keyRoutes.push(route);
      }
    }
    if (keys.length < MEASURED_KEYS || hotPartition < 0) throw new Error('Could not anchor measured thread keys');
    const seedBody = Buffer.from('unrelated measured neighbour');
    const seedDigest = createHash('sha256').update(seedBody).digest();
    const body = fromPlainText('Measured thread body');

    return {
      async grow(db, scale, previous) {
        const count = scale - previous;
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Growth seed count is not valid');
        if (count === 0) return;
        const routes = Array.from({ length: count }, (_, index) => keyRoutes[index % keyRoutes.length]!);
        const threadIds: string[] = [];
        const postIds: string[] = [];
        const revisionIds: string[] = [];
        const transactionIds: string[] = [];
        for (let index = 0; index < count; index++) {
          threadIds.push(newId(routes[index]!));
          postIds.push(newId(routes[index]!));
          revisionIds.push(newId(routes[index]!));
          transactionIds.push(crypto.randomUUID());
        }
        const client = await db.admin.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO content.thread
               (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
                recorded_transaction_id, first_post_id, availability)
             SELECT route, thread_id, $2, $3, 'Unrelated thread', 'published', 1, transaction_id, post_id, 'available'
             FROM unnest($1::integer[], $4::uuid[], $5::uuid[], $6::uuid[])
               AS row(route, thread_id, post_id, transaction_id)`,
            [routes, author.actor.accountId, board.id, threadIds, postIds, transactionIds],
          );
          await client.query(
            `INSERT INTO content.post
               (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id, visibility,
                security_revision, recorded_transaction_id, availability)
             SELECT route, thread_id, post_id, NULL, $2, revision_id, 'published', 1, transaction_id, 'available'
             FROM unnest($1::integer[], $3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[])
               AS row(route, thread_id, post_id, revision_id, transaction_id)`,
            [routes, author.actor.accountId, threadIds, postIds, revisionIds, transactionIds],
          );
          await client.query(
            `INSERT INTO content.revision
               (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids,
                board_id, availability, recorded_transaction_id, media_ids)
             SELECT route, thread_id, post_id, revision_id, $2, $3, 'unrelated', 'MIT', '{}'::uuid[], $4, 'available',
                    transaction_id, '{}'::uuid[]
             FROM unnest($1::integer[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[])
               AS row(route, thread_id, post_id, revision_id, transaction_id)`,
            [routes, seedBody, seedDigest, board.id, threadIds, postIds, revisionIds, transactionIds],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await db.admin.query('ANALYZE content.board, content.thread, content.post, content.revision');
      },
      async operation(db, _scale, repetition) {
        if (db.pool !== database.pool) throw new Error('Measured thread create must use the observed growth pool');
        const key = keys[repetition];
        if (!key) throw new Error('Measured thread key was not anchored');
        const response = await kernel.handle(
          new Request(`${AUDIENCE}/v1/threads`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${author.bearer}`,
              'content-type': 'application/json',
              [IDEMPOTENCY_HEADER]: JSON.stringify(key),
            },
            body: JSON.stringify({
              title: 'Measured thread',
              body,
              licence: 'MIT',
              subjectIds: [],
              boardId: board.id,
              visibility: 'published',
            }),
          }),
        );
        if (response.status !== 201) {
          throw new Error(`Measured thread create failed (${response.status}): ${await response.text()}`);
        }
        return response.status;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Measured content construction and cleanup failed');
    }
    throw error;
  }
}

async function threadOutcomeSystem(): Promise<NativeContentSystem> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  suiteSystemPromise ??= createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl },
    suiteWriteRateOverrides,
  ).catch((error: unknown) => {
    suiteSystemPromise = undefined;
    throw error;
  });
  return suiteSystemPromise;
}

/** Build the suite's shared native system from its file-level beforeAll hook. */
export async function initializeContentThreadSystem(): Promise<void> {
  await threadOutcomeSystem();
}

/** Close shared suite resources after the per-case SQL observers have stopped. */
export async function closeContentThreadSystem(): Promise<void> {
  await releaseSuiteDrivers();
  const system = await suiteSystemPromise?.catch(() => undefined);
  suiteSystemPromise = undefined;
  await system?.close();
}

export async function createContentThreadDriver(): Promise<ContentThreadDriver> {
  const system = await threadOutcomeSystem();
  let driver: ContentThreadDriver;
  try {
    driver = bindDriver(system);
  } catch (error) {
    throw error;
  }
  let closing: Promise<void> | undefined;
  const stop = driver.close.bind(driver);
  driver.close = () => {
    suiteDrivers.delete(driver);
    return (closing ??= stop());
  };
  suiteDrivers.add(driver);
  return driver;
}

function bindDriver(system: NativeContentSystem): ContentThreadDriver {
  const observer: SqlObserver = observeSql(system.database.pool);
  const pool = system.database.pool;
  const writeNamespace = crypto.randomUUID();
  let mark = 0;
  let fixtureSemanticIds = new Set<string>();
  let authorCredential = system.actors.author;
  let otherCredential = system.actors.other;
  let moderatorCredential = system.actors.moderator;
  let owner = personaOf(authorCredential);
  let other = personaOf(otherCredential);
  let moderator = personaOf(moderatorCredential);
  let suspendedActorId: string | undefined;
  const scopes = [...system.actions.keys()].filter((action) => action !== 'media:complete').sort();

  async function refreshCaseCredentials(): Promise<void> {
    const issue = (credential: typeof system.actors.author) =>
      system.auth.issue({
        accountId: credential.actor.accountId,
        clientId: credential.actor.clientId,
        scopes: credential.actor.scopes,
      });
    [authorCredential, otherCredential, moderatorCredential] = await Promise.all([
      issue(authorCredential),
      issue(otherCredential),
      issue(moderatorCredential),
    ]);
    owner = personaOf(authorCredential);
    other = personaOf(otherCredential);
    moderator = personaOf(moderatorCredential);
  }

  function beginTrace(): void {
    mark = observer.records.length;
  }

  function scopedWriteCall(options: WriteOptions, body: Record<string, unknown>) {
    try {
      const key = JSON.parse(options.key);
      if (typeof key === 'string') {
        return writeCall({ ...options, key: JSON.stringify(`${writeNamespace}:${key}`) }, body);
      }
    } catch {
      // Preserve malformed caller keys so the request still exercises validation.
    }
    return writeCall(options, body);
  }

  async function send(
    method: string,
    path: string,
    actor: Persona | null,
    init: { key?: string; session?: string; body?: Record<string, unknown> } = {},
  ): Promise<Response> {
    beginTrace();
    const headers = new Headers();
    if (actor) headers.set('authorization', `Bearer ${actor.bearer}`);
    if (init.key !== undefined) headers.set(IDEMPOTENCY_HEADER, init.key);
    if (init.session !== undefined) headers.set(SESSION_HEADER, init.session);
    const request: RequestInit = { method, headers };
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
      request.body = JSON.stringify(init.body);
    }
    return system.kernel.handle(new Request(`${AUDIENCE}${path}`, request));
  }

  async function parsed<T>(response: Response, read: (body: unknown) => T): Promise<ApiResult<T>> {
    if (response.status !== 200 && response.status !== 201) return { response, value: null };
    return { response, value: read(await response.clone().json()) };
  }

  async function createBoard(
    creator: Credential,
    visibility: 'published' | 'protected',
  ): Promise<{ id: string; route: number }> {
    return provisionBoard(
      system.kernel,
      creator,
      creator,
      visibility,
      visibility === 'published' ? 'Public thread fixture' : 'Protected thread fixture',
    );
  }

  const driver: ContentThreadDriver = {
    async close() {
      if (suspendedActorId) {
        const governance = await pool.query<{ account_id: string }>(
          `SELECT account_id::text AS account_id FROM access.governance_bootstrap WHERE route=0 AND resource_id=$1`,
          [PLATFORM_RESOURCE.id],
        );
        const accountId = governance.rows[0]?.account_id;
        if (!accountId) throw new Error('Governance bootstrap account is missing');
        const credential = await system.auth.issue({
          accountId,
          clientId: system.auth.ordinaryClient.id,
          scopes,
        });
        const response = await send(
          'POST',
          `/v1/accounts/${routedId(suspendedActorId)}:reinstate`,
          personaOf(credential),
          { key: JSON.stringify(crypto.randomUUID()), body: { reason: 'Restore shared thread fixture' } },
        );
        if (response.status !== 200) {
          throw new Error(`Account reinstatement failed (${response.status}): ${await response.text()}`);
        }
        suspendedActorId = undefined;
      }
      await observer.close();
    },
    async provision() {
      await refreshCaseCredentials();
      await bootstrapRelease(pool, bundledRelease);
      const board = await createBoard(authorCredential, 'published');
      const privateBoard = await createBoard(authorCredential, 'protected');
      const semantic = await pool.query<{ id: string }>('SELECT subject_id::text AS id FROM semantic.subject');
      fixtureSemanticIds = new Set(semantic.rows.map((row) => row.id));
      const subjectIds = [newId(9), newId(10), newId(11)];
      const home = threadTarget(system.routeKey, owner.id, 'create').route;
      let foreignKey = '';
      for (let attempt = 0; attempt < 100_000; attempt++) {
        const key = `foreign-${attempt}`;
        if (threadTarget(system.routeKey, owner.id, key).route !== home) {
          foreignKey = key;
          break;
        }
      }
      if (!foreignKey) throw new Error('Could not place a foreign thread on another route');
      const created = await driver.create(
        {
          title: 'Foreign thread',
          body: fromPlainText('Foreign thread'),
          licence: 'MIT',
          subjectIds: [],
          boardId: board.id,
          visibility: 'published',
        },
        { actor: owner, key: JSON.stringify(foreignKey) },
      );
      if (!created.value) {
        throw new Error(`Foreign thread create failed (${created.response.status}): ${await created.response.text()}`);
      }
      const fixture: Fixture = {
        owner,
        other,
        moderator,
        board,
        privateBoard,
        subjectIds,
        unknownThread: newId(7),
        unknownItem: newId(8),
        foreignThread: created.value,
        foreignItem: created.value.firstPost,
      };
      return fixture;
    },
    async create(input: ThreadInput, options: WriteOptions) {
      const response = await send(
        'POST',
        '/v1/threads',
        options.actor,
        scopedWriteCall(
          options,
          requestFields({
            title: input.title,
            body: input.body,
            licence: input.licence,
            subjectIds: input.subjectIds,
            boardId: input.boardId,
            visibility: input.visibility,
            authorId: input.authorId,
          }),
        ),
      );
      return parsed(response, (body) => threadView((body as { thread: ProductThread }).thread));
    },
    async createPost(input: ItemInput, options: WriteOptions) {
      const response = await send(
        'POST',
        `/v1/threads/${routedId(input.threadId)}/posts`,
        options.actor,
        scopedWriteCall(
          options,
          requestFields({
            body: input.body,
            licence: input.licence,
            subjectIds: input.subjectIds,
            boardId: input.boardId,
            authorId: input.authorId,
          }),
        ),
      );
      return parsed(response, (body) => itemView((body as { post: ProductItem }).post));
    },
    async reply(input, options) {
      const response = await send(
        'POST',
        `/v1/threads/${routedId(input.threadId)}/posts`,
        options.actor,
        scopedWriteCall(
          options,
          requestFields({
            body: input.body,
            licence: input.licence,
            parentId: input.parentId,
            subjectIds: input.subjectIds,
            boardId: input.boardId,
            authorId: input.authorId,
          }),
        ),
      );
      return parsed(response, (body) => itemView((body as { post: ProductItem }).post));
    },
    async revise(input, options) {
      const response = await send(
        'POST',
        `/v1/posts/${routedId(input.itemId)}/revisions`,
        options.actor,
        scopedWriteCall(
          options,
          requestFields({
            body: input.body,
            licence: input.licence,
            subjectIds: input.subjectIds,
            boardId: input.boardId,
            authorId: input.authorId,
          }),
        ),
      );
      return parsed(response, (body) => itemView((body as { post: ProductItem }).post));
    },
    async readThread(id, actor) {
      const response = await send('GET', `/v1/threads/${routedId(id)}`, actor);
      return parsed(response, (body) => threadView((body as { thread: ProductThread }).thread));
    },
    async readItem(threadId, itemId, actor, revisionId) {
      routedId(threadId);
      const path = revisionId
        ? `/v1/posts/${routedId(itemId)}/revisions/${routedId(revisionId)}`
        : `/v1/posts/${routedId(itemId)}`;
      const response = await send('GET', path, actor);
      return parsed(response, (body) => itemView((body as { post: ProductItem }).post));
    },
    async readHistory(threadId, itemId, actor) {
      routedId(threadId);
      const response = await send('GET', `/v1/posts/${routedId(itemId)}/revisions?limit=100`, actor);
      return parsed(response, (body) => {
        const revisions = (body as { revisions?: ProductItem[] }).revisions;
        if (!Array.isArray(revisions)) throw new Error('Content history is missing revisions');
        return revisions.map(itemView);
      });
    },
    async readItems(threadId, actor) {
      const response = await send('GET', `/v1/threads/${routedId(threadId)}/posts?limit=100`, actor);
      return parsed(response, (body) => {
        const posts = (body as { posts?: ProductItem[] }).posts;
        if (!Array.isArray(posts)) throw new Error('Content thread is missing posts');
        return posts.map(itemView);
      });
    },
    async readList(boardId, actor) {
      const response = await send('GET', `/v1/boards/${routedId(boardId)}/threads?limit=100`, actor);
      return parsed(response, (body) => {
        const threads = (body as { threads?: ProductThread[] }).threads;
        if (!Array.isArray(threads)) throw new Error('Content board is missing threads');
        return threads.map(threadView);
      });
    },
    async inspect() {
      const client = await pool.connect();
      try {
        const threads = await client.query<{ id: string; route: number; boardId: string; authorId: string }>(
          `SELECT thread_id::text AS id, route, board_id::text AS "boardId", author_account_id::text AS "authorId"
           FROM content.thread ORDER BY thread_id`,
        );
        const items = await client.query<{
          id: string;
          threadId: string;
          route: number;
          parentId: string | null;
          authorId: string;
        }>(
          `SELECT post_id::text AS id, thread_id::text AS "threadId", route,
                  reply_to_post_id::text AS "parentId", author_account_id::text AS "authorId"
           FROM content.post ORDER BY post_id`,
        );
        const revisions = await client.query<{
          id: string;
          itemId: string;
          threadId: string;
          route: number;
          body: unknown;
          sha256: unknown;
          searchText: string | null;
          licence: string;
          subjectIds: unknown;
          boardId: string;
        }>(
          `SELECT revision_id::text AS id, post_id::text AS "itemId", thread_id::text AS "threadId", route,
                  body, body_sha256 AS sha256, search_text AS "searchText", licence,
                  subject_ids AS "subjectIds", board_id::text AS "boardId"
           FROM content.revision ORDER BY revision_id`,
        );
        const receipts = await client.query<{ key: string; partition: number; command: string }>(
          `SELECT idempotency_key AS key, partition_no AS partition, command_kind AS command
           FROM core.receipt ORDER BY partition_no, idempotency_key, command_kind, principal_id`,
        );
        const outbox = await client.query<{
          id: string;
          partition: number;
          command: string;
          threadId: string;
          itemId: string;
          revisionId: string;
          actorId: string;
        }>(
          `SELECT o.id::text AS id, o.partition_no AS partition, r.command_kind AS command,
                  o.data->>'threadId' AS "threadId", o.data->>'itemId' AS "itemId",
                  o.data->>'revisionId' AS "revisionId", o.data->>'actorId' AS "actorId"
           FROM core.outbox o
           JOIN core.receipt r ON r.partition_no = o.partition_no AND r.position = o.position
           WHERE o.data ? 'threadId' AND o.data ? 'itemId' AND o.data ? 'revisionId' AND o.data ? 'actorId'
           ORDER BY o.id`,
        );
        const claims = await client.query<{ id: string; itemId: string }>(
          `SELECT media_id::text AS id, container_id::text AS "itemId"
           FROM content.media WHERE claimed_at IS NOT NULL ORDER BY media_id`,
        );
        const semantic = await client.query<{ id: string }>(
          `SELECT subject_id::text AS id FROM semantic.subject ORDER BY subject_id`,
        );
        const evidence: Evidence = {
          threads: threads.rows,
          items: items.rows,
          revisions: revisions.rows.map((row): RevisionRow => ({
            id: row.id,
            itemId: row.itemId,
            threadId: row.threadId,
            route: row.route,
            body: byteValue(row.body),
            sha256: hexValue(row.sha256),
            searchText: row.searchText ?? '',
            licence: row.licence,
            subjectIds: textIds(row.subjectIds),
            boardId: row.boardId,
          })),
          receipts: receipts.rows,
          outbox: outbox.rows.map((row) => ({
            id: row.id,
            partition: row.partition,
            command: row.command,
            envelope: {
              threadId: row.threadId,
              itemId: row.itemId,
              revisionId: row.revisionId,
              actorId: row.actorId,
            },
          })),
          claims: claims.rows,
          semanticRows: semantic.rows.map((row) => row.id).filter((id) => !fixtureSemanticIds.has(id)),
        };
        return evidence;
      } finally {
        client.release();
      }
    },
    fixtures: {
      // A per-actor denial leaves the indivisible active-accounts standing grant in place.
      async revokeParentCreate(actorId, boardId) {
        const route = routeOf(routedId(boardId));
        await pool.query(
          `INSERT INTO access.resource_denial
             (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
           VALUES ($1, $2, $3, '', 'thread:create', 'resource', '(,)', $4)`,
          [route, boardId, routedId(actorId), crypto.randomUUID()],
        );
      },
      async suspend(actorId) {
        const governance = await pool.query<{ account_id: string }>(
          `SELECT account_id::text AS account_id FROM access.governance_bootstrap`,
        );
        const accountId = governance.rows[0]?.account_id;
        if (!accountId) throw new Error('Governance bootstrap account is missing');
        const credential = await system.auth.issue({
          accountId,
          clientId: system.auth.ordinaryClient.id,
          scopes,
        });
        const response = await send('POST', `/v1/accounts/${routedId(actorId)}:suspend`, personaOf(credential), {
          key: JSON.stringify(crypto.randomUUID()),
          body: { reason: 'Suspended persona' },
        });
        if (response.status !== 200) {
          throw new Error(`Account suspend failed (${response.status}): ${await response.text()}`);
        }
        suspendedActorId = actorId;
      },
      async visibility(id, state: Visibility) {
        const route = routeOf(routedId(id));
        const thread = await pool.query(
          `UPDATE content.thread
           SET visibility = $3, security_revision = security_revision + 1
           WHERE route = $1 AND thread_id = $2`,
          [route, id, state],
        );
        if ((thread.rowCount ?? 0) > 0) return;
        const post = await pool.query(
          `UPDATE content.post
           SET visibility = $3, security_revision = security_revision + 1
           WHERE route = $1 AND post_id = $2`,
          [route, id, state],
        );
        if ((post.rowCount ?? 0) !== 1) throw new Error('Visibility target is missing');
      },
      async failBeforeOutbox() {
        observer.armFault({
          match: { statement: fenceStatement.sql },
          boundary: 'before',
          error: new CommandUnavailableError('overloaded', 0),
        });
      },
    },
    async storage() {
      const column = await pool.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'content' AND table_name = 'revision' AND column_name = 'body'`,
      );
      const compression = await pool.query<{ attcompression: string | null }>(
        `SELECT attcompression FROM pg_attribute
         WHERE attrelid = 'content.revision'::regclass AND attname = 'body'`,
      );
      const code = compression.rows[0]?.attcompression;
      const name = code === 'l' ? 'lz4' : code === 'p' ? 'pglz' : code;
      const bodyType = column.rows[0]?.data_type;
      if (!bodyType || !name) throw new Error('Revision body catalog row is missing');
      return { schema: 'content', bodyType, compression: name };
    },
    async probeRevision(sourceRevisionId, body, sha256) {
      const route = routeOf(routedId(sourceRevisionId));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const found = await client.query<RevisionSource>(
            `SELECT route, thread_id, post_id, search_text, licence, subject_ids, board_id, media_ids, availability
             FROM content.revision WHERE route = $1 AND revision_id = $2`,
            [route, sourceRevisionId],
          );
          const source = found.rows[0];
          if (!source) throw new Error('Probe source revision is missing');
          await client.query(
            `INSERT INTO content.revision
               (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids,
                board_id, availability, recorded_transaction_id, media_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              source.route,
              source.thread_id,
              source.post_id,
              newId(source.route),
              Buffer.from(body),
              Buffer.from(sha256, 'hex'),
              source.search_text,
              source.licence,
              source.subject_ids,
              source.board_id,
              source.availability,
              crypto.randomUUID(),
              source.media_ids,
            ],
          );
          throw new Error('Probe revision insert was accepted');
        } catch (error) {
          const failure = postgresFailure(error);
          if (!failure) throw error;
          return { sqlstate: failure.code, constraint: failure.constraint };
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    },
    async session(response, actor) {
      const token = response.headers.get(SESSION_HEADER);
      if (!token) throw new Error('Session header is absent');
      const components = decodeSession(system.tokenKeys, `account:${actor.id}`, token);
      if (!components) throw new Error('Session token did not verify');
      return { token, partitions: components.map((component) => component.partition) };
    },
    async commandTrace() {
      const records = observer.records.slice(mark);
      const receiptAt = records.findIndex((record) => record.statement === readReceipt.sql);
      const bodyStatements = new Set<string>([insertThread.sql, insertPost.sql, insertRevision.sql]);
      const bodyAt = records.findIndex((record) => bodyStatements.has(record.statement));
      // Board projection and read hydration run after the content command commits.
      // Their fences are separate transactions and are not this command's writes.
      let commandFenceUntil = bodyAt < 0 ? 0 : records.length;
      if (bodyAt >= 0) {
        for (let index = bodyAt + 1; index < records.length; index++) {
          const statement = records[index]!.statement;
          if (statement === 'COMMIT' || statement === 'ROLLBACK') {
            commandFenceUntil = index;
            break;
          }
        }
      }
      const stages: Stage[] = [];
      const checks: { action: string; resourceId: string; partition: number; statement: number; at: string }[] = [];
      const writePartitions: number[] = [];
      const add = (stage: Stage) => {
        if (!stages.includes(stage)) stages.push(stage);
      };
      records.forEach((record, index) => {
        if (record.statement === permissionRead.sql && (receiptAt < 0 || index < receiptAt)) {
          add('authorize');
          const route = Number(parameter(record, permissionRead.params, 'route'));
          checks.push({
            action: String(parameter(record, permissionRead.params, 'action')),
            resourceId: permissionResourceId(record, permissionRead.params),
            partition: route >>> 4,
            statement: index + 1,
            at: instant(parameter(record, permissionRead.params, 'at')),
          });
        } else if (record.statement === readReceipt.sql && (bodyAt < 0 || index < commandFenceUntil)) {
          add('receipt');
        } else if (bodyStatements.has(record.statement)) {
          add('body');
        } else if (record.statement === fenceStatement.sql && index < commandFenceUntil) {
          add('write');
          writePartitions.push(Number(parameter(record, fenceStatement.params, 'partition_no')));
        }
      });
      return {
        checks,
        stages,
        writePartitions,
        throughRunCommand: records.some((record) => record.statement === 'BEGIN ISOLATION LEVEL SERIALIZABLE'),
      };
    },
  };
  return driver;
}
