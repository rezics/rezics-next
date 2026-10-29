import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { WorkContext } from '../work/registry.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { createLifecycleInternals, LifecycleDeniedError } from './lifecycle.ts';
import { lifecycleExecutor } from './lifecycle-20261025094010-command.ts';
import read from './organization-close-read.sql';
import page from './organization-close-page.sql';
import finish from './organization-close-finish.sql';
import release from './organization-close-release.sql';
import inverse from './organization-close-inverse.sql';
import terminal from './membership-inverse-20261025093747-terminal.sql';

const workflowName = 'accounts.organization-close-page';
function allow(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}

/** Trusted recovery port. The close checkpoint is committed with the tombstone.
 * A page's receipt retains its release list before any actor anchor is checked
 * out. Replays finish that same list before advancing the durable random row-key cursor. */
export function createOrganizationCloseRunner(config: { pool: Pool; clock?: () => Date }) {
  const execute = lifecycleExecutor(config.pool, config.clock);
  const lifecycle = createLifecycleInternals({
    ...config,
    routeKey: new Uint8Array(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  async function step(organizationId: string, sequence: number) {
    const route = routeOf(organizationId);
    allow(route !== null && Number.isSafeInteger(sequence) && sequence >= 0);
    const key = `organization-close:${organizationId}:${sequence}`;
    const snapshot = await execute(
      { route, id: organizationId, kind: 'organization-close.page', key, input: { sequence } },
      async (tx, transactionId) => {
        const work = await read.run(tx, { route, organization_id: organizationId });
        allow(work && work.step === sequence && !work.complete);
        const result = await page.run(tx, { route, organization_id: organizationId, transaction_id: transactionId });
        allow(result);
        return {
          count: result.count,
          members: result.members as string[],
          handle: work.handle,
        };
      },
    );
    for (const accountId of snapshot.value.members) {
      const memberRoute = routeOf(accountId);
      allow(memberRoute !== null);
      const member = await withConnection(config.pool, (client) =>
        inverse.run(client, { route: memberRoute, account_id: accountId, organization_id: organizationId }),
      );
      if (!member) continue;
      // Immutable authority proof is read before the member's partition checkout.
      const proof = await withConnection(config.pool, (client) =>
        terminal.run(client, {
          route,
          group_id: organizationId,
          account_id: accountId,
          reservation_id: member.reservationId,
        }),
      );
      allow(proof);
      await execute(
        {
          route: memberRoute,
          id: accountId,
          kind: 'organization-close.release',
          key: `organization-close:${organizationId}:${member.reservationId}`,
          input: { organizationId, reservationId: member.reservationId },
        },
        async (tx, transactionId) => {
          // A concurrent ordinary release may already have removed this inverse.
          // Its immutable terminal proof and our native receipt make absence safe.
          await release.run(tx, {
            route: memberRoute,
            account_id: accountId,
            kind: 'organization',
            group_id: organizationId,
            reservation_id: member.reservationId,
            proof_transaction_id: proof.transactionId,
            transaction_id: transactionId,
          });
          return { accountId: accountId };
        },
      );
    }
    const complete = snapshot.value.count < 100;
    if (complete && snapshot.value.handle) {
      const work = await withConnection(config.pool, (client) =>
        read.run(client, { route, organization_id: organizationId }),
      );
      allow(work);
      await lifecycle.redirectHandle({
        accountId: organizationId,
        handle: snapshot.value.handle,
        key: work.handleKey,
      });
    }
    await execute(
      { route, id: organizationId, kind: 'organization-close.completed', key: `${key}:finish`, input: { sequence } },
      async (tx) => {
        await finish.run(tx, { route, organization_id: organizationId, step: sequence, complete });
        return { accountId: organizationId };
      },
    );
    return { count: snapshot.value.count, next: complete ? null : sequence + 1 };
  }
  return {
    step,
    async continueCommitted(organizationId: string) {
      const route = routeOf(organizationId);
      allow(route !== null);
      const work = await withConnection(config.pool, (client) =>
        read.run(client, { route, organization_id: organizationId }),
      );
      allow(work);
      if (work.complete) return;
      let sequence: number | null = work.step;
      while (sequence !== null) sequence = (await step(organizationId, sequence)).next;
    },
  };
}

export function registerOrganizationCloseWork(context: WorkContext): void {
  const runner = createOrganizationCloseRunner(context);
  const effect = DBOS.registerStep(runner.step, {
    name: `${workflowName}.run`,
    retriesAllowed: true,
    maxAttempts: 10,
    intervalSeconds: 1,
  });
  async function enqueue(organizationId: string, step: number) {
    await context.client.enqueue(
      {
        workflowName,
        queueName: 'workflows',
        workflowID: `${workflowName}:${organizationId}:${step}`,
        workflowIDReusePolicy: 'return-existing',
      },
      organizationId,
      step,
    );
  }
  DBOS.registerWorkflow(
    async (organizationId: string, step: number) => {
      const result = await effect(organizationId, step);
      if (result.next !== null) await enqueue(organizationId, result.next);
    },
    { name: workflowName },
  );
  context.addEffects([
    {
      name: 'organization_close',
      types: ['com.rezics.access.account-tombstoned.v1'],
      async run(event) {
        const { accountId } = event.data as { accountId: string };
        const route = routeOf(accountId);
        allow(route !== null);
        const work = await withConnection(context.pool, (client) =>
          read.run(client, { route, organization_id: accountId }),
        );
        if (work && !work.complete) await enqueue(accountId, work.step);
      },
    },
  ]);
}
