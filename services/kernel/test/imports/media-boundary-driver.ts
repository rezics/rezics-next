import { randomBytes, randomUUID } from 'node:crypto';
import { createKernelClient } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import type { MediaBoundaryDriver } from '../../../../specs/imports-media-boundary-driver.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createImportIdentityDriver } from './identity-driver.ts';
import { identitySupport } from './identity-fixture.ts';
import { createMediaBoundary, type MediaBoundary } from './media-boundary.ts';
import { mediaEnvelope, observeMediaPool } from './media-boundary-observer.ts';
import {
  openGrowthDatabase,
  capture,
  costOf,
  medianCost,
  checkGrowth,
  seed,
  assertGrowth,
  type GrowthSample,
} from '../support/growth.ts';
import type { Capture, Cost } from '../support/growth-cost.ts';
import { routeOf, partitionOf, newId } from '../../src/route/route.ts';
import type { ImportIdentity } from './identity-fixture.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { DBOSExecutor } from '@dbos-inc/dbos-sdk/internal/dbos-executor';
import { globalParams } from '@dbos-inc/dbos-sdk/internal/utils';
import { wfQueueRunner, type WorkflowQueue } from '@dbos-inc/dbos-sdk/internal/wfqueue';
import { composeWork } from '../../src/work/registry.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { effectWorkflowId } from '../../src/events/effects.ts';
import type { Envelope } from '../../src/events/log.ts';

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
  const child = Bun.spawn(
    [process.execPath, '--preload', import.meta.resolve('reylo/register'), import.meta.path, `--media-${mode}`],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
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
  const shared = Boolean(sharedHost);
  const host = await (sharedHost ?? launchBoundaryProcess('host'));
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
      close: shared
        ? async () => {
            await host.call('reset');
          }
        : host.close,
    };
    return {
      ...identity,
      boundary,
      request: (input, key) => host.call('request', { input, key }),
      status: (mediaId) => host.call('status', { mediaId }),
      disclose: (mediaId) => host.call('disclose', { mediaId }),
      close: boundary.close,
    };
  } catch (error) {
    await host.close();
    throw error;
  }
}

