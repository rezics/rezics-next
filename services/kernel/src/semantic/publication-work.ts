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
          // A tick can enqueue just before the SDK stops dequeueing. The durable
          // workflow stays queued for a successor while this local observer drains.
          while (!stopped) {
            const done = await DBOS.getResult<boolean>(handle.workflowID, { timeoutSeconds: 2 });
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
