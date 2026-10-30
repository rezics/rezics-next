import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import pg, { type Pool } from 'pg';
import { R2Storage } from '../../src/content/r2-storage.ts';
import { registerContent } from '../../src/content/register.ts';
import { effectWorkflowId, relayEffects } from '../../src/events/effects.ts';
import type { Envelope } from '../../src/events/log.ts';
import { contentWorkWorkflowId } from '../../src/content/work-contract.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkModule } from '../../src/work/registry.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import type { ContentCredential, ContentSystem } from './support/system.ts';

export const MEDIA_NATIVE_BASE = '2030-01-01T00:00:00.000Z';
export const MEDIA_NATIVE_CUT = '2030-01-02T00:00:00.000Z';
export const MEDIA_NATIVE_GROWTH_BASE = '2031-01-01T00:00:00.000Z';
export const MEDIA_NATIVE_GROWTH_CUT = '2031-01-02T00:00:00.000Z';
export const MEDIA_R2_ORIGIN = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
export const MEDIA_R2_BUCKET = 'media-test';
const MEDIA_R2_ACCESS_KEY = 'media-native-fixture-access';
const MEDIA_R2_SECRET = 'media-native-fixture-secret';
const CONTROL_PREFIX = 'MEDIA_NATIVE_COLLECTION_CONTROL:';
const NATIVE_STAGE_TIMEOUT_MS = 60_000;
const NATIVE_WORKER_READY_TIMEOUT_MS = 30_000;
const NATIVE_WORKER_DIAGNOSTIC_BYTES = 4_096;

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function awaitNativeStage<T>(stage: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out after ${NATIVE_STAGE_TIMEOUT_MS} ms`)),
          NATIVE_STAGE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}: ${detail.slice(0, 800)}`, { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function appendDiagnostic(current: string, next: string): string {
  return `${current}${next}`.slice(-NATIVE_WORKER_DIAGNOSTIC_BYTES);
}

function mappedR2Fetch(endpoint: string, nativeFetch = globalThis.fetch.bind(globalThis)) {
  return async (request: Request): Promise<Response> => {
    const source = new URL(request.url);
    if (source.origin !== MEDIA_R2_ORIGIN) return nativeFetch(request);
    const target = new URL(endpoint);
    target.pathname = `${target.pathname.replace(/\/$/, '')}${source.pathname}`;
    target.search = source.search;
    return nativeFetch(new Request(target, request));
  };
}

export function createMediaObjectStore() {
  const objects = new Map<string, Uint8Array>();
  const listPrefixes: string[] = [];
  const deleteKeys: string[] = [];
  const failedDeletes: string[] = [];
  let failure:
    | {
        readonly prefix: string;
        readonly entered: Deferred<void>;
        readonly release: Deferred<void>;
      }
    | undefined;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!/AWS4-HMAC-SHA256.*\/auto\/s3\/aws4_request/.test(request.headers.get('authorization') ?? ''))
        return new Response(null, { status: 403 });
      const url = new URL(request.url);
      const key = url.pathname
        .slice(`/${MEDIA_R2_BUCKET}/`.length)
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent)
        .join('/');
      if (url.searchParams.has('list-type')) {
        const prefix = url.searchParams.get('prefix') ?? '';
        listPrefixes.push(prefix);
        const keys = [...objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
        return new Response(
          `<ListBucketResult><EncodingType>url</EncodingType><Prefix>${encodeURIComponent(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map((candidate) => `<Contents><Key>${encodeURIComponent(candidate)}</Key></Contents>`).join('')}</ListBucketResult>`,
          { headers: { 'content-type': 'application/xml' } },
        );
      }
      if (request.method === 'PUT') {
        objects.set(key, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        deleteKeys.push(key);
        if (failure && key.startsWith(failure.prefix)) {
          const current = failure;
          failure = undefined;
          current.entered.resolve();
          await current.release.promise;
          failedDeletes.push(key);
          return new Response(null, { status: 503 });
        }
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const bytes = objects.get(key);
      return bytes
        ? new Response(Uint8Array.from(bytes).buffer)
        : new Response('<Error><Code>NoSuchKey</Code></Error>', {
            status: 404,
            headers: { 'content-type': 'application/xml' },
          });
    },
  });

  const uploader = new R2Storage({
    endpoint: MEDIA_R2_ORIGIN,
    bucket: MEDIA_R2_BUCKET,
    accessKeyId: MEDIA_R2_ACCESS_KEY,
    secretAccessKey: MEDIA_R2_SECRET,
    maxObjectBytes: 20 * 1024 * 1024,
    fetch: mappedR2Fetch(server.url.origin),
  });

  return {
    endpoint: server.url.origin,
    objects,
    listPrefixes,
    deleteKeys,
    failedDeletes,
    async putOriginal(mediaId: string, bytes: Uint8Array) {
      await uploader.put(`m/${mediaId}/original`, bytes, {
        mediaType: 'image/png',
      });
    },
    inspect(prefix: string) {
      return [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, sha256: sha256(bytes) }))
        .sort((left, right) => left.key.localeCompare(right.key));
    },
    async failDeleteOnce(prefix: string) {
      if (failure) throw new Error('A physical object deletion failure is already armed');
      const entered = deferred<void>();
      const release = deferred<void>();
      failure = { prefix, entered, release };
      return { entered: entered.promise, release: () => release.resolve() };
    },
    close() {
      server.stop(true);
      objects.clear();
    },
  };
}

