import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import {
  runCommand,
  authoritativeTimeValue,
  currentCommand,
  type CommandAuthorization,
  type CommandTransaction,
  type CommandOutcome,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import {
  accessCommandAuthorization,
  type Access,
  type AccountActor,
  type AccessClient,
  type ActionCatalogue,
} from '../request/access.ts';
import { anchorRoute, derivedId, routeOf, partitionOf } from '../route/route.ts';
import type { PermissionContext } from './permission.ts';
import accountRead from './lifecycle-account.sql';
import handleRead from './lifecycle-handle-read.sql';
import handleReserve from './lifecycle-handle-reserve.sql';
import handleChange from './lifecycle-handle-change.sql';
import handleExpire from './lifecycle-handle-expire.sql';
import accountCreate from './lifecycle-create.sql';
import grantsInsert from './lifecycle-default-grants.sql';
import activateStatement from './lifecycle-activate.sql';
import updateStatement from './lifecycle-update.sql';
import coordinationInsert from './lifecycle-coordination.sql';
import coordinationRead from './lifecycle-coordination-read.sql';
import membershipSlotRead from './lifecycle-membership-slot-read.sql';
import membershipRelease from './lifecycle-membership-release.sql';
import holdsRead from './lifecycle-holds.sql';
import membershipChange from './lifecycle-membership.sql';
import memberInsert from './lifecycle-member-insert.sql';
import ownersRead from './lifecycle-owners.sql';
import fenceStatement from './lifecycle-fence.sql';
import fenceRead from './lifecycle-fence-read.sql';
import fenceClear from './lifecycle-fence-clear.sql';
import handleHold from './lifecycle-handle-hold.sql';
import handlePublish from './lifecycle-handle-publish.sql';
import operationRead from './lifecycle-handle-operation-read.sql';
import operationCancel from './lifecycle-handle-cancel.sql';
import operationComplete from './lifecycle-handle-complete.sql';
import transitionChange from './lifecycle-handle-transition-change.sql';
import transitionRelease from './lifecycle-handle-transition-release.sql';
import expiryInsert from './lifecycle-registration-expiry.sql';
import expiryRead from './lifecycle-registration-expiry-read.sql';
import registrationRelease from './lifecycle-registration-release.sql';
import effectRead from './lifecycle-handle-effect-read.sql';
import bootstrapOwner from './lifecycle-handle-bootstrap-owner.sql';

/** Authoritative application-clock policy: registration lasts 30 minutes and an
 * old handle redirects for 30 days. Neither clock nor timestamps come from JSON.
 * Coordination holds have NO expiry: only a durable workflow may resolve them.
 */
export const REGISTRATION_TTL_MS = 30 * 60 * 1000;
export const HANDLE_REDIRECT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LIFECYCLE_ACTIONS: ActionCatalogue = new Map([
  ['account:read', { anonymous: false }],
  ['account:update', { anonymous: false }],
  ['account:delete', { anonymous: false, replay: 'self-account-read' }],
  ['organization:membership', { anonymous: false }],
]);
const ACTOR_ACTIONS = ['account:update', 'account:delete'];
const ORGANIZATION_ACTIONS = [...ACTOR_ACTIONS, 'organization:membership'];
const SERVICE_ID = '00000000-0000-8000-8000-000000000001';
const ID_NAMESPACE = '9e068400-e1f4-8ba0-925e-098dec304890';

export class LifecycleDeniedError extends Error {
  constructor() {
    super('Account lifecycle command denied');
    this.name = 'LifecycleDeniedError';
  }
}
function requireAllowed(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}
function accountRoute(accountId: string): number {
  const route = routeOf(accountId);
  requireAllowed(route !== null);
  return route;
}
function normalized(handle: string): string {
  requireAllowed(typeof handle === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle));
  return handle.toLowerCase();
}
function handleRoute(handle: string): number {
  return createHash('sha256').update(handle).digest().readUInt16BE(0);
}
function iso(clock: () => Date): string {
  const at = clock();
  requireAllowed(Number.isFinite(at.getTime()));
  return at.toISOString();
}
function affected(result: unknown): boolean {
  return Array.isArray(result) ? result.length > 0 : result != null;
}
function epoch(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
type Boundary = { pool: Pool; clock?: () => Date };
export type LifecycleRequest = Omit<PermissionContext, 'pool'> & { actor: AccountActor };
export type LifecycleCommand = { accountId: string; key: string };
export type HandleTransition = LifecycleCommand & {
  handle: string;
  reservationId: string;
  operationId: string;
  expectedHandle: string | null;
};

function transitionInput(input: HandleTransition): HandleTransition {
  accountRoute(input.accountId);
  requireAllowed(
    typeof input.operationId === 'string' && input.operationId.length > 0 && input.operationId.length <= 256,
  );
  requireAllowed(typeof input.reservationId === 'string');
  const handle = normalized(input.handle);
  const expectedHandle = input.expectedHandle === null ? null : normalized(input.expectedHandle);
  requireAllowed(handle !== expectedHandle);
  return {
    accountId: input.accountId,
    key: input.key,
    handle,
    expectedHandle,
    operationId: input.operationId,
    reservationId: input.reservationId,
  };
}
const transitionParameters = (input: HandleTransition) => ({
  route: accountRoute(input.accountId),
  account_id: input.accountId,
  handle: input.handle,
  reservation_id: input.reservationId,
  operation_id: input.operationId,
  expected_handle: input.expectedHandle ?? '',
});
async function readClaim(pool: Pool, handle: string) {
  return withConnection(pool, (client) => handleRead.run(client, { route: handleRoute(handle), handle }));
}
async function readOperation(pool: Pool, input: HandleTransition) {
  return withConnection(pool, (client) =>
    operationRead.run(client, {
      route: accountRoute(input.accountId),
      account_id: input.accountId,
      operation_id: input.operationId,
    }),
  );
}
function matchesOperation(operation: Awaited<ReturnType<typeof readOperation>>, input: HandleTransition) {
  return (
    operation &&
    operation.handle === input.handle &&
    operation.reservationId === input.reservationId &&
    operation.expectedHandle === input.expectedHandle
  );
}
async function publicationEvidence(pool: Pool, input: HandleTransition) {
  // Every separately anchored read ends before checkout of the account anchor.
  const claim = await readClaim(pool, input.handle);
  const old = input.expectedHandle === null ? null : await readClaim(pool, input.expectedHandle);
  return { claim, old };
}
async function publishHandle(
  tx: CommandTransaction,
  input: HandleTransition,
  evidence: Awaited<ReturnType<typeof publicationEvidence>>,
  transactionId: string,
) {
  const { claim, old } = evidence;
  requireAllowed(
    claim?.state === 'pending' &&
      claim.accountId === input.accountId &&
      claim.reservationId === input.reservationId &&
      claim.operationId === input.operationId &&
      claim.expectedHandle === input.expectedHandle,
  );
  requireAllowed(
    input.expectedHandle === null ||
      (old?.state === 'active' && old.accountId === input.accountId && old.reservationId),
  );
  requireAllowed(
    affected(
      await handlePublish.run(tx, {
        ...transitionParameters(input),
        old_reservation_id: old?.reservationId ?? '',
        transaction_id: transactionId,
      }),
    ),
  );
  return { accountId: input.accountId, handle: input.handle, operationId: input.operationId };
}
/** Exact resulting floor is a decimal string, preserving PostgreSQL bigint.
 * receiptId, accountId and this floor identify the Auth invalidation barrier.
 * kind and priorOperatorAccountId are deliberately retained nonsecret facts.
 */
export type LifecycleFenceReceipt = {
  receiptId: string;
  accountId: string;
  minimumAuthnEpoch: string;
  kind: string;
  priorOperatorAccountId: string | null;
};
type TransactionAccount = NonNullable<Awaited<ReturnType<typeof accountRead.run>>>;
type Mutation = {
  route: number;
  id: string;
  kind: string;
  key: string;
  input: unknown;
  actor?: AccountActor;
  deadline?: number;
  authorization?: CommandAuthorization;
};

/** All idempotency digests include the anchor, actual kernel actor/client and
 * requested_by. Core's partition receipt key is explicitly prefixed by route.
 * Responses/events contain identity and coordination facts, never patch bodies.
 */
function executor(pool: Pool, clock?: () => Date) {
  return async function execute<T>(
    options: Mutation,
    body: (tx: CommandTransaction, transactionId: string) => Promise<T>,
  ): Promise<CommandOutcome<T>> {
    requireAllowed(typeof options.key === 'string' && options.key.length > 0 && options.key.length <= 256);
    const actor = options.actor;
    requireAllowed(!actor || options.authorization);
    const basis = {
      actorAccountId: actor?.accountId ?? SERVICE_ID,
      clientId: actor?.clientId ?? 'internal-access',
      requestedBy: actor?.requestedBy ?? null,
    };
    const digest = createHash('sha256')
      .update(canonicalize([options.route, options.id, options.kind, basis, options.input])!)
      .digest();
    const outcome = await runCommand(
      pool,
      {
        partition: partitionOf(options.route),
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        basis,
        clock,
        authorization: options.authorization,
        receipt: {
          actorAccountId: basis.actorAccountId,
          kind: `access.${options.kind}`,
          key: `${options.route}:${options.key}`,
          digest,
        },
      },
      async (tx, { transactionId }) => {
        const value = await body(tx, transactionId);
        return { value, events: [{ type: `com.rezics.access.${options.kind}.v1`, subject: options.id, data: value }] };
      },
    );
    // Expose snapshots: callers cannot accidentally mutate the response retained
    // by a workflow while passing receipt objects to another service boundary.
    return {
      ...outcome,
      get value() {
        return structuredClone(outcome.value);
      },
    };
  };
}
async function locked(tx: AccessClient, accountId: string): Promise<TransactionAccount> {
  const account = await accountRead.run(tx, { route: accountRoute(accountId), account_id: accountId });
  requireAllowed(account);
  return account;
}
async function memberReservation(pool: Pool, accountId: string, organizationId: string, reservationId: string) {
  return withConnection(pool, async (client) => {
    // This is an independent actor-anchor read before organization checkout.
    // Holds never expire and prevent subsequent deletion/automation on that actor.
    const reservation = await coordinationRead.run(client, {
      route: accountRoute(accountId),
      account_id: accountId,
      reservation_id: reservationId,
    });
    return reservation?.purpose === 'membership' && reservation.relatedAccountId === organizationId
      ? reservation
      : null;
  });
}
async function grants(
  tx: AccessClient,
  accountId: string,
  subjectId: string,
  role: string,
  transactionId: string,
  actions: string[],
) {
  return grantsInsert.run(tx, {
    route: accountRoute(accountId),
    account_id: accountId,
    subject_id: subjectId,
    role,
    transaction_id: transactionId,
    actions,
  });
}
async function membership(
  tx: CommandTransaction,
  organizationId: string,
  memberId: string,
  reservationId: string,
  role: 'owner' | 'member' | null,
  transactionId: string,
) {
  const input = {
    route: accountRoute(organizationId),
    organization_id: organizationId,
    member_id: memberId,
    reservation_id: reservationId,
    removed: role === null,
    at: authoritativeTimeValue(currentCommand(tx).time),
    transaction_id: transactionId,
  };
  requireAllowed(affected(await membershipChange.run(tx, input)));
  if (role !== null) await memberInsert.run(tx, { ...input, role });
}
async function fence(
  tx: AccessClient,
  account: TransactionAccount,
  tombstone: boolean,
  transactionId: string,
): Promise<LifecycleFenceReceipt> {
  const route = accountRoute(account.accountId);
  const receiptId = derivedId(ID_NAMESPACE, `${transactionId}:fence`, route);
  const kind = tombstone ? 'tombstone' : 'fence';
  const priorOperatorAccountId = tombstone ? account.operatorAccountId : null;
  const rows = await fenceStatement.run(tx, {
    route,
    account_id: account.accountId,
    receipt_id: receiptId,
    tombstone,
    kind,
    prior_operator_id: priorOperatorAccountId ?? '',
    transaction_id: transactionId,
  });
  requireAllowed(rows[0]);
  return {
    receiptId,
    accountId: account.accountId,
    minimumAuthnEpoch: rows[0].minimumAuthnEpoch,
    kind,
    priorOperatorAccountId,
  };
}

export type ProvisioningEvidence = {
  accountId: string;
  registrationId: string;
  authIdentityId: string;
  authnEpoch: number;
};
export type RecoveryEvidence = {
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  authnEpoch: number;
  establishmentId: string;
};

/** INTERNAL SERVICE CAPABILITY for the later registration/fencing coordinator.
 * Mount neither this factory nor its inputs as public HTTP commands. Evidence
 * resolvers validate trusted coordinator records; they must not call Auth here.
 * An unrecognized/serialized proof resolves to null. No public trusted flag exists.
 * There is deliberately no multi-anchor workflow or operator transfer in this API.
 *
 * Coordinator brief: every mutation returns the kernel CommandOutcome, including
 * value, partition/epoch/position, transactionId and replayed. Await COMMIT before
 * Auth revocation/erasure. raiseFence and public tombstone return an independently
 * readable LifecycleFenceReceipt; replay keeps its exact ID and floor and emits
 * no additional event. Only tombstone returns the former operator, for release
 * AFTER tombstoning and Auth erasure. Holds remain unresolved in this layer.
 *
 * Registration steps: registrationTarget(key) -> account ID; reserveHandle ->
 * {handle, accountId, reservationId, expiresAt}; createPending ->
 * {accountId, registrationId, expiresAt}; activate -> {accountId}; claimHandle ->
 * {handle, accountId}. Each step is separately anchored and separately replayable.
 * The coordinator must complete the handle barrier before exposing registration
 * as completed: after provisioning, claimHandle accepts that verified evidence
 * while the account is pending, then activate commits the account separately.
 * A provisioning resolver returns only successfully committed Auth provisioning evidence for the same immutable account and reservation.
 *
 * Membership steps: reserveCoordination returns {accountId, relatedAccountId,
 * purpose, reservationId} on the human's anchor; createOrganization consumes its
 * owner hold and returns {accountId, ownerAccountId}. Public setMembership consumes
 * the member's hold and returns {organizationId, memberAccountId, reservationId,
 * role}. Removal permanently closes that reservation on the organization anchor;
 * it does not release the human's responsibility on another anchor.
 *
 * Recovery: clearFence requires resolver-verified new establishment evidence
 * bound to accountId, receiptId, EXACT minimumAuthnEpoch and authnEpoch at/above
 * that floor. It returns {accountId, receiptId, minimumAuthnEpoch}; the floor never
 * decreases. Old proofs cannot clear a later fence, including the same account.
 */
export function createLifecycleInternals(
  config: Boundary & {
    routeKey: Uint8Array;
    provisioningEvidence: (evidence: unknown) => Promise<ProvisioningEvidence | null>;
    recoveryEvidence: (evidence: unknown) => Promise<RecoveryEvidence | null>;
  },
) {
  const { pool } = config;
  const clock = config.clock ?? (() => new Date());
  const execute = executor(pool, config.clock);
  const routeKey = new Uint8Array(config.routeKey);
  return {
    /** Stable route AND identity: the coordinator's durable registration key is
     * namespaced independently from handle spelling. Keep routeKey stable. */
    registrationTarget(key: string) {
      requireAllowed(typeof key === 'string' && key.length > 0 && key.length <= 256);
      const route = anchorRoute(routeKey, `access.registration:${key}`);
      return derivedId(ID_NAMESPACE, `registration:${key}`, route);
    },
    /** Indefinite purpose/account/reservation/operation-bound publication hold.
     * Only the trusted coordinator owns this capability. Cancellation first
     * commits a permanent account-local terminal slot before releasing it. */
    async holdHandle(value: HandleTransition) {
      const input = transitionInput(value);
      const route = handleRoute(input.handle);
      return execute(
        { route, id: input.handle, kind: 'handle-held', key: input.key, input },
        async (tx, transactionId) => {
          requireAllowed(
            affected(
              await handleHold.run(tx, {
                ...transitionParameters(input),
                route,
                at: authoritativeTimeValue(currentCommand(tx).time),
                transaction_id: transactionId,
              }),
            ),
          );
          return {
            accountId: input.accountId,
            handle: input.handle,
            reservationId: input.reservationId,
            operationId: input.operationId,
          };
        },
      );
    },
    /** Narrow bootstrap capability: the durable initial owner's existing
     * reservation is required, and only the first organization handle is set. */
    async bootstrapOrganizationHandle(
      value: HandleTransition & { ownerAccountId: string; ownerReservationId: string },
    ) {
      const input = transitionInput(value);
      requireAllowed(input.expectedHandle === null);
      const ownerAccountId = value.ownerAccountId;
      const ownerReservationId = value.ownerReservationId;
      const owner = await memberReservation(pool, ownerAccountId, input.accountId, ownerReservationId);
      const evidence = await publicationEvidence(pool, input);
      return execute(
        {
          route: accountRoute(input.accountId),
          id: input.accountId,
          kind: 'organization-handle-published',
          key: input.key,
          input: { ...input, ownerAccountId, ownerReservationId },
        },
        async (tx, transactionId) => {
          const account = await locked(tx, input.accountId);
          requireAllowed(owner && account.kind === 'organization');
          requireAllowed(
            await bootstrapOwner.run(tx, {
              route: accountRoute(input.accountId),
              organization_id: input.accountId,
              owner_id: ownerAccountId,
              reservation_id: ownerReservationId,
              at: authoritativeTimeValue(currentCommand(tx).time),
            }),
          );
          return publishHandle(tx, input, evidence, transactionId);
        },
      );
    },
    async finalizeHandleTransition(value: HandleTransition) {
      const input = transitionInput(value);
      const operation = await readOperation(pool, input);
      const route = handleRoute(input.handle);
      return execute(
        { route, id: input.handle, kind: 'transition-handle-claimed', key: input.key, input },
        async (tx, transactionId) => {
          requireAllowed(matchesOperation(operation, input) && operation!.state !== 'cancelled');
          requireAllowed(
            affected(
              await transitionChange.run(tx, {
                route,
                handle: input.handle,
                account_id: input.accountId,
                reservation_id: input.reservationId,
                operation_id: input.operationId,
                state: 'active',
                reserved_until: '',
                transaction_id: transactionId,
              }),
            ),
          );
          return { accountId: input.accountId, handle: input.handle };
        },
      );
    },
    async redirectTransitionHandle(value: HandleTransition) {
      const input = transitionInput(value);
      requireAllowed(input.expectedHandle !== null);
      const operation = await readOperation(pool, input);
      const route = handleRoute(input.expectedHandle);
      return execute(
        { route, id: input.expectedHandle, kind: 'transition-handle-redirected', key: input.key, input },
        async (tx, transactionId) => {
          requireAllowed(
            matchesOperation(operation, input) && operation!.state !== 'cancelled' && operation!.oldReservationId,
          );
          const reservedUntil = new Date(
            Date.parse(authoritativeTimeValue(currentCommand(tx).time)) + HANDLE_REDIRECT_TTL_MS,
          ).toISOString();
          requireAllowed(
            affected(
              await transitionChange.run(tx, {
                route,
                handle: input.expectedHandle!,
                account_id: input.accountId,
                reservation_id: operation!.oldReservationId!,
                operation_id: input.operationId,
                state: 'reserved',
                reserved_until: reservedUntil,
                transaction_id: transactionId,
              }),
            ),
          );
          return { accountId: input.accountId, handle: input.expectedHandle, reservedUntil };
        },
      );
    },
    async completeHandleTransition(value: HandleTransition) {
      const input = transitionInput(value);
      const operation = await readOperation(pool, input);
      const claimed = await withConnection(pool, (client) =>
        effectRead.run(client, {
          route: handleRoute(input.handle),
          handle: input.handle,
          account_id: input.accountId,
          reservation_id: input.reservationId,
          operation_id: input.operationId,
          effect: 'active',
        }),
      );
      const redirected =
        input.expectedHandle === null || !operation?.oldReservationId
          ? null
          : await withConnection(pool, (client) =>
              effectRead.run(client, {
                route: handleRoute(input.expectedHandle!),
                handle: input.expectedHandle!,
                account_id: input.accountId,
                reservation_id: operation.oldReservationId!,
                operation_id: input.operationId,
                effect: 'reserved',
              }),
            );
      return execute(
        {
          route: accountRoute(input.accountId),
          id: input.accountId,
          kind: 'handle-transition-completed',
          key: input.key,
          input,
        },
        async (tx, transactionId) => {
          await locked(tx, input.accountId);
          requireAllowed(matchesOperation(operation, input));
          requireAllowed(claimed && (input.expectedHandle === null || redirected));
          requireAllowed(
            affected(
              await operationComplete.run(tx, { ...transitionParameters(input), transaction_id: transactionId }),
            ),
          );
          return { accountId: input.accountId, handle: input.handle };
        },
      );
    },
    async cancelHandleTransition(value: HandleTransition) {
      const input = transitionInput(value);
      return execute(
        {
          route: accountRoute(input.accountId),
          id: input.accountId,
          kind: 'handle-transition-cancelled',
          key: input.key,
          input,
        },
        async (tx, transactionId) => {
          await locked(tx, input.accountId);
          requireAllowed(
            affected(await operationCancel.run(tx, { ...transitionParameters(input), transaction_id: transactionId })),
          );
          return { accountId: input.accountId, operationId: input.operationId };
        },
      );
    },
    async releaseHandleTransition(value: HandleTransition) {
      const input = transitionInput(value);
      const operation = await readOperation(pool, input);
      const route = handleRoute(input.handle);
      return execute(
        { route, id: input.handle, kind: 'handle-transition-released', key: input.key, input },
        async (tx) => {
          requireAllowed(matchesOperation(operation, input) && operation!.state === 'cancelled');
          requireAllowed(affected(await transitionRelease.run(tx, { ...transitionParameters(input), route })));
          return { accountId: input.accountId, handle: input.handle };
        },
      );
    },
    async expireRegistration(input: LifecycleCommand & { handle: string; reservationId: string }) {
      input = { ...input, handle: normalized(input.handle) };
      const route = accountRoute(input.accountId);
      return execute(
        { route, id: input.accountId, kind: 'registration-expired', key: input.key, input },
        async (tx, transactionId) => {
          const account = await locked(tx, input.accountId);
          requireAllowed(
            account.state === 'pending' &&
              account.registrationId === input.reservationId &&
              account.handle === input.handle &&
              account.expiresAt &&
              Date.parse(account.expiresAt) <= Date.parse(authoritativeTimeValue(currentCommand(tx).time)),
          );
          const receipt = await fence(tx, account, true, transactionId);
          await expiryInsert.run(tx, {
            route,
            account_id: input.accountId,
            reservation_id: input.reservationId,
            handle: input.handle,
            transaction_id: transactionId,
          });
          return receipt;
        },
      );
    },
    async releaseExpiredRegistrationHandle(input: LifecycleCommand & { handle: string; reservationId: string }) {
      input = { ...input, handle: normalized(input.handle) };
      const proof = await withConnection(pool, (client) =>
        expiryRead.run(client, {
          route: accountRoute(input.accountId),
          account_id: input.accountId,
          reservation_id: input.reservationId,
        }),
      );
      const route = handleRoute(input.handle);
      return execute(
        { route, id: input.handle, kind: 'registration-handle-released', key: input.key, input },
        async (tx) => {
          requireAllowed(proof?.handle === input.handle);
          requireAllowed(
            affected(
              await registrationRelease.run(tx, {
                route,
                handle: input.handle,
                account_id: input.accountId,
                reservation_id: input.reservationId,
              }),
            ),
          );
          return { accountId: input.accountId, handle: input.handle };
        },
      );
    },
    async reserveHandle(input: { handle: string; accountId: string; key: string }) {
      input = { ...input };
      const handle = normalized(input.handle);
      accountRoute(input.accountId);
      const route = handleRoute(handle);
      return execute(
        { route, id: handle, kind: 'handle-reserved', key: input.key, input: { handle, accountId: input.accountId } },
        async (tx, transactionId) => {
          const at = authoritativeTimeValue(currentCommand(tx).time);
          const expiresAt = new Date(Date.parse(at) + REGISTRATION_TTL_MS).toISOString();
          const reservationId = derivedId(ID_NAMESPACE, `${transactionId}:handle`, route);
          requireAllowed(
            affected(
              await handleReserve.run(tx, {
                route,
                handle,
                account_id: input.accountId,
                expires_at: expiresAt,
                reservation_id: reservationId,
                transaction_id: transactionId,
                at,
              }),
            ),
          );
          return { handle, accountId: input.accountId, reservationId, expiresAt };
        },
      );
    },
    async createPending(input: LifecycleCommand & { handle: string; reservationId: string }) {
      input = { ...input };
      const handle = normalized(input.handle);
      const route = accountRoute(input.accountId);
      const claim = await withConnection(pool, (client) =>
        handleRead.run(client, { route: handleRoute(handle), handle }),
      );
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'actor-pending',
          key: input.key,
          input: { handle, reservationId: input.reservationId },
        },
        async (tx, transactionId) => {
          requireAllowed(
            claim?.state === 'pending' &&
              claim.accountId === input.accountId &&
              claim.reservationId === input.reservationId &&
              claim.expiresAt &&
              Date.parse(claim.expiresAt) > Date.parse(authoritativeTimeValue(currentCommand(tx).time)),
          );
          await accountCreate.run(tx, {
            route,
            account_id: input.accountId,
            kind: 'actor',
            state: 'pending',
            handle,
            registration_id: input.reservationId,
            expires_at: claim.expiresAt,
            transaction_id: transactionId,
          });
          await grants(tx, input.accountId, input.accountId, '', transactionId, ACTOR_ACTIONS);
          return {
            accountId: input.accountId,
            registrationId: input.reservationId,
            expiresAt: new Date(claim.expiresAt).toISOString(),
          };
        },
      );
    },
    async activate(input: LifecycleCommand & { evidence: unknown }) {
      input = { ...input };
      const route = accountRoute(input.accountId);
      const proof = await resolveEvidence(config.provisioningEvidence, input.evidence);
      requireAllowed(
        proof &&
          proof.accountId === input.accountId &&
          proof.authIdentityId === input.accountId &&
          epoch(proof.authnEpoch),
      );
      return execute(
        { route, id: input.accountId, kind: 'actor-activated', key: input.key, input: proof },
        async (tx, transactionId) => {
          const changed = await activateStatement.run(tx, {
            route,
            account_id: input.accountId,
            registration_id: proof.registrationId,
            authn_epoch: proof.authnEpoch,
            at: authoritativeTimeValue(currentCommand(tx).time),
            transaction_id: transactionId,
          });
          requireAllowed(affected(changed));
          await grants(tx, input.accountId, input.accountId, '', transactionId, ['account:read']);
          return { accountId: input.accountId };
        },
      );
    },
    /** Deployment-only upgrade, one supplied account per batch on its own anchor.
     * Resume with the same account/key after interruption; receipts retain the
     * result. Supply only accounts needing the upgrade, never enumerate in a
     * request path. Existing read history, including expired ranges, is final:
     * the initializer skips that identity/action rather than widening validity.
     * This installs no principal grant and never changes authentication state.
     */
    async installSelfReadGrant(input: LifecycleCommand) {
      input = { ...input };
      const route = accountRoute(input.accountId);
      return execute(
        { route, id: input.accountId, kind: 'self-read-installed', key: input.key, input: {} },
        async (tx, transactionId) => {
          const account = await locked(tx, input.accountId);
          requireAllowed(account.kind === 'actor' && account.state === 'active' && !account.fenced);
          const changed = await grants(tx, input.accountId, input.accountId, '', transactionId, ['account:read']);
          return { accountId: input.accountId, installed: changed.length };
        },
      );
    },
    async claimHandle(input: LifecycleCommand & { handle: string; reservationId: string; evidence?: unknown }) {
      input = { ...input };
      const handle = normalized(input.handle);
      const route = handleRoute(handle);
      const account = await withConnection(pool, (client) =>
        accountRead.run(client, { route: accountRoute(input.accountId), account_id: input.accountId }),
      );
      const proof =
        input.evidence === undefined ? null : await resolveEvidence(config.provisioningEvidence, input.evidence);
      return execute(
        {
          route,
          id: handle,
          kind: 'handle-claimed',
          key: input.key,
          input: { handle, accountId: input.accountId, reservationId: input.reservationId, proof },
        },
        async (tx, transactionId) => {
          // The coordinator can finish the handle barrier after successful Auth
          // provisioning but BEFORE account activation, without an expiry gap.
          const provisionedPending =
            account?.state === 'pending' &&
            proof &&
            proof.accountId === input.accountId &&
            proof.authIdentityId === input.accountId &&
            proof.registrationId === input.reservationId &&
            account.registrationId === input.reservationId &&
            epoch(proof.authnEpoch) &&
            BigInt(proof.authnEpoch) >= BigInt(account.minimumAuthnEpoch);
          requireAllowed(
            account &&
              !account.fenced &&
              account.handle === handle &&
              (account.state === 'active' || provisionedPending),
          );
          requireAllowed(
            affected(
              await handleChange.run(tx, {
                route,
                handle,
                account_id: input.accountId,
                state: 'active',
                reservation_id: input.reservationId,
                reserved_until: '',
                at: authoritativeTimeValue(currentCommand(tx).time),
                transaction_id: transactionId,
              }),
            ),
          );
          return { handle, accountId: input.accountId };
        },
      );
    },
    async redirectHandle(input: LifecycleCommand & { handle: string }) {
      input = { ...input };
      const handle = normalized(input.handle);
      const route = handleRoute(handle);
      return execute(
        { route, id: handle, kind: 'handle-redirected', key: input.key, input: { handle, accountId: input.accountId } },
        async (tx, transactionId) => {
          const at = authoritativeTimeValue(currentCommand(tx).time);
          const reservedUntil = new Date(Date.parse(at) + HANDLE_REDIRECT_TTL_MS).toISOString();
          requireAllowed(
            affected(
              await handleChange.run(tx, {
                route,
                handle,
                account_id: input.accountId,
                state: 'reserved',
                reservation_id: '',
                reserved_until: reservedUntil,
                at,
                transaction_id: transactionId,
              }),
            ),
          );
          return { handle, accountId: input.accountId, reservedUntil };
        },
      );
    },
    async expireHandle(input: { handle: string; key: string }) {
      input = { ...input };
      const handle = normalized(input.handle);
      const route = handleRoute(handle);
      return execute({ route, id: handle, kind: 'handle-expired', key: input.key, input: { handle } }, async (tx) => {
        requireAllowed(
          affected(await handleExpire.run(tx, { route, handle, at: authoritativeTimeValue(currentCommand(tx).time) })),
        );
        return { handle, released: true };
      });
    },
    async resolveHandle(value: string) {
      const handle = normalized(value);
      const claim = await withConnection(pool, (client) =>
        handleRead.run(client, { route: handleRoute(handle), handle }),
      );
      if (
        !claim ||
        (claim.state === 'pending' && Date.parse(claim.expiresAt!) <= Date.parse(iso(clock))) ||
        (claim.state === 'reserved' && Date.parse(claim.reservedUntil!) <= Date.parse(iso(clock)))
      )
        return null;
      return { accountId: claim.accountId, redirect: claim.state === 'reserved' };
    },
    /** Permanent organization-local terminal evidence is read and released
     * before the member anchor command. Only this exact membership hold can be
     * removed; a delayed activation cannot reopen its terminal slot. */
    async releaseMembershipCoordination(input: {
      organizationId: string;
      memberAccountId: string;
      reservationId: string;
      key: string;
    }) {
      input = { ...input };
      const slot = await withConnection(pool, (client) =>
        membershipSlotRead.run(client, {
          route: accountRoute(input.organizationId),
          organization_id: input.organizationId,
          member_id: input.memberAccountId,
          reservation_id: input.reservationId,
        }),
      );
      const route = accountRoute(input.memberAccountId);
      return execute(
        { route, id: input.memberAccountId, kind: 'membership-coordination-released', key: input.key, input },
        async (tx) => {
          await locked(tx, input.memberAccountId);
          requireAllowed(slot?.terminal);
          requireAllowed(
            affected(
              await membershipRelease.run(tx, {
                route,
                account_id: input.memberAccountId,
                organization_id: input.organizationId,
                reservation_id: input.reservationId,
              }),
            ),
          );
          return {
            organizationId: input.organizationId,
            memberAccountId: input.memberAccountId,
            reservationId: input.reservationId,
          };
        },
      );
    },
    /** Account-anchor hold acquired before a separately anchored relation.
     * Holds never expire; release requires exact permanent terminal evidence. */
    async reserveCoordination(
      input: LifecycleCommand & { relatedAccountId: string; purpose: 'membership' | 'operator' },
    ) {
      input = { ...input };
      const route = accountRoute(input.accountId);
      accountRoute(input.relatedAccountId);
      requireAllowed(input.purpose === 'membership' || input.purpose === 'operator');
      requireAllowed(input.accountId !== input.relatedAccountId);
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'coordination-reserved',
          key: input.key,
          input: { relatedAccountId: input.relatedAccountId, purpose: input.purpose },
        },
        async (tx, transactionId) => {
          const account = await locked(tx, input.accountId);
          requireAllowed(
            account.state === 'active' &&
              !account.fenced &&
              account.operatorAccountId === null &&
              (input.purpose === 'operator' || account.kind === 'actor'),
          );
          const reservationId = derivedId(ID_NAMESPACE, `${transactionId}:coordination`, route);
          await coordinationInsert.run(tx, {
            route,
            account_id: input.accountId,
            reservation_id: reservationId,
            related_account_id: input.relatedAccountId,
            purpose: input.purpose,
            transaction_id: transactionId,
          });
          return {
            accountId: input.accountId,
            relatedAccountId: input.relatedAccountId,
            purpose: input.purpose,
            reservationId,
          };
        },
      );
    },
    /** INTERNAL coordinator step: the owner's separately committed hold proves
     * eligibility; this one organization command creates identity, first owner
     * and authoritative owner-role grants atomically. Handle work is separate.
     */
    async createOrganization(input: {
      organizationId: string;
      ownerAccountId: string;
      ownerReservationId: string;
      key: string;
    }) {
      input = { ...input };
      const route = accountRoute(input.organizationId);
      const reservation = await memberReservation(
        pool,
        input.ownerAccountId,
        input.organizationId,
        input.ownerReservationId,
      );
      return execute(
        { route, id: input.organizationId, kind: 'organization-created', key: input.key, input },
        async (tx, transactionId) => {
          requireAllowed(reservation);
          await accountCreate.run(tx, {
            route,
            account_id: input.organizationId,
            kind: 'organization',
            state: 'active',
            handle: '',
            registration_id: '',
            expires_at: '',
            transaction_id: transactionId,
          });
          await membership(
            tx,
            input.organizationId,
            input.ownerAccountId,
            input.ownerReservationId,
            'owner',
            transactionId,
          );
          await grants(tx, input.organizationId, input.organizationId, 'owner', transactionId, ORGANIZATION_ACTIONS);
          return { accountId: input.organizationId, ownerAccountId: input.ownerAccountId };
        },
      );
    },
    async raiseFence(input: LifecycleCommand) {
      input = { ...input };
      const route = accountRoute(input.accountId);
      return execute(
        { route, id: input.accountId, kind: 'authentication-fenced', key: input.key, input: {} },
        async (tx, transactionId) => fence(tx, await locked(tx, input.accountId), false, transactionId),
      );
    },
    async readFenceReceipt(accountId: string, receiptId: string): Promise<LifecycleFenceReceipt | null> {
      return withConnection(pool, (client) =>
        fenceRead.run(client, { route: accountRoute(accountId), account_id: accountId, receipt_id: receiptId }),
      );
    },
    async readFenceState(accountId: string) {
      const account = await withConnection(pool, (client) =>
        accountRead.run(client, { route: accountRoute(accountId), account_id: accountId }),
      );
      return account
        ? { fenced: account.fenced, receiptId: account.receiptId, minimumAuthnEpoch: account.minimumAuthnEpoch }
        : null;
    },
    async clearFence(input: LifecycleCommand & { evidence: unknown }) {
      input = { ...input };
      const route = accountRoute(input.accountId);
      const proof = await resolveEvidence(config.recoveryEvidence, input.evidence);
      requireAllowed(
        proof &&
          proof.accountId === input.accountId &&
          proof.establishmentId &&
          epoch(proof.authnEpoch) &&
          /^[1-9][0-9]*$/.test(proof.minimumAuthnEpoch),
      );
      return execute(
        { route, id: input.accountId, kind: 'authentication-established', key: input.key, input: proof },
        async (tx, transactionId) => {
          requireAllowed(
            affected(
              await fenceClear.run(tx, {
                route,
                account_id: input.accountId,
                receipt_id: proof.receiptId,
                minimum_authn_epoch: proof.minimumAuthnEpoch,
                authn_epoch: proof.authnEpoch,
                transaction_id: transactionId,
              }),
            ),
          );
          return { accountId: input.accountId, receiptId: proof.receiptId, minimumAuthnEpoch: proof.minimumAuthnEpoch };
        },
      );
    },
  };
}

