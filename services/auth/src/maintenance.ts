import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AuthService } from './index.ts';
import { createRetentionMaintenance } from './application/index.ts';
import { CONSENT_ERASURE_BATCH } from './consent-erasure.ts';
import { metadataConfigurationStores } from './metadata-scrub.ts';
import {
  WORKFLOW_RETENTION_WORKFLOW,
  WORKFLOW_RETENTION_SCHEDULE,
  WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
  type WorkflowRetentionConfig,
} from './contract/index.ts';
import { readWorkflowRetentionConfig } from './core/index.ts';

export const AUTH_SYSTEM_SCHEMA = 'auth_dbos';
export const AUTH_MAINTENANCE_SCHEDULE = 'auth-maintenance';
export const AUTH_MAINTENANCE_CRON = '0 * * * * *';

/** Register before the Auth executor launches. Each replayable purpose step
 * invokes exactly one bounded primitive; backlog waits for another native tick.
 * Only counts cross the DBOS boundary, never product rows or key material. */
export function registerAuthMaintenance(
  auth: AuthService,
  retention: WorkflowRetentionConfig = readWorkflowRetentionConfig(process.env),
  redrive = () => auth.internal.redriveNativeErasure(),
) {
  const step = (purpose: string, run: () => Promise<number>) =>
    DBOS.registerStep(
      async () => {
        try {
          return await run();
        } catch {
          // Provider errors may contain SQL parameters or credential material.
          throw new Error(`Auth maintenance failed: ${purpose}`);
        }
      },
      { name: `auth.maintenance.${purpose}`, retriesAllowed: false },
    );

  const sweepExpiredSessions = step('sweepExpiredSessions', () => auth.internal.pruneExpiredSessions(1000));
  const retentionMaintenance = createRetentionMaintenance({
    signing: auth.internal.signing,
    retainWorkflowHistory: (days) => auth.internal.retainWorkflowHistory(days),
  });
  const retireSigningKeys = step('retireSigningKeys', retentionMaintenance.retireSigningKeys);
  const sweepExpiredVerifications = step('sweepExpiredVerifications', () => auth.internal.pruneExpiredVerifications());
  const nativeErasure = step('nativeErasure', redrive);
  const kindConsent = step('kindConsentInvalidations', async () =>
    (await auth.internal.continueKindConsentInvalidations()) ? 1 : 0,
  );
  const sharedCopies = step('sharedCopies', () => auth.internal.redriveErasureHistory());
  const eraseDueConsents = step('eraseDueConsents', () => auth.internal.eraseDueConsents(CONSENT_ERASURE_BATCH));
  const scrubConfiguration = metadataConfigurationStores.map((store) =>
    step(`scrubConfiguration.${store}`, async () => (await auth.internal.scrubMetadataConfiguration(store)).changed),
  );
  const tick = DBOS.registerWorkflow(
    async (_scheduledAt: Date, _context: unknown): Promise<void> => {
      await sweepExpiredSessions();
      await retireSigningKeys();
      await sweepExpiredVerifications();
      for (const scrub of scrubConfiguration) await scrub();
      await nativeErasure();
      await kindConsent();
      if (await auth.internal.hasDueConsentErasure()) await eraseDueConsents();
      await sharedCopies();
    },
    { name: 'auth.maintenance.tick' },
  );

  const retainWorkflows = step('retainWorkflows', () =>
    retentionMaintenance.retainWorkflowHistory(retention.retentionDays),
  );
  const retentionTick = DBOS.registerWorkflow(
    async (_scheduledAt: Date, _context: unknown): Promise<void> => {
      await retainWorkflows();
    },
    {
      name: WORKFLOW_RETENTION_WORKFLOW,
    },
  );

  return {
    async start(schedule = AUTH_MAINTENANCE_CRON) {
      await DBOS.registerQueue(AUTH_MAINTENANCE_SCHEDULE, { globalConcurrency: 1, workerConcurrency: 1 });
      await DBOS.applySchedules([
        {
          scheduleName: AUTH_MAINTENANCE_SCHEDULE,
          workflowFn: tick,
          schedule,
          context: null,
          automaticBackfill: false,
          cronTimezone: 'UTC',
          queueName: AUTH_MAINTENANCE_SCHEDULE,
        },
        {
          scheduleName: WORKFLOW_RETENTION_SCHEDULE,
          workflowFn: retentionTick,
          schedule: WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
          context: null,
          automaticBackfill: false,
          cronTimezone: 'UTC',
          queueName: AUTH_MAINTENANCE_SCHEDULE,
        },
      ]);
    },
  };
}
