import { canonicalCandidate } from '../editorial-review/contract.ts';
import { checkedItem, checkedOutcome, InvalidMerge, itemCommandKey, MERGE_COST,
  mergeDigest, MergeConflict, MergeUnavailable, type MergeHandler, type MergeTask,
  type RecordedItem, type TaskCompletion } from './contract.ts';
import { checkedHandlers } from './handlers.ts';
import { checkedPage, checkedTask, type MergeJournal, type MergeJournalScope } from './journal.ts';

/** Ordered review supplies current authority; the first Work command changes
 * navigation before bounded person-state reconciliation. */
export interface MergeTaskRuntime<Dependencies> {
  dependencies: Dependencies;
  dataEpoch: string;
  /** Idempotent first identity command; receipt lookup precedes head checks. */
  identityReceipt?(task: MergeTask): Promise<string | null>;
  begin(task: MergeTask): Promise<void>;
  /** Retain completion only after all owner stages. No further graph effect. */
  finish(task: MergeTask, commandKey: string): Promise<TaskCompletion>;
  /** Native stages may admit fewer items under their shared command budget. */
  itemsPerRun?: number;
  checkDeadline(): void;
}

function sameTask(retained: MergeTask, wanted: MergeTask): void {
  if (mergeDigest(retained) !== mergeDigest(wanted)) throw new MergeConflict('Decision, epoch or handler versions changed');
}
async function checkOriginal(scope: MergeJournalScope, task: MergeTask): Promise<void> {
  if (task.plan.operation !== 'unmerge') return;
  const original = await scope.original(task.plan.original);
  if (original.plan.source.resource !== task.plan.source.resource
    || original.plan.survivor.resource !== task.plan.survivor.resource
    || original.dataEpoch !== task.dataEpoch
    || mergeDigest(original.handlers) !== mergeDigest(task.handlers)) {
    throw new InvalidMerge('Unmerge differs from the retained merge identities, epoch or owners');
  }
}
async function compensationItem(scope: MergeJournalScope, task: MergeTask, raw: RecordedItem,
  owner: string): Promise<RecordedItem & { result: NonNullable<RecordedItem['result']> }> {
  if (task.plan.operation !== 'unmerge') throw new InvalidMerge('Compensation requires an unmerge');
  const original = await scope.originalItem(task.plan.original, owner, raw.key);
  checkedItem(original);
  if (original.owner !== owner || original.key !== raw.key || !original.result
    || !['moved', 'history'].includes(original.result.outcome)
    || original.result.afterHead !== raw.expectedHead) throw new InvalidMerge('Compensation names an item that was not moved');
  checkedOutcome(original.result, itemCommandKey(task.plan.original, owner, original.key));
  const reference = { original: task.plan.original, owner, key: original.key,
    snapshotDigest: mergeDigest({ key: original.key, expectedHead: original.expectedHead, before: original.before }),
    outcomeDigest: mergeDigest(original.result) };
  if (mergeDigest(reference) !== mergeDigest(raw.before)) throw new MergeUnavailable('Retained compensation basis differs');
  return { ...original, result: original.result };
}