/** Public command inputs carry NO actor/client/scope overrides. The first
 * parameter is verified kernel request context. accessCheck prepares once before
 * checkout and the resource check executes on each real runCommand attempt.
 */
export function createLifecycleCommands(config: Boundary & { access: Access }) {
  const { pool, access } = config;
  const execute = executor(pool, config.clock);
  async function authorize(context: LifecycleRequest, action: string, accountId: string) {
    return accessCommandAuthorization(
      access,
      context.actor,
      action,
      { route: accountRoute(accountId), id: accountId },
      { ...context, pool },
      () => new LifecycleDeniedError(),
    );
  }
  return {
    async transitionAccountHandle(context: LifecycleRequest, value: HandleTransition) {
      const input = transitionInput(value);
      context = snapshotRequest(context);
      const evidence = await publicationEvidence(pool, input);
      const authorization = await authorize(context, 'account:update', input.accountId);
      return execute(
        {
          route: accountRoute(input.accountId),
          id: input.accountId,
          kind: 'account-handle-published',
          key: input.key,
          input,
          actor: context.actor,
          deadline: context.deadline,
          authorization,
        },
        async (tx, transactionId) => {
          await locked(tx, input.accountId);
          requireAllowed(await authorization.check(tx));
          const result = await publishHandle(tx, input, evidence, transactionId);
          requireAllowed(await authorization.check(tx));
          return result;
        },
      );
    },
    async updateAccount(context: LifecycleRequest, input: LifecycleCommand & { patch: unknown }) {
      input = { ...input };
      context = snapshotRequest(context);
      const route = accountRoute(input.accountId);
      const patch = validatePatch(input.patch);
      const authorization = await authorize(context, 'account:update', input.accountId);
      const allowed = authorization.check;
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'account-updated',
          key: input.key,
          input: { patch },
          actor: context.actor,
          deadline: context.deadline,
          authorization,
        },
        async (tx, transactionId) => {
          await locked(tx, input.accountId);
          requireAllowed(await allowed(tx));
          requireAllowed(
            affected(
              await updateStatement.run(tx, {
                route,
                account_id: input.accountId,
                patch,
                transaction_id: transactionId,
              }),
            ),
          );
          requireAllowed(await allowed(tx));
          return { accountId: input.accountId };
        },
      );
    },
    async setMembership(
      context: LifecycleRequest,
      input: {
        organizationId: string;
        memberAccountId: string;
        reservationId: string;
        role: 'owner' | 'member' | null;
        key: string;
      },
    ) {
      input = { ...input };
      context = snapshotRequest(context);
      const route = accountRoute(input.organizationId);
      requireAllowed(input.role === 'owner' || input.role === 'member' || input.role === null);
      const reservation = await memberReservation(
        pool,
        input.memberAccountId,
        input.organizationId,
        input.reservationId,
      );
      const authorization = await authorize(context, 'organization:membership', input.organizationId);
      const allowed = authorization.check;
      return execute(
        {
          route,
          id: input.organizationId,
          kind: 'membership-changed',
          key: input.key,
          input,
          actor: context.actor,
          deadline: context.deadline,
          authorization,
        },
        async (tx, transactionId) => {
          const org = await locked(tx, input.organizationId);
          requireAllowed(await allowed(tx));
          requireAllowed(org.kind === 'organization' && org.state === 'active' && !org.fenced && reservation);
          const owners = await ownersRead.run(tx, {
            route,
            organization_id: input.organizationId,
            member_id: input.memberAccountId,
            at: authoritativeTimeValue(currentCommand(tx).time),
          });
          requireAllowed(
            owners && owners.owners > 0 && (input.role === 'owner' || owners.target === 0 || owners.owners > 1),
          );
          await membership(
            tx,
            input.organizationId,
            input.memberAccountId,
            input.reservationId,
            input.role,
            transactionId,
          );
          requireAllowed(await allowed(tx));
          return {
            organizationId: input.organizationId,
            memberAccountId: input.memberAccountId,
            reservationId: input.reservationId,
            role: input.role,
          };
        },
      );
    },
    async tombstone(context: LifecycleRequest, input: LifecycleCommand) {
      input = { ...input };
      context = snapshotRequest(context);
      const route = accountRoute(input.accountId);
      const authorization = await authorize(context, 'account:delete', input.accountId);
      const allowed = authorization.check;
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'account-tombstoned',
          key: input.key,
          input: {},
          actor: context.actor,
          deadline: context.deadline,
          authorization,
        },
        async (tx, transactionId) => {
          const account = await locked(tx, input.accountId);
          requireAllowed(await allowed(tx));
          requireAllowed(account.state !== 'deleted');
          const holds = await holdsRead.run(tx, { route, account_id: input.accountId });
          requireAllowed(holds && !holds.held);
          if (account.kind === 'organization') {
            const owners = await ownersRead.run(tx, {
              route,
              organization_id: input.accountId,
              member_id: input.accountId,
              at: authoritativeTimeValue(currentCommand(tx).time),
            });
            requireAllowed(owners && owners.owners === 0);
          }
          const receipt = await fence(tx, account, true, transactionId);
          requireAllowed(await allowed(tx));
          return receipt;
        },
      );
    },
  };
}

