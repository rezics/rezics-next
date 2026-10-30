import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AuthService } from './index.ts';
import { SigningRotationPending } from './signing.ts';
import { CONSENT_ERASURE_BATCH } from './consent-erasure.ts';
import {
  readWorkflowRetentionConfig,
  runWorkflowRetentionSweep,
  WORKFLOW_RETENTION_WORKFLOW,
  WORKFLOW_RETENTION_SCHEDULE,
  WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
  type WorkflowRetentionConfig,
} from './retention.ts';

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
  const retireSigningKeys = step('retireSigningKeys', async () => {
    // The live singleton has at most three slots. CAS and retention are owned by
    // the signing primitive; no archive enumeration or key rows enter history.
    try {
      const state = await auth.internal.signing.status();
      if (!state.retiring) return 0;
      await auth.internal.signing.prune({ expectedGeneration: state.generation });
      return 1;
    } catch (error) {
      if (error instanceof SigningRotationPending) return 0;
      throw error;
    }
  });
  const sweepExpiredVerifications = step('sweepExpiredVerifications', () => auth.internal.pruneExpiredVerifications());
  const nativeErasure = step('nativeErasure', redrive);
  const eraseDueConsents = step('eraseDueConsents', () => auth.internal.eraseDueConsents(CONSENT_ERASURE_BATCH));
  const tick = DBOS.registerWorkflow(
    async (_scheduledAt: Date, _context: unknown): Promise<void> => {
      await sweepExpiredSessions();
      await retireSigningKeys();
      await sweepExpiredVerifications();
      await nativeErasure();
      if (await auth.internal.hasDueConsentErasure()) await eraseDueConsents();
    },
    { name: 'auth.maintenance.tick' },
  );

  const retainWorkflows = step('retainWorkflows', () => runWorkflowRetentionSweep(retention.retentionDays));
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