export type MediaObjectStore = ReturnType<typeof createMediaObjectStore>;

export type NativeEventSource = {
  readonly partition: number;
  readonly epoch: number;
  readonly position: bigint;
  readonly eventSeq: number;
  readonly type: string;
};

export async function uploadedEvent(pool: Pool, mediaId: string): Promise<NativeEventSource> {
  const result = await pool.query<{
    partition_no: number;
    epoch: number;
    position: string;
    event_seq: number;
    type: string;
  }>(
    `SELECT partition_no,epoch,position::text,event_seq,type
       FROM core.outbox
      WHERE subject=$1 AND type='com.rezics.content.media.uploaded.v1'
      ORDER BY position,event_seq`,
    [mediaId],
  );
  if (result.rows.length !== 1) throw new Error(`Expected one committed upload event for ${mediaId}`);
  const event = result.rows[0]!;
  return {
    partition: event.partition_no,
    epoch: event.epoch,
    position: BigInt(event.position),
    eventSeq: event.event_seq,
    type: event.type,
  };
}

export function imageWorkflowIds(source: NativeEventSource) {
  const envelope = {
    partition: source.partition,
    epoch: source.epoch,
    position: source.position,
  } as Envelope;
  return {
    effect: effectWorkflowId(envelope, source.eventSeq, 'content_media_image'),
    image: contentWorkWorkflowId(envelope, source.eventSeq, 'image'),
  };
}

export type NativeCollectionRuntime = {
  readonly pool: Pool;
  readonly client: WorkClient;
  readonly effects: Awaited<ReturnType<typeof composeWork>>['effects'];
  relayThrough(partition: number, position: bigint): Promise<bigint>;
  close(): Promise<void>;
};

