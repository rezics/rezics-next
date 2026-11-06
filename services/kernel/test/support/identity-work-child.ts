import { Pool } from 'pg';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { KERNEL_WORK_MODULES } from './default-work-modules.ts';
import { configureTestReceiptKeys, testReceiptKeys } from './receipt-keys.ts';
import { workerTestEnv } from './worker-env.ts';

// The kernel's production work executor, run in its own process so the parent test process can own another DBOS
// host (Auth) without two launched executors sharing one process. Configuration arrives on stdin, never as argv.
const input = await Bun.stdin.json();
const pool = new Pool({ connectionString: input.databaseUrl, max: 8 });
configureTestReceiptKeys(pool);
const client = await createWorkClient(input.databaseUrl, pool);
const work = await composeWork(KERNEL_WORK_MODULES, {
  databaseUrl: input.databaseUrl,
  pool,
  client,
  env: workerTestEnv({
    KERNEL_ROUTE_KEY: input.routeKey,
    OPENSEARCH_URL: input.openSearchUrl,
    KERNEL_SEARCH_PREFIX: input.searchPrefix,
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
