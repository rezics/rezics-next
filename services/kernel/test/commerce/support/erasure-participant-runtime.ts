import { DBOS } from '@dbos-inc/dbos-sdk';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';

// Production module list, queues and effects relay. The child sets the same 5ms poll as
// other native work fixtures before advertising readiness, so enqueue and catch-up can
// proceed; SIGKILL teardown is owned by the parent because erasure coordinators sleep.
await startWorker(readWorkerConfig(process.env), undefined, process.env);
for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
console.info(`Commerce erasure worker ready: ${process.pid}`);
