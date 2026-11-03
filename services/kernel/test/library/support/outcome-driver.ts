import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AuthService } from '@rezics/auth';
import { issuer } from '../../access/native-account-bindings-fixture.ts';
import { createLibraryAccountHost, type LibraryAccountHost } from './native-account-host.ts';
import { LIFECYCLE_ACTIONS } from '../../../src/access/lifecycle.ts';
import { releaseDigest } from '@rezics/definitions';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Anchor, LibraryInspection, Persona } from '../../../../../specs/library-driver.ts';
import { createAccess } from '../../../src/access/index.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { insertMember } from '../../../src/library/collection-store.ts';
import { keyBetween, respacedKeys } from '../../../src/library/ordinal.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { SHELF_TYPE_DIGEST_ENV } from '../../../src/library/shelf-type-keys.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../../../src/work/modules.ts';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';
import { createAuthDatabase } from '../../support/auth-database.ts';
import { dropTestDatabase } from '../../support/drop-test-database.ts';
import {
  capture,
  costOf,
  openGrowthDatabase,
  withoutCatalogStatements,
  type GrowthDatabase,
} from '../../support/growth.ts';
import { placement, seed as seedRows, type Population } from '../../support/growth-seed.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import type { NativeConformanceOptions, NativeConformanceWorld } from './native-conformance.ts';
import { compileLibraryOutcomeRelease } from './profile-entry-fixture.ts';
import type { Access } from '../../../src/request/access.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { NativeLabelCommandTrace } from './native-label-command-trace.ts';
import { createStateReferenceRepair, installStateReferenceRepairLatch } from './native-state-reference-repair.ts';

// Seeded receipts and write bases sit far above every partition's position: relays read only up to it, so the
// missing outbox rows are never a gap, and real commands never reach these positions.
const GROWTH_POSITION_BASE = 1_000_000_000_000;

const autoExplainSetup = [
  "LOAD 'auto_explain'",
  'SET auto_explain.log_min_duration = 0',
  'SET auto_explain.log_analyze = on',
  'SET auto_explain.log_buffers = on',
  'SET auto_explain.log_timing = off',
  'SET auto_explain.log_triggers = off',
  'SET auto_explain.log_verbose = on',
  'SET auto_explain.log_nested_statements = on',
  "SET auto_explain.log_format = 'json'",
  "SET auto_explain.log_level = 'notice'",
  'SET auto_explain.sample_rate = 1',
  'SET client_min_messages = notice',
];

type CapturedStatements = { statements: string[]; plans: unknown[] };
type SavedMeasurement = {
  scale: number;
  index: number;
  statements: string[];
  buffers: number;
};
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ConnectCallback = (error: Error | undefined, client: PoolClient, release: (error?: Error) => void) => void;
type ConnectPrototype = { connect: (...args: unknown[]) => unknown };

function queryText(query: unknown): string | undefined {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return undefined;
  return typeof query.text === 'string' ? query.text : undefined;
}

function planFromNotice(message: string, target: CapturedStatements | undefined): void {
  const marker = 'plan:\n';
  if (!target || !message.startsWith('duration:') || !message.includes(marker)) return;
  target.plans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown);
}

/** Execute Access's database-time observation, then align its returned instant with the scenario clock. */
function bindDatabaseClock(pool: Pool, now: () => string): () => void {
  const clients = new WeakSet<PoolClient>();
  const matches = (query: unknown) =>
    (queryText(query) ?? '').replace(/\s+/g, ' ').trim().startsWith('SELECT clock_timestamp()::text AS at');
  const replace = (value: unknown) => {
    if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows)) return value;
    return {
      ...value,
      rows: value.rows.map((row) => (typeof row === 'object' && row !== null ? { ...row, at: now() } : row)),
    };
  };
  const onAcquire = (client: PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    const query = client.query.bind(client) as PoolClient['query'];
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      if (!matches(args[0])) return query(...args);
      const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
        const next = [...args] as unknown[];
        next[callbackIndex] = (...callbackArgs: unknown[]) => {
          const [error, result, ...remaining] = callbackArgs;
          return callback(error, error ? result : replace(result), ...remaining);
        };
        return query(...(next as Parameters<PoolClient['query']>));
      }
      const result = query(...args);
      if (typeof result !== 'object' || result === null || !('then' in result)) return result;
      return Promise.resolve(result).then(replace);
    }) as PoolClient['query'];
  };
  const poolQuery = pool.query;
  pool.query = ((...args: Parameters<Pool['query']>) => {
    if (!matches(args[0])) return poolQuery.apply(pool, args as never);
    const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => unknown;
      const next = [...args] as unknown[];
      next[callbackIndex] = (...callbackArgs: unknown[]) => {
        const [error, result, ...remaining] = callbackArgs;
        return callback(error, error ? result : replace(result), ...remaining);
      };
      return poolQuery.apply(pool, next as never);
    }
    const result = poolQuery.apply(pool, args as never);
    if (typeof result !== 'object' || result === null || !('then' in result)) return result;
    return Promise.resolve(result).then(replace);
  }) as Pool['query'];
  pool.on('acquire', onAcquire);
  return () => {
    pool.off('acquire', onAcquire);
    pool.query = poolQuery;
  };
}

/** Instrument library-owned pg.Pool instances as well as the shared growth pool. */
function instrumentLibraryPools(
  databaseUrl: string,
  mainPool: Pool,
  active: () => CapturedStatements | undefined,
  trace: NativeLabelCommandTrace,
) {
  const prototype = Pool.prototype as unknown as ConnectPrototype;
  const original = prototype.connect;
  const clients = new WeakSet<PoolClient>();
  const pending = new WeakMap<PoolClient, Promise<void>>();
  const mainClients = new Map<PoolClient, PoolClient['query']>();
  const onAcquire = (client: PoolClient) => {
    if (mainClients.has(client)) return;
    const query = client.query;
    mainClients.set(client, query);
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      trace.query(args);
      return query.apply(client, args as never);
    }) as PoolClient['query'];
  };
  mainPool.on('acquire', onAcquire);

  async function prepare(client: PoolClient): Promise<void> {
    if (clients.has(client)) return pending.get(client);
    clients.add(client);
    const query = client.query.bind(client) as PoolClient['query'];
    client.on('notice', (notice) => {
      if (typeof notice.message === 'string') planFromNotice(notice.message, active());
    });
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const text = queryText(args[0]);
      if (text !== undefined) active()?.statements.push(text);
      trace.query(args);
      return query(...args);
    }) as PoolClient['query'];
    const setup = Promise.all(autoExplainSetup.map((statement) => query(statement))).then(() => undefined);
    pending.set(client, setup);
    await setup;
  }

  prototype.connect = function (this: Pool, ...args: unknown[]): unknown {
    if (this === mainPool || this.options.connectionString !== databaseUrl) return original.apply(this, args);
    const callback = args[0];
    if (typeof callback === 'function') {
      const done = callback as ConnectCallback;
      return original.call(this, ((error: Error | undefined, client: PoolClient, release: (error?: Error) => void) => {
        if (error) {
          done(error, client, release);
          return;
        }
        void prepare(client).then(
          () => done(undefined, client, release),
          (cause: unknown) => {
            const failure = cause instanceof Error ? cause : new Error(String(cause));
            release(failure);
            done(failure, client, release);
          },
        );
      }) as never);
    }
    return (original.call(this) as Promise<PoolClient>).then(async (client) => {
      await prepare(client);
      return client;
    });
  };

  return () => {
    mainPool.off('acquire', onAcquire);
    for (const [client, query] of mainClients) client.query = query;
    mainClients.clear();
    prototype.connect = original;
  };
}

