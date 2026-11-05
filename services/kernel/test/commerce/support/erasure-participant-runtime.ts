import { readWorkerConfig, startWorker } from '../../../src/worker.ts';

// One production kernel executor, isolated from the parent fixture's Auth executor.
// startWorker owns signal handling, graceful shutdown, its client and its pool.
await startWorker(readWorkerConfig(process.env), undefined, process.env);
console.info(`Commerce erasure worker ready: ${process.pid}`);
