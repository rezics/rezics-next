import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeJwt } from 'jose';
import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import type { MediaBoundaryDriver } from '../../../../specs/imports-media-boundary-driver.ts';
import type { MediaBoundary } from './media-boundary.ts';
import { mediaEnvelope, observeMediaPool } from './media-boundary-observer.ts';
import {
  openGrowthDatabase,
  capture,
  costOf,
  medianCost,
  checkGrowth,
  seed,
  assertGrowth,
  type GrowthDatabase,
  type GrowthSample,
  type Population,
} from '../support/growth.ts';
import type { Capture, Cost } from '../support/growth-cost.ts';
import { routeOf, partitionOf, newId } from '../../src/route/route.ts';
import type { ImportIdentity } from './identity-fixture.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { DBOSExecutor } from '@dbos-inc/dbos-sdk/internal/dbos-executor';
import { globalParams } from '@dbos-inc/dbos-sdk/internal/utils';
import { wfQueueRunner, type WorkflowQueue } from '@dbos-inc/dbos-sdk/internal/wfqueue';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { effectWorkflowId } from '../../src/events/effects.ts';
import type { Envelope } from '../../src/events/log.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { workerTestEnv } from '../support/worker-env.ts';

// SQL compilation depends on the unchanged migrated schema, not on a fixture's
// accounts or rows. Retain only the real compiler's output between isolated
// application processes; each child owns and removes its private loader files.
const compiledSql = new Map<string, { source: string; code: string }>();
async function sqlLoader() {
  // A host has already compiled the same migrated SQL before it starts its
  // worker. Carry only that compiler output into the child's private loader.
  if (process.env.MEDIA_SQL_CACHE) {
    const entries = JSON.parse(await readFile(process.env.MEDIA_SQL_CACHE, 'utf8')) as [
      string,
      { source: string; code: string },
    ][];
    for (const [file, value] of entries) compiledSql.set(file, value);
  }
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../../.temp/media-sql-'));
  const cache = `${directory}/compiled.json`;
  const loader = `${directory}/loader.ts`;
  const config = `${directory}/bunfig.toml`;
  try {
    await writeFile(config, '');
    await writeFile(cache, JSON.stringify([...compiledSql]));
    await writeFile(
      loader,
      `import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import compiler from ${JSON.stringify(import.meta.resolve('reylo/jest'))};
const path = ${JSON.stringify(cache)};
const compiled = new Map(JSON.parse(readFileSync(path, 'utf8')));
Bun.plugin({ name: 'native-reylo-cache', setup(build) {
  build.onLoad({ filter: /\\.sql$/ }, ({ path: file }) => {
    const source = readFileSync(file, 'utf8');
    const previous = compiled.get(file);
    if (previous?.source === source) return { loader: 'js', contents: previous.code };
    const { code } = compiler.process(source, file, { supportsStaticESM: true, configString: '' });
    compiled.set(file, { source, code });
    writeFileSync(path + '.pending', JSON.stringify([...compiled]));
    renameSync(path + '.pending', path);
    return { loader: 'js', contents: code };
  });
} });
`,
    );
    return {
      loader,
      config,
      cache,
      async close() {
        try {
          const entries = JSON.parse(await readFile(cache, 'utf8')) as [string, { source: string; code: string }][];
          for (const [file, value] of entries) compiledSql.set(file, value);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// IPC carries only private test observations. These tags preserve byte arrays,
// Headers and log bigint positions without changing any public media JSON.
function wire(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (value instanceof Headers) return { $headers: [...value] };
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wire(v)]));
  return value;
}
function unwire(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if ('$bigint' in value) return BigInt(value.$bigint);
  if ('$bytes' in value) return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
  if ('$headers' in value) return new Headers(value.$headers);
  return Array.isArray(value)
    ? value.map(unwire)
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwire(v)]));
}

