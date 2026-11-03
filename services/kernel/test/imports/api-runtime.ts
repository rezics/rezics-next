import { Database } from 'bun:sqlite';
import { decodeJwt } from 'jose';
import { afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { rateIdentity } from '../../src/access/write-rate-identity.ts';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { SourceRecord } from '../../../../packages/conversion/src/index.ts';
import { Importer } from '../../../importer/src/importer.ts';
import { createImportTransport } from '../../../importer/src/import-client.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import { createMediaResolver } from '../../../importer/src/media-resolver.ts';
import { readDump } from '../../../importer/src/dumps.ts';
import { createDumpCounters } from '../../../importer/src/dumps-bytes.ts';
import { VndbTablesStore } from '../../../importer/src/vndb-tables.ts';
import type { DriverOptions, Dump, Exchange, ImportApiDriver, Run } from '../../../../specs/imports-api-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { setupSemantic } from '../../src/semantic/setup.ts';
import { setupPresentation } from '../../src/presentation/setup.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import {
  createIdentityNamespace,
  importActionCatalogue,
  identitySupport,
  openImportIdentity,
  type ImportIdentity,
} from './identity-fixture.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createMediaBoundary } from './media-boundary.ts';
import { createApiCapture } from './api-capture.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';
import { workerTestEnv } from '../support/worker-env.ts';

type GrowthSqliteCapture = {
  instrument(database: Database): Database;
  attach(objects: readonly object[]): void;
  capture<T>(operation: () => Promise<T>): Promise<{
    value: T;
    statements: import('../../../../specs/imports-growth-driver.ts').SqliteStatement[];
  }>;
  readonly metadata: {
    analyzed: boolean;
    growingRelations: import('../../../../specs/imports-growth-driver.ts').GrowingRelation[];
  };
};
type GrowthObserver = NonNullable<ConstructorParameters<typeof Importer>[0]['observer']>;
type StartupWriteRate = { maximum: number; seconds: number };
type ScheduledDeadline = { scheduledAtMs: number; deadlineAtMs: number; durationMs: number };
type HttpEvent = {
  sequence: number;
  attempt: number;
  method: string;
  path: string;
  requestKey: string;
  bodyBytes: number;
  commandKeys: string[];
  startedAtMs: number;
  deadlineAtMs?: number;
  deadlineMs?: number;
  tokenExpiresAtMs?: number;
  tokenRemainingMs?: number;
  status?: number;
  problem?: string;
  commandProblems?: BatchWriteResult['results'];
  error?: string;
  abortedAtMs?: number;
  abortReason?: string;
};
type RetryWait = { atMs: number; durationMs: number; layer: 'transport' | 'importer' };

const origin = 'https://kernel.import.test';
type Controls = NonNullable<Parameters<ImportApiDriver['run']>[1]>;
type Timer = <T>(phase: string, action: () => Promise<T>) => Promise<T>;
type Namespace = Awaited<ReturnType<typeof createIdentityNamespace>>;
const templates = new Map<string, Promise<{ application: Namespace; auth: Namespace }>>();

/** Only immutable startup installation is shared; no accounts, credentials or import effects are cloned. */
function preparedDatabases(base: string, time: Timer) {
  let prepared = templates.get(base);
  if (!prepared) {
    prepared = (async () => {
      let application: Namespace | undefined;
      let auth: Namespace | undefined;
      try {
        application = await createIdentityNamespace(base, decodeURIComponent(new URL(base).pathname.slice(1)));
        const database = await openGrowthDatabase(application.url);
        try {
          await time('prepare semantic and presentation template', async () => {
            configureTestReceiptKeys(database.pool);
            await setupSemantic(database.pool, bundledRelease);
            await setupPresentation(database.pool);
          });
        } finally {
          await database.close();
        }
        auth = await createIdentityNamespace(base);
        await time('prepare Auth migration template', async () => migrateAuth(auth!.url));
        return { application, auth };
      } catch (error) {
        try {
          await auth?.close();
        } finally {
          await application?.close();
        }
        throw error;
      }
    })();
    templates.set(base, prepared);
  }
  return prepared;
}

