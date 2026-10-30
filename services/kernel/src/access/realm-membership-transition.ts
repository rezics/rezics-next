import type { Pool } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { deadlineClient } from './authenticate.ts';
import { routeOf } from '../route/route.ts';
import { LifecycleDeniedError, lifecycleExecutor } from './lifecycle-20261025094010-command.ts';
import type { MembershipReservation } from './membership-inverse.ts';
import accountRead from './lifecycle-account.sql';
import read from './realm-membership-transition-read.sql';
import consume from './realm-membership-transition-consume.sql';

export type RealmMembershipTransition = MembershipReservation & {
  transition: { generationId: string; operationId: string };
};
export type RealmMembershipProof = RealmMembershipTransition & {
  transactionId: string;
  outcome: 'published' | 'cancelled';
  publicationTransactionId: string | null;
};
export type RealmTransitionAuthority = {
  readTransition(client: AccessClient, input: RealmMembershipTransition): Promise<RealmMembershipProof | null>;
};
export function transitionParameters(input: RealmMembershipTransition) {
  const route = routeOf(input.accountId);
  if (
    route === null ||
    input.principal.kind !== 'realm' ||
    routeOf(input.principal.id) === null ||
    routeOf(input.reservationId) !== route ||
    routeOf(input.transition?.generationId) !== route ||
    typeof input.transition?.operationId !== 'string' ||
    !input.transition.operationId.length ||
    input.transition.operationId.length > 256
  )
    throw new LifecycleDeniedError();
  return {
    route,
    account_id: input.accountId,
    realm_id: input.principal.id,
    reservation_id: input.reservationId,
    generation_id: input.transition.generationId,
    operation_id: input.transition.operationId,
  };
}
export function first<T>(value: T | readonly T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value as T | null);
}
/** A released exact preflight, never held across the foreign command. Source
 * proof uniqueness serializes a delayed publisher against consume/cancellation. */
export async function isRealmTransitionOpen(
  pool: Pool,
  input: RealmMembershipTransition,
  deadline = deadlineFor(30_000),
): Promise<boolean> {
  const row = first(await read.run(deadlineClient(pool, deadline), transitionParameters(input)));
  return !!row && row.active && row.held && row.proofTransactionId === null;
}
export function createRealmMembershipTransitions(config: {
  pool: Pool;
  authority: RealmTransitionAuthority;
  clock?: () => Date;
}) {
  const execute = lifecycleExecutor(config.pool, config.clock);
  async function proof(input: RealmMembershipTransition, deadline = deadlineFor(30_000)) {
    transitionParameters(input);
    // Source connection is returned before any actor-anchor command starts.
    const value = await config.authority.readTransition(deadlineClient(config.pool, deadline), input);
    if (!value) return null;
    if (
      value.accountId !== input.accountId ||
      value.principal.kind !== 'realm' ||
      value.principal.id !== input.principal.id ||
      value.reservationId !== input.reservationId ||
      value.transition.generationId !== input.transition.generationId ||
      value.transition.operationId !== input.transition.operationId ||
      routeOf(value.transactionId) === null ||
      !['published', 'cancelled'].includes(value.outcome)
    )
      throw new LifecycleDeniedError();
    return value;
  }
  return {
    proof,
    async consume(input: RealmMembershipTransition & { key: string; proofTransactionId?: string }) {
      const parameters = transitionParameters(input);
      const deadline = deadlineFor(30_000);
      const value = await proof(input, deadline);
      if (!value || (input.proofTransactionId !== undefined && input.proofTransactionId !== value.transactionId))
        throw new LifecycleDeniedError();
      return execute(
        {
          route: parameters.route,
          id: input.accountId,
          kind: 'realm-membership-transition-consumed',
          key: input.key,
          deadline,
          input: { ...parameters, proofTransactionId: value.transactionId, outcome: value.outcome },
        },
        async (tx, transactionId) => {
          const account = await accountRead.run(tx, { route: parameters.route, account_id: input.accountId });
          if (!account) throw new LifecycleDeniedError();
          const row = first(
            await consume.run(tx, {
              ...parameters,
              proof_transaction_id: value.transactionId,
              outcome: value.outcome,
              transaction_id: transactionId,
            }),
          );
          if (!row) throw new LifecycleDeniedError();
          return {
            accountId: input.accountId,
            principal: input.principal,
            reservationId: input.reservationId,
            transition: input.transition,
            proofTransactionId: value.transactionId,
            outcome: value.outcome,
          };
        },
      );
    },
  };
}
