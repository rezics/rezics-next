import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Persona } from '../../../../../specs/semantic-driver.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { createOpenSearch, OpenSearchError } from '../../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../../src/search/query.ts';
import { createSearchService } from '../../../src/search/service.ts';
import { subjectSource } from '../../../src/semantic/search-source.ts';
import { closeOwnedSemanticAuth, type OwnedSemanticResource } from '../../semantic/outcome-auth.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../../semantic/outcome-driver.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createOutcomeRpc, type OutcomeRpc } from './outcome-rpc.ts';
import type { WorkerStats } from './outcome-worker.ts';

export type OwnedResource =
  | OwnedSemanticResource
  | { kind: 'index_prefix'; name: string }
  | { kind: 'worker_process'; pid: number };
export interface WireResponse {
  status: number;
  body: Record<string, unknown>;
  headers: [string, string][];
}
export interface SupervisorReady {
  globalContext: string;
  indexPrefix: string;
  workerStats: WorkerStats;
}
export interface SupervisorObservation {
  supervisorPid: number;
  resources: OwnedResource[];
  phases: string[];
  proxyUrl?: string;
  authIssuer?: string;
  workerStats?: WorkerStats;
  workerOutput: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Invalid control parameters');
}
function empty(params: unknown) {
  if (params !== undefined) throw new Error('This control takes no parameters');
}

