import { Pool, type PoolClient } from 'pg';
import sharp from 'sharp';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { createContentWorkAccess } from '../../../src/content/register.ts';
import { createContentWork } from '../../../src/content/work.ts';
import { contentEffects } from '../../../src/content/relays.ts';
import { R2Storage } from '../../../src/content/r2-storage.ts';
import { startWorker } from '../../../src/worker.ts';
import { costOf, type Cost } from '../../support/growth-cost.ts';

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

if (process.argv.includes('--imported-field-native-worker')) {
  const databaseUrl = process.env.IMPORTED_FIELD_DATABASE_URL!;
  const authUrl = process.env.IMPORTED_FIELD_AUTH_DATABASE_URL!;
  const storageEndpoint = process.env.IMPORTED_FIELD_STORAGE_ENDPOINT!;
  const sourceEndpoint = process.env.IMPORTED_FIELD_SOURCE_ENDPOINT!;
  const routeKey = Buffer.from(process.env.IMPORTED_FIELD_ROUTE_KEY!, 'base64url');
  const authPool = new Pool({ connectionString: authUrl, max: 2 });
  type WorkerCapture = { statements: string[]; plans: unknown[] };
  let activeCapture: WorkerCapture | undefined;
  const instrumented = new WeakSet<object>();
  const configureClient = async (client: PoolClient): Promise<void> => {
    if (instrumented.has(client)) return;
    instrumented.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    client.on('notice', (notice) => {
      const message = notice.message;
      const marker = 'plan:\n';
      if (
        !activeCapture ||
        typeof message !== 'string' ||
        !message.startsWith('duration:') ||
        !message.includes(marker)
      )
        return;
      activeCapture.plans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)) as unknown);
    });
    for (const statement of [
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
    ])
      await query(statement);
    client.query = ((...args: unknown[]) => {
      const command = args[0];
      const text =
        typeof command === 'string'
          ? command
          : command && typeof command === 'object' && 'text' in command && typeof command.text === 'string'
            ? command.text
            : undefined;
      if (activeCapture && DBOS.workflowID !== undefined && typeof text === 'string')
        activeCapture.statements.push(text);
      return query(...args);
    }) as typeof client.query;
  };
  type NativePool = InstanceType<typeof Pool>;
  type Release = (error?: Error) => void;
  type ConnectCallback = (
    error: Error | undefined,
    client: PoolClient | undefined,
    release: Release | undefined,
  ) => void;
  type Connect = {
    (this: NativePool): Promise<PoolClient>;
    (this: NativePool, callback: ConnectCallback): void;
  };
  const prototype = Pool.prototype as unknown as { connect: Connect };
  const connect = prototype.connect;
  prototype.connect = function (this: NativePool, callback?: ConnectCallback) {
    if (callback) {
      connect.call(this, (error, client, release) => {
        if (error || !client) {
          callback(error, client, release);
          return;
        }
        void configureClient(client).then(
          () => callback(undefined, client, release),
          (failure: unknown) => {
            const error = failure instanceof Error ? failure : new Error(String(failure));
            release?.(error);
            callback(error, undefined, release);
          },
        );
      });
      return;
    }
    const connectPromise = connect as (this: NativePool) => Promise<PoolClient>;
    return connectPromise.call(this).then(async (client) => {
      await configureClient(client);
      return client;
    });
  } as Connect;
  const { readCurrentConsent } = createCurrentConsentReader({ database: authPool });
  const originalFetch = globalThis.fetch.bind(globalThis);
  const externalFetch: typeof fetch = new Proxy(originalFetch, {
    apply: async (_target, _thisArg, [input, init]: [RequestInfo | URL, RequestInit?]) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
      const source = new URL(request.url);
      if (source.origin === storageEndpoint || source.origin === sourceEndpoint) return originalFetch(request);
      if (source.hostname !== 'images.example.test') {
        const [, id = ''] = source.pathname.split('/');
        await originalFetch(
          new Request(`${sourceEndpoint}/__boundary/${encodeURIComponent(id)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: request.url }),
          }),
        );
        return new Response('External host blocked by the fixture boundary', { status: 403 });
      }
      const replacement = new URL(`${source.pathname}${source.search}`, sourceEndpoint);
      return originalFetch(
        new Request(replacement, {
          method: request.method,
          headers: request.headers,
          redirect: request.redirect,
          signal: request.signal,
        }),
      );
    },
  });
  globalThis.fetch = externalFetch;
  const worker = await startWorker({ databaseUrl, executorId: process.env.IMPORTED_FIELD_EXECUTOR_ID!, poolSize: 10 }, [
    createContentWork({
      storage: new R2Storage({
        endpoint: storageEndpoint,
        bucket: 'media-test',
        accessKeyId: 'fixture',
        secretAccessKey: 'fixture-secret',
        maxObjectBytes: MAX_SOURCE_BYTES,
        fetch: externalFetch,
      }),
      collectionPartitions: [Number(process.env.IMPORTED_FIELD_PARTITION!)],
      access: createContentWorkAccess(() => new Date()),
      readConsent: readCurrentConsent,
      routeKey,
      fetchConfig: { allowedHosts: ['images.example.test'] },
    }),
    {
      name: 'content-relays',
      register(context) {
        context.addEffects(contentEffects(context.pool, context.client));
      },
    },
  ]);
  console.log('imported-field-worker-ready');
  for await (const line of console) {
    if (line === 'capture:start') {
      if (activeCapture) throw new Error('A native worker capture is already active');
      activeCapture = { statements: [], plans: [] };
      console.log('imported-field-worker-capture-started');
      continue;
    }
    if (line === 'capture:stop') {
      const capture = activeCapture;
      if (!capture) throw new Error('No native worker capture is active');
      activeCapture = undefined;
      const cost: Cost = costOf(capture);
      console.log(`imported-field-worker-capture:${JSON.stringify(cost)}`);
      continue;
    }
    if (line !== 'stop') continue;
    await worker.stop();
    await authPool.end();
    console.log('imported-field-worker-stopped');
    break;
  }
}
export type SourceKind =
  | 'valid'
  | 'unallowed-host'
  | 'unsafe-redirect'
  | 'redirect-limit'
  | 'byte-limit'
  | 'timeout'
  | 'over-pixel'
  | 'malformed';

export type ObjectStore = {
  readonly endpoint: string;
  readonly objects: Map<string, Uint8Array>;
  readonly puts: string[];
  readonly deletes: string[];
  readonly listCalls: string[];
  readonly listFailures: number;
  readonly pendingListFailures: number;
  failNextList(): void;
  keys(prefix: string): string[];
  close(): void;
};

export type SourceServer = {
  readonly endpoint: string;
  readonly requests: Map<string, string[]>;
  readonly externalRequests: Map<string, string[]>;
  readonly validBytes: Uint8Array;
  readonly largeImage: Uint8Array;
  url(id: string, kind: SourceKind): string;
  close(): void;
};

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function createObjectStore(): ObjectStore {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const deletes: string[] = [];
  const listCalls: string[] = [];
  let pendingListFailures = 0;
  let listFailures = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!/AWS4-HMAC-SHA256.*\/auto\/s3\/aws4_request/.test(request.headers.get('authorization') ?? ''))
        return new Response('missing signed storage request', { status: 403 });
      const url = new URL(request.url);
      const prefix = '/media-test';
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
        return new Response('not found', { status: 404 });
      const key =
        url.pathname === prefix
          ? ''
          : url.pathname
              .slice(prefix.length + 1)
              .split('/')
              .map(decodeURIComponent)
              .join('/');
      if (url.searchParams.has('list-type')) {
        const requested = url.searchParams.get('prefix') ?? '';
        if (pendingListFailures > 0) {
          pendingListFailures--;
          listFailures++;
          listCalls.push(`${requested}:503`);
          return new Response('retry storage cleanup', { status: 503 });
        }
        const found = [...objects.keys()].filter((item) => item.startsWith(requested));
        listCalls.push(`${requested}:200`);
        return new Response(
          `<ListBucketResult><Name>media-test</Name><EncodingType>url</EncodingType><Prefix>${xml(encodeURIComponent(requested))}</Prefix><KeyCount>${found.length}</KeyCount><IsTruncated>false</IsTruncated>${found.map((item) => `<Contents><Key>${xml(encodeURIComponent(item))}</Key></Contents>`).join('')}</ListBucketResult>`,
          { headers: { 'content-type': 'application/xml' } },
        );
      }
      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        objects.set(key, bytes);
        puts.push(key);
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        deletes.push(key);
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const bytes = objects.get(key);
      return bytes
        ? new Response(Uint8Array.from(bytes).buffer)
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    },
  });
  return {
    endpoint: server.url.origin,
    objects,
    puts,
    deletes,
    listCalls,
    get listFailures() {
      return listFailures;
    },
    get pendingListFailures() {
      return pendingListFailures;
    },
    failNextList() {
      pendingListFailures = 1;
    },
    keys(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    close() {
      server.stop(true);
    },
  };
}

let encodedSourceImages: Promise<{ validBytes: Uint8Array; largeImage: Uint8Array }> | undefined;
export async function createSourceServer(): Promise<SourceServer> {
  encodedSourceImages ??= Promise.all([
    sharp({ create: { width: 320, height: 240, channels: 3, background: '#7354a2' } })
      .jpeg({ quality: 82 })
      .toBuffer(),
    sharp({ create: { width: 6501, height: 6501, channels: 3, background: '#a14234' } })
      .jpeg({ quality: 2 })
      .toBuffer(),
  ]).then(([validBytes, largeImage]) => ({
    validBytes: new Uint8Array(validBytes),
    largeImage: new Uint8Array(largeImage),
  }));
  const { validBytes, largeImage } = await encodedSourceImages;
  const requests = new Map<string, string[]>();
  const externalRequests = new Map<string, string[]>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/__boundary/')) {
        const id = decodeURIComponent(url.pathname.slice('/__boundary/'.length));
        const input = (await request.json()) as { url?: unknown };
        const attempted = externalRequests.get(id) ?? [];
        if (typeof input.url === 'string') attempted.push(input.url);
        externalRequests.set(id, attempted);
        return new Response(null, { status: 204 });
      }
      const [, id = '', kind = ''] = url.pathname.split('/');
      const visited = requests.get(id) ?? [];
      visited.push(url.href);
      requests.set(id, visited);
      if (kind === 'unsafe-redirect') {
        return new Response(null, { status: 302, headers: { location: `https://evil.example.test/${id}/image` } });
      }
      if (kind === 'redirect-limit') {
        const hop = Number(url.searchParams.get('hop') ?? 0);
        return new Response(null, {
          status: 302,
          headers: { location: `https://images.example.test/${id}/redirect-limit?hop=${hop + 1}` },
        });
      }
      if (kind === 'timeout') {
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return new Response(null, { status: 408 });
      }
      if (kind === 'byte-limit') {
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) {
              controller.close();
              return;
            }
            sent = true;
            controller.enqueue(new Uint8Array(MAX_SOURCE_BYTES + 1));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      if (kind === 'over-pixel') return new Response(Uint8Array.from(largeImage), { status: 200 });
      if (kind === 'malformed') return new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), { status: 200 });
      return new Response(Uint8Array.from(validBytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  return {
    endpoint: server.url.origin,
    requests,
    externalRequests,
    validBytes,
    largeImage,
    url(id, kind) {
      return `https://images.example.test/${id}/${kind}`;
    },
    close() {
      server.stop(true);
    },
  };
}

export type WorkerProcess = {
  stop(): Promise<void>;
  kill(): Promise<void>;
  diagnostics(): string;
  beginCapture(): Promise<void>;
  endCapture(): Promise<Cost>;
};
export async function startNativeWorker(options: {
  databaseUrl: string;
  authDatabaseUrl: string;
  executorId: string;
  storageEndpoint: string;
  sourceEndpoint: string;
  routeKey: Uint8Array;
  partition: number;
}): Promise<WorkerProcess> {
  const child = Bun.spawn([process.execPath, import.meta.path, '--imported-field-native-worker'], {
    env: {
      ...process.env,
      IMPORTED_FIELD_DATABASE_URL: options.databaseUrl,
      IMPORTED_FIELD_AUTH_DATABASE_URL: options.authDatabaseUrl,
      IMPORTED_FIELD_EXECUTOR_ID: options.executorId,
      IMPORTED_FIELD_STORAGE_ENDPOINT: options.storageEndpoint,
      IMPORTED_FIELD_SOURCE_ENDPOINT: options.sourceEndpoint,
      IMPORTED_FIELD_ROUTE_KEY: Buffer.from(options.routeKey).toString('base64url'),
      IMPORTED_FIELD_PARTITION: String(options.partition),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  let parsedOutput = 0;
  let captureStarts = 0;
  const captures: Cost[] = [];
  const readOutput = (async () => {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk);
      for (;;) {
        const newline = stdout.indexOf('\n', parsedOutput);
        if (newline < 0) break;
        const line = stdout.slice(parsedOutput, newline).trimEnd();
        parsedOutput = newline + 1;
        if (line === 'imported-field-worker-capture-started') captureStarts++;
        else if (line.startsWith('imported-field-worker-capture:'))
          captures.push(JSON.parse(line.slice('imported-field-worker-capture:'.length)) as Cost);
      }
    }
  })();
  const readErrors = (async () => {
    for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk);
    return stderr;
  })();
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 30_000;
    while (!predicate()) {
      if (child.exitCode !== null) throw new Error(`Native worker exited before ready: ${stdout}\n${await readErrors}`);
      if (Date.now() >= deadline) throw new Error(`Native worker readiness timed out: ${stdout}\n${await readErrors}`);
      await Bun.sleep(20);
    }
  };
  try {
    await waitUntil(() => stdout.includes('imported-field-worker-ready'));
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  }
  return {
    diagnostics() {
      return `stdout=${stdout}\nstderr=${stderr}`;
    },
    async beginCapture() {
      const prior = captureStarts;
      child.stdin.write('capture:start\n');
      await waitUntil(() => captureStarts > prior);
    },
    async endCapture() {
      const prior = captures.length;
      child.stdin.write('capture:stop\n');
      await waitUntil(() => captures.length > prior);
      return captures[prior]!;
    },
    async kill() {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await readOutput;
    },
    async stop() {
      if (child.exitCode === null) {
        child.stdin.write('stop\n');
        child.stdin.end();
      }
      await waitUntil(() => child.exitCode !== null);
      const exit = await child.exited;
      await readOutput;
      const errors = await readErrors;
      if (exit !== 0 || !stdout.includes('imported-field-worker-stopped'))
        throw new Error(`Native worker stopped unsuccessfully (${exit}): ${stdout}\n${errors}`);
    },
  };
}
