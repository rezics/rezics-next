import { Pool } from 'pg';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { composeWorkApplication } from '../../src/composition/work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { KERNEL_WORK_MODULES } from './default-work-modules.ts';
import { configureTestReceiptKeys, testReceiptKeys } from './receipt-keys.ts';
import { workerTestEnv } from './worker-env.ts';

// The kernel's production work executor, run in its own process so the parent test process can own another DBOS
// host (Auth) without two launched executors sharing one process. Configuration arrives on stdin, never as argv.
// bun test preload does not apply here; install the ordinary native root before Work builds worker authorization.
const input = await Bun.stdin.json();
installNativeHistoryPreload();
composeWorkApplication();
// Search indexing, shared-history ticks and identity workflows share this executor pool. The
// parent test process has a separate pool; eight connections starve publication on the check host.
const pool = new Pool({ connectionString: input.databaseUrl, max: 32 });
let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
let work: Awaited<ReturnType<typeof composeWork>> | undefined;

async function release(): Promise<void> {
  try {
    await work?.shutdown();
  } finally {
    try {
      await client?.close();
    } finally {
      await pool.end();
    }
  }
}

try {
  configureTestReceiptKeys(pool);
  client = await createWorkClient(input.databaseUrl, pool);
  const openSearchUrl =
    typeof input.openSearchUrl === 'string' && input.openSearchUrl.length > 0
      ? input.openSearchUrl
      : process.env.OPENSEARCH_URL;
  const executorId =
    typeof input.executorId === 'string' && input.executorId.length > 0
      ? input.executorId
      : `identity-work-${process.pid}`;
  work = await composeWork(KERNEL_WORK_MODULES, {
    databaseUrl: input.databaseUrl,
    pool,
    client,
    executorId,
    env: workerTestEnv({
      KERNEL_ROUTE_KEY: input.routeKey,
      KERNEL_SEARCH_PREFIX: input.searchPrefix,
      KERNEL_EXECUTOR_ID: executorId,
      ...(openSearchUrl === undefined ? {} : { OPENSEARCH_URL: openSearchUrl }),
    }),
    receiptKeys: testReceiptKeys(),
  });
  await work.launch();
} catch (error) {
  try {
    await release();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Identity work launch and cleanup failed');
  }
  throw error;
}
let stopping: Promise<never> | undefined;
function stop(): Promise<never> {
  return (stopping ??= (async () => {
    await release();
    process.exit(0);
  })());
}
process.on(
  'SIGTERM',
  () =>
    void stop().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    }),
);
setInterval(() => {}, 1 << 30);
process.stdout.write('IDENTITY_WORK_READY\n');
