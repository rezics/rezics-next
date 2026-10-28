import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import lock from './erasure-lock.sql';
import acknowledge from './erasure-acknowledge.sql';
import complete from './erasure-complete.sql';
import status from './erasure-status.sql';

/** Append versions; never change a list used by a recorded erasure. */
export const ERASURE_PARTICIPANTS = Object.freeze({
  1: Object.freeze([
    'access',
    'auth',
    'library',
    'commerce',
    'content',
    'community',
    'semantic',
    'search',
    'imports',
    'shared-history',
    'delivery',
  ] as const),
});
export const ERASURE_PARTICIPANT_VERSION = 1;
export type ErasureOutcome = 'erased' | 'none';
export type ErasureStatus = {
  version: number;
  at: string;
  participants: Record<string, ErasureOutcome | 'pending'>;
  completedAt: string | null;
};

function participants(version: number): readonly string[] {
  const list = ERASURE_PARTICIPANTS[version as keyof typeof ERASURE_PARTICIPANTS];
  if (!list) throw new LifecycleDeniedError();
  return list;
}
function accountRoute(accountId: string): number {
  const route = routeOf(accountId);
  if (route === null) throw new LifecycleDeniedError();
  return route;
}

/** Internal platform work, called only after the owner's final purge transaction commits.
 * The acknowledgement itself is the permanent idempotency record, independent of receipts and DBOS history.
 */
export async function acknowledgeErasure(
  deps: { pool: Pool; clock?: () => Date },
  input: { accountId: string; participant: string; outcome: ErasureOutcome },
) {
  const { accountId, participant, outcome } = input;
  const route = accountRoute(accountId);
  if (outcome !== 'erased' && outcome !== 'none') throw new LifecycleDeniedError();
  return runCommand(
    deps.pool,
    {
      partition: partitionOf(route),
      clock: deps.clock,
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'internal-access',
        requestedBy: null,
      },
    },
    async (tx, { time }) => {
      const key = { route, account_id: accountId };
      const record = await lock.run(tx, key);
      if (!record || !participants(record.version).includes(participant)) throw new LifecycleDeniedError();
      const rows = await acknowledge.run(tx, { ...key, participant, outcome });
      const row = rows[0];
      if (!row || row.outcome !== outcome) throw new LifecycleDeniedError();
      const value = { accountId, participant, outcome };
      if (!row.inserted) return noEffect(value);
      await complete.run(tx, {
        ...key,
        participants: [...participants(record.version)],
        at: authoritativeTimeValue(time),
      });
      return {
        value,
        events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
      };
    },
  );
}

/** Internal/test read. One snapshot covers both the record and its bounded acknowledgement range. */
export async function readErasureStatus(client: AccessClient, accountId: string): Promise<ErasureStatus | null> {
  const row = await status.run(client, { route: accountRoute(accountId), account_id: accountId });
  if (!row) return null;
  const outcomes = row.outcomes as Record<string, ErasureOutcome>;
  return {
    version: row.version,
    at: new Date(row.at).toISOString(),
    participants: Object.fromEntries(participants(row.version).map((id) => [id, outcomes[id] ?? 'pending'])),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
  };
}
