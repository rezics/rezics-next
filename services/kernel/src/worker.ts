import { composeRatingDependencies } from './composition/rating.ts';
import { initializeEventTypes } from './events/catalogue.ts';
import pg from 'pg';
import type { KernelClock } from './clock.ts';
import { ConfigError } from './commerce/config.ts';
import { createWorkClient } from './work/client.ts';
import { bindExecutionContract } from './command/execution-contract.ts';
import { historyExecutionPort } from './history/application/index.ts';
import { workExecutionPort } from './work/selected-runtime.ts';
import { createDiscoveryProducerEntry } from './composition/discovery.ts';
import { createKernelCreditSearchSource, createKernelRuntimeDefaults } from './composition/runtime-defaults.ts';
import { composeSemanticDomain } from './composition/semantic.ts';
import { composeAccessApplication } from './composition/access.ts';
import { composeWorkApplication } from './composition/work.ts';
import { composeCommunityApplication } from './composition/community.ts';
import { installNativeHistory } from './composition/history.ts';
import { startContentApplication } from './composition/content.ts';
import { composeLibraryDomain } from './composition/library.ts';
import { createKernelWorkModules } from './composition/work-modules.ts';
import { installIdentityRatingRepairProducer } from './composition/identity-rating-repair.ts';
import { composeWork, type WorkModule } from './work/registry.ts';
import { effectsRelay } from './events/effects.ts';
import { relayConcurrencyForPool, startRelays } from './events/relays.ts';
import { configureReceiptKeys, readReceiptKeyRing } from './command/receipt-key.ts';
import type { KeyRing } from './tokens/seal.ts';

/** Report each owned drain boundary without changing its failure or settlement order. */
function shutdownPhase(phase: string) {
  const startedAt = performance.now();
  const emit = (state: string) =>
    console.error(
      `worker: startup ${JSON.stringify({ phase, state, utc: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt) })}`,
    );
  return {
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      emit('starting');
      try {
        const result = await operation();
        emit('ready');
        return result;
      } catch (error) {
        emit('failed');
        throw error;
      }
    },
    runSync<T>(operation: () => T): T {
      emit('starting');
      try {
        const result = operation();
        emit('ready');
        return result;
      } catch (error) {
        emit('failed');
        throw error;
      }
    },
  };
}

export type WorkerConfig = {
  databaseUrl: string;
  executorId?: string;
  poolSize: number;
  receiptKeys?: KeyRing;
  /** Trusted service composition only; never read from the environment. */
  clock?: KernelClock;
  /** Trusted composition only. The worker owns and ends the returned runtime pool. */
  kernelPool?: (url: string) => pg.Pool | Promise<pg.Pool>;
};

export function readWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const receiptKeys = readReceiptKeyRing(env);
  const databaseUrl = env.DATABASE_URL;
  try {
    const url = new URL(databaseUrl ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error();
    }
  } catch {
    throw new ConfigError('DATABASE_URL');
  }
  const size = env.KERNEL_WORKER_POOL_SIZE ?? '10';
  // The SDK retains LISTEN and a background-job lock while its jobs need a third checkout.
  if (!/^\d+$/.test(size) || Number(size) < 3 || Number(size) > 100) {
    throw new ConfigError('KERNEL_WORKER_POOL_SIZE');
  }
  let executorId = env.KERNEL_EXECUTOR_ID;
  if (executorId !== undefined) {
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(executorId)) throw new ConfigError('KERNEL_EXECUTOR_ID');
  } else if (env.NOMAD_JOB_NAME !== undefined || env.NOMAD_ALLOC_INDEX !== undefined) {
    if (env.NOMAD_JOB_NAME !== undefined && !/^[A-Za-z0-9_.-]{1,200}$/.test(env.NOMAD_JOB_NAME)) {
      throw new ConfigError('NOMAD_JOB_NAME');
    }
    if (env.NOMAD_ALLOC_INDEX !== undefined && !/^\d{1,10}$/.test(env.NOMAD_ALLOC_INDEX)) {
      throw new ConfigError('NOMAD_ALLOC_INDEX');
    }
    if (env.NOMAD_JOB_NAME === undefined) throw new ConfigError('NOMAD_JOB_NAME');
    if (env.NOMAD_ALLOC_INDEX === undefined) throw new ConfigError('NOMAD_ALLOC_INDEX');
    executorId = `${env.NOMAD_JOB_NAME}-${env.NOMAD_ALLOC_INDEX}`;
  }
  return {
    databaseUrl: databaseUrl!,
    poolSize: Number(size),
    ...(receiptKeys === undefined ? {} : { receiptKeys }),
    ...(executorId === undefined ? {} : { executorId }),
  };
}

