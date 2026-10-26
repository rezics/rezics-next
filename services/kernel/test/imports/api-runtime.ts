import { Database } from 'bun:sqlite';
import { afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { RATE_LIMIT_V1 } from '../../src/access/write-rate-budgets.ts';
import { rateIdentity } from '../../src/access/write-rate-identity.ts';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
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
import { actionCatalogue } from '../../src/http/request.ts';
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
  identitySupport,
  openImportIdentity,
  type ImportIdentity,
} from './identity-fixture.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createMediaBoundary } from './media-boundary.ts';
import { createApiCapture } from './api-capture.ts';

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
export async function openApiRuntime(options: DriverOptions) {
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
    let stageStart = Date.now();
    const identity = await time('identity and Auth setup', () =>
      openImportIdentity({
        database: ownedDatabase!,
        authTemplate: prepared.auth.name,
        clock: () => new Date(),
        async afterStage(stage) {
          recordPhase(`identity: ${stage}`, stageStart);
          stageStart = Date.now();
        },
      }),
    );
    ownedIdentity = identity;
    // Request the registered client's complete import scopes through the native account-key flow.
    const bulk = await time('importer account-key sign-in', () =>
      identitySupport(identity).issue(identity.bulk.accountId, identity.client.scopes),
    );
    const database = identity.database;
    const auth = identity.accessConfig.auth!;
    // The application resolves resource declarations from its complete mounted
    // routes. Identity administration's action-only extensions are not route metadata.
    const declarations = timeSync('kernel route declarations', () =>
      createKernel({ pool: database.pool, routeKey: identity.routeKey }),
    );
    const access = createAccess({ actions: actionCatalogue(declarations), auth });
    const fetchConfig = { allowedHosts: ['lain.bgm.tv', 'covers.openlibrary.org'] };
    boundary = await time('media boundary', () =>
      createMediaBoundary({
        content: { pool: database.pool, access, routeKey: identity.routeKey, clock: () => new Date() },
        fetchConfig,
        workerEnvironment: {
          AUTH_ISSUER: auth.issuer,
          AUTH_AUDIENCE: auth.audience,
          AUTH_JWKS_URL: auth.jwksUrl,
          KERNEL_SESSION_KEYS: [...identity.tokenKeys.keys]
            .map(([id, bytes]) => `${id}:${Buffer.from(bytes).toString('base64url')}`)
            .join(','),
          CONTENT_AUTH_CONSENT_URL: `${auth.issuer}/internal/v1/consents:read`,
          CF_ACCESS_CLIENT_ID: 'external-fixture',
          CF_ACCESS_CLIENT_SECRET: 'external-fixture-secret',
          OPENSEARCH_URL: '',
          STRIPE_SECRET_KEY: '',
        },
      }),
    );
    const mediaBoundary = boundary;
    await mediaBoundary.source('https://lain.bgm.tv/cover.jpg');
    await mediaBoundary.source('https://lain.bgm.tv/replacement.jpg');
    work = await time('work client', () => createWorkClient(database.url, database.openPool()));
    const secret = randomUUID();
    const context = { pool: database.pool, deadline: Date.now() + 10000 };
    const actor = await access.authenticate(bulk.bearer, context);
    const importerClass = rateIdentity({ ...context, actor }, secret).rateClass;
    let overrides = JSON.stringify({
      [importerClass]: { upload: RATE_LIMIT_V1.service.upload, write: RATE_LIMIT_V1.service.write },
    });
    let limited: Parameters<ImportApiDriver['rateLimit']>[0] | undefined;
    let batchUnits = 0;
    function budget(units: number) {
      if (!limited || units <= batchUnits) return;
      batchUnits = units;
      overrides = JSON.stringify({
        [importerClass]: {
          upload: RATE_LIMIT_V1.service.upload,
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
        workClient: work!,
        content: { fetchConfig },
        writeRate: createWriteRateLimiter({ secret, ...(overrides ? { overrides } : {}) }),
      });
    }
    let app = timeSync('kernel composition', kernel);
    const measurement = createApiCapture(database, identitySupport(identity).authDatabase);
    const captures: { request: Request; body: string; response: Response }[] = [];
    const commands = new Map<string, { command: BatchCommand; actor: string }>();
    let current:
      | { result: Run; controls: Controls; abort: AbortController; lost: boolean; reading: boolean }
      | undefined;

    async function request(path: string, body?: unknown, bearer?: string, key = randomUUID()) {
      return app.handle(
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
    }

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

    const transport = createImportTransport({
      origin,
      tokenProvider: async () => (current?.controls.as === 'ordinary' ? identity.ordinary.bearer : bulk.bearer),
      now: Date.now,
      sleep: async (ms) => {
        current?.result.waits.push({ startedAtMs: Date.now(), durationMs: ms });
        await Bun.sleep(ms);
      },
      fetch: (async (input, init) => {
        const req = new Request(input, init);
        const atMs = Date.now();
        const bytes = req.method === 'POST' ? await req.clone().text() : '';
        const bulk = new URL(req.url).pathname === '/v1/subjects:batchWrite';
        if (bulk) {
          budget((JSON.parse(bytes) as BatchWriteRequest).commands.length);
          await current?.controls.beforeWrite?.();
        }
        const response = await time(`HTTP: ${req.method} ${new URL(req.url).pathname}`, () => app.handle(req));
        captures.push({ request: req, body: bytes, response: response.clone() });
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
              body: await response.clone().json(),
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
      }) as typeof fetch,
    });
    const root = resolve(import.meta.dir, '../../../../.temp');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(`${root}/import-api-`);
    const path = `${directory}/state.sqlite`;
    let workerStart: Promise<void> | undefined;
    function openImporter() {
      const next = new Importer({
        path,
        instrumentDatabase: measurement.instrument,
        transport: {
          batchWrite: (body) => transport.batch(body, current?.abort.signal),
          readFence: (tuple) =>
            transport.fence(
              { source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group },
              current?.abort.signal,
            ),
        },
        onConversionOutput(output) {
          if (current?.reading) (current.result.conversions as object[]).push(output);
        },
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
            });
            if (resolved.outcome !== 'resolved' || resolved.assets.some((asset) => asset.outcome !== 'available'))
              return { status: 'pending' };
            return { status: 'available', mediaIds: resolved.mediaIds };
          },
        },
      });
      measurement.attach([next.session, next.session.store, next.session.bindings]);
      return next;
    }
    importer = timeSync('importer state', openImporter);
    async function run(dump: Dump, controls: Controls = {}): Promise<Run> {
      if (current) throw new Error('Concurrent fixture run');
      const started = Date.now();
      const measured = !!measurement.active;
      const result: Run = { outcome: 'interrupted', conversions: [], exchanges: [], waits: [], vanished: [] };
      current = { result, controls, abort: new AbortController(), lost: false, reading: true };
      const counters = createDumpCounters();
      let tableDb: Database | undefined;
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
        const inputRecords = records;
        records = (async function* () {
          try {
            yield* inputRecords;
          } finally {
            if (current) current.reading = false;
          }
        })();
        const native = await importer!.runRecords(
          createSourceRegistration(dump.source, { source: dump.source, converterRevision: dump.converterRevision }),
          records,
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
        tableDb?.close();
        current = undefined;
        recordPhase(
          `${measured ? 'measured' : 'unmeasured'} run: ${dump.source} ${dump.bytes.length} bytes (${result.outcome})`,
          started,
        );
      }
      return result;
    }
    recordPhase('runtime setup total', started);
    return {
      identity,
      bulk,
      database,
      mediaBoundary,
      measurement,
      time,
      request,
      captures,
      commands,
      receipt,
      run,
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
        batchUnits = 0;
      },
      replay: (req: Request) => app.handle(req),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type ApiRuntime = Awaited<ReturnType<typeof openApiRuntime>>;
