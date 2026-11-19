import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { startWorker } from '../../src/worker.ts';
import type { IdentityWorkProcessConfig } from './identity-work-process.ts';
import { testReceiptKeysEnv } from './receipt-keys.ts';
import { workerTestEnv } from './worker-env.ts';

// The parent owns the Auth DBOS host. Launch the Kernel executor in this process using configuration from stdin.
const input: IdentityWorkProcessConfig = await Bun.stdin.json();
installNativeHistoryPreload();
const executorId = input.executorId || `identity-work-${process.pid}`;
const env = workerTestEnv({
  KERNEL_ROUTE_KEY: input.routeKey,
  KERNEL_SEARCH_PREFIX: input.searchPrefix,
  KERNEL_EXECUTOR_ID: executorId,
  KERNEL_RECEIPT_KEYS: input.receiptKeys ?? testReceiptKeysEnv().KERNEL_RECEIPT_KEYS,
  OPENSEARCH_URL: input.openSearchUrl || process.env.OPENSEARCH_URL,
});
const worker = await startWorker(
  {
    databaseUrl: input.databaseUrl,
    executorId,
    // Search indexing, shared history and identity publication share this pool.
    poolSize: 32,
    handleSignals: false,
    effectsRelay: input.effectsRelay === true,
  },
  (modules) =>
    input.workModules?.map((name) => {
      const module = modules.find((candidate) => candidate.name === name);
      if (!module) throw new Error(`Unknown native work module: ${name}`);
      return module;
    }) ?? modules,
  env,
);
let stopping: Promise<never> | undefined;
function stop(): Promise<never> {
  return (stopping ??= (async () => {
    await worker.stop();
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