/** Default worker registrations. Isolated tests may pass a substitute list; Library and Search
 * outcome children decorate this live list instead of importing a second composition. */
export type KernelWorkModuleDecorator = (modules: readonly WorkModule[]) => readonly WorkModule[];

export async function startWorker(
  config: WorkerConfig,
  modules?: readonly WorkModule[] | KernelWorkModuleDecorator,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  composeRatingDependencies();
  composeAccessApplication();
  composeWorkApplication();
  const community = composeCommunityApplication();
  installNativeHistory();
  installIdentityRatingRepairProducer();
  const content = startContentApplication(config.clock ? { clock: config.clock } : undefined);
  const composed = () =>
    createKernelWorkModules(
      createDiscoveryProducerEntry,
      createKernelRuntimeDefaults,
      composeSemanticDomain,
      {
        fetch: content.application.ambient.fetch,
        now: content.application.ambient.now,
        id: content.application.ambient.id,
      },
      createKernelCreditSearchSource,
      community.ambient,
    );
  const receiptKeys = readReceiptKeyRing(env, config.receiptKeys);
  initializeEventTypes();
  let pool: pg.Pool;
  try {
    pool = config.kernelPool
      ? await config.kernelPool(config.databaseUrl)
      : new pg.Pool({ connectionString: config.databaseUrl, max: config.poolSize });
  } catch (error) {
    content.stop();
    throw error;
  }
  if (receiptKeys) configureReceiptKeys(pool, receiptKeys);
  pool.on('error', () => {});
  composeLibraryDomain({ pool });
  let client: Awaited<ReturnType<typeof createWorkClient>>;
  try {
    client = await createWorkClient(config.databaseUrl, pool);
    bindExecutionContract(client, workExecutionPort(), historyExecutionPort);
  } catch (error) {
    content.stop();
    await pool.end();
    throw error;
  }
  let resolvedModules: readonly WorkModule[];
  try {
    // Build the default list only after the worker pool/client are prepared. Its Search producer
    // supplier remains lazy until registration and is shared by the Semantic and Search modules.
    resolvedModules =
      modules === undefined ? composed() : typeof modules === 'function' ? modules(composed()) : modules;
  } catch (error) {
    try {
      await client.close();
    } finally {
      try {
        content.stop();
      } finally {
        await pool.end();
      }
    }
    throw error;
  }
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let relays: ReturnType<typeof startRelays> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    return (stopping ??= (async () => {
      try {
        // A signal during registration or launch drains the runtime once startup settles.
        await starting?.catch(() => {});
        try {
          await shutdownPhase('shutdown.relays').run(() => relays?.stop());
        } finally {
          if (work) await shutdownPhase('shutdown.work').run(() => work!.shutdown());
        }
      } finally {
        process.removeListener('SIGINT', signal);
        process.removeListener('SIGTERM', signal);
        try {
          await shutdownPhase('shutdown.client').run(() => client.close());
        } finally {
          try {
            shutdownPhase('shutdown.content').runSync(() => content.stop());
          } finally {
            await shutdownPhase('shutdown.pool').run(() => pool.end());
          }
        }
      }
    })());
  };
  const signal = () => {
    void stop().catch(() => {
      console.error('Worker shutdown failed');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    starting = (async () => {
      // Keep each native service's drain visible inside the runtime shutdown boundary.
      // The wrapper preserves registration order, service operands and reverse settlement.
      const tracedModules = resolvedModules.map((module): WorkModule => ({
        name: module.name,
        register(context) {
          let serviceIndex = 0;
          return module.register({
            ...context,
            addService(start) {
              const phase = `service.${module.name}.${serviceIndex++}.stop`;
              context.addService(async () => {
                const service = await start();
                return { ...service, stop: () => shutdownPhase(phase).run(() => service.stop()) };
              });
            },
          });
        },
      }));
      work = await composeWork(tracedModules, { ...config, pool, client, env });
      await work.launch();
      relays = startRelays(pool, [effectsRelay(pool, work.effects)], {
        concurrency: relayConcurrencyForPool(pool),
      });
    })();
    await starting;
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (import.meta.main) {
  try {
    await startWorker(readWorkerConfig(process.env));
    console.info('Worker ready');
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : 'Worker startup failed');
    process.exitCode = 1;
  }
}
