import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AuthService } from './index.ts';
import { SigningRotationPending } from './signing.ts';

export const AUTH_SYSTEM_SCHEMA = 'auth_dbos';
export const AUTH_MAINTENANCE_SCHEDULE = 'auth-maintenance';
export const AUTH_MAINTENANCE_CRON = '0 * * * * *';

/** Register before the Auth executor launches. Each replayable purpose step
 * invokes exactly one bounded primitive; backlog waits for another native tick.
 * Only counts cross the DBOS boundary, never product rows or key material. */
export function registerAuthMaintenance(auth: AuthService) {
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
  const tick = DBOS.registerWorkflow(
    async (_scheduledAt: Date, _context: unknown): Promise<void> => {
      await sweepExpiredSessions();
      await retireSigningKeys();
      await sweepExpiredVerifications();
    },
    { name: 'auth.maintenance.tick' },
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
      ]);
    },
  };
}