async function reconcileOwner<Dependencies>(scope: MergeJournalScope, task: MergeTask,
  handler: MergeHandler<Dependencies>, runtime: MergeTaskRuntime<Dependencies>, budget: { processed: number }): Promise<boolean> {
  const itemLimit = Math.min(runtime.itemsPerRun ?? MERGE_COST.itemsPerRun,MERGE_COST.itemsPerRun);
  if (!Number.isSafeInteger(itemLimit) || itemLimit < 1) throw new InvalidMerge('Invalid native item budget');
  for (;;) {
    runtime.checkDeadline();
    const checkpoint = await scope.checkpoint(handler.owner);
    if (checkpoint.exhausted && !(await scope.pending(handler.owner, 1)).length) return true;
    if (budget.processed >= itemLimit) return false;
    const pending = await scope.pending(handler.owner, Math.min(itemLimit - budget.processed, handler.cost.page));
    if (pending.length) {
      for (const item of pending) {
        runtime.checkDeadline();
        const key = itemCommandKey(task.key, handler.owner, item.key);
        const outcome = task.plan.operation === 'merge'
          ? await handler.apply(task, item, key, runtime.dependencies)
          : await handler.compensate(task, await compensationItem(scope, task, item, handler.owner), key, runtime.dependencies);
        checkedOutcome(outcome, key);
        if (task.plan.operation === 'merge' && outcome.outcome === 'ambiguous') {
          throw new InvalidMerge('A forward merge cannot silently skip an ambiguous item');
        }
        await scope.record(handler.owner, item.key, outcome); budget.processed++;
      }
    } else {
      if (checkpoint.exhausted) return true;
      const page = task.plan.operation === 'merge'
        ? await handler.plan(task, checkpoint.after, Math.min(itemLimit,handler.cost.page), runtime.dependencies)
        : await scope.compensationPage(task.plan.original, handler.owner, checkpoint.after, Math.min(itemLimit,handler.cost.page));
      checkedPage(page, checkpoint.after, handler.cost.page);
      await scope.capture(handler.owner, checkpoint, page);
    }
  }
}

/** G-846 owns delivery order and retained per-command authority. One stage
 * advances only its native owner's existing item journal, at most 32 effects.
 * A stage's completion is not a terminal identity merge decision. */
export async function runMergeOwner<Dependencies>(wanted: MergeTask, owner: string, journal: MergeJournal,
  handlers: readonly MergeHandler<Dependencies>[], runtime: MergeTaskRuntime<Dependencies>) {
  checkedTask(wanted);
  const installed = checkedHandlers(handlers), handler = installed.find(candidate => candidate.owner === owner);
  if (!handler || wanted.dataEpoch !== runtime.dataEpoch
    || mergeDigest(wanted.handlers) !== mergeDigest(installed.map(candidate => ({ owner: candidate.owner, version: candidate.version })))) {
    throw new MergeUnavailable('Merge owner versions or data epoch are unavailable');
  }
  return journal.locked(wanted.key, async scope => {
    const old = await scope.task();
    if (old) sameTask(old, wanted);
    if (await scope.completion()) return { complete: true, processed: 0 };
    await checkOriginal(scope, wanted);
    runtime.checkDeadline();
    if (!old) await scope.prepare(wanted);
    await runtime.begin(wanted);
    const budget = { processed: 0 }, complete = await reconcileOwner(scope, wanted, handler, runtime, budget);
    return { complete, processed: budget.processed };
  });
}

/** Ordered review calls this only after every owner stage has completed.
 * Both delivery and recovery retain the same exact final receipt. */
export async function finishMergeTask<Dependencies>(scope: MergeJournalScope, task: MergeTask,
  runtime: MergeTaskRuntime<Dependencies>): Promise<TaskCompletion> {
  checkedTask(task);
  const retained = await scope.task();
  if (!retained) throw new MergeUnavailable('Merge task is unavailable');
  sameTask(retained, task);
  const completed = await scope.completion();
  if (completed) return completed;
  for (const handler of task.handlers) {
    if (!(await scope.checkpoint(handler.owner)).exhausted || (await scope.pending(handler.owner, 1)).length) {
      throw new MergeConflict('Owner stage is incomplete');
    }
  }
  runtime.checkDeadline();
  const commandKey = itemCommandKey(task.key, 'identity-merge', '$finalize');
  const completion = await runtime.finish(task, commandKey);
  if (!completion || completion.commandKey !== commandKey || !completion.receipt
    || completion.receipt.length > 512) throw new InvalidMerge('Identity finalization lacks an exact owner receipt');
  canonicalCandidate(completion, { bytes: MERGE_COST.taskBytes, depth: 40 });
  await scope.finish(completion);
  return completion;
}
