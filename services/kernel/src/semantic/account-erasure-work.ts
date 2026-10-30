import { DBOS } from '@dbos-inc/dbos-sdk';
import { noEffect, runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { readSemanticErasure, stepSemanticErasure, SEMANTIC_ERASURE_PROGRESS } from './account-erasure.ts';

const workflowName = 'semantic.erasure.local';

/** One durable step per bounded native page, using the single shared executor and existing effects queue. */
export function registerSemanticErasureWork({ pool, client }: WorkContext) {
  const step = DBOS.registerStep(async (accountId: string) => stepSemanticErasure(pool, accountId, 'workflow'), {
    name: 'semantic.erasure.local.step',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 10,
  });
  DBOS.registerWorkflow(
    async ({ accountId }: { accountId: string }) => {
      while (!(await step(accountId)).localComplete) {
        // Each await is a separate persisted DBOS step, not a nested native page or held connection.
      }
    },
    { name: workflowName },
  );

  return async (accountId: string) => {
    const progress = await readSemanticErasure(pool, accountId);
    if (!progress) throw new TypeError('Semantic erasure has not begun');
    if (progress.state === 'pending-shared-custody') return;
    const route = routeOf(accountId)!;
    const partition = partitionOf(route);
    const workflowId = `semantic:erasure:${accountId}:${progress.at}`;
    // This is an exact pending work locator, never a claim that enqueueing or shared minimization succeeded.
    // It commits before enqueue; a crash is retried by the existing scheduled effect with the same native ID.
    await runCommand(
      pool,
      {
        partition,
        basis: {
          actorAccountId: '00000000-0000-8000-8000-000000000001',
          clientId: 'internal-semantic-erasure',
          requestedBy: null,
        },
      },
      async (tx) => {
        await tx.query('SET LOCAL enable_seqscan=off');
        const recorded = await tx.query(
          `UPDATE semantic.erasure_progress SET workflow_id=$3
          WHERE route=$1 AND account_id=$2 AND workflow_id IS NULL RETURNING account_id`,
          [route, accountId, workflowId],
        );
        if (!recorded.rowCount) return noEffect(null);
        return {
          value: null,
          events: [{ type: SEMANTIC_ERASURE_PROGRESS, subject: accountId, data: { accountId } }],
        };
      },
    );
    await client.enqueue(
      {
        queueName: 'effects',
        workflowName,
        workflowID: workflowId,
        workflowIDReusePolicy: 'return-existing',
        queuePartitionKey: `semantic_erasure_local:${partition}`,
      },
      { accountId },
    );
  };
}
