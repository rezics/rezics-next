import { CONTENT_WORKER_LONG_STEP_MS, CONTENT_WORKER_STEP_MS, type ContentAmbient } from '../contract/index.ts';
import { workerDeadline } from '../core/index.ts';

/** Worker budgets are wall time from the supplied ambient, never a hidden Date.now. */
export function createWorkBudgets(ambient: Pick<ContentAmbient, 'now'>) {
  return {
    step(): number {
      return workerDeadline(ambient.now(), CONTENT_WORKER_STEP_MS);
    },
    longStep(): number {
      return workerDeadline(ambient.now(), CONTENT_WORKER_LONG_STEP_MS);
    },
  };
}
