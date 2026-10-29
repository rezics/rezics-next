import { importsWorkModule } from '../../src/imports/erasure.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';

const worker = await startWorker(readWorkerConfig(process.env), [importsWorkModule]);
console.log('imports-worker-ready');
const stop = () => void worker.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