function validatePatch(value: unknown): Record<string, unknown> {
  requireAllowed(value && typeof value === 'object' && !Array.isArray(value));
  const patch = value as Record<string, unknown>;
  requireAllowed(Object.keys(patch).length > 0);
  for (const [key, field] of Object.entries(patch)) {
    if (['displayName', 'avatarUrl', 'biography'].includes(key))
      requireAllowed(field === null || (typeof field === 'string' && field.length <= 4096));
    else if (key === 'birthDate')
      requireAllowed(
        field === null ||
          (typeof field === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(field) &&
            Number.isFinite(Date.parse(field)) &&
            new Date(field).toISOString().slice(0, 10) === field),
      );
    else if (key === 'contentPreferences')
      requireAllowed(
        field && typeof field === 'object' && !Array.isArray(field) && JSON.stringify(field).length <= 16384,
      );
    else throw new LifecycleDeniedError();
  }
  // Snapshot the request so callers cannot mutate its digest or SQL parameters
  // while separately anchored permission preparation is in flight.
  return JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
}

function snapshotRequest(context: LifecycleRequest): LifecycleRequest {
  requireAllowed(context.actor.kind === 'account');
  return {
    ...context,
    actor: Object.isFrozen(context.actor) ? context.actor : { ...context.actor, scopes: [...context.actor.scopes] },
    ...(context.account ? { account: structuredClone(context.account) } : {}),
  };
}
async function resolveEvidence<T>(resolve: (value: unknown) => Promise<T | null>, value: unknown): Promise<T | null> {
  try {
    return structuredClone(await resolve(value));
  } catch {
    return null;
  }
}