export async function composeNativeCollectionRuntime(options: {
  readonly databaseUrl: string;
  readonly routeKey: Uint8Array;
  readonly partitions: readonly number[];
  readonly store: MediaObjectStore;
  readonly clock: () => Date;
  readonly pool?: Pool;
}): Promise<NativeCollectionRuntime> {
  const pool = options.pool ?? new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  const ownsPool = options.pool === undefined;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = mappedR2Fetch(options.store.endpoint, oldFetch.bind(globalThis)) as typeof fetch;
  const env = workerTestEnv({
    CONTENT_R2_ENDPOINT: MEDIA_R2_ORIGIN,
    CONTENT_R2_BUCKET: MEDIA_R2_BUCKET,
    CONTENT_R2_ACCESS_KEY_ID: MEDIA_R2_ACCESS_KEY,
    CONTENT_R2_SECRET_ACCESS_KEY: MEDIA_R2_SECRET,
    CONTENT_TEST_COLLECTION_PARTITIONS: [...new Set(options.partitions)].sort((a, b) => a - b).join(','),
    KERNEL_ROUTE_KEY: Buffer.from(options.routeKey).toString('base64url'),
  });
  let client: WorkClient | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    client = await createWorkClient(options.databaseUrl, pool);
    work = await composeWork([registerContent], {
      databaseUrl: options.databaseUrl,
      pool,
      client,
      env,
      clock: options.clock,
    });
    await work.launch();
  } catch (error) {
    globalThis.fetch = oldFetch;
    try {
      await work?.shutdown();
    } finally {
      try {
        await client?.close();
      } finally {
        if (ownsPool) await pool.end();
      }
    }
    throw error;
  }
  if (!client || !work) throw new Error('Native collection runtime did not compose its registered worker');
  const runningClient = client;
  const runningWork = work;
  let closing: Promise<void> | undefined;
  return {
    pool,
    client: runningClient,
    effects: runningWork.effects,
    async relayThrough(partition, position) {
      let latest = 0n;
      for (;;) {
        const result = await relayEffects(pool, runningWork.effects, partition);
        if (result.status === 'stopped') throw new Error(`Native effect relay stopped: ${result.reason}`);
        if (result.status === 'read') latest = result.position;
        if (result.status === 'read' && latest >= position) return latest;
        if (result.status === 'read' && result.envelopes === 0)
          throw new Error(`Native effect relay made no progress before partition ${partition} position ${position}`);
      }
    },
    close: () =>
      (closing ??= (async () => {
        try {
          await runningWork.shutdown();
        } finally {
          try {
            await runningClient.close();
          } finally {
            globalThis.fetch = oldFetch;
            if (ownsPool) await pool.end();
          }
        }
      })()),
  };
}

export async function databaseUrlForSystem(system: ContentSystem, templateUrl: string): Promise<string> {
  const result = await system.database.pool.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(templateUrl);
  url.pathname = `/${result.rows[0]!.name}`;
  return url.href;
}

export type ContentHttpResult = {
  readonly response: Response;
  readonly body: Record<string, unknown> | undefined;
};

export async function contentHttp(
  system: ContentSystem,
  actor: ContentCredential | null,
  method: string,
  path: string,
  body?: unknown,
  key: string = crypto.randomUUID(),
): Promise<ContentHttpResult> {
  const response = await system.transport
    .capture(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          ...(actor === null ? {} : { authorization: `Bearer ${actor.bearer}` }),
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'idempotency-key': JSON.stringify(key),
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    .then(({ response: captured }) => captured);
  const text = await response.text();
  let value: unknown;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
  }
  return {
    response,
    body: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
  };
}

export type HttpMedia = {
  readonly id: string;
  readonly reservationKey: string;
  readonly containerId: string;
  readonly sourceBytes: Uint8Array;
  readonly sourceDigest: string;
  readonly image: {
    readonly mediaId: string;
    readonly state: 'available' | 'rejected' | 'already_terminal';
    readonly variants: readonly {
      readonly format: 'webp' | 'avif';
      readonly width: number;
      readonly height: number;
      readonly mediaType: string;
      readonly byteCount: number;
      readonly sha256: string;
      readonly key: string;
    }[];
  };
  readonly source: NativeEventSource;
};

