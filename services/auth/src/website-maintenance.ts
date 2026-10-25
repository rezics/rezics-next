import { DBOS, type DBOSClient } from '@dbos-inc/dbos-sdk';

export const WEBSITE_MAINTENANCE_WORKFLOW = 'accounts.website-protocol-expiry';

/** Trusted host composition supplies the Auth-owned bounded primitive. Only
 * counts enter durable history; no tokens, cookies or database credentials do.
 * Structurally compatible with the single kernel worker's WorkModule contract.
 */
export function websiteMaintenanceModule(port: { pruneExpiredProtocolState(batch: number): Promise<number> }) {
  return {
    name: 'accounts.website-protocol',
    async register(context: {
      readonly queues: Readonly<Record<string, unknown>>;
      readonly client: Pick<DBOSClient, 'applySchedules'>;
    }) {
      if (!Object.hasOwn(context.queues, 'maintenance'))
        throw new Error('Website protocol expiry requires the maintenance queue');
      const sweep = DBOS.registerStep(
        async () => {
          try {
            return await port.pruneExpiredProtocolState(1000);
          } catch {
            throw new Error('Website protocol expiry failed');
          }
        },
        { name: `${WEBSITE_MAINTENANCE_WORKFLOW}.batch`, retriesAllowed: false },
      );
      DBOS.registerWorkflow(async (_scheduledAt: Date, _context: null) => sweep(), {
        name: WEBSITE_MAINTENANCE_WORKFLOW,
      });
      await context.client.applySchedules([
        {
          scheduleName: WEBSITE_MAINTENANCE_WORKFLOW,
          workflowName: WEBSITE_MAINTENANCE_WORKFLOW,
          schedule: '* * * * *',
          context: null,
          automaticBackfill: false,
          cronTimezone: 'UTC',
          queueName: 'maintenance',
        },
      ]);
    },
  };
}
