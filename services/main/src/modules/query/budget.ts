import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { RESOURCE_LIST_COST } from './resource-contract.ts';

/** Includes readiness/health, graph position, hydration and final fences. The
 * WorkReadSession retries and nested owners debit this same allocation. */
export function withResourceListBudget<T>(read: () => Promise<T>, scope: 'global' | 'realm' = 'global'): Promise<T> {
  const outer = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(RESOURCE_LIST_COST.deadlineMs);
  let callsLeft: number = RESOURCE_LIST_COST.graphCalls
    + (scope === 'realm' ? RESOURCE_LIST_COST.realmGraphCalls : 0);
  let bytesLeft: number = RESOURCE_LIST_COST.graphBytes;
  return fusekiReadBudget.run(
    {
      signal: outer ? AbortSignal.any([deadline, outer.signal]) : deadline,
      get callsLeft() {
        return Math.min(callsLeft, outer?.callsLeft ?? callsLeft);
      },
      set callsLeft(value) {
        const used = this.callsLeft - value;
        callsLeft -= used;
        if (outer) outer.callsLeft -= used;
      },
      get bytesLeft() {
        return Math.min(bytesLeft, outer?.bytesLeft ?? bytesLeft);
      },
      set bytesLeft(value) {
        const used = this.bytesLeft - value;
        bytesLeft -= used;
        if (outer) outer.bytesLeft -= used;
      },
    },
    read,
  );
}
