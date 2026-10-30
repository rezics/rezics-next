import pg from 'pg';
import type { KernelClock } from './clock.ts';
import { ConfigError } from './commerce/config.ts';
import { createWorkClient } from './work/client.ts';
import { KERNEL_WORK_MODULES } from './work/modules.ts';
import { composeWork, type WorkModule } from './work/registry.ts';
import { effectsRelay } from './events/effects.ts';
import { startRelays } from './events/relays.ts';

export type WorkerConfig = {
  databaseUrl: string;
  executorId?: string;
  poolSize: number;
  /** Trusted service composition only; never read from the environment. */
  clock?: KernelClock;
  /** Trusted composition only. The worker owns and ends the returned runtime pool. */
  kernelPool?: (url: string) => pg.Pool | Promise<pg.Pool>;
};

export function readWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
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
  if (!/^\d+$/.test(size) || Number(size) < 1 || Number(size) > 100) {
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
    ...(executorId === undefined ? {} : { executorId }),
  };
}

export async function startWorker(
  config: WorkerConfig,
  modules: readonly WorkModule[] = KERNEL_WORK_MODULES,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const pool = config.kernelPool
    ? await config.kernelPool(config.databaseUrl)
    : new pg.Pool({ connectionString: config.databaseUrl, max: config.poolSize });
  pool.on('error', () => {});
  let client: Awaited<ReturnType<typeof createWorkClient>>;
  try {
    client = await createWorkClient(config.databaseUrl, pool);
  } catch (error) {
    await pool.end();
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
          await relays?.stop();
        } finally {
          if (work) await work.shutdown();
        }
      } finally {
        process.removeListener('SIGINT', signal);
        process.removeListener('SIGTERM', signal);
        try {
          await client.close();
        } finally {
          await pool.end();
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
      work = await composeWork(modules, { ...config, pool, client, env });
      await work.launch();
      relays = startRelays(pool, [effectsRelay(pool, work.effects)]);
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
