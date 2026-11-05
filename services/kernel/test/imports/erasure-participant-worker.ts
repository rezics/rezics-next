import { mock } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import * as effects from '../../src/events/effects.ts';
import type { Envelope } from '../../src/events/log.ts';
import { importsWorkModule } from '../../src/imports/erasure.ts';

// Intercept only the relay factory boundary to retain its actual registered enqueue
// and the one envelope read by production. Registration, dispatch and execution stay native.
const productionRelay = effects.effectsRelay;
let enqueue: ReturnType<typeof effects.registerEffects>['enqueue'];
let observed: Envelope | undefined;
mock.module('../../src/events/effects.ts', () => ({
  ...effects,
  effectsRelay: (pool: Parameters<typeof productionRelay>[0], registered: Parameters<typeof productionRelay>[1]) => {
    enqueue = registered.enqueue;
    return productionRelay(pool, {
      async enqueue(envelopes) {
        for (const envelope of envelopes) {
          if (
            envelope.events.some(
              (event) =>
                event.type === 'com.rezics.access.account-tombstoned.v1' &&
                event.subject === process.env.IMPORTS_ERASURE_ACCOUNT,
            )
          ) {
            if (observed && observed.position !== envelope.position)
              throw new Error('More than one native tombstone envelope');
            observed = envelope;
          }
        }
        await registered.enqueue(envelopes);
      },
    });
  },
}));
const { readWorkerConfig, startWorker } = await import('../../src/worker.ts');
const worker = await startWorker(readWorkerConfig(process.env), [importsWorkModule]);
console.log('imports-worker-ready');
let requests = 0;
process.on('message', async (message: unknown) => {
  try {
    if (message !== 'observe' && message !== 'redeliver') throw new Error('Unknown fixture request');
    if (++requests !== (message === 'observe' ? 1 : 2) || !observed)
      throw new Error('Expected one observation followed by one native redelivery');
    const eventSeq = observed.events.findIndex(
      (event) =>
        event.type === 'com.rezics.access.account-tombstoned.v1' &&
        event.subject === process.env.IMPORTS_ERASURE_ACCOUNT,
    );
    const workflowId = effects.effectWorkflowId(observed, eventSeq, 'imports_erasure');
    if (message === 'redeliver') await enqueue([observed]);
    const handle = DBOS.retrieveWorkflow(workflowId);
    await handle.getResult();
    process.send?.({
      request: message,
      envelope: { ...observed, position: observed.position.toString() },
      eventSeq,
      workflowId: handle.workflowID,
      status: await handle.getStatus(),
      steps: await DBOS.listWorkflowSteps(workflowId),
    });
  } catch (error) {
    process.send?.({ error: String(error) });
  }
});
const stop = () => void worker.stop().then(() => process.disconnect?.());
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