export async function createHttpMedia(options: {
  readonly system: ContentSystem;
  readonly store: MediaObjectStore;
  readonly runtime: Pick<NativeCollectionRuntime, 'client' | 'relayThrough'>;
  readonly actor: ContentCredential;
  readonly uploader: ContentCredential;
  readonly containerId: string;
  readonly bytes: Uint8Array;
  readonly keyPrefix: string;
}): Promise<HttpMedia> {
  const bytes = Uint8Array.from(options.bytes);
  if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1024 * 1024)
    throw new RangeError('Native media source must be between one byte and twenty MiB');
  const sourceDigest = sha256(bytes);
  const reservationKey = `${options.keyPrefix}-${crypto.randomUUID()}`;
  let stage = 'HTTP reservation';
  let mediaId: string | undefined;
  let source: NativeEventSource | undefined;
  let ids: ReturnType<typeof imageWorkflowIds> | undefined;
  try {
    const reserved = await awaitNativeStage(
      stage,
      contentHttp(
        options.system,
        options.actor,
        'POST',
        '/v1/media',
        {
          containerId: options.containerId,
          purpose: 'post-image',
          mediaType: 'image/png',
          byteCount: bytes.byteLength,
          sha256: sourceDigest,
        },
        reservationKey,
      ),
    );
    if (reserved.response.status !== 201 || !reserved.body?.media || typeof reserved.body.media !== 'object')
      throw new Error(`Native HTTP media reservation failed (${reserved.response.status})`);
    const media = reserved.body.media as { id?: unknown; key?: unknown };
    if (typeof media.id !== 'string' || media.key !== `m/${media.id}/original`)
      throw new Error('Native HTTP media reservation returned an invalid object identity');
    mediaId = media.id;

    stage = `original object PUT for ${mediaId}`;
    await awaitNativeStage(stage, options.store.putOriginal(mediaId, bytes));
    stage = `website-client completion for ${mediaId}`;
    const completed = await awaitNativeStage(
      stage,
      contentHttp(
        options.system,
        options.uploader,
        'POST',
        `/v1/media/${mediaId}:complete`,
        {
          containerId: options.containerId,
          reservationRequestId: reservationKey,
          byteCount: bytes.byteLength,
          sha256: sourceDigest,
        },
        `${reservationKey}-complete`,
      ),
    );
    if (completed.response.status !== 200 || completed.body?.media === undefined)
      throw new Error(`Native website-client media completion failed (${completed.response.status})`);

    stage = `committed upload event lookup for ${mediaId}`;
    source = await awaitNativeStage(stage, uploadedEvent(options.system.database.pool, mediaId));
    ids = imageWorkflowIds(source);
    const sourceId = `${source.partition}.${source.epoch}.${source.position}.${source.eventSeq}`;
    stage = `registered effect relay for source ${sourceId} (${ids.effect})`;
    await awaitNativeStage(stage, options.runtime.relayThrough(source.partition, source.position));
    stage = `registered effect result for source ${sourceId} (${ids.effect})`;
    await awaitNativeStage(stage, options.runtime.client.retrieveWorkflow(ids.effect).getResult());
    stage = `production Sharp image result for source ${sourceId} (${ids.image})`;
    const image = (await awaitNativeStage(
      stage,
      options.runtime.client.retrieveWorkflow(ids.image).getResult(),
    )) as HttpMedia['image'];
    if (image.mediaId !== mediaId) throw new Error('Native image workflow result is not linked to its upload source');
    return {
      id: mediaId,
      reservationKey,
      containerId: options.containerId,
      sourceBytes: bytes,
      sourceDigest,
      image,
      source,
    };
  } catch (error) {
    const sourceId = source
      ? `${source.partition}.${source.epoch}.${source.position}.${source.eventSeq}`
      : 'not committed';
    const workflowIds = ids ? ` effect=${ids.effect} image=${ids.image}` : '';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Native HTTP media ${options.keyPrefix.slice(0, 80)} failed at ${stage}; media=${mediaId ?? 'unknown'}; source=${sourceId}${workflowIds}; ${detail.slice(0, 1_000)}`,
      { cause: error },
    );
  }
}

type WorkerMessage = {
  readonly id: string;
  readonly type: 'clock' | 'relay' | 'stop';
  readonly value?: string;
  readonly partition?: number;
  readonly position?: string;
};
type WorkerReply = {
  readonly id?: string;
  readonly type: 'ready' | 'reply';
  readonly error?: string;
  readonly result?: unknown;
};

export async function runNativeCollectionWorker() {
  const databaseUrl = process.env.DATABASE_URL;
  const endpoint = process.env.CONTENT_TEST_STORAGE;
  if (!databaseUrl || !endpoint) throw new Error('Native collection worker requires its database and storage endpoint');
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = mappedR2Fetch(endpoint, nativeFetch) as typeof fetch;
  let workTime = process.env.CONTENT_TEST_NOW ?? MEDIA_NATIVE_BASE;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  let client: WorkClient | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    client = await createWorkClient(databaseUrl, pool);
    const env = workerTestEnv({
      ...process.env,
      CONTENT_R2_ENDPOINT: MEDIA_R2_ORIGIN,
      CONTENT_R2_BUCKET: MEDIA_R2_BUCKET,
      CONTENT_R2_ACCESS_KEY_ID: MEDIA_R2_ACCESS_KEY,
      CONTENT_R2_SECRET_ACCESS_KEY: MEDIA_R2_SECRET,
      KERNEL_ROUTE_KEY: process.env.KERNEL_ROUTE_KEY,
    });
    const partitions = (process.env.CONTENT_TEST_COLLECTION_PARTITIONS ?? '').split(',').filter(Boolean).map(Number);
    const modules: readonly WorkModule[] = [registerContent];
    const runningWork = await composeWork(modules, {
      databaseUrl,
      executorId: `media-native-${process.pid}`,
      pool,
      client,
      env,
      clock: () => new Date(workTime),
    });
    work = runningWork;
    await runningWork.launch();
    const reply = (message: WorkerReply) => process.stdout.write(`${CONTROL_PREFIX}${JSON.stringify(message)}\n`);
    reply({ type: 'ready', result: { partitions } });
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        continue;
      }
      try {
        if (message.type === 'clock') {
          if (typeof message.value !== 'string' || !Number.isFinite(Date.parse(message.value)))
            throw new TypeError('Invalid native worker clock value');
          workTime = message.value;
          reply({ id: message.id, type: 'reply', result: workTime });
        } else if (message.type === 'relay') {
          if (
            typeof message.partition !== 'number' ||
            !Number.isInteger(message.partition) ||
            typeof message.position !== 'string'
          )
            throw new TypeError('Invalid native relay barrier');
          const wanted = BigInt(message.position);
          let reached = 0n;
          for (;;) {
            const result = await relayEffects(pool, runningWork.effects, message.partition);
            if (result.status === 'stopped') throw new Error(`Native effect relay stopped: ${result.reason}`);
            if (result.status === 'read') reached = result.position;
            if (result.status === 'read' && reached >= wanted) break;
            if (result.status === 'read' && result.envelopes === 0)
              throw new Error(`Native effect relay stopped before ${message.partition}:${wanted}`);
          }
          reply({ id: message.id, type: 'reply', result: reached.toString() });
        } else if (message.type === 'stop') {
          await runningWork.shutdown();
          work = undefined;
          reply({ id: message.id, type: 'reply', result: 'stopped' });
          break;
        } else throw new TypeError('Unknown native worker command');
      } catch (error) {
        reply({
          id: message.id,
          type: 'reply',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    try {
      await work?.shutdown();
    } finally {
      try {
        await client?.close();
      } finally {
        await pool.end();
        globalThis.fetch = nativeFetch;
      }
    }
  }
}

export async function startNativeCollectionWorker(options: {
  readonly entryPath: string;
  readonly databaseUrl: string;
  readonly endpoint: string;
  readonly routeKey: Uint8Array;
  readonly partitions: readonly number[];
  readonly now: string;
}) {
  const child = Bun.spawn([process.execPath, options.entryPath, '--media-native-collection-worker'], {
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      CONTENT_TEST_STORAGE: options.endpoint,
      CONTENT_TEST_NOW: options.now,
      CONTENT_TEST_COLLECTION_PARTITIONS: [...new Set(options.partitions)].sort((a, b) => a - b).join(','),
      KERNEL_ROUTE_KEY: Buffer.from(options.routeKey).toString('base64url'),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pending = new Map<string, (reply: WorkerReply) => void>();
  const ready = deferred<WorkerReply>();
  let stdoutBuffer = '';
  let stdoutDiagnostic = '';
  let stderrDiagnostic = '';
  let stopped = false;
  const outputReader = (async () => {
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      stdoutBuffer += text;
      stdoutDiagnostic = appendDiagnostic(stdoutDiagnostic, text);
      if (stdoutBuffer.length > NATIVE_WORKER_DIAGNOSTIC_BYTES)
        stdoutBuffer = stdoutBuffer.slice(-NATIVE_WORKER_DIAGNOSTIC_BYTES);
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line.startsWith(CONTROL_PREFIX)) continue;
        let message: WorkerReply;
        try {
          message = JSON.parse(line.slice(CONTROL_PREFIX.length)) as WorkerReply;
        } catch {
          continue;
        }
        if (message.type === 'ready') ready.resolve(message);
        else if (message.id) pending.get(message.id)?.(message);
      }
    }
  })();
  const errorReader = (async () => {
    for await (const chunk of child.stderr)
      stderrDiagnostic = appendDiagnostic(stderrDiagnostic, new TextDecoder().decode(chunk));
  })();
  const diagnostic = () => `stdout tail:\n${stdoutDiagnostic}\nstderr tail:\n${stderrDiagnostic}`;
  const exited = child.exited.then((code) => {
    if (!stopped)
      ready.resolve({
        type: 'ready',
        error: `Worker exited (${code})\n${diagnostic()}`,
      });
    for (const [id, resolve] of pending) {
      resolve({
        id,
        type: 'reply',
        error: `Worker exited (${code})\n${diagnostic()}`,
      });
    }
    return code;
  });
  async function waitForExit(timeoutMs: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Worker did not exit within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  async function terminateChild() {
    child.kill('SIGTERM');
    try {
      await waitForExit(5_000);
    } catch {
      child.kill('SIGKILL');
      await exited;
    }
    await Promise.all([outputReader, errorReader]);
  }
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const initial = await Promise.race([
      ready.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Worker did not complete startup within ${NATIVE_WORKER_READY_TIMEOUT_MS} ms`)),
          NATIVE_WORKER_READY_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (initial.error) throw new Error(initial.error);
  } catch (error) {
    await terminateChild();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Native collection worker startup failed: ${detail.slice(0, 1_000)}\n${diagnostic()}`, {
      cause: error,
    });
  }

  async function command(message: Omit<WorkerMessage, 'id'>, label: string) {
    const id = crypto.randomUUID();
    const response = new Promise<WorkerReply>((resolve) => pending.set(id, resolve));
    try {
      child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const reply = await Promise.race([
        response,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`No reply to ${label} within ${NATIVE_STAGE_TIMEOUT_MS} ms`)),
            NATIVE_STAGE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (reply.error) throw new Error(reply.error);
      return reply.result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Native collection worker ${label} failed: ${detail.slice(0, 1_000)}\n${diagnostic()}`, {
        cause: error,
      });
    } finally {
      pending.delete(id);
    }
  }

  return {
    async setClock(value: string) {
      await command({ type: 'clock', value }, `clock ${value}`);
    },
    async relayThrough(partition: number, position: bigint) {
      return BigInt(
        (await command(
          {
            type: 'relay',
            partition,
            position: position.toString(),
          },
          `effect relay through ${partition}:${position}`,
        )) as string,
      );
    },
    async stop() {
      if (stopped) return;
      let stopFailure: unknown;
      try {
        await command({ type: 'stop' }, 'stop');
      } catch (error) {
        stopFailure = error;
        await terminateChild();
      }
      stopped = true;
      const code = await exited;
      await Promise.all([outputReader, errorReader]);
      if (stopFailure) throw stopFailure;
      if (code !== 0) throw new Error(`Native collection worker exited (${code})\n${diagnostic()}`);
    },
  };
}

if (process.argv.includes('--media-native-collection-worker')) await runNativeCollectionWorker();
