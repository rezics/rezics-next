import { DBOS } from '@dbos-inc/dbos-sdk';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';

// The production entry point, registry, Stripe factory, queues and relays run in this process.
await startWorker({
  ...readWorkerConfig(process.env),
  clock: () => new Date(process.env.REFRESH_TIME!),
});
for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
process.send?.({ kind: 'ready', pid: process.pid });
