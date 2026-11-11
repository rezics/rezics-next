import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Persona } from '../../../../../specs/semantic-driver.ts';
import { routeOf } from '../../../src/route/route.ts';
import { STANDARD_QUESTION_ID } from '../../../src/rating/votes.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { composeSearchNativePorts } from '../../../src/composition/search-native.ts';
import { systemClock } from '../../../src/clock.ts';
import { createWorkClient, type WorkClient } from '../../../src/work/client.ts';
import {
  createDefaultPublicFilterRuntime,
  type DefaultPublicFilterRuntime,
} from '../../../src/search/public-runtime.ts';
import { createPublicPreparationStore } from '../../../src/search/public-preparation-store.ts';
import { createOpenSearch, OpenSearchError } from '../../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, HIT_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../../src/search/query.ts';
import { createSearchService } from '../../../src/search/service.ts';
import { createRatedSubjectSource } from '../../../src/search/rated-source.ts';
import { closeOwnedSemanticAuth, type OwnedSemanticResource } from '../../semantic/outcome-auth.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../../semantic/outcome-driver.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import {
  createOutcomeRpc,
  isOutcomeWorkerReadyMessage,
  outcomeWorkerProcessEnvironment,
  type OutcomeRpc,
} from './outcome-rpc.ts';
import type { WorkerStats } from './outcome-worker.ts';
import { createReleasedBookImport } from './released-imports.ts';
import { assertNativeGenerationCoverage } from './native-generation.ts';
import { createSubjectSourceKeyPages } from '../../../src/semantic/subject-source-key-pages.ts';
import { subjectGenerations, subjectIndexName } from '../../../src/search/indices.ts';
import type { ReleasedTransportBarrier, ReleasedTransportBoundary } from './released-discovery-runtime.ts';

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
  lostAliasResponses?: number;
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
export async function searchProxy(endpoint: string) {
  const target = new URL(endpoint);
  const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreams = new Set<ReturnType<typeof httpRequest>>();
  type Gate = ReleasedTransportBoundary & {
    hit(): void;
    wait: Promise<void>;
    release(): void;
    claimed: boolean;
  };
  const gates = new Set<Gate>();
  let closed = false;
  let lostAlias: string | undefined;
  let lostAliasResponses = 0;
  async function boundary(phase: Gate['phase'], method: string | undefined, path: string | undefined) {
    const gate = [...gates].find(
      (gate) => !gate.claimed && gate.phase === phase && gate.method === method && gate.path === path,
    );
    if (!gate) return;
    gate.claimed = true;
    gate.hit();
    await gate.wait;
  }
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      await boundary('request', incoming.method, incoming.url);
      if (incoming.destroyed || outgoing.destroyed) return;
      const alias = incoming.method === 'POST' && incoming.url === '/_aliases' ? lostAlias : undefined;
      const losesAlias =
        alias === undefined
          ? Promise.resolve(false)
          : new Promise<boolean>((resolve, reject) => {
              const chunks: Buffer[] = [];
              incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              incoming.once('error', reject);
              incoming.once('end', () => {
                try {
                  const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                    actions: { add?: { alias: string } }[];
                  };
                  resolve(body.actions.some((action) => action.add?.alias === alias));
                } catch (error) {
                  reject(error);
                }
              });
            });
      void losesAlias.catch(() => outgoing.destroy());
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
          // Retain the native stream under Node's backpressure while delivery is paused.
          void boundary('response', incoming.method, incoming.url)
            .then(async () => {
              // The actual node has applied this request. Drop only its response to the fixture's read alias.
              if ((await losesAlias) && lostAlias === alias && response.statusCode === 200) {
                lostAlias = undefined;
                lostAliasResponses++;
                outgoing.destroy();
                response.destroy();
                return;
              }
              if (outgoing.destroyed) return response.destroy();
              outgoing.writeHead(response.statusCode!, response.statusMessage, response.rawHeaders);
              response.pipe(outgoing);
            })
            .catch(() => outgoing.destroy());
        },
      );
      upstreams.add(upstream);
      upstream.once('close', () => upstreams.delete(upstream));
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
      outgoing.once('close', () => upstream.destroy());
    })().catch(() => outgoing.destroy());
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
  return {
    url: `http://127.0.0.1:${port}`,
    loseAliasResponse(alias: string) {
      lostAlias = alias;
    },
    lostAliasResponses: () => lostAliasResponses,
    up,
    down,
    barrier(input: ReleasedTransportBoundary): ReleasedTransportBarrier {
      if (closed) throw new Error('Search proxy is closed');
      if (!['request', 'response'].includes(input.phase) || !input.path.startsWith('/'))
        throw new Error('Search transport barriers require a phase and an exact absolute HTTP path');
      if (gates.size >= 16) throw new Error('Search proxy permits at most 16 retained transport barriers');
      let hit!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (hit = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      const gate: Gate = {
        ...input,
        hit,
        wait,
        claimed: false,
        release() {
          gates.delete(gate);
          release();
        },
      };
      gates.add(gate);
      return { reached, release: gate.release };
    },
    releaseBarriers() {
      for (const gate of gates) gate.release();
    },
    async close() {
      closed = true;
      for (const gate of gates) gate.release();
      await down();
    },
  };
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
  let nativePorts: ReturnType<typeof composeSearchNativePorts> | undefined;
  let publicFilters: DefaultPublicFilterRuntime | undefined;
  let nativeCoverage: (() => ReturnType<typeof assertNativeGenerationCoverage>) | undefined;
  let preparationClient: Promise<WorkClient> | undefined;
  let releasedBook: ReturnType<typeof createReleasedBookImport> | undefined;
  let proxy: Awaited<ReturnType<typeof searchProxy>> | undefined;
  let workerEnvironment: Record<string, string | undefined> | undefined;
  let worker: ChildProcess | undefined;
  let workerRpc: OutcomeRpc | undefined;
  let workerExit: Promise<{ code: number | null; signal: string | null }> | undefined;
  let exited = false;
  let stoppingWorker: Promise<void> | undefined;
  let operator: Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>> | undefined;
  type Account = Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
  const votersByName = new Map<string, Promise<{ voter: string; accountId: string }>>();
  const voters = new Map<string, { account: Account; session?: string }>();
  const prefix = `test-${randomBytes(12).toString('hex')}-`;
  const searchPorts = () => (nativePorts ??= composeSearchNativePorts());

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
  async function launchWorker(env: Record<string, string | undefined>) {
    const child = fork(`${import.meta.dir}/outcome-worker.ts`, [], {
      execPath: process.execPath,
      // SQL modules load before the IPC init handler: use this world's database and its prepared analysis cache.
      env: outcomeWorkerProcessEnvironment(env),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    worker = child;
    exited = false;
    let onMessage!: (packet: unknown) => void;
    let onError!: (error: Error) => void;
    let onDisconnect!: () => void;
    let onExit!: (code: number | null, signal: string | null) => void;
    let readySettled = false;
    const ipcReady = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('disconnect', onDisconnect);
        child.off('exit', onExit);
      };
      const settle = (error?: Error) => {
        if (readySettled) return;
        readySettled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      onMessage = (packet) => {
        if (isOutcomeWorkerReadyMessage(packet)) settle();
      };
      onError = (error) => settle(error);
      onDisconnect = () => settle(new Error(`Worker IPC disconnected before ready: ${observation.workerOutput}`));
      onExit = (code, signal) =>
        settle(
          new Error(`Worker exited before IPC ready: ${JSON.stringify({ code, signal })}: ${observation.workerOutput}`),
        );
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('disconnect', onDisconnect);
      child.once('exit', onExit);
    });
    void ipcReady.catch(() => {});
    const output = (chunk: unknown) => {
      observation.workerOutput = (observation.workerOutput + String(chunk)).slice(-65_536);
    };
    child.stdout!.on('data', output);
    child.stderr!.on('data', output);
    workerExit = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        exited = true;
        resolve({ code, signal });
      }),
    );
    workerRpc = createOutcomeRpc(
      {
        send: (packet) =>
          new Promise<void>((resolve, reject) =>
            child.send(packet as object, (error) => (error ? reject(error) : resolve())),
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
          child.on('message', message);
          child.on('error', failure);
          child.on('disconnect', disconnect);
          child.on('exit', exit);
          return () => {
            child.off('message', message);
            child.off('error', failure);
            child.off('disconnect', disconnect);
            child.off('exit', exit);
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
    if (!child.pid) throw new Error('Worker has no process identity');
    await own({ kind: 'worker_process', pid: child.pid });
    await ipcReady;
    const stats = await workerRpc.request<WorkerStats>('init', { env });
    observation.workerStats = stats;
    return stats;
  }
  let beforeClosing: Promise<void> | undefined;
  function beforeClose() {
    return (beforeClosing ??= (async () => {
      await attempt(async () => releasedBook?.close());
      await attempt(() => phase('worker', stopWorker));
      // Never release bindings or pools while a process could still be accessing them.
      if (worker && !exited) throw new Error('Worker exit was not confirmed');
      await attempt(async () => publicFilters?.close());
      await attempt(async () => (await preparationClient)?.close());
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
            for (const name of [
              SEARCH_TEMPLATE,
              HIT_TEMPLATE,
              SUGGEST_TEMPLATE,
              'subjects-suggest-v2',
              FACET_TEMPLATE,
            ]) {
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
  function close(admittedControlFailed = false) {
    sealed = true;
    // The caller drains its admitted RPCs before close; their replies can already have
    // left operations here. Preserve that failure in the owned process exit status.
    if (admittedControlFailed) process.exitCode = 1;
    return (closing ??= (async () => {
      await starting?.catch(() => {}); // init preserves and reports its own original error.
      const admitted = await Promise.allSettled([...operations]);
      for (const result of admitted) if (result.status === 'rejected') failures.push(result.reason);
      try {
        return await dispose();
      } catch (error) {
        process.exitCode = 1;
        throw error;
      }
    })());
  }
  async function init(endpoint: string, advancedSearch: boolean): Promise<SupervisorReady> {
    try {
      await own({ kind: 'index_prefix', name: prefix });
      proxy = await searchProxy(endpoint);
      observation.proxyUrl = proxy.url;
      const client = createOpenSearch(proxy.url);
      semantic = await createSemanticDriver(
        (config) => {
          if (!config.tokens) throw new Error('Semantic fixtures did not supply session keys');
          const ports = searchPorts();
          const { source, ratings } = createRatedSubjectSource(config.pool, config.routeKey, undefined, ports);
          return createKernel({
            ...config,
            onAccessReady(access, viewerActions) {
              config.onAccessReady?.(access, viewerActions);
              const keys = createSubjectSourceKeyPages(config.pool, config.routeKey, access);
              nativeCoverage = async () => {
                const generation = (await subjectGenerations(client, prefix)).active!;
                return assertNativeGenerationCoverage({
                  pool: config.pool,
                  search: client,
                  index: subjectIndexName(prefix, generation),
                  source,
                  keys,
                });
              };
              publicFilters = createDefaultPublicFilterRuntime({
                pool: config.pool,
                routeKey: config.routeKey,
                access,
                search: client,
                prefix,
                clock: config.clock ?? systemClock,
              });
            },
            search: createSearchService({
              pool: config.pool,
              client,
              prefix,
              source,
              ratings,
              cursors: config.tokens,
              clock: config.clock ?? systemClock,
              publicFilters: () => {
                if (!publicFilters) throw new Error('Default public Search has not composed Access');
                return publicFilters;
              },
              async preparePublic(job) {
                preparationClient ??= createWorkClient(semantic!.fixtures.runtime.databaseUrl, config.pool);
                await createPublicPreparationStore(config.pool, await preparationClient, prefix).retain(
                  { kind: 'repair', key: JSON.stringify(job), job },
                  Date.now() + 24 * 60 * 60 * 1000,
                );
              },
            }),
          });
        },
        { linkProjection: 'external', strictCleanup: true, onOwnedResource: own, beforeClose },
      );
      const fixtures = semantic.fixtures;
      await fixtures.openFeatures(advancedSearch ? ['search', 'search_advanced'] : ['search']);
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
      workerEnvironment = env;
      const workerStats = await launchWorker(env);
      ready = true;
      return { globalContext: semantic.globalContext, indexPrefix: prefix, workerStats };
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
    if (method === 'importReleasedBook') {
      releasedBook ??= createReleasedBookImport(semantic!);
      return releasedBook.import(params);
    }
    if (method === 'nativeVoter') {
      exact(params, ['name']);
      if (
        typeof params.name !== 'string' ||
        !/^[a-z][a-z0-9_]{0,47}$/.test(params.name) ||
        ['anonymous', 'editor', 'acceptor', 'steward', 'suspended', 'governor', 'search_operator'].includes(params.name)
      )
        throw new Error('Invalid native voter name');
      const existing = votersByName.get(params.name);
      if (existing) return existing;
      // Reserve before provisioning; no token or caller-supplied owner crosses IPC.
      const name = params.name;
      const pending = Promise.resolve().then(async () => {
        const fixtures = semantic!.fixtures;
        const account = await fixtures.person(`nv_${randomBytes(8).toString('hex')}`, {
          scopes: ['rating:vote', 'subject:read'],
        });
        // Own votes use the authenticated account and rating:vote scope without an account grant.
        const voter = randomUUID();
        voters.set(voter, { account });
        return { voter, accountId: account.accountId };
      });
      votersByName.set(name, pending);
      return pending;
    }
    if (method === 'nativeVote') {
      exact(params, ['voter', 'targetId', 'units', 'options']);
      const entry = typeof params.voter === 'string' ? voters.get(params.voter) : undefined;
      if (!entry) throw new Error('Unknown native voter');
      if (
        typeof params.targetId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.targetId) ||
        routeOf(params.targetId) === null ||
        (params.units !== null &&
          (typeof params.units !== 'number' ||
            !Number.isInteger(params.units) ||
            params.units < 0 ||
            params.units > 20))
      )
        throw new Error('Invalid native vote');
      let key = randomUUID() as string;
      if (params.options !== undefined) {
        if (
          !record(params.options) ||
          Object.keys(params.options).length !== 1 ||
          typeof params.options.idempotencyKey !== 'string' ||
          !/^[A-Za-z0-9_-]{1,255}$/.test(params.options.idempotencyKey)
        )
          throw new Error('Invalid native vote options');
        key = params.options.idempotencyKey;
      }
      const response = await semantic!.fixtures.send(
        entry.account,
        params.units === null ? 'DELETE' : 'PUT',
        `/v1/subjects/${params.targetId}/ratings/${STANDARD_QUESTION_ID}/vote`,
        params.units === null ? undefined : { units: params.units },
        { 'Idempotency-Key': `"${key}"`, ...(entry.session ? { 'rezics-session-token': entry.session } : {}) },
      );
      const session = response.headers.get('rezics-session-token');
      if (session) entry.session = session;
      const headers: [string, string][] = [];
      for (const [key, value] of response.headers) if (key.toLowerCase() !== 'set-cookie') headers.push([key, value]);
      for (const value of response.headers.getSetCookie()) headers.push(['set-cookie', value]);
      return { status: response.status, body: response.body, headers } satisfies WireResponse;
    }
    if (method === 'request') {
      exact(params, ['persona', 'method', 'path', 'body', 'headers']);
      const personas: string[] = ['anonymous', 'editor', 'acceptor', 'steward', 'suspended'];
      if (
        typeof params.persona !== 'string' ||
        !personas.includes(params.persona) ||
        typeof params.method !== 'string' ||
        !['GET', 'POST', 'PUT', 'PATCH'].includes(params.method) ||
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
        params.method as 'GET' | 'POST' | 'PUT' | 'PATCH',
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
    if (method === 'nativeCoverage') return nativeCoverage!();
    if (method === 'requestRebuild') return workerRpc!.request('requestRebuild');
    if (method === 'restartWorker') {
      await stopWorker();
      stoppingWorker = undefined;
      await launchWorker(workerEnvironment!);
      return snapshot();
    }
    if (method === 'loseActivationResponse') {
      proxy!.loseAliasResponse(`${prefix}subjects`);
      return null;
    }
    if (method === 'rebuild') return workerRpc!.request('rebuild', undefined, 300_000);
    observation.lostAliasResponses = proxy!.lostAliasResponses();
    observation.workerStats = await workerRpc!.request<WorkerStats>('stats');
    return snapshot();
  }
  return {
    close,
    control(method: string, params: unknown): unknown {
      if (method === 'close') {
        if (params !== undefined) {
          exact(params, ['admittedControlFailed']);
          if (params.admittedControlFailed !== true) throw new Error('Invalid close parameters');
        }
        return close(params !== undefined);
      }
      if (sealed) throw new Error('Search supervisor is closing');
      if (method === 'init') {
        exact(params, ['endpoint', 'advancedSearch']);
        if (typeof params.endpoint !== 'string') throw new Error('init requires endpoint');
        if (params.advancedSearch !== undefined && typeof params.advancedSearch !== 'boolean')
          throw new Error('advancedSearch must be a boolean');
        const endpoint = new URL(params.endpoint);
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
          throw new Error('Invalid OpenSearch endpoint');
        if (initialized) throw new Error('Search supervisor init already attempted');
        initialized = true;
        return (starting = init(endpoint.href, params.advancedSearch === true));
      }
      if (
        ![
          'request',
          'remove',
          'indexing',
          'searchNode',
          'rebuild',
          'requestRebuild',
          'restartWorker',
          'loseActivationResponse',
          'nativeCoverage',
          'inspect',
          'nativeVoter',
          'nativeVote',
          'importReleasedBook',
        ].includes(method)
      )
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
