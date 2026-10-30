import { readWorkerConfig, startWorker } from '../../../src/worker.ts';
import { KERNEL_WORK_MODULES } from '../../../src/work/modules.ts';
import type { WorkContext, WorkModule } from '../../../src/work/registry.ts';
import { rebuildSubjects } from '../../../src/search/generations.ts';
import { createOpenSearch } from '../../../src/search/opensearch.ts';
import { readSearchConfig } from '../../../src/search/work.ts';
import { createRatedSubjectSource } from '../../../src/search/rated-source.ts';
import { readMembershipRouteKey } from '../../../src/access/membership-work-config.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createOutcomeRpc } from './outcome-rpc.ts';
import { createSearchRunnerSlot } from './runner-slot.ts';

/** Observations only: no credentials, source answers or inferred starter execution. */
export interface WorkerStats {
  defaultModules: string[];
  registeredModules: string[];
  registrationCounts: Record<string, number>;
  startedServices: Record<string, number>;
  searchStarterInvocations: number;
  stopped: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function noParams(params: unknown) {
  if (params !== undefined) throw new Error('This control takes no parameters');
}

function initEnv(params: unknown): Record<string, string | undefined> {
  if (!record(params) || Object.keys(params).length !== 1 || !record(params.env)) {
    throw new Error('init requires only {env}');
  }
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params.env)) {
    if (typeof value !== 'string' && value !== undefined) throw new Error('env values must be strings');
    env[key] = value;
  }
  return { ...process.env, ...workerTestEnv(env) };
}

// This executable owns one SDK for its entire lifetime. It never provisions Auth.
if (import.meta.main) {
  if (!process.send) throw new Error('Outcome worker requires a private IPC channel');
  const slot = createSearchRunnerSlot();
  const observations: WorkerStats = {
    defaultModules: KERNEL_WORK_MODULES.map(({ name }) => name),
    registeredModules: [],
    registrationCounts: {},
    startedServices: {},
    searchStarterInvocations: 0,
    stopped: false,
  };
  const stats = (): WorkerStats => structuredClone(observations);
  let initialized = false;
  let ready = false;
  let closing = false;
  let starting: Promise<WorkerStats> | undefined;
  let stopping: Promise<WorkerStats> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let searchContext: WorkContext | undefined;
  let searchServices = 0;

  function close(): Promise<WorkerStats> {
    closing = true; // Seal admission before awaiting any in-flight initialization or controls.
    return (stopping ??= (async () => {
      await starting?.catch(() => {});
      if (worker) await worker.stop();
      else await slot.stop();
      observations.stopped = true;
      return stats();
    })());
  }

  async function init(env: Record<string, string | undefined>): Promise<WorkerStats> {
    const defaults: WorkModule[] = KERNEL_WORK_MODULES.map((module) => ({
      name: module.name,
      async register(context) {
        observations.registeredModules.push(module.name);
        observations.registrationCounts[module.name] = (observations.registrationCounts[module.name] ?? 0) + 1;
        observations.startedServices[module.name] = 0;
        // Only addService is decorated. Pool, queues, client, env, effects and clock retain their identities.
        await module.register({
          ...context,
          addService(original) {
            if (module.name === 'search') {
              searchServices += 1;
              if (searchServices !== 1) throw new Error('Default search must register exactly one service');
              searchContext = context;
            }
            const start = async () => {
              const service = await original();
              observations.startedServices[module.name] = (observations.startedServices[module.name] ?? 0) + 1;
              if (module.name === 'search') observations.searchStarterInvocations += 1;
              return service;
            };
            context.addService(async () => {
              const service = await start();
              return module.name === 'search' ? slot.adopt(service, start) : service;
            });
          },
        });
      },
    }));
    try {
      worker = await startWorker(readWorkerConfig(env), defaults, env);
      if (
        searchServices !== 1 ||
        observations.searchStarterInvocations !== 1 ||
        !observations.defaultModules.includes('semantic') ||
        !(observations.startedServices.semantic! > 0)
      ) {
        throw new Error(
          'Integrated default worker must start exactly one search service and real default semantic services',
        );
      }
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
    if (!['init', 'indexing', 'rebuild', 'stats', 'close'].includes(method))
      throw new Error(`Unknown control: ${method}`);
    if (method === 'init') {
      const env = initEnv(params);
      if (initialized) throw new Error('Outcome worker init already attempted');
      initialized = true;
      return (starting = init(env));
    }
    if (method === 'close') {
      noParams(params);
      return close();
    }
    if (!ready) throw new Error('Outcome worker is not initialized');
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
      const { generation } = await rebuildSubjects({
        pool: context.pool,
        search: createOpenSearch(config.url),
        prefix: config.prefix,
        source: createRatedSubjectSource(context.pool, routeKey).source,
        runner,
      });
      return { generation };
    });
  }

  // Install loss/failure handling before accepting init, including disconnect during startup.
  const lost = () => {
    void close().catch((error) => {
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
    { onRequest: control },
  );
  // The parent disconnects only after receiving the completed close reply; natural exit proves drain.
}
