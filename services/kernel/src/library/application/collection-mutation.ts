/** The owning Core command retains authority, receipt lookup, retries and transaction lifetime. */
import type { CollectionMutationApplication, CollectionMutationPorts } from '../contract/index.ts';
import { collectionMetadataMutationPlan } from '../core/index.ts';

export function createCollectionMutationApplication<Connection>(
  ports: CollectionMutationPorts<Connection>,
): CollectionMutationApplication<Connection> {
  const initializeHistory: CollectionMutationApplication<Connection>['initializeHistory'] = (tx, input, plan) =>
    ports.initialize(tx, input, plan);

  const captureHistory: CollectionMutationApplication<Connection>['captureHistory'] = async (tx, input, supplied) => {
    const plan = supplied ?? ports.planCapture(input);
    if (input.after.curatorAccountId === null) throw new Error('A metadata write needs a current Collection curator');
    if (plan.changedFields.length === 0) return;
    const { owner, append, prune, pruned } = plan.leaves;
    if (!owner || !append || !prune || !pruned) throw new Error('Metadata transition plan is incomplete');
    await ports.owner(tx, owner);
    if ((await ports.append(tx, append)) !== 1)
      throw new Error('Collection metadata history did not record one native change');
    const removed = await ports.prune(tx, prune);
    if (removed > 1) throw new Error('Collection metadata history exceeded its one-row prune bound');
    if (removed === 1) await ports.pruned(tx, pruned);
  };

  return {
    initializeHistory,
    captureHistory,
    async create(tx, input, write) {
      const value = await write();
      await initializeHistory(tx, input);
      return value;
    },
    async updateMetadata(tx, input, effects) {
      if (input.before.revision !== input.revision) return effects.conflict();
      const value = await effects.write();
      if (!value) return effects.conflict();
      await captureHistory(tx, { ...input, after: value });
      const plan = collectionMetadataMutationPlan(input.before, value);
      if (plan.retirePublication) await effects.retirePublication();
      if (plan.reducePublicSource) await effects.reducePublicSource();
      return plan.reread ? effects.readCurrent() : value;
    },
    async removeRetainedPage(_tx, input, effects) {
      if (input.publicCustody)
        return { status: 'retained', removed: 0, custody: 'collection_source_and_destination_disposition' };
      if (input.sourceCustody) {
        const retirement = await effects.retireCapture();
        if (retirement.status === 'progress' || retirement.status === 'retired') {
          if (retirement.removed > 0) return { status: 'progress', removed: retirement.removed };
        } else return { status: 'retained', removed: 0, custody: 'native_source_capture' };
      }
      // Child occurrence order is part of the closed native operation. Never deduplicate this sequence.
      for (const remove of effects.children) {
        const removed = await remove();
        if (removed > 0) return { status: 'progress', removed };
      }
      if (!(await effects.removeHead())) throw new Error('Locked Collection head still has undisposed local children');
      await effects.retireFence();
      return { status: 'purged', removed: 1 };
    },
    async advancePublication(_tx, _expected, phase, effects) {
      if (!(await effects.admit())) return false;
      const current = await effects.current();
      if (!current) return false;
      const changed = await effects.compareAndSet();
      if (changed && phase === 'refused') await effects.cancel(current.generation);
      return changed;
    },
    async updateRule(_tx, input, effects) {
      if (input.before.revision !== input.revision) return effects.conflict();
      if (await effects.unchanged()) return { value: input.before, changed: false };
      await effects.write();
      await effects.retirePublication();
      const value = await effects.readCurrent();
      if (input.before.visibility !== 'private') await effects.reducePublicSource();
      return { value, changed: true };
    },
  };
}
