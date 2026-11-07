import { Pool } from 'pg';
import { composeAccessApplication } from '../../src/composition/access.ts';
import { installNativeHistory } from '../../src/composition/history.ts';
import { composeWorkApplication } from '../../src/composition/work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { KERNEL_WORK_MODULES } from './default-work-modules.ts';
import { configureTestReceiptKeys, testReceiptKeys } from './receipt-keys.ts';
import { workerTestEnv } from './worker-env.ts';

// The kernel's production work executor, run in its own process so the parent test process can own another DBOS
// host (Auth) without two launched executors sharing one process. Configuration arrives on stdin, never as argv.
// bun test preload does not apply here; install the same Access/Work/History root as worker.ts before compose.
const input = await Bun.stdin.json();
composeAccessApplication();
composeWorkApplication();
installNativeHistory();
// Search indexing, shared-history ticks and identity workflows share this executor pool. The
// parent test process has a separate pool; eight connections starve publication on the check host.
const pool = new Pool({ connectionString: input.databaseUrl, max: 32 });
configureTestReceiptKeys(pool);
const client = await createWorkClient(input.databaseUrl, pool);
const openSearchUrl =
  typeof input.openSearchUrl === 'string' && input.openSearchUrl.length > 0
    ? input.openSearchUrl
    : process.env.OPENSEARCH_URL;
const executorId =
  typeof input.executorId === 'string' && input.executorId.length > 0
    ? input.executorId
    : `identity-work-${process.pid}`;
const work = await composeWork(KERNEL_WORK_MODULES, {
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
process.stdout.write('IDENTITY_WORK_READY\n');

async function stop(): Promise<never> {
  await work.shutdown();
  await client.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
setInterval(() => {}, 1 << 30);