/** One OS process per application runtime, with an owned graceful teardown. */
export async function launchBoundaryProcess(mode: 'host' | 'worker', env: Record<string, string | undefined> = {}) {
  const sql = await sqlLoader();
  const child = await (async () => {
    try {
      return Bun.spawn(
        [process.execPath, `--config=${sql.config}`, '--preload', sql.loader, import.meta.path, `--media-${mode}`],
        {
          cwd: process.cwd(),
          env: { ...process.env, ...env, MEDIA_SQL_CACHE: sql.cache },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
    } catch (error) {
      await sql.close();
      throw error;
    }
  })();
  // The parent owns process lifetime through its RPC streams. Detaching the
  // process handle lets Bun close stdin on test-file exit, which the fixture
  // host uses to tear down its identity and worker databases.
  child.unref();
  let output = '';
  let errorOutput = '';
  const errors = (async () => {
    for await (const chunk of child.stderr) {
      const text = new TextDecoder().decode(chunk);
      errorOutput += text;
      if (process.env.MEDIA_DEBUG) process.stderr.write(text);
    }
    return errorOutput;
  })();
  const ready = Promise.withResolvers<string>();
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
      const address = output.match(/^MEDIA_READY (http:\/\/127\.0\.0\.1:\d+)$/m)?.[1];
      if (address) ready.resolve(address);
    }
    ready.reject(new Error(`Media ${mode} exited before startup: ${output}\n${await errors}`));
  })();
  let origin: string;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    origin = await Promise.race([
      ready.promise,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error(`Media ${mode} startup exceeded its fixture deadline`)),
          110_000,
        );
      }),
    ]);
  } catch (error) {
    child.kill();
    await child.exited;
    await sql.close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  const call = async <T = unknown>(method: string, input?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(`${origin}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire({ method, input })),
      signal: AbortSignal.any([
        AbortSignal.timeout(method === 'growth' ? 550_000 : 120_000),
        ...(signal ? [signal] : []),
      ]),
    });
    const result = unwire(await response.json());
    if (response.status !== 200) throw new Error(result.error);
    return result;
  };
  let closing: Promise<void> | undefined;
  return {
    call,
    close: () =>
      (closing ??= (async () => {
        try {
          await call('close');
        } finally {
          const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
          try {
            await child.exited;
            await reading;
            if (child.exitCode !== 0) throw new Error(await errors);
          } finally {
            clearTimeout(timer);
            await sql.close();
          }
        }
      })()),
  };
}

let sharedHost: ReturnType<typeof launchBoundaryProcess> | undefined;
export async function prepareMediaBoundaryDriver() {
  sharedHost ??= launchBoundaryProcess('host');
  await (await sharedHost).call('start');
}
export async function closeMediaBoundaryDriver() {
  const host = sharedHost;
  sharedHost = undefined;
  await (await host)?.close();
}

/** Mechanical forwarding to the full application's actual mounted API fixture. */
export async function createMediaBoundaryDriver(): Promise<MediaBoundaryDriver> {
  sharedHost ??= launchBoundaryProcess('host');
  const host = await sharedHost;
  try {
    const identity = await host.call<{ importerId: string; containerId: string }>('open');
    let pending = Promise.resolve<unknown>(undefined);
    const boundary: MediaBoundary = {
      // The remote fixture owns this interface. Portable callers cannot use it to
      // touch image bytes; it is only meaningful inside application composition.
      get configuration(): MediaBoundary['configuration'] {
        throw new Error('Remote composition owns media storage');
      },
      reset: () => host.call('reset'),
      start: () => host.call('start'),
      measureTransition: (mediaId) => host.call('measureTransition', { mediaId }),
      source: (url, fault) => host.call('source', { url, fault }),
      failNextPut() {
        pending = pending.then(() => host.call('failNextPut'));
      },
      async drain(input) {
        input.signal.throwIfAborted();
        await pending;
        return host.call(
          'drain',
          { mediaIds: input.mediaIds, maxJobs: input.maxJobs, redeliver: input.redeliver },
          input.signal,
        );
      },
      observe: (mediaId) => host.call('observe', { mediaId }),
      async capture() {
        const result = await host.call<
          Omit<Awaited<ReturnType<MediaBoundary['capture']>>, 'registrations'> & { names: string[] }
        >('capture');
        // Function identities cannot cross IPC; resolve the same native exports in
        // this runtime only after observing the real registered workflow names.
        const { processImportedMedia } = await import('../../src/content/media-import-job.ts');
        const { processImage } = await import('../../src/content/image-job.ts');
        const { CONTENT_WORKFLOWS, CONTENT_QUEUES } = await import('../../src/content/work-contract.ts');
        return {
          ...result,
          registrations: result.names.flatMap(
            (name): Awaited<ReturnType<MediaBoundary['capture']>>['registrations'][number][] =>
              name === CONTENT_WORKFLOWS.importFromUrl
                ? [{ name, queue: CONTENT_QUEUES.importFromUrl, handler: processImportedMedia }]
                : name === CONTENT_WORKFLOWS.image
                  ? [{ name, queue: CONTENT_QUEUES.image, handler: processImage }]
                  : [],
          ),
        };
      },
      seedWorkflowHistory: (count) => host.call('seedWorkflowHistory', { count }) as Promise<number>,
      close: async () => {
        await host.call('reset');
      },
    };
    return Object.assign(
      {
        ...identity,
        boundary,
        request: (input: MediaImportRequest, key: string) => host.call('request', { input, key }),
        status: (mediaId: string) => host.call('status', { mediaId }),
        disclose: (mediaId: string) => host.call('disclose', { mediaId }),
        close: boundary.close,
      },
      {
        counters: () => host.call('counters'),
        seedGrowthStep: (input: { request: MediaImportRequest; previousScale: number; scale: number }) =>
          host.call('growthSeedStep', input),
      },
    ) as MediaBoundaryDriver;
  } catch (error) {
    await host.close();
    throw error;
  }
}

type RpcHost = { call(method: string, input: any, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };

const MEDIA_HISTORY_ROWS = 2_048;
const MEDIA_WORKFLOW_HISTORY_ROWS = 2_048;
const MEDIA_ROWS_PER_SCALE = 8;

function mediaHistoryPopulation(
  name: string,
  hotRoute: number,
  positionBase: number,
  rangeStart: number,
  epoch: number,
): Population {
  const hotPartition = partitionOf(hotRoute);
  const credit = {
    rightsHolder: 'Growth fixture',
    via: { name: 'Growth fixture', url: 'https://lain.bgm.tv/' },
    license: 'CC-BY-4.0',
    obligations: [],
  };
  const provenance = {
    source: 'bangumi',
    external_id: 'growth-fixture',
    record_revision: 'fixture:1',
    digest: '0'.repeat(64),
    converter_revision: 'fixture:1',
    field_group: 'cover',
    references: [{ name: 'Growth fixture', url: 'https://lain.bgm.tv/' }],
  };
  return {
    name,
    hotPartition,
    hotShare: 1,
    rows({ ordinal }) {
      const route = hotRoute;
      const mediaId = newId(route);
      const containerId = newId(route);
      const uploaderId = newId(route);
      const transactionId = randomUUID();
      const eventId = randomUUID();
      const position = positionBase + ordinal - rangeStart + 1;
      return {
        'access.account': [
          { route, account_id: uploaderId, kind: 'actor', state: 'active', transaction_id: transactionId },
        ],
        'semantic.subject': [
          { route, subject_id: containerId, type: 'schema:Book', recorded_transaction_id: transactionId },
        ],
        'content.media': [
          {
            route,
            media_id: mediaId,
            container_id: containerId,
            uploader_id: uploaderId,
            reservation_request_id: `${name}-${ordinal}`,
            purpose: 'cover',
            media_type: null,
            byte_count: null,
            declared_sha256: null,
            actual_byte_count: null,
            sha256: null,
            state: 'reserved',
            decision: null,
            key: `m/${mediaId}/original`,
            transaction_id: transactionId,
            source_url: 'https://lain.bgm.tv/pic/growth-baseline.jpg',
            credit,
            provenance,
          },
        ],
        'access.resource_role_grant': [mediaId, containerId].map((resource_id) => ({
          route,
          resource_id,
          subject_kind: 'identity',
          subject_id: uploaderId,
          subject_role: '',
          grant_role: 'owner',
          valid: '(,)',
          transaction_id: transactionId,
        })),
        'core.receipt': [
          {
            partition_no: hotPartition,
            principal_kind: 'account',
            principal_id: uploaderId,
            command_kind: 'content.media.importFromUrl',
            idempotency_key: `${name}-${ordinal}`,
            request_digest: Buffer.alloc(32),
            epoch,
            position,
            transaction_id: transactionId,
            response: { mediaId },
          },
        ],
        'core.outbox': [
          {
            partition_no: hotPartition,
            position,
            event_seq: 0,
            event_count: 1,
            epoch,
            id: eventId,
            type: 'com.rezics.content.media.import-requested.v1',
            subject: mediaId,
            data: { mediaId },
          },
        ],
      };
    },
    async finish(admin, range) {
      if (range.from === range.to) return;
      await admin.query('UPDATE core.partition SET position=GREATEST(position,$2) WHERE partition_no=$1', [
        hotPartition,
        positionBase + range.to - range.from,
      ]);
    },
  };
}

async function mediaGrowthSeedStep(
  database: GrowthDatabase,
  host: RpcHost,
  request: MediaImportRequest,
  previousScale: number,
  scale: number,
): Promise<void> {
  const hotRoute = routeOf(request.containerId);
  if (hotRoute === null) throw new Error('Growth fixture container has no route');
  if (
    !Number.isSafeInteger(previousScale) ||
    !Number.isSafeInteger(scale) ||
    previousScale < 0 ||
    scale <= previousScale
  )
    throw new RangeError('Media growth scales must be positive increasing integers');
  const hotPartition = partitionOf(hotRoute);
  const partition = (
    await database.admin.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text AS position FROM core.partition WHERE partition_no=$1',
      [hotPartition],
    )
  ).rows[0];
  if (!partition) throw new Error('Growth fixture partition is missing');
  const from = previousScale * MEDIA_ROWS_PER_SCALE;
  const to = scale * MEDIA_ROWS_PER_SCALE;
  const population = mediaHistoryPopulation(
    'media-growth-history',
    hotRoute,
    Number(partition.position),
    from,
    partition.epoch,
  );
  await seed({ pool: database.pool, admin: database.admin }, population, { from, to });
  const result = (await host.call('request', {
    input: request,
    key: `media-growth-hot-${scale}`,
  })) as { status: number };
  if (result.status !== 202) throw new Error(`Growth public import: ${JSON.stringify(result)}`);
}

async function applicationHost(): Promise<RpcHost> {
  const { COMMON_ACTIONS, IMPORT_ACTIONS } = await import('../../../../specs/imports-identity-driver.ts');
  // The worker process loads the registered application modules, but has no
  // application HTTP/identity host to install. Keep those host-only dependencies
  // out of every isolated worker's module loading and SQL compilation.
  const [
    { createKernelClient },
    { bundledRelease },
    { createKernel },
    { createAccess },
    { bootstrapRelease },
    { createWriteRateLimiter },
    { createImportIdentityDriver },
    { identitySupport, importActionCatalogue },
    { createMediaBoundary },
  ] = await Promise.all([
    import('@rezics/client'),
    import('@rezics/definitions/bundled'),
    import('../../src/http/kernel.ts'),
    import('../../src/access/index.ts'),
    import('../../src/semantic/definitions.ts'),
    import('../../src/access/write-rate.ts'),
    import('./identity-driver.ts'),
    import('./identity-fixture.ts'),
    import('./media-boundary.ts'),
  ]);
  const identities = createImportIdentityDriver();
  const publicApiCalls: { containerId: string }[] = [];
  let identityOpens = 0;
  let boundary: MediaBoundary | undefined;
  let ending: Promise<void> | undefined;
  const close = () =>
    (ending ??= (async () => {
      try {
        await boundary?.close();
      } finally {
        await identities.close();
      }
    })());
  try {
    const f = await identities.open({ clock: () => new Date() });
    identityOpens++;
    const auth = f.accessConfig.auth!;
    const access = createAccess({ actions: importActionCatalogue(f.database, f.routeKey), auth });
    // The media client consents to its private status read as well as import.
    // Auth performs ordinary account-key signin and issuance; no token is edited.
    const mediaScopes = [...f.client.scopes, 'media:read_reservation'];
    await f.auth.internal.registerClient({ ...f.client, scopes: mediaScopes });
    const credential = await identitySupport(f).issue(f.bulk.accountId, mediaScopes);
    await bootstrapRelease(f.database.pool, bundledRelease);
    const fetchConfig = { allowedHosts: ['lain.bgm.tv', 'covers.openlibrary.org'] };
    boundary = await createMediaBoundary({
      content: { pool: f.database.pool, access, routeKey: f.routeKey, clock: () => new Date() },
      fetchConfig,
      workerEnvironment: workerTestEnv({
        AUTH_ISSUER: auth.issuer,
        AUTH_AUDIENCE: auth.audience,
        AUTH_JWKS_URL: auth.jwksUrl,
        KERNEL_SESSION_KEYS: [...f.tokenKeys.keys]
          .map(([id, bytes]) => `${id}:${Buffer.from(bytes).toString('base64url')}`)
          .join(','),
        KERNEL_AUTH_CONSENT_URL: `${auth.issuer}/internal/v1/consents:read`,
        CF_ACCESS_CLIENT_ID: 'external-fixture',
        CF_ACCESS_CLIENT_SECRET: 'external-fixture-secret',
        OPENSEARCH_URL: '',
        STRIPE_SECRET_KEY: '',
      }),
    });
    const app = createKernel({
      // Match the shared test kernel's request deadline.
      requestDeadlineMs: 30_000,
      pool: f.database.pool,
      access,
      routeKey: f.routeKey,
      receiptKeys: testReceiptKeys(),
      tokens: f.tokenKeys,
      content: { fetchConfig },
      writeRate: createWriteRateLimiter({
        secret: randomBytes(32).toString('hex'),
        overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60},"upload":{"maximum":100000,"seconds":60}}}',
      }),
    });
    // Fixture population shares each caller's native account and partition
    // fences. Admit its public writes in order; worker drains still overlap.
    const writing = new Map<string, Promise<void>>();
    async function handle(request: Request, accountId: string) {
      if (request.method === 'GET') return app.handle(request);
      const previous = writing.get(accountId);
      const next = Promise.withResolvers<void>();
      writing.set(accountId, next.promise);
      await previous;
      try {
        return await app.handle(request);
      } finally {
        if (writing.get(accountId) === next.promise) writing.delete(accountId);
        next.resolve();
      }
    }
    function authenticated(initial: ImportIdentity['bulk'], scopes: readonly string[]) {
      let credential = initial;
      let renewing: Promise<ImportIdentity['bulk']> | undefined;
      return async (request: Request) => {
        if ((decodeJwt(credential.bearer).exp ?? 0) * 1000 - Date.now() < 60_000) {
          renewing ??= identitySupport(f).issue(credential.accountId, scopes);
          try {
            credential = await renewing;
          } finally {
            renewing = undefined;
          }
        }
        request.headers.set('authorization', `Bearer ${credential.bearer}`);
        return handle(request, credential.accountId);
      };
    }
    const importRequest = authenticated(credential, mediaScopes);
    const setupRequest = authenticated(f.governance, [...COMMON_ACTIONS, ...IMPORT_ACTIONS]);
    const client = createKernelClient('https://kernel.media.test', {
      headers: { authorization: `Bearer ${credential.bearer}` },
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const response = await importRequest(request);
        if (process.env.MEDIA_DEBUG)
          console.error(
            'Public fixture HTTP',
            request.method,
            request.url,
            response.status,
            response.status >= 400 ? await response.clone().text() : '',
          );
        return response;
      }) as typeof fetch,
    });
    const setupClient = createKernelClient('https://kernel.media.test', {
      headers: { authorization: `Bearer ${f.governance.bearer}` },
      fetch: ((input, init) => setupRequest(new Request(input, init))) as typeof fetch,
    });
    const anonymous = createKernelClient('https://kernel.media.test', {
      fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    });
    let fixture = 0;
    async function openContainer() {
      const ordinal = ++fixture;
      const created = await setupClient.subjects.$batchWrite.post({
        commands: [
          {
            op: 'create',
            key: `media-container-${ordinal}`,
            source: {
              source: 'openlibrary',
              external_id: `OL-MEDIA-CONTAINER-${ordinal}`,
              record_revision: '1',
              digest: 'c'.repeat(64),
              converter_revision: 'fixture@1',
              field_group: 'facts',
            },
            subject: { type: 'schema:Book', labels: { en: 'Media fixture' } },
          },
        ],
      });
      const result = created.data?.results[0];
      if (!result || !('value' in result) || !('id' in result.value))
        throw new Error(`Public subject creation failed: ${JSON.stringify(created.data ?? created.error)}`);
      return result.value.id;
    }
    let containerId = '';
    const importerId = f.bulk.accountId;
    const b = boundary;
    const host: RpcHost = {
      close,
      async call(method, input, signal) {
        switch (method) {
          case 'open':
            await b.reset();
            containerId = await openContainer();
            return { importerId, containerId };
          case 'counters':
            return { identityOpens, publicApiCalls: [...publicApiCalls] };
          case 'start':
            return b.start();
          case 'reset':
            return b.reset();
          case 'seedWorkflowHistory':
            return b.seedWorkflowHistory(input.count as number);
          case 'growthSeedStep':
            return mediaGrowthSeedStep(
              f.database,
              host,
              input.request as MediaImportRequest,
              input.previousScale as number,
              input.scale as number,
            );
          case 'growth':
            return mediaGrowth(f, b, host, input.request, input.minimumRows);
          case 'measureTransition':
            return b.measureTransition(input.mediaId);
          case 'source':
            return b.source(input.url, input.fault);
          case 'failNextPut':
            b.failNextPut();
            return null;
          case 'drain':
            return b.drain({ ...input, signal: signal ?? new AbortController().signal });
          case 'observe':
            return b.observe(input.mediaId);
          case 'capture': {
            const captured = await b.capture();
            return { ...captured, registrations: undefined, names: captured.registrations.map((r) => r.name) };
          }
          case 'request': {
            publicApiCalls.push({ containerId: (input.input as MediaImportRequest).containerId });
            const response = await client.media.$importFromUrl.post(input.input as MediaImportRequest, {
              headers: { 'idempotency-key': JSON.stringify(`${containerId}:${input.key}`) },
            });
            return { status: response.status, body: response.data ?? response.error?.value };
          }
          case 'status': {
            const response = await client.media({ id: input.mediaId }).$importStatus.get();
            return { status: response.status, body: response.data as MediaImportStatus };
          }
          case 'disclose': {
            // Browser-side delivery follows the actual API decision. The importer
            // request path never touches source or stored image bytes.
            const native = await b.observe(input.mediaId);
            const variant = native.variants[0];
            const response = await anonymous.media({ id: input.mediaId }).$authorizeDownload.get({
              query: { variant: variant ? `${variant.format}-${variant.width}` : 'webp-48' },
            });
            const decision = response.data;
            const bytes = decision?.allowed ? await b.configuration.storage.get(decision.key) : null;
            return {
              status: response.status,
              headers: response.response.headers,
              bytes: bytes ?? new Uint8Array(),
              url: response.response.url || `https://kernel.media.test/v1/media/${input.mediaId}:authorizeDownload`,
            };
          }
          default:
            throw new Error(`Unknown media fixture method ${method}`);
        }
      },
    };
    return host;
  } catch (error) {
    if (process.env.MEDIA_DEBUG) console.error(error);
    await close();
    throw error;
  }
}

