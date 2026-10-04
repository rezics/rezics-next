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
export const scaleIntegrationFiles: ReadonlySet<string> = new Set([
  'tests/qa/integration/g-1038-catalogue-scale.test.ts',
  'tests/qa/integration/g-1031-catalogue-write.test.ts',
  'tests/qa/integration/g-1035-catalogue-write.test.ts',
  'tests/qa/integration/g-1032-catalogue-preparation.test.ts',
]);

/** A single scale setting selects disk storage and its JVM/container allocation.
 * TDB2's copy-on-write files on tmpfs count against the container memory limit. */
export function qaStackMode(env: NodeJS.ProcessEnv): QaStackMode {
  const mode = env.REZICS_QA_STACK_MODE ?? 'test';
  if (mode !== 'test' && mode !== 'scale') throw new Error('Invalid REZICS_QA_STACK_MODE');
  return mode;
}

export function qaStackEnvironment(env: NodeJS.ProcessEnv,
  mode: QaStackMode = qaStackMode(env)): NodeJS.ProcessEnv {
  return {
    ...env,
    REZICS_QA_STACK_MODE: mode,
    REZICS_FUSEKI_MEMORY_LIMIT: env.REZICS_QA_FUSEKI_MEMORY_LIMIT ?? (mode === 'scale' ? '7g' : '2g'),
    REZICS_FUSEKI_JVM_ARGS:
      env.REZICS_QA_FUSEKI_JVM_ARGS ?? (mode === 'scale'
        ? '-Xms128m -Xmx1536m -XX:MaxDirectMemorySize=512m'
        : '-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m'),
  };
}
