import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { SearchDriver } from '../../../../../specs/search-driver.ts';
import { createOutcomeRpc } from './outcome-rpc.ts';
import type { OwnedResource, SupervisorObservation, SupervisorReady, WireResponse } from './outcome-supervisor.ts';

const STARTUP_MS = 180_000;
const OPERATION_MS = 180_000;
const REBUILD_MS = 300_000;
const CLOSE_MS = 180_000;
const EXIT_MS = 30_000;
const OUTPUT_BYTES = 65_536;

export interface DriverLedger {
  supervisorPid: number;
  resources: OwnedResource[];
  exited: boolean;
  exit?: { code: number | null; signal: string | null };
  stdout: string;
  stderr: string;
  cleanup?: SupervisorObservation;
}
export interface DriverClient {
  init(): Promise<SearchDriver>;
  inspect(): Promise<SupervisorObservation>;
  ledger(): DriverLedger;
  close(): Promise<void>;
}

async function bounded<T>(promise: Promise<T>, ms: number, detail: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(detail())), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Linux process identity includes start time, so an unrelated reused PID is never signalled. */
function identity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return undefined;
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
}

function ownedResource(value: unknown): OwnedResource {
  if (!value || typeof value !== 'object') throw new Error('Invalid owned resource');
  const resource = value as Record<string, unknown>;
  if (
    resource.kind === 'worker_process' &&
    Object.keys(resource).length === 2 &&
    Number.isSafeInteger(resource.pid) &&
    Number(resource.pid) > 0 &&
    resource.pid !== process.pid
  ) {
    return { kind: 'worker_process', pid: Number(resource.pid) };
  }
  if (
    ['kernel_database', 'auth_database', 'index_prefix'].includes(String(resource.kind)) &&
    Object.keys(resource).length === 2 &&
    typeof resource.name === 'string' &&
    /^[a-z][a-z0-9_-]+$/.test(resource.name)
  ) {
    return { kind: resource.kind, name: resource.name } as OwnedResource;
  }
  throw new Error('Invalid owned resource identity');
}