type RpcHost = { call(method: string, input: any, signal?: AbortSignal): Promise<unknown>; close(): Promise<void> };
async function applicationHost(): Promise<RpcHost> {
  const identities = createImportIdentityDriver();
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
    const auth = f.accessConfig.auth!;
    // The media client consents to its private status read as well as import.
    // Auth performs ordinary account-key signin and issuance; no token is edited.
    const mediaScopes = [...f.client.scopes, 'media:read_reservation'];
    await f.auth.internal.registerClient({ ...f.client, scopes: mediaScopes });
    const credential = await identitySupport(f).issue(f.bulk.accountId, mediaScopes);
    await bootstrapRelease(f.database.pool, bundledRelease);
    const fetchConfig = { allowedHosts: ['lain.bgm.tv', 'covers.openlibrary.org'] };
    boundary = await createMediaBoundary({
      content: { pool: f.database.pool, access: f.access, routeKey: f.routeKey, clock: () => new Date() },
      fetchConfig,
      workerEnvironment: {
        AUTH_ISSUER: auth.issuer,
        AUTH_AUDIENCE: auth.audience,
        AUTH_JWKS_URL: auth.jwksUrl,
        KERNEL_SESSION_KEYS: [...f.tokenKeys.keys]
          .map(([id, bytes]) => `${id}:${Buffer.from(bytes).toString('base64url')}`)
          .join(','),
        CONTENT_AUTH_CONSENT_URL: `${auth.issuer}/internal/v1/consents:read`,
        CF_ACCESS_CLIENT_ID: 'external-fixture',
        CF_ACCESS_CLIENT_SECRET: 'external-fixture-secret',
        OPENSEARCH_URL: '',
        STRIPE_SECRET_KEY: '',
      },
    });
    const app = createKernel({
      // Match the shared test kernel's request deadline.
      requestDeadlineMs: 30_000,
      pool: f.database.pool,
      access: f.access,
      routeKey: f.routeKey,
      tokens: f.tokenKeys,
      content: { fetchConfig },
      writeRate: createWriteRateLimiter({
        secret: randomBytes(32).toString('hex'),
        overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60},"upload":{"maximum":100000,"seconds":60}}}',
      }),
    });
    const client = createKernelClient('https://kernel.media.test', {
      headers: { authorization: `Bearer ${credential.bearer}` },
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const response = await app.handle(request);
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
      fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
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
          case 'start':
            return b.start();
          case 'reset':
            return b.reset();
          case 'growth':
            return mediaGrowth(f, b, host, input.request, openContainer, input.minimumRows);
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

/** Setup grows native public writes; fixed operations are captured on every owning
 * pool, including nested plans and the actual DBOS system/client pools. */
async function mediaGrowth(
  f: ImportIdentity,
  boundary: MediaBoundary,
  host: RpcHost,
  request: MediaImportRequest,
  createContainer: () => Promise<string>,
  minimumRows: number,
) {
  const bounds = { statements: 'constant', rows: 'constant', blocks: 'logarithmic' } as const;
  const hotContainer = request.containerId;
  const submit = async (input: MediaImportRequest, key: string) => {
    const response = (await host.call('request', { input, key })) as {
      status: number;
      body: { media: { id: string } };
    };
    if (response.status !== 202) throw new Error(`Growth public import: ${JSON.stringify(response)}`);
    return response.body.media.id;
  };
  // Native workflow tables need a populated baseline too. Otherwise PostgreSQL's
  // small-table sequential plans count the benchmark's own preceding runs. Each
  // batch is at most sixteen real public reservations and registered jobs, with
  // corrupt encoded input exercising normal rejection and governance cleanup.
  // Setup and external input allocation are outside every fixed measurement.
  const baseline: { executedJobs: number; sourceBytes: number }[] = [];
  for (let batch = 0; batch < 16; batch++) {
    await boundary.reset();
    await boundary.source(request.sourceUrl, 'corrupt-image');
    const ids = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const containerId = await createContainer();
        return submit({ ...request, containerId }, `workflow-baseline-${batch}-${index}`);
      }),
    );
    await Promise.all(
      ids.map((id) => boundary.drain({ mediaIds: [id], maxJobs: 16, signal: new AbortController().signal })),
    );
    const recorded = await boundary.capture();
    baseline.push({
      executedJobs: recorded.executedJobs,
      sourceBytes: recorded.sourceRequests.reduce((sum, r) => sum + r.bytes, 0),
    });
  }
  await boundary.reset();
  const source = await boundary.source(request.sourceUrl);
  const fixed = await submit(request, 'fixed-read');
  await boundary.drain({ mediaIds: [fixed], maxJobs: 16, signal: new AbortController().signal });
  // Seed unrelated native-shaped history in the hot route so measured exact
  // lookups plan against populated relations. The importer, operator, human,
  // hot container and fixed media remain untouched by this setup.
  const hotRoute = routeOf(hotContainer);
  if (hotRoute === null) throw new Error('Growth fixture container has no route');
  const seededRows = 2_048;
  const mediaIds = Array.from({ length: seededRows }, () => newId(hotRoute));
  const containerIds = Array.from({ length: seededRows }, () => newId(hotRoute));
  const accountIds = Array.from({ length: seededRows }, () => newId(hotRoute));
  const transactionIds = Array.from({ length: seededRows }, () => randomUUID());
  const eventIds = Array.from({ length: seededRows }, () => randomUUID());
  const partition = (
    await f.database.admin.query<{ epoch: number; position: string }>(
      'SELECT epoch,position::text AS position FROM core.partition WHERE partition_no=$1',
      [partitionOf(hotRoute)],
    )
  ).rows[0];
  if (!partition) throw new Error('Growth fixture partition is missing');
  await f.database.admin.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
    SELECT $1,account_id,'actor','active',transaction_id
    FROM unnest($2::uuid[],$3::uuid[]) AS seeded(account_id,transaction_id)`,
    [hotRoute, accountIds, transactionIds],
  );
  await f.database.admin.query(
    `INSERT INTO semantic.subject (route,subject_id,type,recorded_transaction_id)
    SELECT $1,subject_id,'schema:Book',transaction_id
    FROM unnest($2::uuid[],$3::uuid[]) AS seeded(subject_id,transaction_id)`,
    [hotRoute, containerIds, transactionIds],
  );
  await f.database.admin.query(
    `INSERT INTO content.media (
      route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,byte_count,
      declared_sha256,actual_byte_count,sha256,state,decision,key,transaction_id,source_url,credit,provenance
    )
    SELECT $1,media_id,container_id,uploader_id,'growth-baseline-'||ordinality,'cover',NULL,NULL,
      NULL,NULL,NULL,'reserved',NULL,'m/'||media_id::text||'/original',transaction_id,
      'https://lain.bgm.tv/pic/growth-baseline.jpg',
      jsonb_build_object(
        'rightsHolder','Growth fixture',
        'via',jsonb_build_object('name','Growth fixture','url','https://lain.bgm.tv/'),
        'license','CC-BY-4.0','obligations','[]'::jsonb
      ),
      jsonb_build_object(
        'source','bangumi','external_id','growth-'||ordinality,'record_revision','fixture:1',
        'digest',repeat('0',64),'converter_revision','fixture:1','field_group','cover',
        'references',jsonb_build_array(jsonb_build_object('name','Growth fixture','url','https://lain.bgm.tv/'))
      )
    FROM unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[]) WITH ORDINALITY
      AS seeded(media_id,container_id,uploader_id,transaction_id,ordinality)`,
    [hotRoute, mediaIds, containerIds, accountIds, transactionIds],
  );
  await f.database.admin.query(
    `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
    SELECT $1,resource_id,'identity',account_id,'','owner','(,)',transaction_id
    FROM unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[]) AS seeded(media_id,container_id,account_id,transaction_id)
    CROSS JOIN LATERAL (VALUES (media_id),(container_id)) AS resources(resource_id)`,
    [hotRoute, mediaIds, containerIds, accountIds, transactionIds],
  );
  await f.database.admin.query(
    `INSERT INTO core.receipt (
      partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,
      epoch,position,transaction_id,response
    )
    SELECT $1,'account',account_id,'content.media.importFromUrl','growth-baseline-'||ordinality,
      decode(repeat('00',32),'hex'),$2,$3::bigint+1000000+ordinality,transaction_id,
      jsonb_build_object('mediaId',media_id::text)
    FROM unnest($4::uuid[],$5::uuid[],$6::uuid[]) WITH ORDINALITY
      AS seeded(media_id,account_id,transaction_id,ordinality)`,
    [partitionOf(hotRoute), partition.epoch, partition.position, mediaIds, accountIds, transactionIds],
  );
  await f.database.admin.query(
    `INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
    SELECT $1,$2::bigint+1000000+ordinality,0,1,$3,event_id,
      'com.rezics.content.media.import-requested.v1',media_id::text,
      jsonb_build_object('mediaId',media_id::text)
    FROM unnest($4::uuid[],$5::uuid[]) WITH ORDINALITY
      AS seeded(media_id,event_id,ordinality)`,
    [partitionOf(hotRoute), partition.position, partition.epoch, mediaIds, eventIds],
  );
  const workerRuns = new Map<number, Cost[]>();
  const authRuns = new Map<number, Cost[]>();
  const raw: { scale: number; worker: Capture; auth: Capture }[] = [];
  let floors: Record<string, number> = {};
  const population = {
    name: 'public-media-and-history',
    hotPartition: partitionOf(routeOf(hotContainer)!),
    async write(_target: unknown, placement: { ordinal: number; hot: boolean }) {
      const containerId = placement.hot ? hotContainer : await createContainer();
      await submit({ ...request, containerId }, `population-${placement.ordinal}`);
    },
  };
  const report = await checkGrowth(f.database, {
    name: 'public media status, disclosure, receipt and registered import',
    bounds,
    repetitions: 3,
    warmups: 1,
    async grow(db, scale, previous) {
      await seed(db, population, { from: previous * 8, to: scale * 8 });
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
    baseline,
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
  const database = await openGrowthDatabase();
  const observer = await observeMediaPool(database.pool);
  const client = await createWorkClient(database.url, database.openPool());
  const originalFetch = globalThis.fetch;
  const endpoint = new URL(process.env.MEDIA_EXTERNAL_ENDPOINT!);
  const names: string[] = [];
  const calls: { workflowId: string; name: string; mediaId: string }[] = [];
  const network: string[] = [];
  let drainStart = 0;
  let drainMaximum = 0;
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
            if (calls.length - drainStart >= drainMaximum) throw new Error('Exceeded bounded native dispatch');
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
    return originalFetch(new URL(`/${kind}?url=${encodeURIComponent(url.href)}`, endpoint), request);
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
    await work.launch();
    const executor = DBOSExecutor.globalInstance;
    if (!executor) throw new Error('Missing work executor');
    // The timeout sweep issues a statement on a one-second timer. Leaving it on
    // the measured pool makes the statement count follow wall-clock duration.
    executor.systemDatabase.cancelTimedOutWorkflows = async () => [];
    const effectsQueue = await DBOS.retrieveQueue('effects');
    const importQueue = await DBOS.retrieveQueue('import');
    if (!effectsQueue || !importQueue) throw new Error('Missing native import queue');
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
          drainStart = calls.length;
          drainMaximum = 0;
          return null;
        }
        if (method === 'beginDrain') {
          drainStart = calls.length;
          drainMaximum = input.maxJobs;
          return null;
        }
        if (method === 'trace') return observer.trace(input.mediaId);
        if (method === 'capture') return { names, calls, network };
        if (method !== 'dispatch' && method !== 'measure') throw new Error('Unknown native worker operation');
        const envelope = input.envelope as Envelope;
        const mediaId = input.mediaId as string;
        const run = async (source: Envelope, effect: string, kind: 'importFromUrl' | 'image') => {
          if (calls.length - drainStart >= drainMaximum) throw new Error('Exceeded bounded native dispatch');
          const type =
            kind === 'image' ? 'com.rezics.content.media.uploaded.v1' : 'com.rezics.content.media.import-requested.v1';
          const index = source.events.findIndex((event) => event.subject === mediaId && event.type === type);
          if (index < 0) throw new Error('Missing native dispatch event');
          await work!.effects.enqueue([source]);
          await DBOS.retrieveWorkflow(effectWorkflowId(source, index, effect)).getResult();
          const id = contentWorkWorkflowId(source, index, kind, kind === 'image' ? undefined : mediaId);
          return DBOS.retrieveWorkflow(id).getResult();
        };
        if (method === 'measure') {
          drainStart = calls.length;
          drainMaximum = 16;
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
              if (calls.length - drainStart >= drainMaximum) throw new Error('Exceeded bounded native dispatch');
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
