import { fileURLToPath } from 'node:url';

const READY = 'IDENTITY_WORK_READY';
// The child loads the whole kernel module graph before it can launch; the suites' beforeAll budget covers this wait.
const READY_TIMEOUT_MS = 150_000;

export type IdentityWorkProcessConfig = {
  databaseUrl: string;
  routeKey: string;
  searchPrefix: string;
  openSearchUrl?: string | undefined;
};

/** Starts the production kernel work executor in a child process (identity-work-child.ts). The parent keeps its
 * DBOS client for enqueueing; the child owns the launched executor. Resolves once the child reports ready. */
export async function startIdentityWorkProcess(config: IdentityWorkProcessConfig) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./identity-work-child.ts', import.meta.url))], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
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
