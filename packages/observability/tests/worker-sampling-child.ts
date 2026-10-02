import {
  recordWorkerOutcome,
  shutdownTelemetry,
  startTelemetry,
  withWorkerTelemetry,
} from '../src/runtime.ts';

startTelemetry('rezics-worker-sampling-test');
const value = await withWorkerTelemetry('main.content.projection', async () => {
  recordWorkerOutcome({ outcome: 'worked', processed: 2, unit: 'event' });
  return 42;
});
const failure = new Error('PRIVATE_FAILURE');
let sameError = false;
try {
  await withWorkerTelemetry('main.notification.delivery', async () => {
    throw failure;
  });
} catch (error) {
  sameError = error === failure;
}
await shutdownTelemetry();
console.log(JSON.stringify({ value, sameError }));
