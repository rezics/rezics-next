import {
  integrationResourceClasses,
  qaResourceClasses,
  type QaResourceClass,
} from './resource-classes.ts';

export type QaStackMode = 'test' | 'scale';

/** Leave 60 seconds for smoke/shutdown within the complete preparation ceiling.
 * A scale probe can use up to 400 seconds after actual startup/bootstrap. */
export function scalePreparationBudgetMs(startedAt: number, now = Date.now()): number {
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(now) || startedAt > now)
    throw new Error('Invalid QA preparation start time');
  const remaining = Math.min(400_000, 600_000 - (now - startedAt) - 60_000);
  if (remaining <= 0) throw new Error('QA startup exhausted the preparation budget');
  return remaining;
}

/** These recipes grow a command-created catalogue; ordinary integration shards
 * retain tmpfs. Opt-in recipes still choose scale storage before their test starts. */
export const scaleIntegrationFiles: ReadonlySet<string> = new Set(
  [...integrationResourceClasses]
    .filter(([, name]) => name === 'catalogue-disk')
    .map(([file]) => file),
);

/** A single scale setting selects disk storage and its JVM/container allocation.
 * TDB2's copy-on-write files on tmpfs count against the container memory limit. */
export function qaStackMode(env: NodeJS.ProcessEnv): QaStackMode {
  const mode = env.REZICS_QA_STACK_MODE ?? 'test';
  if (mode !== 'test' && mode !== 'scale') throw new Error('Invalid REZICS_QA_STACK_MODE');
  return mode;
}

export function qaStackEnvironment(
  env: NodeJS.ProcessEnv,
  mode: QaStackMode = qaStackMode(env),
  resourceClass?: QaResourceClass,
): NodeJS.ProcessEnv {
  const allocation =
    qaResourceClasses[
      resourceClass && resourceClass !== 'ordinary'
        ? resourceClass
        : mode === 'scale'
          ? 'catalogue-disk'
          : 'ordinary'
    ];
  const override = env.REZICS_QA_FUSEKI_MEMORY_LIMIT;
  if (resourceClass && resourceClass !== 'ordinary' && override && override !== '0') {
    const match = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(override);
    const units: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
    const bytes = match ? Number(match[1]) * units[match[2]?.toLowerCase() ?? 'b']! : NaN;
    if (!Number.isFinite(bytes) || bytes < 7 * 1024 ** 3)
      throw new Error(`${resourceClass} requires at least 7 GiB of Fuseki memory`);
  }
  return {
    ...env,
    REZICS_QA_STACK_MODE: mode,
    REZICS_FUSEKI_MEMORY_LIMIT: env.REZICS_QA_FUSEKI_MEMORY_LIMIT ?? allocation.memory,
    REZICS_FUSEKI_JVM_ARGS: env.REZICS_QA_FUSEKI_JVM_ARGS ?? allocation.jvmArgs,
  };
}