/** Private per-factory transport. No runtime-owning module is imported into this process. */
export function createDriverClient(endpoint = process.env.OPENSEARCH_URL): DriverClient {
  if (!endpoint) throw new Error('OPENSEARCH_URL must name the real test node');
  const actualEndpoint = endpoint;
  const child = fork(`${import.meta.dir}/outcome-supervisor.ts`, [], {
    execPath: process.execPath,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ledger: DriverLedger = { supervisorPid: child.pid ?? 0, resources: [], exited: false, stdout: '', stderr: '' };
  const descendants = new Map<number, string>();
  const supervisorIdentity = child.pid ? identity(child.pid) : undefined;
  let trackingError: unknown;
  function track(pid: number) {
    const start = identity(pid);
    if (!start) return;
    if (!descendants.has(pid) && descendants.size >= 256) throw new Error('Owned descendant ledger overflow');
    descendants.set(pid, start);
    let children: string;
    try {
      children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
    } catch (error) {
      if (!identity(pid)) return;
      throw error;
    }
    for (const entry of children.trim().split(/\s+/).filter(Boolean)) track(Number(entry));
  }
  const tracking = setInterval(() => {
    try {
      if (child.pid && identity(child.pid) === supervisorIdentity) track(child.pid);
    } catch (error) {
      trackingError = error;
    }
  }, 100);
  const diagnostics = () => JSON.stringify({ ...ledger, resources: ledger.resources });
  const outputErrors: unknown[] = [];
  for (const [stream, key] of [
    [child.stdout!, 'stdout'],
    [child.stderr!, 'stderr'],
  ] as const) {
    stream.on('data', (chunk) => {
      ledger[key] = (ledger[key] + String(chunk)).slice(-OUTPUT_BYTES);
    });
    stream.on('error', (error) => outputErrors.push(error));
  }
  const exit = new Promise<void>((resolve) =>
    child.once('close', (code, signal) => {
      ledger.exited = true;
      ledger.exit = { code, signal };
      clearInterval(tracking);
      resolve(); // Node's close event includes both output streams reaching EOF.
    }),
  );
  let sealed = false;
  let initializing: Promise<SearchDriver> | undefined;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const rpc = createOutcomeRpc(
    {
      send(packet) {
        return new Promise<void>((resolve, reject) => {
          child.send(packet as object, (error) => (error ? reject(error) : resolve()));
        });
      },
      subscribe(message, failure) {
        const disconnected = () => failure(new Error(`Search supervisor disconnected: ${diagnostics()}`));
        const exited = (code: number | null, signal: string | null) =>
          failure(new Error(`Search supervisor exited (${code}, ${signal}): ${diagnostics()}`));
        const errored = (error: Error) =>
          failure(new Error(`Search supervisor process failed: ${diagnostics()}`, { cause: error }));
        child.on('message', message);
        child.on('disconnect', disconnected);
        child.on('exit', exited);
        child.on('error', errored);
        return () => {
          child.off('message', message);
          child.off('disconnect', disconnected);
          child.off('exit', exited);
          child.off('error', errored);
        };
      },
    },
    {
      timeoutMs: OPERATION_MS,
      onRequest(method, params) {
        if (method !== 'owned-resource') throw new Error(`Unexpected supervisor request: ${method}`);
        const resource = ownedResource(params);
        if (ledger.resources.length >= 16) throw new Error('Owned resource ledger overflow');
        ledger.resources.push(resource); // Record before the RPC peer can send an ownership ACK.
        if (resource.kind === 'worker_process') {
          try {
            track(resource.pid);
          } catch (error) {
            trackingError = error;
            throw error;
          }
        }
        return { acknowledged: true };
      },
    },
  );

  function admit<T>(method: string, params?: unknown, timeout = OPERATION_MS): Promise<T> {
    if (sealed) return Promise.reject(new Error('Search driver is closing'));
    const operation = rpc.request<T>(method, params, timeout);
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  }

  async function descendantsExited() {
    const deadline = performance.now() + EXIT_MS;
    while ([...descendants].some(([pid, start]) => identity(pid) === start)) {
      if (performance.now() >= deadline) throw new Error(`Owned descendants did not exit: ${diagnostics()}`);
      await Bun.sleep(50);
    }
  }

  async function fallback() {
    // The supervisor may have failed between creation ACK and disposal. Only this exact ledger is eligible.
    if (!ledger.exited) throw new Error('Cannot clean resources before confirmed supervisor exit');
    if (trackingError) throw trackingError;
    await descendantsExited();
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    const databases = ledger.resources.filter(
      (resource): resource is Extract<OwnedResource, { kind: 'kernel_database' | 'auth_database' }> =>
        resource.kind === 'kernel_database' || resource.kind === 'auth_database',
    );
    if (databases.length)
      await attempt(async () => {
        const { Pool } = await import('pg');
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 10_000,
          query_timeout: 10_000,
        });
        try {
          for (const resource of databases)
            await attempt(() => pool.query(`DROP DATABASE IF EXISTS "${resource.name}" WITH (FORCE)`));
        } finally {
          await pool.end();
        }
      });
    for (const resource of ledger.resources)
      if (resource.kind === 'index_prefix')
        await attempt(async () => {
          const { createOpenSearch } = await import('../../../src/search/opensearch.ts');
          const { SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } = await import('../../../src/search/query.ts');
          const search = createOpenSearch(actualEndpoint);
          const result = await search.request<{ indices: { name: string }[] }>(
            'GET',
            `/_resolve/index/${resource.name}*`,
            undefined,
            { query: { expand_wildcards: 'all' } },
          );
          for (const index of result.body.indices) {
            if (!index.name.startsWith(resource.name)) throw new Error('Fallback index escaped acknowledged prefix');
            await attempt(() => search.request('DELETE', `/${encodeURIComponent(index.name)}`));
          }
          for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
            await attempt(async () => {
              try {
                await search.request('DELETE', `/_scripts/${resource.name}${name}`);
              } catch (error) {
                if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
              }
            });
        });
    if (failures.length) throw new AggregateError(failures, 'Exact owned resource fallback cleanup failed');
  }

  function close(): Promise<void> {
    sealed = true;
    return (closing ??= (async () => {
      const failures: unknown[] = [];
      const admitted = await Promise.allSettled([...operations]);
      for (const result of admitted) if (result.status === 'rejected') failures.push(result.reason);
      try {
        ledger.cleanup = await rpc.request<SupervisorObservation>('close', undefined, CLOSE_MS);
      } catch (error) {
        failures.push(error);
      }
      try {
        if (child.connected) child.disconnect();
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(exit, EXIT_MS, () => `Search supervisor did not exit after cleanup: ${diagnostics()}`);
      } catch (error) {
        failures.push(error);
        // Forced termination is always an error; first stop only descendants whose identities we recorded.
        try {
          if (child.pid && identity(child.pid) === supervisorIdentity) track(child.pid);
          for (const resource of ledger.resources)
            if (
              resource.kind === 'worker_process' &&
              descendants.get(resource.pid) === identity(resource.pid) &&
              identity(resource.pid)
            )
              process.kill(resource.pid, 'SIGKILL');
          if (child.pid && identity(child.pid) === supervisorIdentity) child.kill('SIGKILL');
          await bounded(exit, EXIT_MS, () => `Forced supervisor exit unconfirmed: ${diagnostics()}`);
        } catch (forced) {
          failures.push(forced);
        }
      }
      rpc.close();
      clearInterval(tracking);
      if (ledger.exit?.code !== 0 || ledger.exit?.signal !== null)
        failures.push(new Error(`Search supervisor failed to drain: ${diagnostics()}`));
      failures.push(...outputErrors);
      if (failures.length) {
        try {
          await fallback();
        } catch (error) {
          failures.push(error);
        }
        throw new AggregateError(failures, `Search driver cleanup failed: ${diagnostics()}`);
      }
    })());
  }

  return {
    close,
    ledger: () => structuredClone(ledger),
    inspect: () => admit<SupervisorObservation>('inspect'),
    init() {
      return (initializing ??= (async () => {
        try {
          const ready = await admit<SupervisorReady>('init', { endpoint: actualEndpoint }, STARTUP_MS);
          return {
            globalContext: ready.globalContext,
            async request(persona, method, path, body, headers) {
              const response = await admit<WireResponse>('request', { persona, method, path, body, headers });
              const actual = new Headers();
              for (const [key, value] of response.headers) actual.append(key, value);
              return { status: response.status, body: response.body, headers: actual };
            },
            async remove(subjectId, mode) {
              await admit('remove', { subjectId, mode });
            },
            async indexing(state) {
              await admit('indexing', { state });
            },
            async searchNode(state) {
              await admit('searchNode', { state });
            },
            rebuild: () => admit('rebuild', undefined, REBUILD_MS),
            close,
          } satisfies SearchDriver;
        } catch (error) {
          try {
            await close();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'Search driver initialization and cleanup failed', {
              cause: error,
            });
          }
          throw error;
        }
      })());
    },
  };
}
