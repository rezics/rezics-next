import { readWorkerConfig, startWorker, type WorkerConfig } from '../../../src/worker.ts';
import type { WorkContext, WorkModule } from '../../../src/work/registry.ts';
import { rebuildSubjects, RebuildError } from '../../../src/search/generations.ts';
import { createOpenSearch } from '../../../src/search/opensearch.ts';
import { readSearchConfig } from '../../../src/search/work.ts';
import { createRatedSubjectSource } from '../../../src/search/rated-source.ts';
import { readMembershipRouteKey } from '../../../src/access/membership-work-config.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createOutcomeRpc, createOutcomeWorkerClock, OUTCOME_WORKER_READY_MESSAGE } from './outcome-rpc.ts';
import { createSearchRunnerSlot } from './runner-slot.ts';

/** Observations only: no credentials, source answers or inferred starter execution. */
export interface WorkerStats {
  defaultModules: string[];
  registeredModules: string[];
  registrationCounts: Record<string, number>;
  startedServices: Record<string, number>;
  searchStarterInvocations: number;
  stopped: boolean;
  /** Sampled from the actual WorkerConfig.clock; never readiness or Source lag evidence. */
  clockInstant: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function noParams(params: unknown) {
  if (params !== undefined) throw new Error('This control takes no parameters');
}

function phase(name: string) {
  process.stderr.write(`outcome-worker phase=${name}\n`);
}

function initEnv(params: unknown): {
  env: Record<string, string | undefined>;
  searchDisabled: boolean;
} {
  if (
    !record(params) ||
    Object.keys(params).some((key) => key !== 'env' && key !== 'clock' && key !== 'searchDisabled') ||
    !record(params.env) ||
    ('searchDisabled' in params && typeof params.searchDisabled !== 'boolean')
  ) {
    throw new Error('init requires {env}, optional private clock state and optional Search-disabled mode');
  }
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params.env)) {
    if (typeof value !== 'string' && value !== undefined) throw new Error('env values must be strings');
    env[key] = value;
  }
  return {
    env: { ...process.env, ...workerTestEnv(env) },
    searchDisabled: params.searchDisabled === true,
  };
}

