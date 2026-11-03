import type { Pool } from 'pg';
import { accessEvidence } from './evidence.ts';
import type { AccessClient } from '../request/access.ts';
import { derivedId, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import { LifecycleDeniedError, lifecycleExecutor } from './lifecycle-20261025094010-command.ts';
import transitionAcquire from './realm-membership-transition-acquire.sql';
import {
  first,
  createRealmMembershipTransitions,
  type RealmMembershipTransition,
  type RealmTransitionAuthority,
} from './realm-membership-transition.ts';
import accountRead from './lifecycle-account.sql';
import read from './membership-inverse-20261025093747-read.sql';
import ready from './membership-inverse-ready.sql';
import reserve from './membership-inverse-20261025093747-reserve.sql';
import release from './membership-inverse-20261025093747-release.sql';
import terminal from './membership-inverse-20261025093747-terminal.sql';
import change from './membership-inverse-20261025093747-bootstrap.sql';
import reservationRead from './membership-inverse-20261025095033-reservation.sql';

export const MEMBERSHIP_LIMIT = 1000;
export type MembershipPrincipal = { kind: 'organization' | 'realm'; id: string };
export type MembershipReservation = {
  accountId: string;
  principal: MembershipPrincipal;
  reservationId: string;
  transition?: { generationId: string; operationId: string };
};
export type MembershipAdmission = { accountId: string; principal: MembershipPrincipal; key: string };
export type MembershipRelease = MembershipReservation & { key: string };
/** A source membership transaction is the resumable item cursor, not a claim of
 * whole-stream completeness. The coordinator persists its outer source cursor
 * only after this command commits; repeats return the same native receipt. */
export type MembershipBootstrapStep = MembershipAdmission & { sourceTransactionId: string };
export class MembershipLimitError extends Error {
  readonly code = 'membership_limit';
  constructor() {
    super('An account may hold at most 1000 organization and role-bearing Realm memberships');
    this.name = 'MembershipLimitError';
  }
}
export const MEMBERSHIP_INVERSE_DEPLOYMENT_BARRIER =
  'Stop all old membership writers before migration; backfill each authoritative membership change through stable source cursors, reconcile outstanding reservations, then certify each actor anchor complete before enabling inverse reads. Mixed-version writers are forbidden.';
export class MembershipInverseIncompleteError extends LifecycleDeniedError {
  readonly code = 'membership_inverse_incomplete';
  constructor() {
    super();
    this.name = 'MembershipInverseIncompleteError';
    this.message = MEMBERSHIP_INVERSE_DEPLOYMENT_BARRIER;
  }
}
const NAMESPACE = '8c058b06-1993-8bb2-81f8-15f709707fa1';
function requireAllowed(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}
function route(id: string): number {
  const value = routeOf(id);
  requireAllowed(value !== null);
  return value;
}
function admission(input: MembershipAdmission) {
  requireAllowed(input && typeof input === 'object' && input.principal);
  const principal = { ...input.principal };
  route(input.accountId);
  route(principal.id);
  requireAllowed(principal.kind === 'organization' || principal.kind === 'realm');
  requireAllowed(input.accountId !== principal.id);
  return { accountId: input.accountId, principal, key: input.key };
}

function requireCompleteAnchor(
  account:
    | {
        accountKind: string;
        state: string;
        fenced: boolean;
        operatorAccountId: string | null;
        complete: boolean;
      }
    | null
    | undefined,
): asserts account {
  requireAllowed(
    account &&
      account.accountKind === 'actor' &&
      account.state === 'active' &&
      !account.fenced &&
      account.operatorAccountId === null,
  );
  if (!account.complete) throw new MembershipInverseIncompleteError();
}

/** Point-read the same registration/cut barrier without expanding the inverse.
 * A bounded personal inventory must check this even when its raw page is empty.
 */
export async function requireMembershipInverseReady(
  client: AccessClient,
  input: { accountId: string; authnEpoch: number },
): Promise<void> {
  const account = await ready.run(client, { route: route(input.accountId), account_id: input.accountId });
  requireCompleteAnchor(account);
  requireAllowed(
    Number.isSafeInteger(input.authnEpoch) && BigInt(input.authnEpoch) >= BigInt(account.minimumAuthnEpoch),
  );
}

/** Exact actor-anchor superset read: never use its rows to prove membership.
 * Authorization must separately verify matched authoritative group memberships
 * at the attempt's T. Missing coverage, malformed rows and overflow deny access;
 * no LIMIT or role expansion can omit candidates or silently spend more slots.
 */
export async function readMembershipInverse(
  client: AccessClient,
  input: { accountId: string },
): Promise<readonly MembershipPrincipal[]> {
  const rows = await read.run(client, { route: route(input.accountId), account_id: input.accountId });
  const account = rows[0];
  requireCompleteAnchor(account);
  const result: MembershipPrincipal[] = [];
  for (const row of rows) {
    if (row.kind === null && row.id === null) continue;
    requireAllowed((row.kind === 'organization' || row.kind === 'realm') && row.id !== null);
    route(row.id);
    requireAllowed(row.id !== input.accountId);
    result.push({ kind: row.kind, id: row.id });
    requireAllowed(result.length <= MEMBERSHIP_LIMIT);
  }
  return result;
}

/** Trusted, deployment-owned Realm authority port. It must read exactly the
 * supplied Realm/member/reservation slot on this released connection and return
 * only committed, immutable terminal evidence; no timeout or missing row proves
 * termination. A Realm module must install this adapter before Realm release or
 * bootstrap is available. Reserve itself needs no Realm checkout or placement.
 */
export type RealmMembershipAuthority = Partial<RealmTransitionAuthority> & {
  readTerminal(
    client: AccessClient,
    input: MembershipReservation,
  ): Promise<(MembershipReservation & { transactionId: string }) | null>;
  readChange(
    client: AccessClient,
    input: MembershipBootstrapStep,
  ): Promise<(MembershipBootstrapStep & { reservationId?: string | null }) | null>;
};

/** INTERNAL service capability, like createLifecycleInternals; never mount this
 * factory or accept its configuration from HTTP. Inputs contain canonical actor
 * and group IDs, a durable idempotency key, and (release only) the exact returned
 * reservation ID. No LifecycleRequest is accepted: these are trusted workflow
 * steps, not permission-bearing public commands. Public membership publication
 * still uses LifecycleRequest and Access authorization on the organization.
 *
 * reserve -> authoritative join; authoritative leave/terminalization -> release.
 * Native lifecycle executor supplies identity-bound digest, fence, receipt,
 * authoritative T and outbox. Duplicate group admission shares its reservation,
 * even across role changes. Only the first admission spends a slot. Following a
 * Realm has no entry point here. All proof reads finish before actor checkout.
 *
 * bootstrapStep is one verified source change per command, resumable by its
 * stable source transaction/key. It does NOT mark completeness. Existing actors
 * stay closed until the separately deployed backfill coordinator satisfies
 * MEMBERSHIP_INVERSE_DEPLOYMENT_BARRIER. New accounts start complete only after
 * that deployment writer barrier. There is no request-time membership scan.
 */
export function createMembershipInverseCommands(config: {
  pool: Pool;
  clock?: () => Date;
  realmAuthority?: RealmMembershipAuthority;
  /** Preserve the existing lifecycle coordinator's receipt/event contract. */
  releaseCommandKind?: 'membership-coordination-released';
}) {
  const execute = lifecycleExecutor(config.pool, config.clock);
  async function reserveOne(
    input: MembershipAdmission,
    sourceTransactionId?: string,
    sourceProof?: { reservationId?: string | null } | null,
  ) {
    // A terminal reservation may be superseded before its hold is released.
    // Both preflight connections are released before the account command starts.
    // The locked SQL compares this reservation again, so racing reservations
    // share one successor and stale cleanup cannot remove the new inverse.
    const previous =
      !sourceTransactionId && input.principal.kind === 'organization'
        ? await withConnection(config.pool, (client) =>
            reservationRead.run(client, {
              route: route(input.accountId),
              account_id: input.accountId,
              kind: input.principal.kind,
              group_id: input.principal.id,
            }),
          )
        : null;
    const terminalProof = previous
      ? await withConnection(config.pool, (client) =>
          terminal.run(client, {
            route: route(input.principal.id),
            group_id: input.principal.id,
            account_id: input.accountId,
            reservation_id: previous.reservationId,
          }),
        )
      : null;
    return execute(
      {
        route: route(input.accountId),
        id: input.accountId,
        kind: sourceTransactionId ? 'membership-inverse-bootstrapped' : 'membership-inverse-reserved',
        key: input.key,
        input: {
          accountId: input.accountId,
          principal: input.principal,
          sourceTransactionId: sourceTransactionId ?? null,
        },
      },
      async (tx, transactionId): Promise<MembershipReservation & { sourceTransactionId?: string }> => {
        const account = await accountRead.run(tx, { route: route(input.accountId), account_id: input.accountId });
        requireAllowed(
          account &&
            account.kind === 'actor' &&
            account.state === 'active' &&
            !account.fenced &&
            account.operatorAccountId === null,
        );
        requireAllowed(!sourceTransactionId || sourceProof);
        if (!sourceTransactionId && !account.membershipInverseComplete) throw new MembershipInverseIncompleteError();
        const priorReservationId = sourceProof?.reservationId;
        if (priorReservationId) requireAllowed(route(priorReservationId) === route(input.accountId));
        const rows = await reserve.run(tx, {
          route: route(input.accountId),
          account_id: input.accountId,
          kind: input.principal.kind,
          group_id: input.principal.id,
          reservation_id:
            priorReservationId ?? derivedId(NAMESPACE, `${transactionId}:membership`, route(input.accountId)),
          transaction_id: transactionId,
          source_transaction_id: sourceTransactionId ?? '',
          previous_reservation_id: terminalProof ? previous!.reservationId : '',
          proof_transaction_id: terminalProof?.transactionId ?? '',
        });
        if (!rows[0]) throw new MembershipLimitError();
        requireAllowed(rows[0].provenanceValid);
        requireAllowed(rows[0].admitted <= MEMBERSHIP_LIMIT);
        let transition: MembershipReservation['transition'];
        if (input.principal.kind === 'realm' && !sourceTransactionId) {
          const generationId = derivedId(NAMESPACE, `${transactionId}:transition`, route(input.accountId));
          const acquired = first(
            await transitionAcquire.run(tx, {
              route: route(input.accountId),
              account_id: input.accountId,
              realm_id: input.principal.id,
              reservation_id: rows[0].reservationId,
              generation_id: generationId,
              operation_id: input.key,
              transaction_id: transactionId,
            }),
          );
          requireAllowed(acquired);
          transition = { generationId, operationId: input.key };
        }
        return {
          accountId: input.accountId,
          principal: input.principal,
          reservationId: rows[0].reservationId,
          ...(transition ? { transition } : {}),
          ...(sourceTransactionId ? { sourceTransactionId } : {}),
        };
      },
    );
  }
  return {
    async reserve(input: MembershipAdmission) {
      return reserveOne(admission(input));
    },
    async release(input: MembershipRelease) {
      const identity = admission(input);
      const reservationRoute = route(input.reservationId);
      const reservationId = input.reservationId;
      const coordination = config.releaseCommandKind
        ? { organizationId: identity.principal.id, memberAccountId: identity.accountId, reservationId }
        : null;
      const proof = await withConnection(config.pool, async (client) => {
        if (identity.principal.kind === 'organization') {
          return terminal.run(client, {
            route: route(identity.principal.id),
            group_id: identity.principal.id,
            account_id: identity.accountId,
            reservation_id: reservationId,
          });
        }
        const value = await accessEvidence(
          () => config.realmAuthority?.readTerminal(client, { ...identity, reservationId }),
          () => new LifecycleDeniedError(),
        );
        return value &&
          value.accountId === identity.accountId &&
          value.principal.kind === 'realm' &&
          value.principal.id === identity.principal.id &&
          value.reservationId === reservationId
          ? value
          : null;
      });
      if (identity.principal.kind === 'realm' && input.transition) {
        requireAllowed(config.realmAuthority?.readTransition);
        await createRealmMembershipTransitions({
          pool: config.pool,
          authority: { readTransition: config.realmAuthority.readTransition },
          ...(config.clock ? { clock: config.clock } : {}),
        }).consume({ ...(input as RealmMembershipTransition), key: `${identity.key}:transition` });
      }
      return execute(
        {
          route: route(identity.accountId),
          id: identity.accountId,
          kind: config.releaseCommandKind ?? 'membership-inverse-released',
          key: identity.key,
          // Preserve existing durable workflow keys/digests across the upgrade.
          input: coordination
            ? { ...coordination, key: identity.key }
            : { accountId: identity.accountId, principal: identity.principal, reservationId },
        },
        async (tx, transactionId) => {
          // Receipt replay/conflict is decided before semantic denial, as with
          // the existing lifecycle coordinator command.
          requireAllowed(reservationRoute === route(identity.accountId));
          requireAllowed(proof && routeOf(proof.transactionId) !== null);
          requireAllowed(
            await accountRead.run(tx, { route: route(identity.accountId), account_id: identity.accountId }),
          );
          const rows = await release.run(tx, {
            route: route(identity.accountId),
            account_id: identity.accountId,
            kind: identity.principal.kind,
            group_id: identity.principal.id,
            reservation_id: reservationId,
            proof_transaction_id: proof.transactionId,
            transaction_id: transactionId,
          });
          requireAllowed(rows[0]);
          return {
            accountId: identity.accountId,
            principal: identity.principal,
            reservationId,
            proofTransactionId: proof.transactionId,
            ...coordination,
          };
        },
      );
    },
    async bootstrapStep(input: MembershipBootstrapStep) {
      const identity = admission(input);
      const sourceTransactionId = input.sourceTransactionId;
      route(sourceTransactionId);
      const proof = await withConnection(config.pool, async (client) => {
        if (identity.principal.kind === 'organization') {
          return change.run(client, {
            route: route(identity.principal.id),
            group_id: identity.principal.id,
            account_id: identity.accountId,
            source_transaction_id: sourceTransactionId,
          });
        }
        const value = await accessEvidence(
          () => config.realmAuthority?.readChange(client, { ...identity, sourceTransactionId }),
          () => new LifecycleDeniedError(),
        );
        return value &&
          value.accountId === identity.accountId &&
          value.principal.kind === 'realm' &&
          value.principal.id === identity.principal.id &&
          value.sourceTransactionId === sourceTransactionId
          ? value
          : null;
      });
      return reserveOne(identity, sourceTransactionId, proof);
    },
  };
}