/** Seed unrelated native-shaped history with one hot public reservation per scale;
 * fixed operations are captured on every owning pool, including DBOS. */
async function mediaGrowth(
  f: ImportIdentity,
  boundary: MediaBoundary,
  host: RpcHost,
  request: MediaImportRequest,
  minimumRows: number,
) {
  const { identitySupport } = await import('./identity-fixture.ts');
  const bounds = { statements: 'constant', rows: 'constant', blocks: 'logarithmic' } as const;
  const submit = async (input: MediaImportRequest, key: string) => {
    const response = (await host.call('request', { input, key })) as {
      status: number;
      body: { media: { id: string } };
    };
    if (response.status !== 202) throw new Error(`Growth public import: ${JSON.stringify(response)}`);
    return response.body.media.id;
  };
  // Keep the probe on the real public reservation and registered job path. Seed
  // only unrelated history set-based, with contiguous positions owned by C.
  await boundary.reset();
  const source = await boundary.source(request.sourceUrl);
  const fixed = await submit(request, 'fixed-read');
  await boundary.drain({ mediaIds: [fixed], maxJobs: 16, signal: new AbortController().signal });
  const hotRoute = routeOf(request.containerId);
  if (hotRoute === null) throw new Error('Growth fixture container has no route');
  const hotPartition = partitionOf(hotRoute);
  const partition = (
    await f.database.admin.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text AS position FROM core.partition WHERE partition_no=$1',
      [hotPartition],
    )
  ).rows[0];
  if (!partition) throw new Error('Growth fixture partition is missing');
  await seed(
    f.database,
    mediaHistoryPopulation('media-growth-baseline', hotRoute, Number(partition.position), 0, partition.epoch),
    { from: 0, to: MEDIA_HISTORY_ROWS },
  );
  const workflowBaselineRows = await boundary.seedWorkflowHistory(MEDIA_WORKFLOW_HISTORY_ROWS);
  const workerRuns = new Map<number, Cost[]>();
  const authRuns = new Map<number, Cost[]>();
  const raw: { scale: number; worker: Capture; auth: Capture }[] = [];
  let floors: Record<string, number> = {};
  const report = await checkGrowth(f.database, {
    name: 'public media status, disclosure, receipt and registered import',
    scales: [1, 8, 64],
    bounds,
    repetitions: 3,
    warmups: 1,
    async grow(db, scale, previous) {
      await mediaGrowthSeedStep(db, host, request, previous, scale);
      if (scale === 1) {
        for (const relation of [
          'content.media',
          'core.outbox',
          'core.receipt',
          'semantic.subject',
          'access.resource_role_grant',
        ]) {
          const result = await db.admin.query<{ rows: string }>(`SELECT count(*)::text AS rows FROM ${relation}`);
          floors[relation] = Number(result.rows[0]?.rows ?? 0);
          if (floors[relation]! < minimumRows)
            throw new Error(`${relation} has fewer than ${minimumRows} live rows after scale 1 VACUUM (ANALYZE)`);
        }
      }
    },
    async operation(_db, scale, repetition) {
      const observed = await capture(identitySupport(f).authDatabase, async () => {
        const status = (await host.call('status', { mediaId: fixed })) as { status: number };
        const disclosure = (await host.call('disclose', { mediaId: fixed })) as { status: number; bytes: Uint8Array };
        if (status.status !== 200 || disclosure.status !== 200 || !disclosure.bytes.byteLength)
          throw new Error('Fixed public media read failed');
        const id = await submit(request, `measured-${repetition}`);
        return boundary.measureTransition(id);
      });
      // Match the shared harness's three measured repetitions, excluding its
      // one warm-up. Retain raw plans too; no queries or background SQL are filtered.
      if (repetition % 4 !== 0) {
        const workers = workerRuns.get(scale) ?? [];
        const auth = authRuns.get(scale) ?? [];
        workers.push(costOf(observed.value));
        auth.push(costOf(observed.capture));
        workerRuns.set(scale, workers);
        authRuns.set(scale, auth);
      }
      raw.push({ scale, worker: observed.value, auth: observed.capture });
    },
  });
  const workers: GrowthSample[] = [...workerRuns].map(([scale, costs]) => ({ scale, cost: medianCost(costs) }));
  const auth: GrowthSample[] = [...authRuns].map(([scale, costs]) => ({ scale, cost: medianCost(costs) }));
  assertGrowth(workers, bounds);
  assertGrowth(auth, bounds);
  return {
    workflowBaselineRows,
    application: report.samples,
    worker: workers,
    auth,
    floors,
    raw,
    sourceBytes: source.bytes.byteLength,
    capture: await boundary.capture(),
  };
}