afterAll(async () => {
  for (const prepared of templates.values()) {
    const result = await prepared.catch(() => undefined);
    if (result)
      try {
        await result.auth.close();
      } finally {
        await result.application.close();
      }
  }
  templates.clear();
}, 120_000);

/** One owner of credentials, public transport, worker, durable journal and cleanup. */
export async function openApiRuntime(
  options: DriverOptions & { readonly sourceStatistics?: 'vndb' },
  growthSqlite?: GrowthSqliteCapture,
  growthObserver?: GrowthObserver,
  growthWriteRate?: StartupWriteRate,
) {
  const started = Date.now();
  const fixture = randomUUID();
  const evidenceRoot = resolve(import.meta.dir, '../../../../.temp');
  mkdirSync(evidenceRoot, { recursive: true });
  function recordPhase(phase: string, started: number) {
    appendFileSync(
      `${evidenceRoot}/import-api-timings.jsonl`,
      `${JSON.stringify({ fixture, processId: process.pid, phase, atMs: Date.now(), elapsedMs: Date.now() - started })}\n`,
    );
  }
  async function time<T>(phase: string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await action();
    } finally {
      recordPhase(phase, started);
    }
  }
  function timeSync<T>(phase: string, action: () => T): T {
    const started = Date.now();
    try {
      return action();
    } finally {
      recordPhase(phase, started);
    }
  }
  let ownedIdentity: ImportIdentity | undefined;
  let ownedDatabase: GrowthDatabase | undefined;
  let namespace: Namespace | undefined;
  let boundary: Awaited<ReturnType<typeof createMediaBoundary>> | undefined;
  let workerStart: Promise<void> | undefined;
  let importer: Importer | undefined;
  let work: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let directory: string | undefined;
  let ending: Promise<void> | undefined;
  const close = () =>
    (ending ??= time('close', async () => {
      try {
        await importer?.close();
      } finally {
        try {
          await boundary?.close();
        } finally {
          try {
            await work?.close();
          } finally {
            try {
              try {
                await ownedIdentity?.close();
              } finally {
                try {
                  await ownedDatabase?.close();
                } finally {
                  await namespace?.close();
                }
              }
            } finally {
              if (directory) await rm(directory, { recursive: true, force: true });
            }
          }
        }
      }
    }));
  try {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL must name a migrated application database');
    const prepared = await time('prepare shared databases', () => preparedDatabases(base, time));
    namespace = await time('clone application template', () =>
      createIdentityNamespace(base, prepared.application.name),
    );
    ownedDatabase = await openGrowthDatabase(namespace.url);
    const fetchConfig = { allowedHosts: ['lain.bgm.tv', 'covers.openlibrary.org'] };
    let stageStart = Date.now();
    const identity = await time('identity and Auth setup', () =>
      openImportIdentity({
        database: ownedDatabase!,
        authTemplate: prepared.auth.name,
        clock: () => new Date(),
        ...(options.sourceStatistics === undefined ? {} : { sourceStatistics: options.sourceStatistics }),
        async configured(configuration) {
          const auth = configuration.accessConfig.auth!;
          boundary = await time('media boundary', () =>
            createMediaBoundary({
              content: {
                pool: ownedDatabase!.pool,
                access: configuration.access,
                routeKey: configuration.routeKey,
                clock: () => new Date(),
              },
              fetchConfig,
              workerEnvironment: workerTestEnv({
                AUTH_ISSUER: auth.issuer,
                AUTH_AUDIENCE: auth.audience,
                AUTH_JWKS_URL: auth.jwksUrl,
                KERNEL_SESSION_KEYS: [...configuration.tokenKeys.keys]
                  .map(([id, bytes]) => `${id}:${Buffer.from(bytes).toString('base64url')}`)
                  .join(','),
                KERNEL_AUTH_CONSENT_URL: `${auth.issuer}/internal/v1/consents:read`,
                CF_ACCESS_CLIENT_ID: 'external-fixture',
                CF_ACCESS_CLIENT_SECRET: 'external-fixture-secret',
                OPENSEARCH_URL: '',
                STRIPE_SECRET_KEY: '',
              }),
            }),
          );
          // The isolated kernel worker and Auth provisioning are independent.
          // Keep their real startup work inside setup, but let it overlap.
          workerStart = time('media worker start', () => boundary!.start());
          void workerStart.catch(() => {});
        },
        async afterStage(stage) {
          recordPhase(`identity: ${stage}`, stageStart);
          stageStart = Date.now();
        },
      }),
    );
    ownedIdentity = identity;
    // Request the registered client's complete import scopes through the native account-key flow.
    let bulk = await time('importer account-key sign-in', () =>
      identitySupport(identity).issue(identity.bulk.accountId, identity.client.scopes),
    );
    const tokenRenewals: { atMs: number; priorExpiresAtMs: number; expiresAtMs: number }[] = [];
    const database = identity.database;
    const auth = identity.accessConfig.auth!;
    // The application resolves resource declarations from its complete mounted
    // routes. Identity administration's action-only extensions are not route metadata.
    const actions = timeSync('kernel route declarations', () => importActionCatalogue(database, identity.routeKey));
    const access = createAccess({ actions, auth });
    const mediaBoundary = boundary!;
    await mediaBoundary.source('https://lain.bgm.tv/cover.jpg');
    await mediaBoundary.source('https://lain.bgm.tv/replacement.jpg');
    work = await time('work client', () => createWorkClient(database.url, database.openPool()));
    const secret = randomUUID();
    let overrides: string | undefined = growthWriteRate
      ? JSON.stringify({ service: { write: growthWriteRate } })
      : undefined;
    let limited: Parameters<ImportApiDriver['rateLimit']>[0] | undefined;
    // The public growth client caps each request at 100 commands. Keep one
    // startup budget for all warm-up and measured envelopes.
    let batchUnits = growthWriteRate ? 100 : 0;
    function budget(units: number) {
      if (growthWriteRate || !limited || units <= batchUnits) return;
      batchUnits = units;
      overrides = JSON.stringify({
        [importerClass]: {
          write: { maximum: limited.requests * batchUnits, seconds: limited.windowMs / 1000 },
        },
      });
      app = timeSync('rate-limit kernel configuration', kernel);
    }
    function kernel() {
      return createKernel({
        pool: database.pool,
        routeKey: identity.routeKey,
        access,
        tokens: identity.tokenKeys,
        receiptKeys: testReceiptKeys(),
        workClient: work!,
        content: { fetchConfig },
        writeRate: createWriteRateLimiter({ secret, ...(overrides ? { overrides } : {}) }),
      });
    }
    let app = timeSync('kernel composition', kernel);
    // Observer fan-out shares one native pool; admit reads before HTTP deadlines start.
    let observerRequests = 0;
    const observerWaiting: (() => void)[] = [];
    async function request(path: string, body?: unknown, bearer?: string, key = randomUUID()) {
      if (observerRequests === 1) await new Promise<void>((resolve) => observerWaiting.push(resolve));
      else observerRequests++;
      const send = () =>
        app.handle(
          new Request(`${origin}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
              ...(body === undefined
                ? {}
                : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      try {
        let response = await send();
        for (let attempt = 1; response.status === 503 && attempt < 3; attempt++) {
          await response.body?.cancel();
          await Bun.sleep(1000);
          response = await send();
        }
        return response;
      } finally {
        const next = observerWaiting.shift();
        if (next) next();
        else observerRequests--;
      }
    }

    if (options.sourceStatistics === 'vndb') {
      const response = await request(
        '/v1/platform/exposure/personal_library:open',
        {},
        identitySupport(identity).managementBearer,
      );
      if (response.status !== 200)
        throw new Error(`VNDB statistic exposure setup: HTTP ${response.status}: ${await response.text()}`);
      await response.body?.cancel();
    }
    const tierKey = randomUUID();
    const tierResponse = await request(
      `/v1/accounts/${bulk.accountId}:setRateTier`,
      { key: tierKey, tier: 'service' },
      identitySupport(identity).managementBearer,
      tierKey,
    );
    if (tierResponse.status !== 200)
      throw new Error(`Importer service tier setup: HTTP ${tierResponse.status}: ${await tierResponse.text()}`);
    const context = { pool: database.pool, deadline: Date.now() + 10000 };
    const actor = await access.authenticate(bulk.bearer, context);
    const importerClass = rateIdentity({ ...context, actor }, secret).rateClass;
    const measurement = createApiCapture(database, identitySupport(identity).authDatabase);
    const captures: { request: Request; body: string; response: Response }[] = [];
    const httpEvents: HttpEvent[] = [];
    const retryWaits: RetryWait[] = [];
    const pendingDeadlines: ScheduledDeadline[] = [];
    const deadlines = new Map<string, ScheduledDeadline>();
    const attempts = new Map<string, number>();
    let lastTransportClockMs = Date.now();
    function transportKey(request: Request, body: string): { key: string; commandKeys: string[] } {
      const url = new URL(request.url);
      let commandKeys: string[] = [];
      if (url.pathname === '/v1/subjects:batchWrite' && body) {
        try {
          const commands = (JSON.parse(body) as { commands?: { key?: unknown }[] }).commands;
          if (Array.isArray(commands))
            commandKeys = commands.flatMap((command) => (typeof command.key === 'string' ? [command.key] : []));
        } catch {
          // Keep the transport evidence even when the endpoint rejects an invalid envelope.
        }
      }
      const identity =
        request.headers.get('idempotency-key') ??
        (commandKeys.length ? commandKeys.join('\u0000') : `${url.pathname}${url.search}`);
      return { key: `${request.method} ${url.pathname}${url.search} ${identity}`, commandKeys };
    }
    function scheduleDeadline(callback: () => void, durationMs: number) {
      const scheduledAtMs = lastTransportClockMs;
      const deadline: ScheduledDeadline = { scheduledAtMs, deadlineAtMs: scheduledAtMs + durationMs, durationMs };
      pendingDeadlines.push(deadline);
      const timer = setTimeout(callback, durationMs);
      return () => {
        clearTimeout(timer);
        const index = pendingDeadlines.indexOf(deadline);
        if (index >= 0) pendingDeadlines.splice(index, 1);
      };
    }
    const commands = new Map<string, { command: BatchCommand; actor: string }>();
    let current: { result: Run; controls: Controls; abort: AbortController; lost: boolean } | undefined;

    async function receipt(key: string) {
      const known = commands.get(key);
      if (!known) return null;
      const command = known.command;
      const kind = `subject.batch_${command.op}`;
      const route =
        command.op === 'create'
          ? tupleRoute(identity.routeKey, command.source.source, command.source.external_id)
          : routeOf(command.subject)!;
      const found = await database.admin.query<{
        partition_no: number;
        principal_kind: string;
        principal_id: string;
        command_kind: string;
        idempotency_key: string;
      }>(
        'SELECT partition_no,principal_kind,principal_id,command_kind,idempotency_key FROM core.receipt WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5',
        [partitionOf(route), 'account', known.actor, kind, key],
      );
      return found.rows[0] ? JSON.stringify(found.rows[0]) : null;
    }

    let renewingBulk: Promise<void> | undefined;
    // Bound HTTP connections alongside the sixteen record workers so their
    // three-way preflights cannot overflow the native admission queue.
    let requests = 0;
    const waiting: (() => void)[] = [];
    // Writes share one account's native transaction fences. Order them while
    // record reads and deferred media work retain their pipeline concurrency.
    let writing = false;
    const writes: (() => void)[] = [];
    async function bulkBearer() {
      if ((decodeJwt(bulk.bearer).exp ?? 0) * 1000 - Date.now() < 60_000) {
        renewingBulk ??= time('importer account-key renewal', async () => {
          const atMs = Date.now();
          const priorExpiresAtMs = (decodeJwt(bulk.bearer).exp ?? 0) * 1000;
          bulk = await identitySupport(identity).issue(identity.bulk.accountId, identity.client.scopes);
          tokenRenewals.push({ atMs, priorExpiresAtMs, expiresAtMs: (decodeJwt(bulk.bearer).exp ?? 0) * 1000 });
        }).finally(() => {
          renewingBulk = undefined;
        });
        await renewingBulk;
      }
      return bulk.bearer;
    }
    const transport = createImportTransport({
      origin,
      async tokenProvider() {
        if (current?.controls.as === 'ordinary') return identity.ordinary.bearer;
        return bulkBearer();
      },
      now: growthSqlite
        ? () => {
            lastTransportClockMs = Date.now();
            return lastTransportClockMs;
          }
        : Date.now,
      sleep: async (ms) => {
        retryWaits.push({ atMs: Date.now(), durationMs: ms, layer: 'transport' });
        current?.result.waits.push({ startedAtMs: Date.now(), durationMs: ms });
        await Bun.sleep(ms);
      },
      ...(growthSqlite === undefined ? {} : { schedule: scheduleDeadline }),
      fetch: (async (input, init) => {
        const req = new Request(input, init);
        const bulk = new URL(req.url).pathname === '/v1/subjects:batchWrite';
        let event: HttpEvent | undefined;
        const onAbort = () => {
          if (!event) return;
          event.abortedAtMs = Date.now();
          event.abortReason = String(req.signal.reason ?? 'aborted');
        };
        if (bulk) {
          if (writing) await new Promise<void>((resolve) => writes.push(resolve));
          else writing = true;
        }
        if (requests >= 8) await new Promise<void>((resolve) => waiting.push(resolve));
        else requests++;
        try {
          req.signal.throwIfAborted();
          const atMs = Date.now();
          const bytes = req.method === 'POST' || req.method === 'PUT' ? await req.clone().text() : '';
          const { key: requestKey, commandKeys } = transportKey(req, bytes);
          const scheduled = pendingDeadlines.shift();
          if (scheduled) {
            deadlines.set(requestKey, scheduled);
            attempts.set(requestKey, 0);
          }
          const attempt = (attempts.get(requestKey) ?? 0) + 1;
          attempts.set(requestKey, attempt);
          const deadline = deadlines.get(requestKey);
          let tokenExpiresAtMs: number | undefined;
          const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
          if (bearer) {
            try {
              const expiry = decodeJwt(bearer).exp;
              if (typeof expiry === 'number') tokenExpiresAtMs = expiry * 1000;
            } catch {
              // Keep the HTTP event when a request has a non-JWT authorization value.
            }
          }
          event = {
            sequence: httpEvents.length + 1,
            attempt,
            method: req.method,
            path: `${new URL(req.url).pathname}${new URL(req.url).search}`,
            requestKey,
            bodyBytes: Buffer.byteLength(bytes),
            commandKeys,
            startedAtMs: atMs,
            ...(deadline === undefined ? {} : { deadlineAtMs: deadline.deadlineAtMs, deadlineMs: deadline.durationMs }),
            ...(tokenExpiresAtMs === undefined ? {} : { tokenExpiresAtMs, tokenRemainingMs: tokenExpiresAtMs - atMs }),
          };
          req.signal.addEventListener('abort', onAbort, { once: true });
          if (bulk) {
            budget((JSON.parse(bytes) as BatchWriteRequest).commands.length);
            await current?.controls.beforeWrite?.();
          }
          const response = await time(`HTTP: ${req.method} ${new URL(req.url).pathname}`, () => app.handle(req));
          // Detach the actual response bytes before a simulated transport loss
          // aborts the request and its connected response streams.
          const captured = new Response(response.status === 204 ? null : await response.clone().arrayBuffer(), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          event.status = response.status;
          if (response.status >= 400) event.problem = await captured.clone().text();
          if (bulk && response.status === 200) {
            const body = (await captured.clone().json()) as BatchWriteResult;
            const problems = body.results.filter((result) => result.status >= 400);
            if (problems.length) event.commandProblems = problems;
          }
          captures.push({ request: req, body: bytes, response: captured });
          if (bulk && current) {
            const body = JSON.parse(bytes) as BatchWriteRequest;
            for (const command of body.commands)
              commands.set(command.key, {
                command,
                actor: current.controls.as === 'ordinary' ? identity.ordinary.accountId : identity.bulk.accountId,
              });
            const exchange: Exchange = {
              request: {
                url: req.url,
                method: req.method,
                headers: new Headers(req.headers),
                body,
                serializedBody: bytes,
                keys: body.commands.map((c) => c.key),
              },
              response: {
                status: response.status,
                headers: new Headers(response.headers),
                body: await captured.clone().json(),
              },
              atMs,
              receipts:
                response.status === 200
                  ? await Promise.all(body.commands.map(async (c) => ({ key: c.key, identity: await receipt(c.key) })))
                  : [],
            };
            current.result.exchanges.push(exchange);
            if (response.status === 429) await current.controls.onRateLimited?.(exchange);
            if (response.status === 200 && current.controls.loseCommittedResponse && !current.lost) {
              current.lost = true;
              current.abort.abort(new Error('Committed response lost at HTTP boundary'));
              throw current.abort.signal.reason;
            }
          }
          return response;
        } catch (error) {
          if (event) event.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          throw error;
        } finally {
          if (event) httpEvents.push(event);
          req.signal.removeEventListener('abort', onAbort);
          const next = waiting.shift();
          if (next) next();
          else requests--;
          if (bulk) {
            const write = writes.shift();
            if (write) write();
            else writing = false;
          }
        }
      }) as typeof fetch,
    });
    directory = await mkdtemp(`${tmpdir()}/import-api-`);
    const path = `${directory}/state.sqlite`;
    function openImporter(serial = false) {
      const next = new Importer({
        path,
        destination: { origin },
        // Fault controls select one record so the chosen commit or one-request
        // rate window has a deterministic boundary within bounded retries.
        ...(serial || limited ? { recordConcurrency: 1 } : {}),
        now: Date.now,
        sleep: async (ms, signal) => {
          retryWaits.push({ atMs: Date.now(), durationMs: ms, layer: 'importer' });
          current?.result.waits.push({ startedAtMs: Date.now(), durationMs: ms });
          await sleep(ms, undefined, { signal });
        },
        instrumentDatabase: growthSqlite?.instrument ?? measurement.instrument,
        transport: {
          setSourceRecordMetadata: (input, signal) =>
            transport.setSourceRecordMetadata(input, signal ?? current?.abort.signal),
          batchWrite: (body) => transport.batch(body, current?.abort.signal),
          ...(options.sourceStatistics === 'vndb'
            ? {
                clearSourceStatistic: (
                  input: Parameters<typeof transport.clearSourceStatistic>[0],
                  signal?: AbortSignal,
                ) => transport.clearSourceStatistic(input, signal ?? current?.abort.signal),
                writeSourceStatistic: (
                  input: Parameters<typeof transport.writeSourceStatistic>[0],
                  signal?: AbortSignal,
                ) => transport.writeSourceStatistic(input, signal ?? current?.abort.signal),
              }
            : {}),
          readFence: (tuple) =>
            transport.fence(
              { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
              current?.abort.signal,
            ),
        },
        onConversionOutput(output) {
          if (current) (current.result.conversions as object[]).push(output);
        },
        ...(growthObserver === undefined ? {} : { observer: growthObserver }),
        mediaResolver: {
          async resolve(input) {
            const resolver = createMediaResolver({
              bindings: next.session.bindings,
              sleep: async (ms) => {
                current?.result.waits.push({ startedAtMs: Date.now(), durationMs: ms });
                await Bun.sleep(ms);
              },
              port: {
                readFence: (tuple, signal) => transport.fence(tuple, signal),
                importFromUrl: (bytes, key, signal) => transport.requestMedia(bytes, key, signal),
                async importStatus(id, signal) {
                  await (workerStart ??= time('media worker start', () => mediaBoundary.start()));
                  await time('media drain', () => mediaBoundary.drain({ mediaIds: [id], maxJobs: 16, signal }));
                  return transport.mediaStatus(id, signal);
                },
              },
            });
            const resolved = await resolver.resolve({
              owner: input.owner,
              containerId: input.subject,
              mediaImportIntents: input.mediaImportIntents,
              signal: input.signal,
              deferPending: input.deferPending ?? false,
            });
            if (resolved.outcome !== 'resolved' || resolved.assets.some((asset) => asset.outcome !== 'available'))
              return { status: 'pending' };
            return { status: 'available', mediaIds: resolved.mediaIds };
          },
        },
      });
      if (growthSqlite) measurement.attachDatabase(next.session.store.database);
      measurement.attach([next.session, next.session.store, next.session.bindings]);
      growthSqlite?.attach([next.session, next.session.store, next.session.bindings]);
      return next;
    }
    importer = timeSync('importer state', openImporter);
    // A deployment's worker is already running when imports reach its API.
    // Compile and launch this isolated native worker before request deadlines start.
    await (workerStart ??= time('media worker start', () => mediaBoundary.start()));
    async function run(dump: Dump, controls: Controls = {}): Promise<Run> {
      if (current) throw new Error('Concurrent fixture run');
      if (controls.loseCommittedResponse) {
        await importer!.close();
        importer = openImporter(true);
      }
      const started = Date.now();
      const measured = !!measurement.active;
      const result: Run = { outcome: 'interrupted', conversions: [], exchanges: [], waits: [], vanished: [] };
      current = { result, controls, abort: new AbortController(), lost: false };
      const counters = createDumpCounters();
      let tableDb: Database | undefined;
      let readerMs = 0;
      try {
        let records: AsyncIterable<SourceRecord>;
        if (dump.source === 'vndb' && dump.entries) {
          tableDb = new Database(`${directory}/vndb-${randomUUID()}.sqlite`);
          const tables = new VndbTablesStore(tableDb, { pageSize: options.batchRecords });
          const run = randomUUID();
          tables.begin('vndb', run);
          await tables.stage('vndb', run, dump.entries());
          records = (async function* () {
            let after: string | null = null;
            do {
              const page = tables.page('vndb', run, { after, limit: options.batchRecords });
              for (const record of page.records)
                yield {
                  source: 'vndb' as const,
                  key: record.key,
                  revision: String(record.revision),
                  payload: record.record,
                };
              after = page.next;
            } while (after);
          })();
        } else {
          const chunks = (async function* () {
            for (let offset = 0; offset < dump.bytes.length; offset += 4096)
              yield dump.bytes.slice(offset, offset + 4096);
          })();
          records = readDump(dump.source, chunks, { maxRecordBytes: options.maxRecordBytes, counters });
        }
        const native = await importer!.runRecords(
          createSourceRegistration(dump.source, { source: dump.source, converterRevision: dump.converterRevision }),
          (async function* () {
            const reader = records[Symbol.asyncIterator]();
            try {
              while (true) {
                const started = performance.now();
                let next: IteratorResult<SourceRecord>;
                try {
                  next = await reader.next();
                } finally {
                  readerMs += performance.now() - started;
                }
                if (next.done) return;
                yield next.value;
              }
            } finally {
              await reader.return?.();
            }
          })(),
          { maxRecordBytes: options.maxRecordBytes, collectionLimit: 10000, signal: current.abort.signal },
        );
        result.outcome = current.lost
          ? 'interrupted'
          : native.status === 'committed'
            ? 'complete'
            : native.status === 'mass-disappearance'
              ? 'mass-disappearance'
              : native.status === 'invalid-dump'
                ? 'invalid-input'
                : native.status === 'bulk-failed'
                  ? 'denied'
                  : 'interrupted';
        result.vanished = native.vanished;
      } catch (error) {
        if (current.lost) result.outcome = 'interrupted';
        else if (
          dump.source === 'vndb' &&
          error instanceof Error &&
          ['Invalid VNDB table input', 'VNDB table staging failed'].includes(error.message)
        )
          result.outcome = 'invalid-input';
        else throw error;
      } finally {
        const reader = measurement.active?.reader;
        if (reader) {
          reader.inputBytes += counters.pulledBytes;
          reader.records += counters.yieldedRecords;
          reader.peakBufferedBytes = Math.max(reader.peakBufferedBytes, counters.peakRetainedBytes);
          reader.maxPageRecords = Math.max(reader.maxPageRecords, counters.yieldedRecords > 0 ? 1 : 0);
          reader.workUnits += counters.scannedBytes + counters.copiedBytes;
        }
        recordPhase(`reader: ${dump.source} ${dump.bytes.length} bytes`, Date.now() - readerMs);
        tableDb?.close();
        current = undefined;
        recordPhase(
          `${measured ? 'measured' : 'unmeasured'} run: ${dump.source} ${dump.bytes.length} bytes (${result.outcome})`,
          started,
        );
      }
      return result;
    }
    // Reylo checks each query object's schema freshness on first use and again every minute, and every
    // concurrent cold use probes. The importer's concurrent fence reads share these native query objects, so
    // complete one real public read of a spare tuple first. A fence check only reads: no ledger, proposal,
    // receipt or checkpoint of a measured source can come from it.
    async function warm() {
      await time('fence query warm-up', async () => {
        const source = 'warm-spare';
        const query = new URLSearchParams({ source, externalId: randomUUID(), fieldGroup: 'facts' });
        const response = await app.handle(
          new Request(`${origin}/v1/sourceFences:check?${query}`, {
            headers: { authorization: `Bearer ${await bulkBearer()}` },
          }),
        );
        if (response.status !== 200)
          throw new Error(`Fence warm-up: HTTP ${response.status}: ${await response.text()}`);
        await response.body?.cancel();
      });
    }
    await warm();
    recordPhase('runtime setup total', started);
    return {
      identity,
      get bulk() {
        return bulk;
      },
      database,
      mediaBoundary,
      measurement,
      async measureGrowth<T>(operation: () => Promise<T>) {
        if (!growthSqlite) throw new Error('Growth SQLite capture was not configured');
        let sqliteStatements: import('../../../../specs/imports-growth-driver.ts').SqliteStatement[] = [];
        const phases = await measurement.measure(async () => {
          const observed = await growthSqlite.capture(operation);
          sqliteStatements = observed.statements;
          return observed.value;
        });
        return { phases, sqliteStatements, sqlite: growthSqlite.metadata };
      },
      importTransport: transport,
      time,
      request,
      captures,
      httpEvents,
      tokenRenewals,
      retryWaits,
      commands,
      receipt,
      run,
      warm,
      close,
      get importer() {
        return importer!;
      },
      importerClass,
      async restart() {
        await importer!.close();
        importer = openImporter();
      },
      async rateLimit(input: Parameters<ImportApiDriver['rateLimit']>[0]) {
        limited = input;
        if (!growthWriteRate) batchUnits = 0;
        await importer!.close();
        importer = openImporter();
      },
      replay: (req: Request) => app.handle(req),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type ApiRuntime = Awaited<ReturnType<typeof openApiRuntime>>;
