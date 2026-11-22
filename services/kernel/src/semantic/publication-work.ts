import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import type { SubjectPagePublication } from './subject-page-publication.ts';

const WORKFLOW = 'semantic.subjectPagePublication';
/** The maintenance queue drives bounded durable pages; publication checkpoints own recovery. */
export function registerSubjectPagePublicationWork(context: WorkContext, publication: SubjectPagePublication) {
  let stopped = false;
  DBOS.registerWorkflow(
    async () => {
      for (let page = 0; page < 128 && !stopped; page++) {
        const result = await DBOS.runStep(() => publication.step({ limit: 32 }), { name: 'publication-page' });
        if (result.done) return true;
      }
      return false;
    },
    { name: WORKFLOW },
  );
  context.addService(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> = Promise.resolve();
    const tick = () => {
      if (stopped) return;
      active = (async () => {
        let delay = 100;
        try {
          const handle = await context.client.enqueue({
            queueName: 'maintenance',
            workflowName: WORKFLOW,
            workflowID: randomUUID(),
          });
          // A maintenance workflow can still be queued when its worker starts draining.
          // Bound the actual SDK poll so shutdown can release this observer and leave the job durable.
          while (!stopped) {
            const done = await DBOS.getResult<boolean>(handle.workflowID, { timeoutSeconds: 1 });
            if (done !== null) {
              delay = done ? 100 : 1;
              break;
            }
          }
        } catch (error) {
          console.error('Subject page publication repair failed', error);
          delay = 1000;
        } finally {
          if (!stopped) timer = setTimeout(tick, delay);
        }
      })();
    };
    tick();
    return {
      async stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        await active;
      },
    };
  });
}
