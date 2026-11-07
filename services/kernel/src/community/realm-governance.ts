import { memoizedValue } from '../memoized.ts';
import { ProblemError } from '../http/problem-error.ts';
import { GrantDeniedError } from '../access/resource-access-errors.ts';
import { authoritativeTimeValue, type CommandAuthorization } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import type { RealmContinuity } from './contract/index.ts';
import lock from './realm-continuity-lock.sql';

export type { RealmContinuity } from './contract/index.ts';

export function RealmReadOnlyError() {
  return memoizedValue(
    RealmReadOnlyError,
    () =>
      class RealmReadOnlyError extends ProblemError {
        constructor() {
          super('conflict', {
            detail: 'This Realm is orphaned and governance is read-only pending a platform ownership decision.',
          });
          this.name = 'RealmReadOnlyError';
        }
      },
  );
}
export type RealmReadOnlyError = InstanceType<ReturnType<typeof RealmReadOnlyError>>;

export function realmContinuityView(row: {
  ownership_state: string;
  orphaned_at: string | null;
  claim_eligible_at: string | null;
}): RealmContinuity {
  if (row.ownership_state !== 'owned' && row.ownership_state !== 'orphaned')
    throw new Error('Invalid native Realm ownership decision');
  return {
    ownershipState: row.ownership_state,
    orphanedAt: row.orphaned_at === null ? null : new Date(row.orphaned_at).toISOString(),
    claimEligibleAt: row.claim_eligible_at === null ? null : new Date(row.claim_eligible_at).toISOString(),
    governanceReadOnly: row.ownership_state === 'orphaned',
  };
}

/** The transaction rechecks and locks the same native identity before receipt replay
 * or a new write. A concurrent succession cannot slip between this check and commit.
 * This guard consumes ordinary Access authorization; it grants no action itself.
 */
export function realmGovernanceAuthorization(
  authorization: CommandAuthorization,
  resource: Resource,
): CommandAuthorization {
  return {
    ...authorization,
    async authorize(tx, attempt, proof) {
      const outcome = await authorization.authorize(tx, attempt, proof);
      const row = await lock.run(tx, {
        route: resource.route,
        id: resource.id,
        at: authoritativeTimeValue(attempt.time),
      });
      if (!row) throw new GrantDeniedError();
      if (row.ownership_state !== 'owned') throw new (RealmReadOnlyError())();
      return outcome;
    },
  };
}