/** The proxy retains a stable port across a genuine connectivity outage. */
async function searchProxy(endpoint: string) {
  const target = new URL(endpoint);
  const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreams = new Set<ReturnType<typeof httpRequest>>();
  const server = createServer((incoming, outgoing) => {
    const upstream = forward(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.rawHeaders,
      },
      (response) => {
        outgoing.writeHead(response.statusCode!, response.statusMessage, response.rawHeaders);
        response.pipe(outgoing);
      },
    );
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  let port = 0;
  async function up() {
    if (server.listening) return;
    server.listen({ host: '127.0.0.1', port });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Search proxy did not bind');
    port = address.port;
  }
  async function down() {
    for (const upstream of upstreams) upstream.destroy();
    if (!server.listening) return;
    const stopped = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await stopped;
  }
  await up();
  return { url: `http://127.0.0.1:${port}`, up, down };
}

function supervise(parent: OutcomeRpc) {
  let initialized = false;
  let ready = false;
  let sealed = false;
  let starting: Promise<SupervisorReady> | undefined;
  let closing: Promise<SupervisorObservation> | undefined;
  let cleanup: Promise<SupervisorObservation> | undefined;
  const operations = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const observation: SupervisorObservation = {
    supervisorPid: process.pid,
    resources: [],
    phases: [],
    workerOutput: '',
  };
  let semantic: SemanticOutcomeDriver | undefined;
  let proxy: Awaited<ReturnType<typeof searchProxy>> | undefined;
  let worker: ChildProcess | undefined;
  let workerRpc: OutcomeRpc | undefined;
  let workerExit: Promise<{ code: number | null; signal: string | null }> | undefined;
  let exited = false;
  let stoppingWorker: Promise<void> | undefined;
  let operator: Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>> | undefined;
  const prefix = `test-${randomBytes(12).toString('hex')}-`;

  const snapshot = () => structuredClone(observation);
  async function own(resource: OwnedResource) {
    const result = await parent.request<{ acknowledged: boolean }>('owned-resource', resource);
    if (result?.acknowledged !== true) throw new Error('Parent did not acknowledge owned resource');
    observation.resources.push(resource);
  }
  async function phase(name: string, step: () => unknown | Promise<unknown>) {
    await step();
    observation.phases.push(name);
  }
  async function attempt(step: () => unknown | Promise<unknown>) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  function stopWorker() {
    return (stoppingWorker ??= (async () => {
      if (!worker || !workerExit) return;
      const errors: unknown[] = [];
      let forced = false;
      const timer = setTimeout(() => {
        forced = true;
        worker!.kill('SIGKILL');
      }, 90_000);
      try {
        try {
          observation.workerStats = await workerRpc!.request<WorkerStats>('close', undefined, 60_000);
        } catch (error) {
          errors.push(error);
        }
        if (worker.connected) worker.disconnect();
        const result = await workerExit; // close includes stdout/stderr EOF, not merely the exit signal.
        if (forced || result.code !== 0 || result.signal !== null) {
          errors.push(
            new Error(`Worker did not drain: ${JSON.stringify({ ...result, forced })}: ${observation.workerOutput}`),
          );
        }
      } finally {
        clearTimeout(timer);
        workerRpc?.close();
      }
      if (errors.length) throw new AggregateError(errors, 'Owned worker cleanup failed');
    })());
  }
  let beforeClosing: Promise<void> | undefined;
  function beforeClose() {
    return (beforeClosing ??= (async () => {
      await attempt(() => phase('worker', stopWorker));
      // Never release bindings or pools while a process could still be accessing them.
      if (worker && !exited) throw new Error('Worker exit was not confirmed');
      await attempt(() => phase('auth', closeOwnedSemanticAuth));
    })());
  }
  function dispose() {
    return (cleanup ??= (async () => {
      if (semantic) await attempt(() => phase('semantic', () => semantic!.close()));
      else await beforeClose();
      if (worker && !exited) throw new AggregateError(failures, 'Cannot delete state before worker exit');
      if (proxy) {
        await attempt(() =>
          phase('indices', async () => {
            await proxy!.up();
            const search = createOpenSearch(proxy!.url);
            const errors: unknown[] = [];
            const deleting = async (step: () => Promise<unknown>) => {
              try {
                await step();
              } catch (error) {
                errors.push(error);
              }
            };
            await deleting(async () => {
              const { body } = await search.request<{ indices: { name: string }[] }>(
                'GET',
                `/_resolve/index/${prefix}*`,
                undefined,
                { query: { expand_wildcards: 'all' } },
              );
              for (const { name } of body.indices) {
                await deleting(async () => {
                  if (!name.startsWith(prefix)) throw new Error('Index escaped owned prefix');
                  await search.request('DELETE', `/${encodeURIComponent(name)}`);
                });
              }
            });
            // Stored scripts also carry this factory's exact prefix.
            for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
              await deleting(async () => {
                try {
                  await search.request('DELETE', `/_scripts/${prefix}${name}`);
                } catch (error) {
                  if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
                }
              });
            }
            if (errors.length) throw new AggregateError(errors, 'Owned index deletion failed');
          }),
        );
        await attempt(() => phase('proxy', proxy!.down));
      }
      if (failures.length) throw new AggregateError(failures, 'Search supervisor cleanup failed');
      return snapshot();
    })());
  }
  function close() {
    sealed = true;
    return (closing ??= (async () => {
      await starting?.catch(() => {}); // init preserves and reports its own original error.
      const admitted = await Promise.allSettled([...operations]);
      for (const result of admitted) if (result.status === 'rejected') failures.push(result.reason);
      return dispose();
    })());
  }
  async function init(endpoint: string): Promise<SupervisorReady> {
    try {
      await own({ kind: 'index_prefix', name: prefix });
      proxy = await searchProxy(endpoint);
      observation.proxyUrl = proxy.url;
      const client = createOpenSearch(proxy.url);
      semantic = await createSemanticDriver(
        (config) => {
          if (!config.tokens) throw new Error('Semantic fixtures did not supply session keys');
          return createKernel({
            ...config,
            search: createSearchService({
              pool: config.pool,
              client,
              prefix,
              source: subjectSource(config.pool, config.routeKey),
              cursors: config.tokens,
            }),
          });
        },
        { linkProjection: 'external', strictCleanup: true, onOwnedResource: own, beforeClose },
      );
      const fixtures = semantic.fixtures;
      observation.authIssuer = fixtures.runtime.authIssuer;
      operator = await fixtures.person('search_operator');
      await fixtures.grantAccount(operator, ['moderation:hide', 'moderation:takedown']);
      const runtime = fixtures.runtime;
      // Start from a clean host integration environment. Only the real fixture credentials cross this boundary.
      const env = workerTestEnv({
        DATABASE_URL: runtime.databaseUrl,
        KERNEL_ROUTE_KEY: runtime.routeKey,
        KERNEL_SESSION_KEYS: runtime.sessionKeys,
        AUTH_ISSUER: runtime.authIssuer,
        AUTH_AUDIENCE: runtime.authAudience,
        AUTH_JWKS_URL: runtime.authJwksUrl,
        OPENSEARCH_URL: proxy.url,
        KERNEL_SEARCH_PREFIX: prefix,
      });
      worker = fork(`${import.meta.dir}/outcome-worker.ts`, [], {
        execPath: process.execPath,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|TEMP|LANG|TZ|BUN_.+)$/.test(key)),
        ),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const output = (chunk: unknown) => {
        observation.workerOutput = (observation.workerOutput + String(chunk)).slice(-65_536);
      };
      worker.stdout!.on('data', output);
      worker.stderr!.on('data', output);
      workerExit = new Promise((resolve) =>
        worker!.once('close', (code, signal) => {
          exited = true;
          resolve({ code, signal });
        }),
      );
      workerRpc = createOutcomeRpc(
        {
          send: (packet) =>
            new Promise<void>((resolve, reject) =>
              worker!.send(packet as object, (error) => (error ? reject(error) : resolve())),
            ),
          subscribe(message, failure) {
            const disconnect = () => failure(new Error(`Worker IPC disconnected: ${observation.workerOutput}`));
            const exit = () => {
              failure(new Error(`Worker exited: ${observation.workerOutput}`));
              if (!stoppingWorker && ready)
                void close().catch((error) => {
                  console.error(error);
                  process.exitCode = 1;
                });
            };
            worker!.on('message', message);
            worker!.on('error', failure);
            worker!.on('disconnect', disconnect);
            worker!.on('exit', exit);
            return () => {
              worker!.off('message', message);
              worker!.off('error', failure);
              worker!.off('disconnect', disconnect);
              worker!.off('exit', exit);
            };
          },
        },
        {
          onRequest() {
            throw new Error('Worker cannot control supervisor');
          },
          timeoutMs: 90_000,
        },
      );
      if (!worker.pid) throw new Error('Worker has no process identity');
      await own({ kind: 'worker_process', pid: worker.pid });
      observation.workerStats = await workerRpc.request<WorkerStats>('init', { env });
      ready = true;
      return { globalContext: semantic.globalContext, indexPrefix: prefix, workerStats: observation.workerStats };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Search supervisor initialization and cleanup failed', {
          cause: error,
        });
      }
      throw error;
    }
  }

  async function operate(method: string, params: unknown) {
    if (method === 'request') {
      exact(params, ['persona', 'method', 'path', 'body', 'headers']);
      const personas: string[] = ['anonymous', 'editor', 'acceptor', 'steward', 'suspended'];
      if (
        typeof params.persona !== 'string' ||
        !personas.includes(params.persona) ||
        typeof params.method !== 'string' ||
        !['GET', 'POST', 'PUT'].includes(params.method) ||
        typeof params.path !== 'string' ||
        !params.path.startsWith('/')
      )
        throw new Error('Invalid HTTP request');
      if (
        params.headers !== undefined &&
        (!record(params.headers) || Object.values(params.headers).some((v) => typeof v !== 'string'))
      )
        throw new Error('Invalid HTTP headers');
      const response = await semantic!.request(
        params.persona as Persona,
        params.method as 'GET' | 'POST' | 'PUT',
        params.path,
        params.body,
        params.headers as Record<string, string> | undefined,
      );
      const headers: [string, string][] = [];
      for (const [key, value] of response.headers) if (key.toLowerCase() !== 'set-cookie') headers.push([key, value]);
      for (const value of response.headers.getSetCookie()) headers.push(['set-cookie', value]);
      return { status: response.status, body: response.body, headers } satisfies WireResponse;
    }
    if (method === 'remove') {
      exact(params, ['subjectId', 'mode']);
      if (
        typeof params.subjectId !== 'string' ||
        !params.subjectId ||
        typeof params.mode !== 'string' ||
        !['hidden', 'taken_down'].includes(params.mode)
      )
        throw new Error('Invalid removal control');
      const response = await semantic!.fixtures.send(
        operator!,
        'POST',
        `/v1/subjects/${params.subjectId}:${params.mode === 'hidden' ? 'hide' : 'takedown'}`,
        params.mode === 'hidden'
          ? { reason: 'Search outcome moderation fixture' }
          : { notice: { complaint: 'Search outcome takedown fixture', received_at: new Date().toISOString() } },
        { 'Idempotency-Key': `"${randomUUID()}"` },
      );
      if (response.status !== 200)
        throw new Error(`Subject moderation failed: ${response.status}: ${JSON.stringify(response.body)}`);
      return null;
    }
    if (method === 'indexing' || method === 'searchNode') {
      exact(params, ['state']);
      const states = method === 'indexing' ? ['paused', 'running'] : ['down', 'up'];
      if (typeof params.state !== 'string' || !states.includes(params.state)) throw new Error('Invalid control state');
      if (method === 'indexing') {
        observation.workerStats = await workerRpc!.request<WorkerStats>('indexing', params);
        return null;
      }
      await (params.state === 'down' ? proxy!.down() : proxy!.up());
      return null;
    }
    empty(params);
    if (method === 'rebuild') return workerRpc!.request('rebuild');
    observation.workerStats = await workerRpc!.request<WorkerStats>('stats');
    return snapshot();
  }
  return {
    close,
    control(method: string, params: unknown): unknown {
      if (method === 'close') {
        empty(params);
        return close();
      }
      if (sealed) throw new Error('Search supervisor is closing');
      if (method === 'init') {
        exact(params, ['endpoint']);
        if (typeof params.endpoint !== 'string') throw new Error('init requires endpoint');
        const endpoint = new URL(params.endpoint);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
          throw new Error('Invalid OpenSearch endpoint');
        if (initialized) throw new Error('Search supervisor init already attempted');
        initialized = true;
        return (starting = init(endpoint.href));
      }
      if (!['request', 'remove', 'indexing', 'searchNode', 'rebuild', 'inspect'].includes(method))
        throw new Error(`Unknown control: ${method}`);
      if (!ready) throw new Error('Search supervisor is not initialized');
      const operation = operate(method, params);
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => {});
      return operation;
    },
  };
}

if (import.meta.main) {
  if (!process.send) throw new Error('Search supervisor requires private IPC');
  let supervisor: ReturnType<typeof supervise>;
  const parent = createOutcomeRpc(
    {
      send: (packet) =>
        new Promise<void>((resolve, reject) =>
          process.send!(packet as object, (error: Error | null) => (error ? reject(error) : resolve())),
        ),
      subscribe(message, failure) {
        const disconnect = () => failure(new Error('Search parent disconnected'));
        process.on('message', message);
        process.on('disconnect', disconnect);
        process.on('error', failure);
        return () => {
          process.off('message', message);
          process.off('disconnect', disconnect);
          process.off('error', failure);
        };
      },
    },
    { onRequest: (method, params) => supervisor.control(method, params), timeoutMs: 90_000 },
  );
  supervisor = supervise(parent);
  const lost = () => {
    void supervisor.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.on('disconnect', lost);
  process.on('error', lost);
}