function responseError(label: string, response: Response, body: string): Error {
  return new Error(`${label} returned ${response.status}: ${body}`);
}

async function expectJson<T>(label: string, response: Response, status: number): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw responseError(label, response, text);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${label} returned invalid JSON: ${text}`, { cause });
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function difference(left: readonly string[], right: readonly string[]): { added: string[]; removed: string[] } {
  const remaining = [...right];
  const added: string[] = [];
  for (const statement of left) {
    const index = remaining.indexOf(statement);
    if (index < 0) added.push(statement);
    else remaining.splice(index, 1);
  }
  return { added, removed: remaining };
}

function sourceFile(statement: string): string {
  return statement.match(/\/\*\s*file=['"]([^'"]+)['"][^*]*\*\//i)?.[1] ?? 'source not embedded in statement';
}

export async function createLibraryDriver(options: NativeConformanceOptions = {}): Promise<NativeConformanceWorld> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL must name the migrated test database');

  const suffix = Bun.randomUUIDv7().replaceAll('-', '');
  const kernelName = `library_${suffix}`;
  const authName = `library_auth_${suffix}`;
  const url = new URL(base);
  const template = decodeURIComponent(url.pathname.slice(1));
  url.pathname = '/postgres';

  let owner: Pool | undefined;
  let db: GrowthDatabase | undefined;
  let authPool: Pool | undefined;
  let accountHost: LibraryAccountHost | undefined;
  let authServer: ReturnType<typeof Bun.serve> | undefined;
  let workClient: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stateReferenceRepair: ReturnType<typeof createStateReferenceRepair> | undefined;
  let restorePoolInstrumentation: (() => void) | undefined;
  let restoreDatabaseClock: (() => void) | undefined;
  let dropped = false;
  const commandTrace = new NativeLabelCommandTrace();

  const cleanup = async () => {
    commandTrace.close();
    stateReferenceRepair?.close();
    if (child) {
      child.kill('SIGCONT');
      child.kill('SIGTERM');
      await child.exited.catch(() => undefined);
      child = undefined;
    }
    restorePoolInstrumentation?.();
    restorePoolInstrumentation = undefined;
    restoreDatabaseClock?.();
    restoreDatabaseClock = undefined;
    await authServer?.stop(true).catch(() => undefined);
    authServer = undefined;
    await workClient?.close().catch(() => undefined);
    workClient = undefined;
    await accountHost?.close().catch(() => undefined);
    accountHost = undefined;
    await authPool?.end().catch(() => undefined);
    authPool = undefined;
    await db?.close().catch(() => undefined);
    db = undefined;
    if (owner && !dropped) {
      for (const database of [authName, kernelName]) {
        try {
          await dropTestDatabase(owner, database);
        } catch {
          // Preserve the original setup/test error while still attempting both drops.
        }
      }
      dropped = true;
    }
    await owner?.end().catch(() => undefined);
    owner = undefined;
  };

  try {
    owner = new Pool({ connectionString: url.toString(), max: 1 });
    await owner.query(`CREATE DATABASE ${kernelName} TEMPLATE "${template.replaceAll('"', '""')}"`);
    url.pathname = `/${kernelName}`;
    const databaseUrl = url.toString();
    let fixedInstant: string | undefined;
    const scenarioNow = () => fixedInstant ?? new Date().toISOString();
    db = await openGrowthDatabase(databaseUrl);
    restoreDatabaseClock = bindDatabaseClock(db.pool, scenarioNow);

    authPool = new Pool({ connectionString: await createAuthDatabase(base, authName), max: 2 });
    authPool.on('error', () => {});
    authPool.on('connect', (client) => client.on('error', () => {}));

    const routeKey = new Uint8Array(32).fill(17);
    const tokens = new Map<string, string>();
    const ownerAccount = { id: newId(0x3300), route: 0x3300, partition: partitionOf(0x3300) };
    const otherAccount = { id: newId(0x3301), route: 0x3301, partition: partitionOf(0x3301) };
    const suspendedAccount = { id: newId(0x5520), route: 0x5520, partition: partitionOf(0x5520) };
    const governor = { id: newId(0x1101), route: 0x1101, partition: partitionOf(0x1101) };
    const seedSamePartition = { id: newId(0x3302), route: 0x3302, partition: partitionOf(0x3302) };
    const seedOtherPartition = { id: newId(0x6610), route: 0x6610, partition: partitionOf(0x6610) };
    const seedParallelPeople = [0x7710, 0x8810, 0x9910, 0xaa10, 0xbb10, 0xcc10, 0xdd10, 0xee10].map((route) => ({
      id: newId(route),
      route,
      partition: partitionOf(route),
    }));
    const knownPeople = [
      ownerAccount,
      otherAccount,
      suspendedAccount,
      governor,
      seedSamePartition,
      seedOtherPartition,
      ...seedParallelPeople,
    ];

    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'library-outcomes',
      alg: 'ES256',
    };
    const tokenSigningKey = await importJWK(signingKey, 'ES256');
    let auth!: AuthService;
    authServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => auth.handler(request),
    });
    const audience = 'https://ordinary.api.test';

    const cursorKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
    let managementObserver: Parameters<NativeConformanceWorld['native']['observeManagement']>[0];
    let nativeAccess: Access;
    const app = createKernel({
      receiptKeys: testReceiptKeys(),
      requestDeadlineMs: 30_000,
      pool: db!.pool,
      clock: () => new Date(scenarioNow()),
      writeRate: createWriteRateLimiter({
        secret: 'library-fixture-write-rate-secret-with-at-least-32-bytes',
        overrides: JSON.stringify({
          anonymous: { write: { maximum: 1_000_000, seconds: 60 } },
          'new-account': { write: { maximum: 1_000_000, seconds: 60 } },
          member: { write: { maximum: 1_000_000, seconds: 60 } },
          trusted: { write: { maximum: 1_000_000, seconds: 60 } },
          service: { write: { maximum: 1_000_000, seconds: 60 } },
        }),
      }),
      routeKey,
      ...(options.shelfTypeDigest === undefined ? {} : { shelfTypeDigest: options.shelfTypeDigest }),
      tokens: cursorKeys,
      access: (config) => {
        const access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            fetch: async (location, init) => auth.handler(new Request(location, init)),
          },
        });
        const authorize = access.authorize.bind(access);
        access.authorize = (...args) => {
          const [, , action, resource] = args;
          if (['collection:update', 'space:manage', 'account:manage'].includes(action))
            managementObserver?.({ action, resource: { route: resource.route, id: resource.id } });
          return commandTrace.authorize(action, () => authorize(...args));
        };
        nativeAccess = access;
        return access;
      },
    });
    const scopes = [...actionCatalogue(app).keys()].filter((scope) => scope !== 'media:complete');
    scopes.push(...[...LIFECYCLE_ACTIONS.keys()].filter((scope) => !scopes.includes(scope)));
    scopes.push('access:grant');
    accountHost = await createLibraryAccountHost({
      pool: db.admin,
      authPool,
      databaseUrl: authPool.options.connectionString!,
      privateKey: signingKey,
      actions: actionCatalogue(app),
      scopes,
    });
    auth = accountHost.service;

    async function provisionAccount(person: Anchor): Promise<Anchor> {
      const registered = await accountHost!.person(person.partition);
      Object.assign(person, { id: registered.id, route: registered.route });
      tokens.set(person.id, registered.credential);
      return person;
    }
    for (const person of knownPeople) await provisionAccount(person);

    async function consent(account: Anchor, requestedScopes: readonly string[]): Promise<string> {
      return (await accountHost!.signIn(account.id, requestedScopes)).credential;
    }

    for (const [name, selected] of Object.entries({
      ownerReadOnly: ['collection:read', 'subject:read', 'library_entry:read', 'library_entry:list'],
      libraryOnly: scopes.filter((scope) => !scope.startsWith('progress_session:')),
      progressOnly: scopes.filter((scope) => !scope.startsWith('library_entry:')),
      ungranted: [],
      unscoped: [],
    }))
      tokens.set(name, await consent(ownerAccount, selected));

    const byRoute = async (
      token: string | null,
      method: HttpMethod,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => {
      const requestHeaders = new Headers(headers);
      if (token) requestHeaders.set('authorization', `Bearer ${token}`);
      else requestHeaders.delete('authorization');
      const init: RequestInit = { method, headers: requestHeaders };
      if (body !== undefined) {
        requestHeaders.set('content-type', 'application/json');
        init.body = JSON.stringify(body);
      }
      const response = await app.handle(new Request(`http://kernel.test${path}`, init));
      return response;
    };
    const key = () => `"${Bun.randomUUIDv7()}"`;
    const tokenFor = (person: Anchor) => {
      const token = tokens.get(person.id);
      if (!token) throw new Error(`No authenticated fixture token for ${person.id}`);
      return token;
    };
    const grantSeedSubjectCreation = async (person: Anchor) => {
      const response = await byRoute(
        tokenFor(governor),
        'POST',
        '/v1/grants',
        {
          resource: PLATFORM_RESOURCE,
          subject: { kind: 'account', id: person.id },
          actions: ['subject:create'],
          valid: '(,)',
        },
        { 'Idempotency-Key': key() },
      );
      await expectJson(`Granting subject creation to seed account ${person.id}`, response, 201);
    };
    // db.admin is outside statement capture; the measured pool stays out of fixture setup.
    await bootstrapGovernance(db.admin, governor.id);

    const definitionGrant = await byRoute(
      tokenFor(governor),
      'POST',
      '/v1/grants',
      {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'account', id: governor.id },
        actions: ['definitions:publish', 'definitions:activate'],
        valid: '(,)',
      },
      { 'Idempotency-Key': key() },
    );
    await expectJson('Granting fixture definition publication', definitionGrant, 201);
    const release = await compileLibraryOutcomeRelease();
    const digest = releaseDigest(release);
    const published = await byRoute(
      tokenFor(governor),
      'POST',
      '/v1/definitions/releases',
      { release },
      { 'Idempotency-Key': key() },
    );
    const publishedBody = await expectJson<{ digest: string }>(
      'Publishing Library outcome definitions',
      published,
      201,
    );
    if (publishedBody.digest !== digest) throw new Error('Definitions returned a different compiled release digest');
    const currentHead = await byRoute(null, 'GET', '/v1/definitions/active');
    const expectedHead =
      currentHead.status === 404
        ? null
        : (await expectJson<{ head: number }>('Reading fixture definitions head', currentHead, 200)).head;
    const activated = await byRoute(
      tokenFor(governor),
      'POST',
      `/v1/definitions/releases/${digest}:activate`,
      { expected_head: expectedHead },
      { 'Idempotency-Key': key() },
    );
    await expectJson('Activating Library outcome definitions', activated, 200);
    const active = await expectJson<{ digest: string }>(
      'Reading activated Library outcome definitions',
      await byRoute(null, 'GET', '/v1/definitions/active'),
      200,
    );
    if (active.digest !== digest) throw new Error('Definitions did not activate the compiled fixture release');

    for (const group of ['collections', 'personal_library', 'reading_progress']) {
      const response = await byRoute(tokenFor(governor), 'POST', `/v1/platform/exposure/${group}:open`, undefined, {
        'Idempotency-Key': key(),
      });
      await expectJson(`Opening ${group}`, response, 200);
    }
    for (const person of [seedSamePartition, seedOtherPartition, ...seedParallelPeople]) {
      await grantSeedSubjectCreation(person);
    }
    const suspend = await byRoute(
      tokenFor(governor),
      'POST',
      `/v1/accounts/${suspendedAccount.id}:suspend`,
      {},
      {
        'Idempotency-Key': key(),
      },
    );
    await expectJson('Suspending fixture persona', suspend, 200);

    workClient = await createWorkClient(databaseUrl);
    let activeInternalCapture: CapturedStatements | undefined;
    restorePoolInstrumentation = instrumentLibraryPools(
      databaseUrl,
      db.pool,
      () => activeInternalCapture,
      commandTrace,
    );

    const accounts = {
      owner: { id: ownerAccount.id, route: ownerAccount.route, partition: ownerAccount.partition },
      other: { id: otherAccount.id, route: otherAccount.route, partition: otherAccount.partition },
      suspended: { id: suspendedAccount.id, route: suspendedAccount.route, partition: suspendedAccount.partition },
    };
    const unknown = {
      collectionId: newId(ownerAccount.route),
      memberId: newId(ownerAccount.route),
      subjectId: newId(0x6b21),
      sessionId: newId(ownerAccount.route),
      copyId: newId(ownerAccount.route),
      logId: newId(ownerAccount.route),
    };
    const initialSubjectIds = new Set<string>();
    let seedSubjects = 0;
    let measurementScale = -1;
    let measurementIndex = 0;
    const savedMeasurements: SavedMeasurement[] = [];
    let childHeld = true;
    let workerFailure: string | undefined;
    let workerDiagnosticsTask: Promise<void> | undefined;
    stateReferenceRepair = createStateReferenceRepair({
      accountId: ownerAccount.id,
      client: workClient,
      resume: resumeExecutor,
      send: (message) => {
        if (!child) throw new Error('Production library executor is unavailable');
        child.send(message);
      },
    });

    async function startExecutor(): Promise<void> {
      if (child) {
        if (childHeld) child.kill('SIGCONT');
        childHeld = false;
        return;
      }
      let ready!: () => void;
      const readiness = new Promise<void>((resolveReady) => {
        ready = resolveReady;
      });
      child = Bun.spawn([process.execPath, import.meta.filename], {
        env: {
          ...process.env,
          ...workerTestEnv({
            DATABASE_URL: databaseUrl,
            KERNEL_WORKER_POOL_SIZE: '10',
            KERNEL_EXECUTOR_ID: 'library-outcomes',
            AUTH_ISSUER: issuer,
            AUTH_AUDIENCE: audience,
            AUTH_JWKS_URL: `http://127.0.0.1:${authServer!.port}/.well-known/jwks.json`,
            OPENSEARCH_URL: '',
            [SHELF_TYPE_DIGEST_ENV]: options.workerShelfTypeDigest,
          }),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        ipc(message) {
          if (message === 'ready') ready();
          else stateReferenceRepair?.receive(message);
        },
      });
      const running = child;
      let diagnostics = '';
      workerDiagnosticsTask = (async () => {
        const read = async (stream: ReadableStream<Uint8Array>) => {
          const decoder = new TextDecoder();
          for await (const chunk of stream) {
            diagnostics += decoder.decode(chunk, { stream: true });
            workerFailure ??= diagnostics.match(/Relay (?:effects|semantic_links) stopped[^\n]*/)?.[0];
          }
          diagnostics += decoder.decode();
        };
        await Promise.all([
          read(running.stdout as ReadableStream<Uint8Array>),
          read(running.stderr as ReadableStream<Uint8Array>),
        ]);
        workerFailure ??= diagnostics.match(/Relay (?:effects|semantic_links) stopped[^\n]*/)?.[0];
        workerFailure ??=
          running.exitCode !== 0 && running.exitCode !== null
            ? `executor exited ${running.exitCode}: ${diagnostics}`
            : undefined;
      })();
      const exited = running.exited.then(async (code) => {
        stateReferenceRepair?.close();
        await workerDiagnosticsTask;
        workerFailure ??= `executor exited ${code}: ${diagnostics || '(no output)'}`;
        return code;
      });
      const outcome = await Promise.race([
        readiness.then(() => ({ ready: true as const })),
        exited.then((code) => ({ ready: false as const, code })),
      ]);
      if (!outcome.ready) throw new Error(`Production library executor exited ${outcome.code}: ${workerFailure ?? ''}`);
      for (const queue of await workClient!.listQueues()) await queue.setMinPollingIntervalMs(5);
      childHeld = false;
    }

    async function holdExecutor(): Promise<void> {
      if (child && !childHeld) {
        child.kill('SIGSTOP');
        childHeld = true;
      }
    }

    async function resumeExecutor(): Promise<void> {
      if (!child) throw new Error('Production library executor was not started with the driver');
      if (childHeld) child.kill('SIGCONT');
      childHeld = false;
    }

    async function settle(): Promise<void> {
      await resumeExecutor();
      for (;;) {
        if (workerFailure) {
          const stopped = workerFailure.match(/partition (\d+) position (\d+)/);
          const events = stopped
            ? await db!.admin.query(
                'SELECT event_seq, type, data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
                [Number(stopped[1]!), (BigInt(stopped[2]!) + 1n).toString()],
              )
            : undefined;
          throw new Error(
            `Production library executor: ${workerFailure}${events ? `; events=${JSON.stringify(events.rows)}` : ''}`,
          );
        }
        const workflows = (await workClient!.listWorkflows({ limit: 10000 })).filter((row) => row.status !== 'SUCCESS');
        if (workflows.length) {
          for (const workflow of workflows.filter((row) => row.status !== 'DELAYED')) {
            await workClient!.retrieveWorkflow(workflow.workflowID).getResult();
          }
          if (workflows.some((row) => row.status !== 'DELAYED')) continue;
        }
        const pending = await db!.admin.query(`
          SELECT 1
            FROM core.partition AS partition
            CROSS JOIN (VALUES ('effects'::text), ('semantic_links'::text)) AS consumers(name)
            LEFT JOIN core.consumer_checkpoint AS checkpoint
              ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = consumers.name
           WHERE partition.position > COALESCE(checkpoint.position, 0)
           LIMIT 1`);
        if (
          !pending.rowCount &&
          (await workClient!.listWorkflows({ limit: 10000 })).every((row) => row.status === 'SUCCESS')
        )
          return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }

    async function inspect(): Promise<LibraryInspection> {
      const collections = (
        await db!.admin.query(`
        SELECT collection_id AS id, curator_account_id AS "curatorAccountId", title, description, visibility,
               revision, member_count AS "memberCount", created_at AS "createdAt", updated_at AS "updatedAt", route
          FROM library.collection ORDER BY route, collection_id`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: partitionOf(Number(row.route)),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      })) as LibraryInspection['collections'];
      const members = (
        await db!.admin.query(`
        SELECT member_id AS id, subject_id AS "subjectId", note, added_at AS "addedAt",
               collection_id AS "collectionId", ordinal_key AS "orderKey", route
          FROM library.collection_member ORDER BY route, collection_id, member_id`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: partitionOf(Number(row.route)),
        addedAt: iso(row.addedAt),
      })) as LibraryInspection['members'];
      const entries = (
        await db!.admin.query(`
        SELECT subject_id AS "subjectId", incarnation_id AS "incarnationId", state, revision, created_at AS "createdAt", updated_at AS "updatedAt",
               account_id AS "accountId", route
          FROM library.entry ORDER BY route, account_id, subject_id`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: partitionOf(Number(row.route)),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      })) as LibraryInspection['entries'];
      const sessions = (
        await db!.admin.query(`
        SELECT session_id AS id, subject_id AS "subjectId", version_subject_id AS "versionSubjectId", mode, unit,
               total::text AS total, amount::text AS amount, locator, position::text AS position,
               completed_unit_count AS "completedUnitCount", state, revision, started_at AS "startedAt",
               completed_at AS "completedAt", account_id AS "accountId", route
          FROM library.progress_session ORDER BY route, session_id`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: partitionOf(Number(row.route)),
        startedAt: iso(row.startedAt),
        completedAt: row.completedAt === null ? null : iso(row.completedAt),
      })) as LibraryInspection['sessions'];
      const completedUnits = (
        await db!.admin.query(`
        SELECT session_id AS "sessionId", unit_id AS "unitId"
          FROM library.progress_unit ORDER BY route, session_id, unit_id`)
      ).rows as LibraryInspection['completedUnits'];
      const changes = (
        await db!.admin.query(`
        SELECT session_id AS "sessionId", change_no AS revision, intent, recorded_at AS "createdAt"
          FROM library.progress_change ORDER BY route, session_id, change_no`)
      ).rows.map((row) => ({
        id: `${row.sessionId}:${row.revision}`,
        sessionId: row.sessionId,
        revision: Number(row.revision),
        intent: row.intent,
        createdAt: iso(row.createdAt),
      })) as LibraryInspection['changes'];
      const copies = (
        await db!.admin.query(`
        SELECT copy_id AS id, subject_id AS "subjectId", status, revision, location, source,
               acquired_on AS "acquiredOn", disposed_on AS "disposedOn", note,
               account_id AS "accountId", route
          FROM library.copy ORDER BY route, copy_id`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: partitionOf(Number(row.route)),
        acquiredOn: row.acquiredOn instanceof Date ? row.acquiredOn.toISOString().slice(0, 10) : row.acquiredOn,
        disposedOn: row.disposedOn instanceof Date ? row.disposedOn.toISOString().slice(0, 10) : row.disposedOn,
      })) as LibraryInspection['copies'];
      const follows = (
        await db!.admin.query(`
        SELECT target_id AS "targetId", target_type AS "targetType", state, reason,
               updated_at AS "updatedAt", account_id AS "accountId", route
          FROM library.follow ORDER BY route, account_id, target_id`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: partitionOf(Number(row.route)),
        updatedAt: iso(row.updatedAt),
      })) as LibraryInspection['follows'];
      const publishedLogs = (
        await db!.admin.query(`
        SELECT log_id AS id, account_id AS "accountId", subject_id AS "subjectId", session_state AS "sessionState",
               started_at AS "startedAt", completed_at AS "completedAt", note, published_at AS "publishedAt"
          FROM library.published_log ORDER BY route, log_id`)
      ).rows.map((row) => ({
        ...row,
        startedAt: iso(row.startedAt),
        completedAt: row.completedAt === null ? null : iso(row.completedAt),
        publishedAt: iso(row.publishedAt),
      })) as LibraryInspection['publishedLogs'];

      // The target subject must share the physical partition with a private source row
      // before that row belongs in this exhaustive partition view. Collection metadata
      // is joined from the authoritative source Collection; no visibility filter applies.
      const subjectPartitionRows = (
        await db!.admin.query(`
        SELECT listing.subject_id AS "subjectId", listing.route,
               listing.route >> 4 AS partition, 'library.subject_collection'::text AS "table",
               listing.collection_id::text AS key, 'collection'::text AS source,
               listing.collection_id AS "collectionId", collection.visibility,
               listing.multiplicity
          FROM library.subject_collection AS listing
          LEFT JOIN library.collection AS collection
            ON collection.route = listing.collection_route AND collection.collection_id = listing.collection_id
        UNION ALL
        SELECT entry.subject_id, entry.route, entry.route >> 4, 'library.entry',
               entry.account_id::text || ':' || entry.subject_id::text, 'entry', NULL, NULL, NULL
          FROM library.entry AS entry
          JOIN semantic.subject AS subject
            ON subject.subject_id = entry.subject_id AND subject.route >> 4 = entry.route >> 4
        UNION ALL
        SELECT session.subject_id, session.route, session.route >> 4, 'library.progress_session',
               session.session_id::text, 'session', NULL, NULL, NULL
          FROM library.progress_session AS session
          JOIN semantic.subject AS subject
            ON subject.subject_id = session.subject_id AND subject.route >> 4 = session.route >> 4
        UNION ALL
        SELECT copy.subject_id, copy.route, copy.route >> 4, 'library.copy',
               copy.copy_id::text, 'copy', NULL, NULL, NULL
          FROM library.copy AS copy
          JOIN semantic.subject AS subject
            ON subject.subject_id = copy.subject_id AND subject.route >> 4 = copy.route >> 4
        UNION ALL
        SELECT follow.target_id, follow.route, follow.route >> 4, 'library.follow',
               follow.account_id::text || ':' || follow.target_id::text, 'follow', NULL, NULL, NULL
          FROM library.follow AS follow
          JOIN semantic.subject AS subject
            ON subject.subject_id = follow.target_id AND subject.route >> 4 = follow.route >> 4
         WHERE follow.target_type = 'subject'
        UNION ALL
        SELECT log.subject_id, log.route, log.route >> 4, 'library.published_log',
               log.log_id::text, 'publishedLog', NULL, NULL, NULL
          FROM library.published_log AS log
          JOIN semantic.subject AS subject
            ON subject.subject_id = log.subject_id AND subject.route >> 4 = log.route >> 4
        ORDER BY partition, route, "table", key`)
      ).rows.map((row) => ({
        ...row,
        route: Number(row.route),
        partition: Number(row.partition),
        multiplicity: row.multiplicity === null ? null : Number(row.multiplicity),
      })) as LibraryInspection['subjectPartitionRows'];
      const events = (
        await db!.admin.query('SELECT id, type, data FROM core.outbox ORDER BY partition_no, position, event_seq')
      ).rows as LibraryInspection['events'];
      const workflows = (await workClient!.listWorkflows({ limit: 10000 }))
        .map((row) => ({ id: row.workflowID, name: row.workflowName, status: row.status }))
        .sort((left, right) => left.id.localeCompare(right.id));
      return {
        collections,
        members,
        entries,
        sessions,
        completedUnits,
        changes,
        copies,
        follows,
        publishedLogs,
        subjectPartitionRows,
        events,
        workflows,
      };
    }

    async function provisionSubject(input: { versionOf?: string } = {}, author: Anchor = governor): Promise<Anchor> {
      const body =
        input.versionOf === undefined
          ? { type: 'schema:Book', labels: { en: 'Library outcome subject' } }
          : {
              type: 'bf:Instance',
              labels: { en: 'Library outcome edition' },
              statements: {
                'schema:exampleOfWork': [
                  {
                    property: { id: 'schema:exampleOfWork' },
                    value: { type: 'value', content: input.versionOf },
                  },
                ],
              },
            };
      const response = await byRoute(tokenFor(author), 'POST', '/v1/subjects', body, {
        'Idempotency-Key': key(),
      });
      const result = await expectJson<{
        subject: { id: string; type: string; release: string };
      }>('Creating semantic subject', response, 201);
      if (result.subject.type !== body.type || result.subject.release !== digest)
        throw new Error('Semantic did not accept the subject against the activated Library outcome definitions');
      const subjectRoute = routeOf(result.subject.id);
      if (subjectRoute === null) throw new Error('Production semantic create returned an unroutable subject');
      initialSubjectIds.add(result.subject.id);
      return { id: result.subject.id, route: subjectRoute, partition: partitionOf(subjectRoute) };
    }

    const nativeRequest: NativeConformanceWorld['native']['request'] = (as, input) => {
      const person =
        as === 'steward'
          ? governor
          : as === 'anonymous'
            ? null
            : as === 'owner' || as === 'other' || as === 'suspended'
              ? accounts[as]
              : ownerAccount;
      const bearer = person === null ? null : (tokens.get(as) ?? tokenFor(person));
      return byRoute(bearer, input.method, input.path, input.body, input.headers);
    };
    const driver: NativeConformanceWorld = {
      native: {
        accountHost,
        pool: db.pool,
        reader: db.admin,
        databaseUrl,
        workClient,
        traceCommand: (operation) => commandTrace.trace(operation),
        stateReferenceRepair,
        steward: governor,
        growth: db,
        async principal(partition) {
          if (!Number.isInteger(partition) || partition < 0 || partition >= 4096)
            throw new RangeError('Native principal partition must be below 4096');
          const person = await provisionAccount({ id: newId(partition * 16), route: partition * 16, partition });
          return { accountId: person.id, credential: tokenFor(person) };
        },
        async reauthenticate(accountId, selected = scopes) {
          const route = routeOf(accountId);
          if (route === null) throw new TypeError('Unroutable native account');
          return {
            accountId,
            credential: await consent({ id: accountId, route, partition: partitionOf(route) }, selected),
          };
        },
        async bearerRequest(credential, path, init = {}) {
          const headers = new Headers(init.headers);
          if (credential === null) headers.delete('authorization');
          else headers.set('authorization', `Bearer ${credential}`);
          return app.handle(new Request(`http://kernel.test${path}`, { ...init, headers }));
        },
        observeManagement(observer) {
          managementObserver = observer;
        },
        token(as) {
          const person =
            as === 'steward'
              ? governor
              : as === 'owner' || as === 'other' || as === 'suspended'
                ? accounts[as]
                : ownerAccount;
          return tokens.get(as) ?? tokenFor(person);
        },
        accountActor(as) {
          return nativeAccess.authenticate(tokenFor(accounts[as]), { pool: db!.pool, deadline: deadlineFor(30_000) });
        },
        request: nativeRequest,
        async rawRequest(as, method, path, rawJson, headers = {}) {
          return app.handle(
            new Request(`http://kernel.test${path}`, {
              method,
              headers: {
                ...headers,
                'content-type': 'application/json',
                ...(as === 'anonymous' ? {} : { authorization: `Bearer ${driver.native.token(as)}` }),
              },
              body: rawJson,
            }),
          );
        },
        async subject(type, author = 'steward') {
          const response = await nativeRequest(author, {
            method: 'POST',
            path: '/v1/subjects',
            body: { type, labels: { en: 'Native Library conformance subject' } },
            headers: { 'Idempotency-Key': key() },
          });
          const result = await expectJson<{ subject: { id: string } }>('Creating native typed subject', response, 201);
          const route = routeOf(result.subject.id);
          if (route === null) throw new Error('Semantic returned an unroutable subject');
          initialSubjectIds.add(result.subject.id);
          return { id: result.subject.id, route, partition: partitionOf(route) };
        },
        async rotateCursorKeys() {
          cursorKeys.current++;
          cursorKeys.keys.clear();
          cursorKeys.keys.set(cursorKeys.current, crypto.getRandomValues(new Uint8Array(32)));
        },
        hold: holdExecutor,
        resume: resumeExecutor,
        async capture(operation) {
          await holdExecutor();
          const internal: CapturedStatements = { statements: [], plans: [] };
          activeInternalCapture = internal;
          try {
            const result = await capture(db!, operation, { includeBackends: true });
            if (internal.statements.length)
              throw new Error(
                'Native cross-pool wire/backend attribution unavailable; refusing incomplete cost evidence',
              );
            return result;
          } finally {
            activeInternalCapture = undefined;
          }
        },
      },
      accounts,
      unknown: {
        collectionId: unknown.collectionId,
        memberId: unknown.memberId,
        subjectId: unknown.subjectId,
        sessionId: unknown.sessionId,
        copyId: unknown.copyId,
        logId: unknown.logId,
      },
      async setTime(value) {
        fixedInstant = new Date(value).toISOString();
        // Keep the fixture's authenticated credentials on the same timeline as Access.
        const issuedAt = Math.floor(Date.parse(fixedInstant) / 1000);
        for (const [id, token] of tokens) {
          const claims = decodeJwt(token);
          const shift = issuedAt - claims.iat!;
          tokens.set(
            id,
            await new SignJWT({ ...claims, auth_time: Number(claims.auth_time) + shift })
              .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid, typ: 'at+jwt' })
              .setIssuedAt(issuedAt)
              .setExpirationTime(claims.exp! + shift)
              .sign(tokenSigningKey),
          );
        }
      },
      now: scenarioNow,
      provisionSubject,
      async request(as: Persona, input) {
        const account = as === 'anonymous' ? null : accounts[as];
        return byRoute(
          account === null ? null : tokenFor(account),
          input.method,
          input.path,
          input.body,
          input.headers,
        );
      },
      inspect,
      settle,
      async seedMembers(input) {
        const route = routeOf(input.collectionId);
        if (route === null) throw new Error(`Collection ${input.collectionId} has no route`);
        if (input.count < 1) return;
        const stored = input.count - 1;
        // db.admin is outside statement capture, so seeding never reaches the measured pool.
        const last = await db!.admin.query<{ ordinal_key: string }>(
          'SELECT ordinal_key FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY ordinal_key DESC, member_id DESC LIMIT 1',
          [route, input.collectionId],
        );
        const keys = last.rows[0] ? [] : respacedKeys(stored);
        let previous = last.rows[0]?.ordinal_key ?? null;
        while (keys.length < stored) {
          previous = keyBetween(previous, null);
          if (previous === null) throw new Error('Seeded members exhausted the ordinal key length');
          keys.push(previous);
        }
        const time = scenarioNow();
        for (let index = 0; index < stored; index += 200) {
          const client = await db!.admin.connect();
          try {
            await client.query('BEGIN');
            const transactionId = Bun.randomUUIDv7();
            for (const ordinalKey of keys.slice(index, index + 200)) {
              const member = await insertMember(
                client,
                route,
                input.collectionId,
                { id: newId(route), subjectId: input.subjectId, note: null, ordinalKey },
                { transactionId, time },
              );
              if (!member) throw new Error(`Collection ${input.collectionId} refused a seeded member`);
            }
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        }
        const curator = await db!.admin.query<{ curator_account_id: string }>(
          'SELECT curator_account_id FROM library.collection WHERE route=$1 AND collection_id=$2',
          [route, input.collectionId],
        );
        const person = knownPeople.find((candidate) => candidate.id === curator.rows[0]?.curator_account_id);
        if (!person) throw new Error(`Collection ${input.collectionId} has no fixture curator`);
        const response = await byRoute(
          tokenFor(person),
          'POST',
          `/v1/collections/${input.collectionId}/members`,
          { subjectId: input.subjectId },
          { 'Idempotency-Key': key() },
        );
        await expectJson(`Seeding the last member of collection ${input.collectionId}`, response, 201);
      },
      async seed(scale) {
        if (!Number.isSafeInteger(scale) || scale < seedSubjects) throw new RangeError('Seed scales must increase');
        measurementScale = scale;
        measurementIndex = 0;
        if (scale === seedSubjects) return;
        const range = { from: seedSubjects, to: scale };
        const time = scenarioNow();
        const subjectRouteOf = (ordinal: number) => (ordinal * 40_503 + 0x1357) % 65_536;
        const population: Population = {
          name: `library-growth-${suffix}`,
          hotPartition: accounts.owner.partition,
          rows(placement) {
            const route = placement.route;
            const subjectRoute = subjectRouteOf(placement.ordinal);
            const account = newId(route);
            const subjectId = newId(subjectRoute);
            const collectionId = newId(route);
            const memberId = newId(route);
            const sessionId = newId(route);
            const copyId = newId(route);
            const logId = newId(route);
            const transactions = Array.from({ length: 9 }, () => Bun.randomUUIDv7());
            const [subjectTx, collectionTx, entryTx, sessionTx, copyTx, followTx, memberTx, recordTx, logTx] =
              transactions as [string, string, string, string, string, string, string, string, string];
            const commands: {
              partition: number;
              kind: string;
              transactionId: string;
              response: unknown;
            }[] = [
              {
                partition: subjectRoute >>> 4,
                kind: 'subject.create',
                transactionId: subjectTx,
                response: { id: subjectId },
              },
              {
                partition: placement.partition,
                kind: 'library.collection.create',
                transactionId: collectionTx,
                response: { id: collectionId },
              },
              {
                partition: placement.partition,
                kind: 'library.entry.put',
                transactionId: entryTx,
                response: { created: true },
              },
              {
                partition: placement.partition,
                kind: 'progress_session.start',
                transactionId: sessionTx,
                response: { id: sessionId },
              },
              {
                partition: placement.partition,
                kind: 'library.copy.create',
                transactionId: copyTx,
                response: { id: copyId },
              },
              {
                partition: placement.partition,
                kind: 'library.follow',
                transactionId: followTx,
                response: { targetId: subjectId },
              },
              {
                partition: placement.partition,
                kind: 'library.collection.member.add',
                transactionId: memberTx,
                response: { id: memberId },
              },
              {
                partition: placement.partition,
                kind: 'progress_session.record',
                transactionId: recordTx,
                response: { id: sessionId },
              },
              {
                partition: placement.partition,
                kind: 'published_log.create',
                transactionId: logTx,
                response: { id: logId },
              },
            ];
            const positionOf = (index: number) => GROWTH_POSITION_BASE + placement.ordinal * 16 + index;
            return {
              'access.resource_initialization': [
                {
                  route,
                  resource_id: collectionId,
                  resource_type: 'library.collection',
                  creator_id: account,
                  initialized_at: time,
                },
              ],
              'access.resource_role_grant': [
                {
                  route,
                  resource_id: collectionId,
                  subject_kind: 'identity',
                  subject_id: account,
                  subject_role: '',
                  grant_role: 'library.collection.owner',
                  valid: `[${time},)`,
                  transaction_id: collectionTx,
                },
              ],
              'library.collection': [
                {
                  route,
                  collection_id: collectionId,
                  curator_account_id: account,
                  title: `Growth shelf ${placement.ordinal}`,
                  description: null,
                  visibility: 'private',
                  state: 'active',
                  revision: 1,
                  member_count: 1,
                  order_epoch: 0,
                  created_at: time,
                  updated_at: time,
                  transaction_id: memberTx,
                },
              ],
              'library.collection_member': [
                {
                  route,
                  collection_id: collectionId,
                  member_id: memberId,
                  subject_id: subjectId,
                  note: null,
                  ordinal_key: 'a0',
                  added_at: time,
                  transaction_id: memberTx,
                },
              ],
              'library.entry': [
                {
                  route,
                  account_id: account,
                  subject_id: subjectId,
                  requested_subject_id: null,
                  state: 'planned',
                  revision: 1,
                  created_at: time,
                  updated_at: time,
                  transaction_id: entryTx,
                },
              ],
              'library.progress_session': [
                {
                  route,
                  session_id: sessionId,
                  account_id: account,
                  subject_id: subjectId,
                  version_subject_id: null,
                  mode: 'completed_units',
                  unit: 'chapter',
                  total: null,
                  amount: null,
                  locator: null,
                  position: null,
                  completed_unit_count: 1,
                  state: 'active',
                  revision: 2,
                  started_at: time,
                  completed_at: null,
                  transaction_id: recordTx,
                },
              ],
              'library.progress_unit': [
                { route, session_id: sessionId, unit_id: `growth-unit:${placement.ordinal}`, added_at: time },
              ],
              'library.progress_change': [
                {
                  route,
                  session_id: sessionId,
                  change_no: 2,
                  intent: { add: [`growth-unit:${placement.ordinal}`] },
                  recorded_at: time,
                  transaction_id: recordTx,
                },
              ],
              'library.copy': [
                {
                  route,
                  copy_id: copyId,
                  account_id: account,
                  subject_id: subjectId,
                  status: 'ordered',
                  location: null,
                  source: null,
                  acquired_on: null,
                  disposed_on: null,
                  note: null,
                  revision: 1,
                  created_at: time,
                  updated_at: time,
                  transaction_id: copyTx,
                },
              ],
              'library.follow': [
                {
                  route,
                  account_id: account,
                  target_id: subjectId,
                  target_type: 'subject',
                  state: 'following',
                  reason: 'explicit',
                  created_at: time,
                  updated_at: time,
                  transaction_id: followTx,
                },
              ],
              'library.published_log': [
                {
                  route,
                  log_id: logId,
                  account_id: account,
                  session_id: sessionId,
                  subject_id: subjectId,
                  session_state: 'active',
                  started_at: time,
                  completed_at: null,
                  note: null,
                  published_at: time,
                  transaction_id: logTx,
                },
              ],
              'core.receipt': commands.map((command, index) => ({
                partition_no: command.partition,
                principal_kind: 'account',
                principal_id: account,
                command_kind: command.kind,
                idempotency_key: Bun.randomUUIDv7(),
                request_digest: crypto.getRandomValues(new Uint8Array(32)),
                epoch: 1,
                position: positionOf(index),
                transaction_id: command.transactionId,
                response: command.response,
              })),
              'editorial.write_basis': commands.map((command, index) => ({
                partition_no: command.partition,
                transaction_id: command.transactionId,
                epoch: 1,
                position: positionOf(index),
                principal_kind: 'account',
                principal_id: account,
                client_id: 'web',
                requested_by: null,
              })),
            };
          },
        };
        // Receipts and write bases reference their partitions.
        const partitions = new Set<number>();
        for (let ordinal = range.from; ordinal < range.to; ordinal++) {
          partitions.add(placement(population, ordinal).partition);
          partitions.add(subjectRouteOf(ordinal) >>> 4);
        }
        await db!.admin.query(
          'INSERT INTO core.partition (partition_no, node) SELECT unnest($1::int[]), (SELECT node FROM core.partition LIMIT 1) ON CONFLICT DO NOTHING',
          [[...partitions]],
        );
        await seedRows({ pool: db!.pool, admin: db!.admin }, population, range);
        seedSubjects = scale;
      },
      async measure<T>(operation: () => Promise<T>) {
        await holdExecutor();
        const internal: CapturedStatements = { statements: [], plans: [] };
        activeInternalCapture = internal;
        const result = await capture(db!, operation).finally(() => {
          activeInternalCapture = undefined;
        });
        const raw = withoutCatalogStatements('library outcome', {
          statements: [...result.capture.statements, ...internal.statements],
          plans: [...result.capture.plans, ...internal.plans],
        });
        const cost = costOf(raw);
        const saved = {
          scale: measurementScale,
          index: measurementIndex++,
          statements: [...raw.statements],
          buffers: cost.blocks,
        };
        savedMeasurements.push(saved);
        await mkdir(resolve(import.meta.dir, '../../../../../.temp'), { recursive: true });
        await Bun.write(
          resolve(import.meta.dir, `../../../../../.temp/library-outcome-${suffix}.json`),
          JSON.stringify(savedMeasurements, null, 2),
        );
        const baseline = savedMeasurements.find((item) => item.scale === 0 && item.index === saved.index);
        if (baseline && saved.scale > 0 && baseline.statements.length !== saved.statements.length) {
          const diff = difference(saved.statements, baseline.statements);
          const statements = (values: string[]) => values.map((text) => ({ file: sourceFile(text), text }));
          throw new Error(
            `Statement count changed at scale ${saved.scale}, measurement ${saved.index}; ` +
              `extra statements: ${JSON.stringify(statements(diff.added))}; ` +
              `missing statements: ${JSON.stringify(statements(diff.removed))}. ` +
              'Captured statement texts are in .temp/library-outcome-*.json.',
          );
        }
        return { value: result.value, statements: raw.statements.length, buffers: cost.blocks };
      },
      async close() {
        tokens.clear();
        await cleanup();
        dropped = true;
      },
    };
    await startExecutor();
    return driver;
  } catch (error) {
    await cleanup();
    dropped = true;
    throw error;
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the library executor');
  const workerEnv = workerTestEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    KERNEL_WORKER_POOL_SIZE: '10',
    KERNEL_EXECUTOR_ID: 'library-outcomes',
  });
  let repairLatch: ReturnType<typeof installStateReferenceRepairLatch> | undefined;
  process.on('message', (message) => repairLatch?.receive(message));
  process.on('disconnect', () => repairLatch?.close());
  const modules = KERNEL_WORK_MODULES.map((module) =>
    module.name !== 'library'
      ? module
      : {
          ...module,
          async register(context: Parameters<typeof module.register>[0]) {
            repairLatch = installStateReferenceRepairLatch(context.pool, (message) => process.send?.(message));
            await module.register(context);
          },
        },
  );
  await startWorker(readWorkerConfig(workerEnv), modules, workerEnv);
  for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
  process.send?.('ready');
}
