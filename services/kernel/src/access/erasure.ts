import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkModule } from '../work/registry.ts';
import { LOCATOR_EFFECTS_QUEUE } from '../work/queues.ts';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  authoritativeTimeValue,
  currentCommand,
  hasLiveCommandTransaction,
  noEffect,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import lock from './erasure-lock.sql';
import acknowledge from './erasure-acknowledge.sql';
import complete from './erasure-complete.sql';
import status from './erasure-status.sql';
import resolve from './erasure-resolve.sql';
import recordLate from './erasure-late-record.sql';
import resolveLate from './erasure-late-resolve.sql';
import snapshotFrontier from './erasure-frontier-snapshot.sql';
import deliverFrontier from './erasure-frontier-delivered.sql';
import pendingLocator from './erasure-frontier-work.sql';

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
/** Owners register every effect that writes cross-partition erasure locators here. */
export const ERASURE_LOCATOR_EFFECTS: ReadonlySet<string> = new Set<string>();
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
  outstanding: { lateItems: boolean; effectsFrontier: boolean };
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
      const pending = await pendingLocator.run(tx, { ...key, queue: LOCATOR_EFFECTS_QUEUE });
      if (pending && !pending.pending)
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
  const row = await status.run(client, {
    route: accountRoute(accountId),
    account_id: accountId,
    queue: LOCATOR_EFFECTS_QUEUE,
  });
  if (!row) return null;
  const outcomes = row.outcomes as Record<
    string,
    { outcome: string; retained: StoredException[]; resolutions: Record<string, string> }
  >;
  let outstanding = false;
  const recorded = Object.fromEntries(
    participants(row.version).map((id) => {
      const ack = outcomes[id];
      let outcome: ErasureOutcome | 'pending' = 'pending';
      if (ack) {
        if (ack.outcome !== 'erased' && ack.outcome !== 'none') throw new LifecycleDeniedError();
        outcome = ack.outcome;
      }
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
    outstanding: { lateItems: row.lateItems, effectsFrontier: row.effectsFrontier },
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
  };
}

type LateErasureItem = { accountId: string; participant: string; locator: string };
function lateKey(input: LateErasureItem) {
  if (typeof input.locator !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(input.locator))
    throw new LifecycleDeniedError();
  return {
    route: accountRoute(input.accountId),
    account_id: input.accountId,
    participant: input.participant,
    locator: input.locator,
  };
}

/** Call with the live home command holding the participant's locator fence. Ids only, never personal payload. */
export async function recordLateErasureItem(tx: CommandTransaction, input: LateErasureItem): Promise<void> {
  const key = lateKey(input);
  if (!hasLiveCommandTransaction(tx) || currentCommand(tx).partition !== partitionOf(key.route))
    throw new LifecycleDeniedError();
  const record = await lock.run(tx, key);
  if (!record || !participants(record.version).includes(input.participant)) throw new LifecycleDeniedError();
  await recordLate.run(tx, key);
}

/** Internal platform command, only after the copy's minimization or purge commits. */
export async function resolveLateErasureItem(deps: { pool: Pool; clock?: () => Date }, input: LateErasureItem) {
  const key = lateKey(input);
  return runCommand(
    deps.pool,
    {
      partition: partitionOf(key.route),
      clock: deps.clock,
      basis: { actorAccountId: '00000000-0000-8000-8000-000000000001', clientId: 'internal-access', requestedBy: null },
    },
    async (tx, { time }) => {
      const record = await lock.run(tx, key);
      if (!record || !participants(record.version).includes(input.participant)) throw new LifecycleDeniedError();
      const rows = await resolveLate.run(tx, { ...key, at: authoritativeTimeValue(time) });
      const row = rows[0];
      if (!row) throw new LifecycleDeniedError();
      if (!row.changed) return noEffect(input);
      return {
        value: input,
        events: [
          {
            type: 'com.rezics.access.account-updated.v1',
            subject: input.accountId,
            data: { accountId: input.accountId },
          },
        ],
      };
    },
  );
}

/** One durable terminal-work step; requests never drive completion. */
export async function advanceErasureCompletion(deps: { pool: Pool; clock?: () => Date }, accountId: string) {
  const key = { route: accountRoute(accountId), account_id: accountId };
  return runCommand(
    deps.pool,
    {
      partition: partitionOf(key.route),
      clock: deps.clock,
      basis: { actorAccountId: '00000000-0000-8000-8000-000000000001', clientId: 'internal-access', requestedBy: null },
    },
    async (tx, { time }) => {
      const record = await lock.run(tx, key);
      if (!record) throw new LifecycleDeniedError();
      if (record.completedAt !== null) return noEffect(true);
      let changed = false;
      if (record.frontier === null) {
        await snapshotFrontier.run(tx, key);
        changed = true;
      }
      const delivered = await deliverFrontier.run(tx, key);
      changed ||= delivered !== null;
      const pending = await pendingLocator.run(tx, { ...key, queue: LOCATOR_EFFECTS_QUEUE });
      let done = false;
      if (pending && !pending.pending) {
        const completed = await complete.run(tx, {
          ...key,
          participants: [...participants(record.version)],
          at: authoritativeTimeValue(time),
        });
        done = completed !== null;
        changed ||= done;
      }
      if (!changed) return noEffect(false);
      return {
        value: done,
        events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
      };
    },
  );
}

/** The terminal workflow survives retries and completion is independent of retained DBOS history. */
export const erasureWorkModule: WorkModule = {
  name: 'account_erasure',
  register(context) {
    const advance = DBOS.registerStep(
      async (accountId: string) => (await advanceErasureCompletion({ pool: context.pool }, accountId)).value,
      { name: 'access.erasure.advance', retriesAllowed: true, maxAttempts: 10 },
    );
    DBOS.registerWorkflow(
      async (accountId: string) => {
        while (!(await advance(accountId))) await DBOS.sleep(1);
      },
      { name: 'access.erasure' },
    );
    context.addEffects([
      {
        name: 'account_erasure',
        types: ['com.rezics.access.account-tombstoned.v1'],
        async run(event) {
          const { accountId } = event.data as { accountId: string };
          await context.client.enqueue(
            {
              workflowName: 'access.erasure',
              workflowID: `erasure:${accountId}`,
              workflowIDReusePolicy: 'return-existing',
              queueName: 'maintenance',
            },
            accountId,
          );
        },
      },
    ]);
  },
};
