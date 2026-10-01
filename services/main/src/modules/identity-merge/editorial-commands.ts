import { canonicalCandidate, type ApplyInput, type CommandDelivery, type CommandOutcome,
  type EditorialCommand } from '../editorial-review/contract.ts';
import { checkedTask, type MergeJournal } from './journal.ts';
import { itemCommandKey, mergeDigest, MergeUnavailable, type MergeHandler, type MergeTask } from './contract.ts';
import { mergeOwnerBinding } from './authority.ts';
import { runMergeOwner, type MergeTaskRuntime } from './engine.ts';
import { checkedHandlers } from './handlers.ts';

/** G-846 retains these ordered owner stages before delivery. The item journal
 * remains the bounded source inventory and native-receipt acknowledgement;
 * it supplies neither another application lifecycle nor another approval policy.
 * The native Work command is first; subsequent owner commands see its redirect. */
export function mergeEditorialCommands<Dependencies>(input: ApplyInput, task: MergeTask,
  journal: MergeJournal, handlers: readonly MergeHandler<Dependencies>[], runtime: MergeTaskRuntime<Dependencies>): EditorialCommand[] {
  checkedTask(task);
  const installed = checkedHandlers(handlers);
  if (task.key !== input.operationKey || task.application !== input.permit.proof
    || task.candidateDigest !== input.revision.candidateDigest
    || mergeDigest(task.plan) !== canonicalCandidate(input.revision.candidate).digest
    || mergeDigest(task.handlers) !== mergeDigest(installed.map(handler => ({ owner: handler.owner, version: handler.version })))) {
    throw new MergeUnavailable('Reviewed merge command plan differs');
  }
  return ['identity-merge', ...installed.map(handler => handler.owner)].map(owner => {
    const key = itemCommandKey(task.key, owner, '$stage'), binding = mergeOwnerBinding(task, owner);
    const check = (delivery: CommandDelivery) => {
      if (delivery.key !== key || delivery.input.permit.proof !== task.application
        || delivery.input.operationKey !== task.key || mergeDigest(delivery.binding) !== mergeDigest(binding)) {
        throw new MergeUnavailable('Reviewed merge stage differs');
      }
    };
    const resolve = async (): Promise<CommandOutcome | null> => journal.locked<CommandOutcome | null>(task.key, async scope => {
      const stored = await scope.task();
      if (!stored) return null;
      if (mergeDigest(stored) !== mergeDigest(task)) throw new MergeUnavailable('Retained merge task differs');
      if (owner === 'identity-merge') {
        const receipt = await runtime.identityReceipt?.(task);
        return receipt ? { key, outcome: 'applied', receipt,
          result: canonicalCandidate({ task: task.key, owner }).candidate } : null;
      }
      const checkpoint = await scope.checkpoint(owner);
      return checkpoint.exhausted && !(await scope.pending(owner, 1)).length
        ? { key, outcome: 'applied', receipt: `urn:rezics:identity-merge-stage:${key}`,
          result: canonicalCandidate({ task: task.key, owner, version: task.handlers.find(handler => handler.owner === owner)!.version }).candidate } : null;
    });
    return { key, prepare: () => Promise.resolve(binding),
      resolve(delivery) { check(delivery); return resolve(); },
      async execute(delivery) {
        check(delivery);
        if (owner === 'identity-merge') await journal.locked(task.key, async scope => {
          if (!(await scope.task())) await scope.prepare(task);
          if (task.plan.operation === 'unmerge') await scope.original(task.plan.original);
          await runtime.begin(task);
        });
        else await runMergeOwner(task, owner, journal, installed, runtime);
        return resolve();
      } };
  });
}