async function workerHost(): Promise<RpcHost> {
  const { KERNEL_WORK_MODULES } = await import('../../src/work/modules.ts');
  const database = await openGrowthDatabase();
  const observer = await observeMediaPool(database.pool);
  const client = await createWorkClient(database.url, database.openPool());
  const originalFetch = globalThis.fetch;
  const endpoint = new URL(process.env.MEDIA_EXTERNAL_ENDPOINT!);
  const names: string[] = [];
  const calls: { workflowId: string; name: string; mediaId: string }[] = [];
  const network: string[] = [];
  const drains = new Map<string, { id: string; jobs: number; maximum: number }>();
  const workflowDrains = new Map<string, string>();
  function beginDrain(mediaIds: readonly string[], maximum: number) {
    if (maximum !== 16 || mediaIds.length > 16) throw new Error('Unbounded media drain');
    const budget = { id: randomUUID(), jobs: 0, maximum };
    for (const id of mediaIds) drains.set(id, budget);
  }
  function checkDrain(mediaId: string, executed = false) {
    const budget = drains.get(mediaId);
    if (!budget || budget.jobs >= budget.maximum) throw new Error('Exceeded bounded native dispatch');
    if (executed) {
      budget.jobs++;
      workflowDrains.set(DBOS.workflowID!, budget.id);
    }
  }
  const registerStep = DBOS.registerStep;
  const registerWorkflow = DBOS.registerWorkflow;
  // Observe registration and executed native steps while delegating unchanged to
  // the real SDK. No workflow, retry, queue or job body is replaced.
  DBOS.registerWorkflow = ((fn: Function, config: { name?: string }) => {
    if (config?.name === 'content.importFromUrl' || config?.name === 'content.image') names.push(config.name);
    return Reflect.apply(registerWorkflow, DBOS, [fn, config]);
  }) as typeof DBOS.registerWorkflow;
  DBOS.registerStep = ((fn: Function, config: { name?: string }) => {
    const name =
      config?.name === 'content.import.step'
        ? 'content.importFromUrl'
        : config?.name === 'content.image.step'
          ? 'content.image'
          : config?.name === 'content.purge.step'
            ? 'content.purge'
            : undefined;
    return Reflect.apply(registerStep, DBOS, [
      name
        ? async (...args: any[]) => {
            checkDrain(args[0].mediaId, true);
            calls.push({ workflowId: DBOS.workflowID!, name, mediaId: args[0].mediaId });
            return Reflect.apply(fn, undefined, args);
          }
        : fn,
      config,
    ]);
  }) as typeof DBOS.registerStep;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const kind =
      url.hostname === '00000000000000000000000000000000.r2.cloudflarestorage.com'
        ? 'objects'
        : ['lain.bgm.tv', 'covers.openlibrary.org'].includes(url.hostname)
          ? 'source'
          : null;
    if (!kind) {
      network.push(url.href);
      throw new Error(`Unconfigured external network request: ${url.origin}`);
    }
    const target = new URL(`/${kind}?url=${encodeURIComponent(url.href)}`, endpoint);
    const drain = workflowDrains.get(DBOS.workflowID!);
    if (drain) target.searchParams.set('drain', drain);
    return originalFetch(target, request);
  }) as typeof fetch;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let ending: Promise<void> | undefined;
  // Launch starts the queue poller. Keep its promise so a measured import can
  // stop the poller and wait until an in-flight sweep has left the pool.
  const startDispatchLoop = wfQueueRunner.dispatchLoop.bind(wfQueueRunner);
  let queueLoop: Promise<void> = Promise.resolve();
  wfQueueRunner.dispatchLoop = (executor, listenQueues, maxConcurrentQueueDispatches) => {
    queueLoop = startDispatchLoop(executor, listenQueues, maxConcurrentQueueDispatches);
    return queueLoop;
  };
  const close = () =>
    (ending ??= (async () => {
      try {
        await work?.shutdown();
      } finally {
        globalThis.fetch = originalFetch;
        try {
          await client.close();
        } finally {
          await database.close();
        }
      }
    })());
  try {
    const env = { ...process.env };
    // The complete worker also registers rating effects, which require a
    // deployment counting secret even though these fixtures only dispatch media.
    env.KERNEL_RATING_COUNTER_SECRET ??= randomBytes(32).toString('base64url');
    // Optional services remain disabled in this complete kernel deployment.
    for (const name of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRETS',
      'STRIPE_MANAGED_PAYMENTS',
      'STRIPE_API_HOST',
      'CHECKOUT_SUCCESS_URL',
      'CHECKOUT_CANCEL_URL',
      'OPENSEARCH_URL',
    ])
      delete env[name];
    work = await composeWork(KERNEL_WORK_MODULES, {
      databaseUrl: database.url,
      pool: database.pool,
      client,
      env,
      executorId: `media-${randomUUID()}`,
    });
    DBOS.registerStep = registerStep;
    DBOS.registerWorkflow = registerWorkflow;
    // Persist the SDK's real polling configuration before launch discovers its
    // queues and schedules their first polls in this isolated runtime.
    const effectsQueue = await client.retrieveQueue('effects');
    const importQueue = await client.retrieveQueue('import');
    if (!effectsQueue || !importQueue) throw new Error('Missing native import queue');
    await effectsQueue.setMinPollingIntervalMs(1);
    await importQueue.setMinPollingIntervalMs(1);
    await work.launch();
    const executor = DBOSExecutor.globalInstance;
    if (!executor) throw new Error('Missing work executor');
    // The timeout sweep issues a statement on a one-second timer. Leaving it on
    // the measured pool makes the statement count follow wall-clock duration.
    executor.systemDatabase.cancelTimedOutWorkflows = async () => [];
    let queuesQuiet = false;
    const quietQueues = async () => {
      if (queuesQuiet) return;
      wfQueueRunner.stop();
      await queueLoop.catch(() => undefined);
      queuesQuiet = true;
    };
    const admit = async (queue: WorkflowQueue, workflowId: string) => {
      const ownerXid = randomUUID();
      const claimed = await executor.systemDatabase.findAndMarkStartablePartitionedWorkflows(
        queue,
        executor.executorID,
        globalParams.appVersion,
        1,
        ownerXid,
      );
      if (claimed.length !== 1 || claimed[0] !== workflowId) throw new Error(`Missing queued workflow ${workflowId}`);
      await executor.dispatchDequeuedWorkflows([workflowId], ownerXid);
    };
    return {
      close,
      async call(method, input) {
        if (method === 'reset') {
          drains.clear();
          workflowDrains.clear();
          return null;
        }
        if (method === 'seedHistory') {
          const count = input.count as number;
          const now = Date.now();
          const namespace = `media-growth:${randomUUID()}:`;
          await database.admin.query(
            `WITH history AS (
               SELECT $1 || item::text AS workflow_uuid, item
               FROM generate_series(1, $2::integer) AS item
             ), inserted AS (
               INSERT INTO dbos.workflow_status (
                 workflow_uuid, status, name, queue_name, authenticated_user, assumed_role, authenticated_roles,
                 executor_id, application_id, created_at, updated_at, recovery_attempts, inputs,
                 queue_partition_key, serialization
               )
               SELECT workflow_uuid, 'SUCCESS', 'content.importFromUrl', 'import', '', '', '', '', 'rezics-kernel',
                      $3::bigint + item, $3::bigint + item, 0, '[]', 'media-growth:' || item::text, 'JSON'
               FROM history
               RETURNING workflow_uuid
             ), inputs AS (
               INSERT INTO dbos.workflow_input (workflow_uuid, inputs)
               SELECT workflow_uuid, '[]' FROM inserted
             ), outputs AS (
               INSERT INTO dbos.workflow_output (workflow_uuid, output, error)
               SELECT workflow_uuid, 'null', '' FROM inserted
             )
             INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output, error)
             SELECT workflow_uuid, 1, 'content.importFromUrl', 'null', '' FROM inserted`,
            [namespace, count, now],
          );
          return count;
        }
        if (method === 'beginDrain') {
          beginDrain(input.mediaIds, input.maxJobs);
          return null;
        }
        if (method === 'trace') return observer.trace(input.mediaId);
        if (method === 'capture') return { names, calls, network };
        if (method !== 'dispatch' && method !== 'measure') throw new Error('Unknown native worker operation');
        const envelope = input.envelope as Envelope;
        const mediaId = input.mediaId as string;
        const run = async (source: Envelope, effect: string, kind: 'importFromUrl' | 'image') => {
          checkDrain(mediaId);
          const type =
            kind === 'image' ? 'com.rezics.content.media.uploaded.v1' : 'com.rezics.content.media.import-requested.v1';
          const index = source.events.findIndex((event) => event.subject === mediaId && event.type === type);
          if (index < 0) throw new Error('Missing native dispatch event');
          await work!.effects.enqueue([source]);
          await DBOS.retrieveWorkflow(effectWorkflowId(source, index, effect)).getResult({ pollingIntervalMs: 1 });
          const id = contentWorkWorkflowId(source, index, kind, kind === 'image' ? undefined : mediaId);
          return DBOS.retrieveWorkflow(id).getResult({ pollingIntervalMs: 1 });
        };
        if (method === 'measure') {
          beginDrain([mediaId], 16);
          // Queue polling and result polling share this pool, and a sweep walks
          // every enqueued partition head. Either one adds statements as the
          // measured import waits or as unrelated heads accumulate. Stop the
          // poller, drop those heads, and claim this import directly.
          await quietQueues();
          await database.admin.query(
            `UPDATE dbos.workflow_status
                SET status = 'CANCELLED',
                    updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
              WHERE status = 'ENQUEUED'`,
          );
          return (
            await capture(database, async () => {
              checkDrain(mediaId);
              const index = envelope.events.findIndex(
                (event) => event.subject === mediaId && event.type === 'com.rezics.content.media.import-requested.v1',
              );
              if (index < 0) throw new Error('Missing native dispatch event');
              await work!.effects.enqueue([envelope]);
              const effectId = effectWorkflowId(envelope, index, 'content_url_import');
              await admit(effectsQueue, effectId);
              await DBOS.retrieveWorkflow(effectId).getResult();
              const importId = contentWorkWorkflowId(envelope, index, 'importFromUrl', mediaId);
              await admit(importQueue, importId);
              return DBOS.retrieveWorkflow(importId).getResult();
            })
          ).capture;
        }
        await run(envelope, 'content_url_import', 'importFromUrl');
        const trace = observer.trace(mediaId);
        if ((trace.anchors[mediaId] ?? []).length) {
          const uploaded = await mediaEnvelope(
            database.pool,
            mediaId,
            [trace],
            'com.rezics.content.media.uploaded.v1',
          ).catch(() => null);
          if (uploaded) await run(uploaded, 'content_media_image', 'image');
        }
        return null;
      },
    };
  } catch (error) {
    DBOS.registerStep = registerStep;
    DBOS.registerWorkflow = registerWorkflow;
    await close();
    throw error;
  }
}

if (import.meta.main && process.argv.some((arg) => arg.startsWith('--media-'))) {
  let host: RpcHost | undefined;
  const initialized = Promise.withResolvers<RpcHost | undefined>();
  const parentClosed = async () => {
    const owner = await initialized.promise;
    await owner?.close();
    process.exit(0);
  };
  void new Response(Bun.stdin.stream()).text().then(parentClosed);
  process.once('SIGTERM', () => {
    void parentClosed();
  });
  process.once('SIGINT', () => {
    void parentClosed();
  });
  try {
    host = process.argv.includes('--media-worker') ? await workerHost() : await applicationHost();
    initialized.resolve(host);
    const owner = host;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        try {
          const { method, input } = unwire(await request.json());
          const result = method === 'close' ? await owner.close() : await owner.call(method, input, request.signal);
          if (method === 'close')
            setTimeout(async () => {
              await server.stop(true);
              process.exit(0);
            }, 25);
          return Response.json(wire(result ?? null));
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.stack : String(error) }, { status: 500 });
        }
      },
    });
    console.log(`MEDIA_READY ${server.url.origin}`);
  } catch (error) {
    initialized.resolve(host);
    console.error(error);
    await host?.close();
    process.exitCode = 1;
  }
}
