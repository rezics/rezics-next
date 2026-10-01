import { finishMergeTask, runMergeOwner, type MergeTaskRuntime } from '../src/modules/identity-merge/engine.ts';
import type { MergeHandler, MergeTask, TaskCompletion } from '../src/modules/identity-merge/contract.ts';
import type { MergeJournal } from '../src/modules/identity-merge/journal.ts';

/** Journal probes exercise the production owner stages and finalizer directly.
 * The public application lifecycle is covered by ordered-command/API tests. */
export async function runMergeFixture<Dependencies>(task: MergeTask, journal: MergeJournal,
  handlers: readonly MergeHandler<Dependencies>[], runtime: MergeTaskRuntime<Dependencies>): Promise<{
    key: string; state: 'pending' | 'complete'; processed: number; completion: TaskCompletion | null;
  }> {
  let processed = 0;
  for (const handler of handlers) {
    const stage = await runMergeOwner(task, handler.owner, journal, handlers, runtime);
    processed += stage.processed;
    if (!stage.complete) return { key: task.key, state: 'pending', processed, completion: null };
  }
  const completion = await journal.locked(task.key, scope => finishMergeTask(scope, task, runtime));
  return { key: task.key, state: 'complete', processed, completion };
}
