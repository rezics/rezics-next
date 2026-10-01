import { canonicalCandidate } from '../editorial-review/contract.ts';
import { checkedItem, checkedOutcome, checkedPlan, InvalidMerge, itemCommandKey, MERGE_COST,
  mergeDigest, MergeConflict, MergeUnavailable, type MergeHandler, type MergeTask,
  type RecordedItem, type TaskCompletion, type TaskProgress } from './contract.ts';
import { checkedHandlers } from './handlers.ts';
import { checkedPage, checkedTask, type MergeJournal, type MergeJournalScope } from './journal.ts';

/** Runtime binding must reserve BOTH identity heads, prevent new references to
 * the source while reconciling, and independently validate G-865's current
 * two-human-review permit in each native owner effect. This kernel supplies no
 * approval policy and is deliberately not a public editorial adapter. */
export interface MergeTaskRuntime<Dependencies> {
  dependencies: Dependencies;
  dataEpoch: string;
  /** Idempotent owner reservation; recover its receipt before checking heads.
   * Includes disclosure, controlled-Agent, grain and cyclic/stale guards.
   * Caller-owned timeouts/AbortSignal must reach every owner operation. */
  begin(task: MergeTask): Promise<void>;
  /** Final identity CAS/receipt projects/removes mergedInto only after all item
   * outcomes. It retains both native identities and exact old revisions. */
  finish(task: MergeTask, commandKey: string): Promise<TaskCompletion>;
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
  for (;;) {
    runtime.checkDeadline();
    const checkpoint = await scope.checkpoint(handler.owner);
    if (checkpoint.exhausted && !(await scope.pending(handler.owner, 1)).length) return true;
    if (budget.processed >= MERGE_COST.itemsPerRun) return false;
    const pending = await scope.pending(handler.owner, Math.min(MERGE_COST.itemsPerRun - budget.processed, handler.cost.page));
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
        ? await handler.plan(task, checkpoint.after, handler.cost.page, runtime.dependencies)
        : await scope.compensationPage(task.plan.original, handler.owner, checkpoint.after, handler.cost.page);
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

/** One bounded run of one duplicate pair. Checkpoint writes precede owner
 * delivery and receipt writes follow it; either crash gap safely replays the
 * SAME owner command. A later run resumes from the latest bounded page rather
 * than scanning or reconstructing a completed inventory. */
export async function runMergeTask<Dependencies>(wanted: MergeTask, journal: MergeJournal,
  handlers: readonly MergeHandler<Dependencies>[], runtime: MergeTaskRuntime<Dependencies>): Promise<TaskProgress> {
  checkedPlan(wanted.plan); checkedTask(wanted);
  const installed = checkedHandlers(handlers);
  if (wanted.dataEpoch !== runtime.dataEpoch
    || mergeDigest(wanted.handlers) !== mergeDigest(installed.map(handler => ({ owner: handler.owner, version: handler.version })))) {
    throw new MergeUnavailable('Merge task owner versions or data epoch are unavailable');
  }
  return journal.locked(wanted.key, async scope => {
    const old = await scope.task();
    if (old) sameTask(old, wanted);
    const completed = await scope.completion();
    if (completed) return { key: wanted.key, state: 'complete', processed: 0, completion: completed };
    await checkOriginal(scope, wanted);
    runtime.checkDeadline();
    // Retain the decision binding BEFORE reserving/delivering a cross-owner
    // effect, so a killed process never leaves an unlocatable reservation.
    if (!old) await scope.prepare(wanted);
    await runtime.begin(wanted);
    const budget = { processed: 0 };
    for (const handler of installed) {
      if (!await reconcileOwner(scope, wanted, handler, runtime, budget)) {
        return { key: wanted.key, state: 'pending', processed: budget.processed, completion: null };
      }
    }
    runtime.checkDeadline();
    const commandKey = itemCommandKey(wanted.key, 'identity-merge', '$finalize');
    const completion = await runtime.finish(wanted, commandKey);
    if (!completion || completion.commandKey !== commandKey || !completion.receipt
      || completion.receipt.length > 512) throw new InvalidMerge('Identity finalization lacks an exact owner receipt');
    canonicalCandidate(completion, { bytes: MERGE_COST.taskBytes, depth: 40 });
    await scope.finish(completion);
    return { key: wanted.key, state: 'complete', processed: budget.processed, completion };
  });
}