/** One production SDK composition, shared by the child and explicit pool instrumentation. */
export function createOutcomeWorker(overrides: Pick<WorkerConfig, 'kernelPool' | 'clock'> = {}) {
  const workerClock = createOutcomeWorkerClock(overrides.clock);
  const slot = createSearchRunnerSlot();
  const observations: Omit<WorkerStats, 'clockInstant'> = {
    defaultModules: [],
    registeredModules: [],
    registrationCounts: {},
    startedServices: {},
    searchStarterInvocations: 0,
    stopped: false,
  };
  const stats = (): WorkerStats => ({ ...structuredClone(observations), clockInstant: workerClock.clock().getTime() });
  let initialized = false;
  let ready = false;
  let closing = false;
  let starting: Promise<WorkerStats> | undefined;
  let stopping: Promise<WorkerStats> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let searchContext: WorkContext | undefined;
  let searchServices = 0;
  let tail = Promise.resolve();

  function close(): Promise<WorkerStats> {
    closing = true; // Seal admission before awaiting any in-flight initialization or controls.
    return (stopping ??= (async () => {
      // Seal and drain Search immediately. Init may still be waiting for the actual worker to
      // finish registration; queuing this behind init prevents the owner from cancelling it.
      const failures: unknown[] = [];
      try {
        await slot.stop();
      } catch (error) {
        failures.push(error);
      }
      await starting?.catch(() => {});
      if (worker) {
        try {
          await worker.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      observations.stopped = true;
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Outcome worker shutdown failed');
      return stats();
    })());
  }

  async function init(env: Record<string, string | undefined>, searchDisabled: boolean): Promise<WorkerStats> {
    try {
      phase('startWorker:start');
      worker = await startWorker(
        { ...readWorkerConfig(env), ...overrides, clock: workerClock.clock },
        (composed) => {
          observations.defaultModules = composed.map(({ name }) => name);
          return composed.map((module): WorkModule => {
            return {
              name: module.name,
              async register(context) {
                phase(`register:start module=${module.name}`);
                observations.registeredModules.push(module.name);
                observations.registrationCounts[module.name] = (observations.registrationCounts[module.name] ?? 0) + 1;
                observations.startedServices[module.name] = 0;
                let serviceOrdinal = 0;
                // Only addService is decorated. Pool, queues, client, env, effects and clock retain their identities.
                await module.register({
                  ...context,
                  addService(original) {
                    // Search also owns retention/erasure services. Adopt only the actual
                    // runner returned by its post-launch starter, retaining every service.
                    const isRunner = (service: Awaited<ReturnType<typeof original>>) =>
                      module.name === 'search' && 'refresh' in service && typeof service.refresh === 'function';
                    const start = async () => {
                      const ordinal = ++serviceOrdinal;
                      phase(`service:start module=${module.name} service=${ordinal}`);
                      const service = await original();
                      observations.startedServices[module.name] = (observations.startedServices[module.name] ?? 0) + 1;
                      if (isRunner(service)) observations.searchStarterInvocations += 1;
                      phase(`service:ready module=${module.name} service=${ordinal}`);
                      return service;
                    };
                    context.addService(async () => {
                      const service = await start();
                      if (!isRunner(service)) return service;
                      searchServices += 1;
                      if (searchServices !== 1) {
                        await service.stop();
                        throw new Error('Default search must start exactly one runner');
                      }
                      searchContext = context;
                      return slot.adopt(service, start);
                    });
                  },
                });
                phase(`register:ready module=${module.name}`);
              },
            };
          });
        },
        env,
      );
      const searchModeReady = searchDisabled
        ? searchServices === 0 && observations.searchStarterInvocations === 0
        : searchServices === 1 && observations.searchStarterInvocations === 1;
      if (
        !searchModeReady ||
        !observations.defaultModules.includes('semantic') ||
        !(observations.startedServices.semantic! > 0)
      ) {
        throw new Error(
          'Integrated default worker must register the selected Search mode and real default semantic services',
        );
      }
      phase('startWorker:ready');
      ready = true;
      return stats();
    } catch (error) {
      // Missing integrated composition is a failed init, never a readiness reply.
      try {
        if (worker) await worker.stop();
        else await slot.stop();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Outcome worker initialization and cleanup failed');
      }
      throw error;
    }
  }

  function control(method: string, params: unknown): unknown | Promise<unknown> {
    if (closing) throw new Error('Outcome worker is closing');
    if (!['init', 'indexing', 'rebuild', 'requestRebuild', 'stats', 'clock', 'close'].includes(method))
      throw new Error(`Unknown control: ${method}`);
    if (method === 'init') {
      const options = initEnv(params);
      if (initialized) throw new Error('Outcome worker init already attempted');
      if (record(params) && 'clock' in params) workerClock.initialize(params.clock);
      initialized = true;
      return (starting = init(options.env, options.searchDisabled));
    }
    if (method === 'close') {
      noParams(params);
      return close();
    }
    if (!ready) throw new Error('Outcome worker is not initialized');
    if (method === 'clock') return workerClock.change(params);
    if (method === 'indexing') {
      if (
        !record(params) ||
        Object.keys(params).length !== 1 ||
        (params.state !== 'paused' && params.state !== 'running')
      ) {
        throw new Error('indexing requires state paused or running');
      }
      return (params.state === 'paused' ? slot.pause() : slot.resume()).then(stats);
    }
    noParams(params);
    if (method === 'stats') return stats();
    return slot.withRunner(async (runner) => {
      const context = searchContext!;
      const config = readSearchConfig(context.env);
      if (!config) throw new Error('Default search configuration is missing');
      const routeKey = readMembershipRouteKey(context.env);
      const rebuilding = rebuildSubjects({
        publication: 'native',
        ...(method === 'requestRebuild' ? { timeoutMs: 0 } : {}),
        pool: context.pool,
        search: createOpenSearch(config.url),
        prefix: config.prefix,
        source: createRatedSubjectSource(context.pool, routeKey).source,
        runner,
      });
      if (method === 'requestRebuild') {
        try {
          const result = await rebuilding;
          return { generation: result.generation };
        } catch (error) {
          // The ordinary CLI timed out after allocation/refresh; maintenance retains its work.
          if (error instanceof RebuildError && error.reason === 'timeout') return { generation: error.generation };
          throw error;
        }
      }
      return rebuilding;
    });
  }

  return {
    close,
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      // Shutdown is an out-of-band control: it seals Search even if init has not settled.
      if (method === 'close') {
        noParams(params);
        return close() as Promise<T>;
      }
      // Admit init before a concurrently delivered close can overtake its queue microtask.
      let pending: Promise<unknown>;
      if (method === 'init') {
        try {
          pending = Promise.resolve(control(method, params));
        } catch (error) {
          pending = Promise.reject(error);
        }
      } else {
        pending = tail.then(() => control(method, params));
      }
      tail = pending.then(
        () => {},
        () => {},
      );
      return pending as Promise<T>;
    },
  };
}

// This executable owns one SDK for its entire lifetime. It never provisions Auth.
if (import.meta.main) {
  if (!process.send) throw new Error('Outcome worker requires a private IPC channel');
  phase('child:entry');
  const worker = createOutcomeWorker();
  // Install loss/failure handling before accepting init, including disconnect during startup.
  const lost = () => {
    void worker.close().catch((error) => {
      console.error('Outcome worker shutdown failed', error);
      process.exitCode = 1;
    });
  };
  process.on('disconnect', lost);
  process.on('error', lost);
  createOutcomeRpc(
    {
      send(packet) {
        return new Promise<void>((resolve, reject) => {
          process.send!(packet as object, (error: Error | null) => (error ? reject(error) : resolve()));
        });
      },
      subscribe(message, failure) {
        const disconnect = () => failure(new Error('Outcome parent disconnected'));
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
    { onRequest: (method, params) => worker.request(method, params) },
  );
  phase('child:ipc-ready');
  process.send!({ type: OUTCOME_WORKER_READY_MESSAGE }, (error: Error | null) => {
    if (error) {
      console.error('Outcome worker could not announce IPC readiness');
      process.exitCode = 1;
    }
  });
  // The parent disconnects only after receiving the completed close reply; natural exit proves drain.
}
