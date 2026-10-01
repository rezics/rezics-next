import { canonicalCandidate, checkedHeads, EditorialBlocked, EditorialInvalid, headsEqual,
  type EditorialAdapter, type EditorialAdapterModule, type OwnerReceipt } from './contract.ts';
import type { EditorialRuntime } from './runtime.ts';
import { applyOrderedCommands } from './ordered.ts';
import { checkedPlan, itemCommandKey, MergeConflict, type MergeTask } from '../identity-merge/contract.ts';
import { discoverMergeHandlers } from '../identity-merge/handlers.ts';
import { previewMerge, MergeConflictWithHeads } from '../identity-merge/preflight.ts';
import { AccessMergeJournal } from '../identity-merge/journal.ts';
import { mergeEditorialCommands } from '../identity-merge/editorial-commands.ts';
import { mergeDependencies, mergePreflightOwner, mergeTaskRuntime } from '../identity-merge/runtime.ts';
import { mergeTargets, requireMergeDisclosure } from '../identity-merge/pair-authority.ts';
import { ownerAuthorityBlockers } from './owner-authority.ts';

export function reviewedMergeAdapter(owners: Pick<EditorialAdapter,'validate'|'commands'|'complete'|'compensate'>): EditorialAdapter {
  const adapter: EditorialAdapter = { ...owners,kind: 'merge',requiredApprovals: 2,
    preview: revision => Promise.resolve([{ path: 'identity',before: revision.before,after: revision.candidate }]),
    apply: input => applyOrderedCommands(adapter,input) };
  return adapter;
}
export const adapterModule = { kind: 'merge',
  create(runtime: EditorialRuntime & { actingSubject: string }): EditorialAdapter {
    const dependencies = mergeDependencies(runtime), journal = new AccessMergeJournal(dependencies.accessPool);
    const owner = mergePreflightOwner(runtime,runtime.actingSubject), handlers = discoverMergeHandlers(dependencies);
    const adapter = reviewedMergeAdapter({
      async validate(target,raw,expected) {
        const plan = checkedPlan(raw);
        if (target.resource !== plan.source.resource || target.work !== target.resource) throw new EditorialInvalid('Merge targets its original Work');
        const heads = checkedHeads([{ component: plan.source.resource,head: plan.source.revision },{ component: plan.survivor.resource,head: plan.survivor.revision }]);
        if (!headsEqual(heads,expected)) throw new EditorialBlocked({ code: 'stale_base',expectedHeads: expected,actualHeads: heads });
        await requireMergeDisclosure(plan,dependencies.graph);
        const blockers = await ownerAuthorityBlockers(runtime,runtime.actingSubject,
          mergeTargets(target,plan).map(pair => ({ action: 'work.edit',scope: `work:edit:${pair.resource}` })));
        if (blockers.length) throw new EditorialBlocked(blockers[0]!);
        try {
          if (plan.operation === 'unmerge') await journal.locked(plan.original,async scope => {
            const original = await scope.task(), completed = await scope.completion();
            if (!original || !completed || original.plan.operation !== 'merge' || original.plan.source.resource !== plan.source.resource
              || original.plan.survivor.resource !== plan.survivor.resource) throw new EditorialInvalid('Unmerge names the completed original pair');
          });
          const preview = await previewMerge(plan,owner,await handlers,dependencies);
          return { candidate: canonicalCandidate(plan).candidate,before: canonicalCandidate(preview).candidate,baseHeads: heads };
        } catch (error) {
          if (error instanceof MergeConflictWithHeads) throw new EditorialBlocked({ code: 'stale_base',expectedHeads: heads,
            actualHeads: [{ component: plan.source.resource,head: error.sourceHead },{ component: plan.survivor.resource,head: error.survivorHead }] });
          throw error;
        }
      },
      async commands(input) {
        const installed = await handlers, plan = checkedPlan(input.revision.candidate);
        const task: MergeTask = { key: input.operationKey,application: input.permit.proof,candidateDigest: input.revision.candidateDigest,
          plan,dataEpoch: runtime.work.environment.lineage.dataEpoch,handlers: installed.map(handler => ({ owner: handler.owner,version: handler.version })) };
        return mergeEditorialCommands(input,task,journal,installed,mergeTaskRuntime(runtime));
      },
      async complete(input) {
        return journal.locked(input.operationKey,async scope => {
          const task = await scope.task();
          if (!task) throw new EditorialInvalid('Merge task is unavailable');
          let completion = await scope.completion();
          if (!completion) {
            for (const handler of task.handlers) if (!(await scope.checkpoint(handler.owner)).exhausted
              || (await scope.pending(handler.owner,1)).length) throw new MergeConflict('Owner stage is incomplete');
            completion = await mergeTaskRuntime(runtime).finish(task,itemCommandKey(task.key,'identity-merge','$finalize'));
            await scope.finish(completion);
          }
          return { receipt: completion.receipt,proposal: input.revision.proposal,revision: input.revision.n,
            candidateDigest: input.revision.candidateDigest,operationKey: input.operationKey,beforeHeads: input.expectedHeads,
            afterHeads: input.expectedHeads,candidate: input.revision.candidate,before: input.revision.before,owner: completion.result };
        });
      },
      async compensate(receipt: OwnerReceipt) {
        const original = checkedPlan(receipt.candidate);
        if (original.operation !== 'merge') throw new EditorialInvalid('Only a merge has a compensating unmerge');
        const [source,survivor] = await Promise.all([owner.read(original.source.resource),owner.read(original.survivor.resource)]);
        if (!source || !survivor) throw new EditorialBlocked({ code: 'owner_unavailable' });
        const plan = checkedPlan({ ...original,operation: 'unmerge',original: receipt.operationKey,
          source: { resource: source.header.resource,revision: source.header.revision },survivor: { resource: survivor.header.resource,revision: survivor.header.revision } });
        return { candidate: canonicalCandidate(plan).candidate,before: receipt.candidate,
          baseHeads: [{ component: plan.source.resource,head: plan.source.revision },{ component: plan.survivor.resource,head: plan.survivor.revision }] };
      },
    });
    return { ...adapter,applyBlockers: (target,revision,agent) => ownerAuthorityBlockers(runtime,agent,
      mergeTargets(target,revision.candidate).map(pair => ({ action: 'work.edit',scope: `work:edit:${pair.resource}` }))) };
  },
} satisfies EditorialAdapterModule<EditorialRuntime & { actingSubject: string }>;
