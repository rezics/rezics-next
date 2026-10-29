import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import lock from './erasure-lock.sql';
import acknowledge from './erasure-acknowledge.sql';
import complete from './erasure-complete.sql';
import status from './erasure-status.sql';
import resolve from './erasure-resolve.sql';

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
export type RetentionException = {
  store: string;
  fields: readonly string[];
  purpose: string;
  expiresAt: Date;
};
type StoredException = Omit<RetentionException, 'expiresAt'> & { expiresAt: string };
export type ErasureStatus = {
  state: 'pending' | 'retention-outstanding' | 'complete';
  version: number;
  at: string;
  participants: Record<
    string,
    {
      outcome: ErasureOutcome | 'pending';
      retained: (StoredException & { resolvedAt: string | null; overdue: boolean })[];
    }
  >;
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

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);

function exceptions(input: readonly RetentionException[], outcome: ErasureOutcome): StoredException[] {
  if (!Array.isArray(input) || input.length > 16 || (outcome === 'none' && input.length > 0))
    throw new LifecycleDeniedError();
  const stores = new Set<string>();
  return Array.from(input)
    .map((entry) => {
      if (
        !entry ||
        !identifier(entry.store) ||
        stores.has(entry.store) ||
        !Array.isArray(entry.fields) ||
        entry.fields.length < 1 ||
        entry.fields.length > 32 ||
        !Array.from(entry.fields).every(identifier) ||
        typeof entry.purpose !== 'string' ||
        entry.purpose.length < 1 ||
        entry.purpose.length > 200 ||
        !(entry.expiresAt instanceof Date) ||
        !Number.isFinite(entry.expiresAt.getTime())
      )
        throw new LifecycleDeniedError();
      stores.add(entry.store);
      return {
        store: entry.store,
        fields: [...entry.fields].sort(),
        purpose: entry.purpose,
        expiresAt: entry.expiresAt.toISOString(),
      };
    })
    .sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : 0));
}

/** Internal platform work, called only after the owner's final purge transaction commits.
 * The acknowledgement itself is the permanent idempotency record, independent of receipts and DBOS history.
 */
export async function acknowledgeErasure(
  deps: { pool: Pool; clock?: () => Date },
  input: { accountId: string; participant: string; outcome: ErasureOutcome; retained?: readonly RetentionException[] },
) {
  const { accountId, participant, outcome } = input;
  const route = accountRoute(accountId);
  if (outcome !== 'erased' && outcome !== 'none') throw new LifecycleDeniedError();
  const retained = exceptions(input.retained === undefined ? [] : input.retained, outcome);
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
      if (retained.some((entry) => new Date(entry.expiresAt).getTime() <= new Date(record.at).getTime()))
        throw new LifecycleDeniedError();
      const rows = await acknowledge.run(tx, { ...key, participant, outcome, retained });
      const row = rows[0];
      if (!row || row.outcome !== outcome || canonicalize(row.retained) !== canonicalize(retained))
        throw new LifecycleDeniedError();
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

/** The owner calls this in a separate platform command after its expiry purge commits. */
export async function resolveRetention(
  deps: { pool: Pool; clock?: () => Date },
  input: { accountId: string; participant: string; store: string },
) {
  const { accountId, participant, store } = input;
  const route = accountRoute(accountId);
  if (!identifier(store)) throw new LifecycleDeniedError();
  return runCommand(
    deps.pool,
    {
      partition: partitionOf(route),
      clock: deps.clock,
      basis: { actorAccountId: '00000000-0000-8000-8000-000000000001', clientId: 'internal-access', requestedBy: null },
    },
    async (tx, { time }) => {
      const rows = await resolve.run(tx, {
        route,
        account_id: accountId,
        participant,
        store,
        at: authoritativeTimeValue(time),
      });
      const row = rows[0];
      if (!row) throw new LifecycleDeniedError();
      const value = { accountId, participant, store };
      if (!row.changed) return noEffect(value);
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
  const outcomes = row.outcomes as Record<
    string,
    { outcome: string; retained: StoredException[]; resolutions: Record<string, string> }
  >;
  let outstanding = false;
  const recorded = Object.fromEntries(
    participants(row.version).map((id) => {
      const ack = outcomes[id];
      if (ack && ack.outcome !== 'erased' && ack.outcome !== 'none') throw new LifecycleDeniedError();
      const outcome: ErasureOutcome | 'pending' = ack?.outcome ?? 'pending';
      return [
        id,
        {
          outcome,
          retained: (ack?.retained ?? []).map((entry) => {
            const resolved =
              ack && Object.hasOwn(ack.resolutions, entry.store) ? ack.resolutions[entry.store] : undefined;
            const resolvedAt = resolved ? new Date(resolved).toISOString() : null;
            if (resolvedAt === null) outstanding = true;
            return {
              ...entry,
              resolvedAt,
              overdue: resolvedAt === null && new Date(entry.expiresAt).getTime() < new Date(row.readAt).getTime(),
            };
          }),
        },
      ];
    }),
  );
  return {
    state: row.completedAt === null ? 'pending' : outstanding ? 'retention-outstanding' : 'complete',
    version: row.version,
    at: new Date(row.at).toISOString(),
    participants: recorded,
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
  };
}
