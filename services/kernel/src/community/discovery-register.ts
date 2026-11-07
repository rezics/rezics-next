import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { projectRealmDiscovery } from './discovery-projection.ts';
import { expireRealmDiscovery } from './discovery-expiry.ts';
import { routeOf } from '../route/route.ts';
import type { CommunityAmbient } from './ambient.ts';

const CHANGED = 'com.rezics.community.realm-discovery.changed.v1';
const PROJECT = 'community.discovery.project';
const EXPIRE = 'community.discovery.expire';

/** Source events wake the genuine log reader; neither event data nor a timer is contribution authority. */
export async function registerDiscoveryWork(context: WorkContext, ambient: CommunityAmbient): Promise<void> {
  const project = DBOS.registerStep(
    async (realmId: string) =>
      projectRealmDiscovery(context.pool, realmId, { clock: context.clock, deadlineNow: ambient.deadlineNow }),
    { name: 'community.discovery.apply', ...COMMAND_STEP_RETRIES },
  );
  const enqueue = DBOS.registerStep(
    async (realmId: string) => {
      // Each bounded continuation has its own durable identity, avoiding an unbounded workflow history.
      await context.client.enqueue(
        {
          workflowName: PROJECT,
          queueName: 'maintenance',
          workflowID: `community:discovery:${createHash('sha256').update(`${realmId}:${DBOS.workflowID}`).digest('hex')}`,
          workflowIDReusePolicy: 'return-existing',
        },
        realmId,
      );
    },
    { name: 'community.discovery.continue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (realmId: string) => {
      if (await project(realmId)) await enqueue(realmId);
    },
    { name: PROJECT },
  );
  const expire = DBOS.registerStep(
    async () => expireRealmDiscovery(context.pool, { clock: context.clock, deadlineNow: ambient.deadlineNow }),
    { name: 'community.discovery.expiry-step', ...COMMAND_STEP_RETRIES },
  );
  // No draining loop: the next schedule continues the indexed due frontier, at most fifty keys per tick.
  DBOS.registerWorkflow(
    async () => {
      await expire();
    },
    { name: EXPIRE },
  );
  context.addEffects([
    {
      name: 'community_realm_discovery',
      types: [CHANGED],
      async run(event) {
        const realmId = (event.data as { realmId?: unknown })?.realmId;
        if (typeof realmId !== 'string' || routeOf(realmId) === null || event.subject !== realmId)
          throw new TypeError('Invalid Realm discovery wake identity');
        await context.client.enqueue(
          {
            workflowName: PROJECT,
            queueName: 'maintenance',
            workflowID: `community:discovery:${event.id}`,
            workflowIDReusePolicy: 'return-existing',
          },
          realmId,
        );
      },
    },
  ]);
  await context.client.applySchedules([
    {
      scheduleName: 'community.discovery.expiry',
      workflowName: EXPIRE,
      schedule: '* * * * *',
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}
