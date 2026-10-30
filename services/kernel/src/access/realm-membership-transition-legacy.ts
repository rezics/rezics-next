import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { withConnection } from '../database/pool.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import { routeOf } from '../route/route.ts';
import { lifecycleExecutor, LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import accountRead from './lifecycle-account.sql';
import page from './realm-membership-transition-legacy-page.sql';
import redrive from './realm-membership-transition-legacy-redrive.sql';
import progressRead from './realm-membership-transition-legacy-progress.sql';
import adopt from './realm-membership-transition-legacy-adopt.sql';
import record from './realm-membership-transition-legacy-record.sql';
import advance from './realm-membership-transition-legacy-advance.sql';
import {
  first,
  createRealmMembershipTransitions,
  type RealmMembershipTransition,
  type RealmTransitionAuthority,
} from './realm-membership-transition.ts';
import type { WorkContext } from '../work/registry.ts';
import type { RealmMembershipCommands } from './membership-work.ts';

const SCOPE = 'access.realm-membership.reconciliation';
export const REALM_MEMBERSHIP_LEGACY_PAGE = 32;
export const REALM_MEMBERSHIP_RECONCILIATION_WORKFLOW_NAME = 'accounts.realm-membership.reconcile';
export type RealmMembershipReconciliationInput = { accountId: string; cursor?: string | null; redrive?: boolean };
export type RealmMembershipReconciliationResult = Awaited<
  ReturnType<ReturnType<typeof createRealmMembershipReconciler>['page']>
>;
type State = 'published' | 'cancelled' | 'pending' | 'uncertain';
type Item = { reservationId: string; realmId: string; holdTransactionId: string };
type Cursor = { accountId: string; barrierId: string; afterId: string | null; redrive: boolean };
function allowed(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}
/** INTERNAL deployment coordinator. Install only behind the existing stopped-old-
 * writer barrier. The barrier name is deployment configuration, never user data.
 * Each page and each source point commits resumably; no completeness bit certifies
 * a hold. Unresolved items persist separately and are explicitly redrivable. */
export function createRealmMembershipReconciler(config: {
  pool: Pool;
  keys: KeyRing;
  barrierId: string;
  authority: RealmTransitionAuthority;
  certify(input: RealmMembershipTransition, key: string): Promise<'published' | 'cancelled'>;
}) {
  allowed(config.barrierId.length > 0 && config.barrierId.length <= 128);
  const execute = lifecycleExecutor(config.pool);
  const transitions = createRealmMembershipTransitions(config);
  const key = (part: string) => 'legacy:' + createHash('sha256').update(`${config.barrierId}:${part}`).digest('hex');
  return {
    async page(input: RealmMembershipReconciliationInput) {
      const observation = crypto.randomUUID();
      const route = routeOf(input.accountId);
      allowed(route !== null);
      const identity = { route, account_id: input.accountId, barrier_id: config.barrierId };
      const saved = await withConnection(config.pool, async (client) =>
        first(await progressRead.run(client, identity)),
      );
      let cursor: Cursor = {
        accountId: input.accountId,
        barrierId: config.barrierId,
        afterId: input.redrive ? null : (saved?.afterId ?? null),
        redrive: input.redrive === true,
      };
      if (input.cursor) {
        const decoded = unseal(config.keys, SCOPE, input.cursor) as Cursor | undefined;
        allowed(
          decoded &&
            decoded.accountId === input.accountId &&
            decoded.barrierId === config.barrierId &&
            decoded.redrive === cursor.redrive &&
            (decoded.afterId === null || routeOf(decoded.afterId) === route),
        );
        if (!cursor.redrive) allowed(decoded.afterId === cursor.afterId);
        cursor = decoded;
      }
      if (!cursor.redrive && saved?.completed) return { cursor: null, completed: true, items: [] };
      const rows = await withConnection(config.pool, (client) =>
        (cursor.redrive ? redrive : page).run(client, {
          ...identity,
          after_id: cursor.afterId ?? '',
          sentinel: REALM_MEMBERSHIP_LEGACY_PAGE + 1,
        }),
      );
      allowed(rows.every((item) => item.admitted));
      const items: (Item & { state: State })[] = [];
      for (const item of rows.slice(0, REALM_MEMBERSHIP_LEGACY_PAGE)) {
        const transition: RealmMembershipTransition = {
          accountId: input.accountId,
          principal: { kind: 'realm', id: item.realmId },
          reservationId: item.reservationId,
          transition: { generationId: item.reservationId, operationId: `legacy:${item.holdTransactionId}` },
        };
        let state: State = 'uncertain';
        if (item.provenanceValid)
          try {
            await execute(
              {
                route,
                id: input.accountId,
                kind: 'realm-membership-legacy-adopted',
                key: key(`adopt:${item.reservationId}`),
                input: transition,
              },
              async (tx) => {
                const account = await accountRead.run(tx, { route, account_id: input.accountId });
                allowed(account && account.state === 'active' && !account.fenced);
                allowed(
                  first(
                    await adopt.run(tx, {
                      ...identity,
                      realm_id: item.realmId,
                      reservation_id: item.reservationId,
                      operation_id: transition.transition.operationId,
                      hold_transaction_id: item.holdTransactionId,
                    }),
                  ),
                );
                return transition;
              },
            );
            state = await config.certify(transition, key(`source:${item.reservationId}`));
            await transitions.consume({ ...transition, key: key(`consume:${item.reservationId}`) });
          } catch (error) {
            state =
              error && typeof error === 'object' && 'state' in error && error.state === 'pending'
                ? 'pending'
                : 'uncertain';
          }
        await execute(
          {
            route,
            id: input.accountId,
            kind: 'realm-membership-legacy-recorded',
            key: key(`record:${item.reservationId}:${observation}`),
            input: { ...item, state },
          },
          async (tx) => {
            await accountRead.run(tx, { route, account_id: input.accountId });
            await record.run(tx, {
              ...identity,
              realm_id: item.realmId,
              reservation_id: item.reservationId,
              hold_transaction_id: item.holdTransactionId,
              state,
            });
            return {
              accountId: input.accountId,
              reservationId: item.reservationId,
              realmId: item.realmId,
              holdTransactionId: item.holdTransactionId,
              state,
            };
          },
        );
        items.push({ ...item, state });
      }
      const afterId = items.at(-1)?.reservationId ?? cursor.afterId;
      const completed = rows.length <= REALM_MEMBERSHIP_LEGACY_PAGE;
      if (!cursor.redrive)
        await execute(
          {
            route,
            id: input.accountId,
            kind: 'realm-membership-legacy-page',
            key: key(`page:${cursor.afterId ?? 'start'}`),
            input: { afterId, completed, previous: cursor.afterId },
          },
          async (tx) => {
            await accountRead.run(tx, { route, account_id: input.accountId });
            allowed(
              first(
                await advance.run(tx, {
                  ...identity,
                  after_id: afterId ?? '',
                  previous_id: cursor.afterId ?? '',
                  completed,
                }),
              ),
            );
            return { afterId, completed };
          },
        );
      return { cursor: completed ? null : seal(config.keys, SCOPE, { ...cursor, afterId }), completed, items };
    },
  };
}

/** Registered on the normal Accounts host, not a public deletion command. The
 * deployment submits an actor and resumes the returned opaque cursor. No source
 * checkout is held while actor progress/consumption is committed. */
export function registerRealmMembershipReconciliation(
  context: WorkContext,
  realm: RealmMembershipCommands,
  keys: KeyRing,
) {
  const step = DBOS.registerStep(
    async (input: RealmMembershipReconciliationInput) => {
      const barrierId = context.env.KERNEL_REALM_MEMBERSHIP_BARRIER;
      if (!barrierId || !realm.certifyLegacy || !realm.authority.readTransition) throw new LifecycleDeniedError();
      return createRealmMembershipReconciler({
        pool: context.pool,
        keys,
        barrierId,
        authority: { readTransition: realm.authority.readTransition },
        certify: realm.certifyLegacy,
      }).page(input);
    },
    { name: 'accounts.realm-membership.reconcile.page', retriesAllowed: false },
  );
  return DBOS.registerWorkflow(async (input: RealmMembershipReconciliationInput) => step(input), {
    name: REALM_MEMBERSHIP_RECONCILIATION_WORKFLOW_NAME,
  });
}
