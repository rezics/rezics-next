import sharp from 'sharp';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { mediaEnvelope, observeMediaPool, observeNativeMedia, type MediaTrace } from './media-boundary-observer.ts';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { processImportedMedia, type MediaImportJobDependencies } from '../../src/content/media-import-job.ts';
import { processImage } from '../../src/content/image-job.ts';
import type { MediaState, MediaVariant } from '../../src/content/media.ts';
import type { SourceFenceTuple } from '../../src/content/source-fences.ts';
import { CONTENT_QUEUES, CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';

export const MISSING_MEDIA_BOUNDARY = 'Import media boundary fixture is not implemented';

/** Private external-boundary data, never a replacement fetch job or validator. */
export interface SourceFixture {
  url: string;
  /** Deterministic encoded image delivered by the HTTP fixture, not raw pixels. */
  bytes: Uint8Array;
}
export type SourceFault =
  | 'redirect-denied-host'
  | 'redirect-private-ip'
  | 'redirect-loop'
  | 'stream-over-20-mib'
  | 'timeout'
  | 'over-40-megapixels'
  | 'corrupt-image';
export interface MediaBoundaryOptions {
  /** Shared real database, Access, clock and route key; supplied by the API assembly. */
  content: Omit<MediaImportJobDependencies, 'storage' | 'fetchConfig'>;
  /** Exact production host configuration; no fixture-domain or wildcard addition. */
  fetchConfig: MediaImportJobDependencies['fetchConfig'];
  /** Actual Auth deployment configuration for the isolated full kernel worker. */
  workerEnvironment?: Readonly<Record<string, string>>;
}
export interface NativeMediaObservation {
  /** Read existing content.media and media_variant rows by route + media ID. */
  row: Readonly<{
    id: string;
    containerId: string;
    uploaderId: string;
    purpose: 'cover' | 'post-image';
    state: MediaState;
    sha256: string | null;
    sourceUrl: string;
    credit: MediaImportRequest['credit'];
    provenance: MediaImportRequest['provenance'];
    collectionPending: boolean;
  }>;
  /** Committed native events/rows in order, never inferred from requested outcomes. */
  transitions: readonly MediaState[];
  events: readonly { type: string; transactionId: string }[];
  variants: readonly (MediaVariant & { bytes: Uint8Array })[];
  original: Uint8Array | null;
  /** Actual production fence-read bind parameters, never reconstructed from expected input. */
  fence: SourceFenceTuple;
}
export interface MediaBoundary {
  /** Production MediaStorage interface (also implemented by R2Storage), faked here ONLY. */
  configuration: Pick<MediaImportJobDependencies, 'storage' | 'fetchConfig'>;
  /** Serve this exact native HTTPS URL. Optional encoded bytes are copied and
   * bounded to the production 20 MiB source cap, including their backing buffer;
   * shared/resizable backing and combination with a fault are rejected.
   * Stream overflow omits Content-Length; timeout stalls the response.
   * Neither mode changes production limits.
   */
  source(url: string, fault?: SourceFault, encodedBytes?: Uint8Array): Promise<SourceFixture>;
  /** Fail one real object-store operation; never fabricate a content job result. */
  failNextPut(): void;
  /** Test facade over real registered dispatch; not a new production queue API.
   * Redelivery reuses the captured event and native deterministic workflow ID.
   * Aborting stops the bounded drain; it cannot invent a terminal DBOS state.
   */
  drain(input: { mediaIds: readonly string[]; maxJobs: 16; signal: AbortSignal; redeliver?: boolean }): Promise<void>;
  observe(mediaId: string): Promise<NativeMediaObservation>;
  capture(): Promise<{
    sourceRequests: readonly { url: string; bytes: number; headers: Headers; responseHeaders: Headers }[];
    liveInternetRequests: readonly string[];
    peakBufferedSourceBytes: number;
    sourceInputBackings: readonly number[];
    storedObjectBytes: number;
    executedJobs: number;
    registrations: readonly (
      | {
          name: typeof CONTENT_WORKFLOWS.importFromUrl;
          queue: typeof CONTENT_QUEUES.importFromUrl;
          handler: typeof processImportedMedia;
        }
      | {
          name: typeof CONTENT_WORKFLOWS.image;
          queue: typeof CONTENT_QUEUES.image;
          handler: typeof processImage;
        }
    )[];
    calls: readonly { workflowId: string; name: string; mediaId: string }[];
  }>;
  /** Begin an isolated case on the shared full application worker. */
  reset(): Promise<void>;
  start(): Promise<void>;
  /** Actual shared growth capture of one registered import transition. */
  measureTransition(mediaId: string): Promise<import('../support/growth-cost.ts').Capture>;
  /** Seed completed DBOS history rows with the production workflow persistence shape. */
  seedWorkflowHistory(count: number): Promise<number>;
  close(): Promise<void>;
}

/** An isolated fixture owns one complete application worker lifecycle. Auth and
 * kernel workers run in separate application processes, each launching DBOS once.
 * Only source HTTP and the object provider are external fixtures. */
export async function createMediaBoundary(options: MediaBoundaryOptions): Promise<MediaBoundary> {
  const native = await observeMediaPool(options.content.pool);
  const objects = new Map<string, Uint8Array>();
  const sources = new Map<string, { bytes: Uint8Array; fault?: SourceFault }>();
  const requests: { url: string; bytes: number; headers: Headers; responseHeaders: Headers }[] = [];
  const internet: string[] = [];
  let peak = 0;
  let failPut = false;
  let putFailure = 0;
  let worker: Awaited<ReturnType<(typeof import('./media-boundary-driver.ts'))['launchBoundaryProcess']>> | undefined;
  const workerTraces = new Map<string, MediaTrace>();
  let ending: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let callStart = 0;
  const sourceRequestsByDrain = new Map<string, number>();
  const endpoint = 'https://00000000000000000000000000000000.r2.cloudflarestorage.com';
  const transport = globalThis.fetch;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const incoming = new URL(request.url);
      const target = new URL(incoming.searchParams.get('url')!);
      if (incoming.pathname === '/source') {
        const drain = incoming.searchParams.get('drain')!;
        const count = sourceRequestsByDrain.get(drain) ?? 0;
        if (count >= 64) return new Response(null, { status: 429 });
        sourceRequestsByDrain.set(drain, count + 1);
        const source =
          sources.get(target.href) ??
          [...sources.entries()].find(([url]) => {
            const base = new URL(url);
            return base.origin === target.origin && base.pathname === target.pathname;
          })?.[1];
        if (!source) {
          internet.push(target.href);
          return new Response(null, { status: 404 });
        }
        const responseHeaders = new Headers({ 'content-type': 'image/png' });
        const recorded = { url: target.href, bytes: 0, headers: new Headers(request.headers), responseHeaders };
        requests.push(recorded);
        if (source.fault?.startsWith('redirect-')) {
          const location =
            source.fault === 'redirect-denied-host'
              ? 'https://denied.invalid/image.png'
              : source.fault === 'redirect-private-ip'
                ? 'https://127.0.0.1/image.png'
                : `${target.origin}${target.pathname}?hop=${Number(target.searchParams.get('hop') ?? 0) + 1}`;
          responseHeaders.set('location', location);
          return new Response(null, { status: 302, headers: responseHeaders });
        }
        if (source.fault === 'timeout') {
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return new Response(null, { status: 408 });
        }
        let offset = 0;
        const bytes = source.bytes;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === bytes.byteLength) {
                controller.close();
                return;
              }
              const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength));
              offset += chunk.byteLength;
              recorded.bytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { headers: responseHeaders },
        );
      }
      if (incoming.pathname !== '/objects' || target.origin !== endpoint) {
        internet.push(target.href);
        return new Response(null, { status: 403 });
      }
      const key = decodeURIComponent(target.pathname.slice('/media-fixture/'.length));
      if (request.method === 'PUT') {
        if (failPut) {
          failPut = false;
          putFailure++;
          return new Response(null, { status: 503 });
        }
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (target.searchParams.has('list-type')) {
        const prefix = target.searchParams.get('prefix')!;
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><IsTruncated>false</IsTruncated><KeyCount>${keys.length}</KeyCount>${keys.map((k) => `<Contents><Key>${encodeURIComponent(k)}</Key></Contents>`).join('')}</ListBucketResult>`,
        );
      }
      const bytes = objects.get(key);
      return bytes
        ? new Response(bytes.slice())
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    },
  });
  const externalFetch = (request: Request) =>
    transport(new URL(`/objects?url=${encodeURIComponent(request.url)}`, server.url), request);
  const storage = new R2Storage({
    endpoint,
    bucket: 'media-fixture',
    accessKeyId: 'fixture',
    secretAccessKey: 'fixture-secret',
    maxObjectBytes: 20 * 1024 * 1024,
    fetch: externalFetch,
  });
  const traces = (id: string) => [native.trace(id), workerTraces.get(id) ?? { anchors: {}, fences: [] }];
  async function syncTrace(mediaId: string) {
    if (worker) workerTraces.set(mediaId, await worker.call<MediaTrace>('trace', { mediaId }));
  }
  const boundary: MediaBoundary = {
    configuration: { storage, fetchConfig: options.fetchConfig },
    async source(url, fault, encodedBytes) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !options.fetchConfig.allowedHosts.includes(parsed.hostname))
        throw new Error('Fixture requires an actual configured source URL');
      if (encodedBytes !== undefined) {
        if (fault !== undefined) throw new TypeError('Supplied source bytes cannot be combined with a source fault');
        if (
          !(encodedBytes instanceof Uint8Array) ||
          !(encodedBytes.buffer instanceof ArrayBuffer) ||
          encodedBytes.buffer.resizable
        )
          throw new TypeError('Supplied source bytes require a fixed, non-shared backing buffer');
        if (
          encodedBytes.byteLength === 0 ||
          encodedBytes.byteLength > 20 * 1024 * 1024 ||
          encodedBytes.buffer.byteLength > 20 * 1024 * 1024
        )
          throw new RangeError('Supplied source bytes and backing must fit the production source byte cap');
      }
      const bytes =
        encodedBytes !== undefined
          ? new Uint8Array(encodedBytes)
          : fault === 'stream-over-20-mib'
            ? new Uint8Array(20 * 1024 * 1024 + 1)
            : fault === 'corrupt-image'
              ? new TextEncoder().encode('corrupt encoded image')
              : new Uint8Array(
                  await sharp({
                    create: {
                      width: fault === 'over-40-megapixels' ? 6400 : 48,
                      height: fault === 'over-40-megapixels' ? 6400 : 32,
                      channels: 3,
                      background: { r: 19, g: 81, b: 143 },
                    },
                  })
                    .png()
                    .toBuffer(),
                );
      peak = Math.max(peak, bytes.byteLength);
      sources.set(url, { bytes, ...(fault === undefined ? {} : { fault }) });
      return { url, bytes: bytes.slice() };
    },
    failNextPut() {
      failPut = true;
    },
    start() {
      return (starting ??= (async () => {
        if (!worker) {
          const { launchBoundaryProcess } = await import('./media-boundary-driver.ts');
          const url = options.content.pool.options.connectionString;
          if (!url) throw new Error('Media fixture needs its actual database URL');
          worker = await launchBoundaryProcess('worker', {
            ...options.workerEnvironment,
            DATABASE_URL: url,
            KERNEL_ROUTE_KEY: Buffer.from(options.content.routeKey).toString('base64url'),
            CONTENT_SOURCE_HOSTS: options.fetchConfig.allowedHosts.join(','),
            CONTENT_R2_ENDPOINT: endpoint,
            CONTENT_R2_BUCKET: 'media-fixture',
            CONTENT_R2_ACCESS_KEY_ID: 'fixture',
            CONTENT_R2_SECRET_ACCESS_KEY: 'fixture-secret',
            MEDIA_EXTERNAL_ENDPOINT: server.url.href,
          });
        }
      })());
    },
    async drain(input) {
      input.signal.throwIfAborted();
      if (input.maxJobs !== 16 || input.mediaIds.length > 16) throw new Error('Unbounded media drain');
      await boundary.start();
      await worker!.call('beginDrain', { mediaIds: input.mediaIds, maxJobs: input.maxJobs });
      const failures = putFailure;
      // Dispatch every pending ID before awaiting completion, including IDs
      // from other drain calls using the same native worker concurrently.
      const running = Promise.all(
        input.mediaIds.map(async (id) => {
          await syncTrace(id);
          const envelope = await mediaEnvelope(
            options.content.pool,
            id,
            traces(id),
            'com.rezics.content.media.import-requested.v1',
          );
          await worker!.call('dispatch', { envelope, mediaId: id, redeliver: input.redeliver });
        }),
      );
      // A failed external operation is reported immediately; DBOS owns its retry.
      // The next bounded drain observes that same durable identity to completion.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const failure = new Promise<never>((_, reject) => {
        const check = () => {
          if (putFailure !== failures) reject(new Error('Actual object provider PUT failed'));
          else if (input.signal.aborted) reject(input.signal.reason);
          else timer = setTimeout(check, 5);
        };
        timer = setTimeout(check, 5);
      });
      try {
        await Promise.race([running, failure]);
      } finally {
        clearTimeout(timer);
        await Promise.all(input.mediaIds.map(syncTrace));
      }
    },
    async measureTransition(id) {
      await boundary.start();
      await syncTrace(id);
      const envelope = await mediaEnvelope(
        options.content.pool,
        id,
        traces(id),
        'com.rezics.content.media.import-requested.v1',
      );
      try {
        return await worker!.call('measure', { envelope, mediaId: id });
      } finally {
        await syncTrace(id);
      }
    },
    async seedWorkflowHistory(count) {
      if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Workflow history count must be positive');
      await boundary.start();
      return worker!.call('seedHistory', { count }) as Promise<number>;
    },
    async observe(id) {
      await syncTrace(id);
      return observeNativeMedia(options.content.pool, id, traces(id), objects);
    },
    async capture() {
      const captured = worker
        ? await worker.call<{
            names: string[];
            calls: { workflowId: string; name: string; mediaId: string }[];
            network: string[];
          }>('capture')
        : { names: [], calls: [], network: [] };
      return {
        sourceRequests: requests.map((r) => ({
          ...r,
          headers: new Headers(r.headers),
          responseHeaders: new Headers(r.responseHeaders),
        })),
        liveInternetRequests: [...internet, ...captured.network],
        peakBufferedSourceBytes: peak,
        sourceInputBackings: [...sources.values()].map((s) => s.bytes.buffer.byteLength),
        storedObjectBytes: [...objects.values()].reduce((sum, b) => sum + b.byteLength, 0),
        executedJobs: captured.calls.length - callStart,
        registrations: captured.names.flatMap(
          (name): Awaited<ReturnType<MediaBoundary['capture']>>['registrations'][number][] =>
            name === CONTENT_WORKFLOWS.importFromUrl
              ? [{ name, queue: CONTENT_QUEUES.importFromUrl, handler: processImportedMedia } as const]
              : name === CONTENT_WORKFLOWS.image
                ? [{ name, queue: CONTENT_QUEUES.image, handler: processImage } as const]
                : [],
        ),
        calls: captured.calls.slice(callStart),
      };
    },
    async reset() {
      if (worker) {
        const capture = await worker.call<{ calls: unknown[] }>('capture');
        callStart = capture.calls.length;
        await worker.call('reset');
      }
      workerTraces.clear();
      objects.clear();
      sources.clear();
      requests.length = 0;
      sourceRequestsByDrain.clear();
      internet.length = 0;
      peak = 0;
      failPut = false;
    },
    close() {
      return (ending ??= (async () => {
        try {
          await starting?.catch(() => {});
          await worker?.close();
        } finally {
          await server.stop(true);
          objects.clear();
          sources.clear();
        }
      })());
    },
  };
  return boundary;
}

// The portable suite imports this fixture before declaring its cases. Setup and
// teardown hooks own one complete application lifecycle; individual cases own
// separate public containers, idempotency namespaces and external fixture data.
if (
  Bun.main.endsWith('/specs/imports-media-boundary.test.ts') &&
  process.env.IMPORT_MEDIA_BOUNDARY_DRIVER === new URL('./media-boundary-driver.ts', import.meta.url).pathname
) {
  const { beforeAll, afterAll } = await import('bun:test');
  beforeAll(async () => (await import('./media-boundary-driver.ts')).prepareMediaBoundaryDriver(), 120_000);
  afterAll(async () => (await import('./media-boundary-driver.ts')).closeMediaBoundaryDriver(), 120_000);
}
