import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { workerTestEnv } from './worker-env.ts';

const READY = 'IDENTITY_WORK_READY';
// The child loads the whole kernel module graph before it can launch; the suites' beforeAll budget covers this wait.
const READY_TIMEOUT_MS = 180_000;

export type IdentityWorkProcessConfig = {
  databaseUrl: string;
  routeKey: string;
  searchPrefix: string;
  executorId: string;
  openSearchUrl?: string | undefined;
};

/** Starts the production kernel work executor in a child process (identity-work-child.ts). The parent keeps its
 * DBOS client for enqueueing; the child owns the launched executor. Resolves once the child reports ready. */
export async function startIdentityWorkProcess(config: IdentityWorkProcessConfig) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./identity-work-child.ts', import.meta.url))], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...workerTestEnv({
        KERNEL_ROUTE_KEY: config.routeKey,
        KERNEL_SEARCH_PREFIX: config.searchPrefix,
        KERNEL_EXECUTOR_ID: config.executorId,
        KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '10000',
        ...(config.openSearchUrl === undefined ? {} : { OPENSEARCH_URL: config.openSearchUrl }),
      }),
    },
  });
  child.stdin.write(JSON.stringify(config));
  await child.stdin.end();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`identity work process was not ready within ${READY_TIMEOUT_MS} ms`)),
      READY_TIMEOUT_MS,
    );
  });
  const exited = child.exited.then(() => {
    throw new Error('identity work process exited before it was ready');
  });
  try {
    while (!seen.includes(READY)) {
      const next = await Promise.race([reader.read(), timeout, exited]);
      if (next.done) throw new Error('identity work process closed stdout before it was ready');
      seen += decoder.decode(next.value, { stream: true });
    }
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  // Keep draining stdout so a chatty executor cannot block on a full pipe.
  void (async () => {
    while (!(await reader.read()).done);
  })();
  return {
    async stop() {
      child.kill('SIGTERM');
      await child.exited;
    },
  };
}

export type AccountIdentityPublicationRuntime = {
  workClient: WorkClient;
  stop(): Promise<void>;
};

/** Parent fixtures register queues on a dedicated WorkClient and never call composeWork/setConfig.
 * Only the child executor launches, so the parent cannot hold the system-database lease or share the
 * command pool with DBOS system queries.
 */
export async function startAccountIdentityPublication(config: {
  databaseUrl: string;
  routeKey: string;
  searchPrefix: string;
  openSearchUrl?: string | undefined;
}): Promise<AccountIdentityPublicationRuntime> {
  const workClient = await createWorkClient(config.databaseUrl);
  for (const [name, parameters] of Object.entries(WORK_QUEUES)) await workClient.registerQueue(name, parameters);
  const identityWork = await startIdentityWorkProcess({
    databaseUrl: config.databaseUrl,
    routeKey: config.routeKey,
    searchPrefix: config.searchPrefix,
    executorId: `identity-publication-${randomUUID()}`,
    ...(config.openSearchUrl === undefined ? {} : { openSearchUrl: config.openSearchUrl }),
  });
  return {
    workClient,
    async stop() {
      await identityWork.stop();
      await workClient.close();
    },
  };
}
