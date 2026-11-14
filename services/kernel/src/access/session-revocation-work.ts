import type { WorkContext } from '../work/registry.ts';
import { sessionRevocationContinuation } from './lifecycle-review-source.ts';
import type { SuspensionValue } from './suspension.ts';

/** The trusted native Auth host, supplied by the Work composition. */
export type CommittedSessionRevocationWorkflow = {
  resumeCommittedSessionRevocation(input: { accountId: string; operationKey: string }): Promise<void>;
};

/** Work's effect workflow keeps the committed event as its durable input. Its
 * stable event identity and bounded DBOS step retries survive worker restarts. */
export function registerSessionRevocationWork(context: WorkContext, auth: CommittedSessionRevocationWorkflow): void {
  context.addEffects([
    {
      name: 'suspension_auth',
      types: ['com.rezics.access.account.suspended.v1'],
      async run(event) {
        const { accountId, receiptId, continuationOperationKey } = event.data as SuspensionValue;
        if (continuationOperationKey === undefined) return;
        const root = await sessionRevocationContinuation(context.pool, Date.now() + 10_000, {
          accountId,
          operationKey: continuationOperationKey,
        });
        if (!root || root.barrierReceiptId !== receiptId)
          throw new Error('Committed suspension continuation unavailable');
        await auth.resumeCommittedSessionRevocation({ accountId, operationKey: continuationOperationKey });
      },
    },
  ]);
}
