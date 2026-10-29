import { throwAccessUnavailable } from './unavailable.ts';
import { LifecycleDeniedError, lifecycleExecutor } from './lifecycle-20261025094010-command.ts';
export { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import {
  accessCommandAuthorization,
  type Access,
  type AccountActor,
  type AccessClient,
  type ActionCatalogue,
} from '../request/access.ts';
import { anchorRoute, derivedId, routeOf } from '../route/route.ts';
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
import membershipEvidence from './membership-inverse-20261025093747-evidence.sql';
import terminalizeMembership from './lifecycle-20261025093747-terminalize.sql';
import { createMembershipInverseCommands } from './membership-inverse.ts';
import holdsRead from './lifecycle-holds.sql';
import membershipChange from './lifecycle-membership.sql';
import memberInsert from './lifecycle-member-insert.sql';
import ownersRead from './lifecycle-owners.sql';
import membershipTime from './lifecycle-membership-time.sql';
import fenceStatement from './lifecycle-fence.sql';
import authBarrier from './auth-barriers-advance.sql';
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
import {
  insertDeletionContinuation,
  validateContinuationBinding,
  type ContinuationBinding,
} from './committed-continuations.ts';

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
  ['organization:create', { anonymous: false }],
  ['organization:membership', { anonymous: false }],
]);
const ACTOR_ACTIONS = ['account:update', 'account:delete'];
const ORGANIZATION_ACTIONS = [...ACTOR_ACTIONS, 'organization:membership', 'account:manage', 'access:grant'];
const ID_NAMESPACE = '9e068400-e1f4-8ba0-925e-098dec304890';

function requireAllowed(value: unknown): asserts value {
  if (!value) throw new LifecycleDeniedError();
}
function accountRoute(accountId: string): number {
  const route = routeOf(accountId);
  requireAllowed(route !== null);
  return route;
}
export function normalizeHandle(handle: string): string {
  requireAllowed(typeof handle === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle));
  return handle.toLowerCase();
}
function normalized(handle: string): string {
  return normalizeHandle(handle);
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
export type AuthenticationBarrierCommand = LifecycleCommand & {
  purpose: 'consent-reduction' | 'recovery';
  expectedMinimumAuthnEpoch: number;
  proofReference: string;
  proofDigest: string;
  proofExpiresAt: string;
};
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
async function locked(tx: AccessClient, accountId: string): Promise<TransactionAccount> {
  const account = await accountRead.run(tx, { route: accountRoute(accountId), account_id: accountId });
  requireAllowed(account);
  return account;
}
/** Lock every account before any coordinated write. Route then id order matches
 * suspension's single-account lock, so the transactions cannot deadlock.
 */
async function lockAccounts(tx: AccessClient, ids: readonly string[]): Promise<Map<string, TransactionAccount>> {
  const ordered = [...new Set(ids)].sort((left, right) => {
    const delta = accountRoute(left) - accountRoute(right);
    return delta === 0 ? (left < right ? -1 : left > right ? 1 : 0) : delta;
  });
  const rows = new Map<string, TransactionAccount>();
  for (const id of ordered) rows.set(id, await locked(tx, id));
  return rows;
}
async function memberReservation(pool: Pool, accountId: string, organizationId: string, reservationId: string) {
  requireAllowed(accountRoute(reservationId) === accountRoute(accountId));
  return withConnection(pool, async (client) => {
    // This is an independent actor-anchor read before organization checkout.
    // Holds never expire and prevent subsequent deletion/automation on that actor.
    return membershipEvidence.run(client, {
      route: accountRoute(accountId),
      account_id: accountId,
      group_id: organizationId,
      reservation_id: reservationId,
    });
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
  // Closure and insertion share the command's authoritative time. Native writes
  // admit one ongoing interval; a future scheduling API needs bounded admission
  // or a separately anchored workflow for its actual future interval changes.
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
  /** Expiring sources must supply their original expiry (native Auth always does). */
  expiresAt?: string;
};

/** INTERNAL SERVICE CAPABILITY for the later registration/fencing coordinator.
 * Mount neither this factory nor its inputs as public HTTP commands. Evidence
 * resolvers validate trusted coordinator records. Recovery may point-read the
 * Auth-owned witness before checkout, never while holding the account anchor.
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
 * bound to accountId, receiptId and the exact minimumAuthnEpoch/authnEpoch.
 * It returns {accountId, receiptId, minimumAuthnEpoch}; the floor never
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
  const execute = lifecycleExecutor(pool, config.clock);
  const routeKey = new Uint8Array(config.routeKey);
  const inverse = createMembershipInverseCommands({
    ...config,
    releaseCommandKind: 'membership-coordination-released',
  });
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
          await grants(tx, input.accountId, input.accountId, '', transactionId, ['account:read', 'account:manage']);
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
    /** Release the exact member hold and inverse together, after independently
     * reading immutable organization-local terminal evidence. */
    async releaseMembershipCoordination(input: {
      organizationId: string;
      memberAccountId: string;
      reservationId: string;
      key: string;
    }) {
      input = { ...input };
      const outcome = await inverse.release({
        accountId: input.memberAccountId,
        principal: { kind: 'organization', id: input.organizationId },
        reservationId: input.reservationId,
        key: input.key,
      });
      return {
        ...outcome,
        value: {
          organizationId: input.organizationId,
          memberAccountId: input.memberAccountId,
          reservationId: input.reservationId,
        },
      };
    },
    /** Actor/operator-anchor hold, separate from organization mutation. Holds
     * remain until the durable workflow releases them using terminal proof.
     */
    async reserveCoordination(
      input: LifecycleCommand & { relatedAccountId: string; purpose: 'membership' | 'operator' },
    ) {
      input = { ...input };
      const route = accountRoute(input.accountId);
      accountRoute(input.relatedAccountId);
      requireAllowed(input.purpose === 'membership' || input.purpose === 'operator');
      requireAllowed(input.accountId !== input.relatedAccountId);
      if (input.purpose === 'membership') {
        const outcome = await inverse.reserve({
          accountId: input.accountId,
          principal: { kind: 'organization', id: input.relatedAccountId },
          key: input.key,
        });
        return {
          ...outcome,
          value: {
            accountId: input.accountId,
            relatedAccountId: input.relatedAccountId,
            purpose: input.purpose,
            reservationId: outcome.value.reservationId,
          },
        };
      }
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
              input.purpose === 'operator',
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
    /** Abort an unpublished organization reservation on its authoritative anchor.
     * A committed terminal slot permanently prevents delayed publication. Active
     * memberships must first use public setMembership(role: null). No actor
     * connection is held here; the later inverse release reads this proof anew.
     */
    async terminalizeMembership(input: {
      organizationId: string;
      memberAccountId: string;
      reservationId: string;
      key: string;
    }) {
      input = { ...input };
      const route = accountRoute(input.organizationId);
      requireAllowed(accountRoute(input.reservationId) === accountRoute(input.memberAccountId));
      return execute(
        { route, id: input.organizationId, kind: 'membership-terminalized', key: input.key, input },
        async (tx, transactionId) => {
          // An existing organization serializes with its own membership commands.
          // A failed organization creation may have no account row yet.
          await accountRead.run(tx, { route, account_id: input.organizationId });
          requireAllowed(
            affected(
              await terminalizeMembership.run(tx, {
                route,
                organization_id: input.organizationId,
                member_id: input.memberAccountId,
                reservation_id: input.reservationId,
                transaction_id: transactionId,
              }),
            ),
          );
          return { ...input, transactionId };
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
          // The owner's coordination row is on the owner anchor. Observe it again
          // under that row lock so a committed suspension fails closed.
          const owner = await locked(tx, input.ownerAccountId);
          requireAllowed(
            owner.kind === 'actor' &&
              owner.operatorAccountId === null &&
              owner.state === 'active' &&
              !owner.fenced &&
              reservation,
          );
          requireAllowed(
            await membershipEvidence.run(tx, {
              route: accountRoute(input.ownerAccountId),
              account_id: input.ownerAccountId,
              group_id: input.organizationId,
              reservation_id: input.ownerReservationId,
            }),
          );
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
    /** Trusted Auth composition only. Proof resolution happens at each native
     * attempt, including receipt replay; floor comparison holds the account lock.
     * A later floor can never authorize an earlier operation's receipt.
     */
    async advanceAuthenticationFloor(value: AuthenticationBarrierCommand, verifyAtAttempt: () => Promise<boolean>) {
      const input = { ...value };
      const route = accountRoute(input.accountId);
      requireAllowed(
        ['consent-reduction', 'recovery'].includes(input.purpose) &&
          epoch(input.expectedMinimumAuthnEpoch) &&
          input.expectedMinimumAuthnEpoch < 2147483647 &&
          /^[a-f0-9]{64}$/.test(input.proofReference) &&
          /^[a-f0-9]{64}$/.test(input.proofDigest) &&
          Number.isFinite(Date.parse(input.proofExpiresAt)) &&
          typeof verifyAtAttempt === 'function',
      );
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'authentication-floor-advanced',
          key: input.key,
          input,
          authorization: {
            action: 'authentication-floor-advance',
            resource: { route, id: input.accountId },
            prepare: () => verifyAtAttempt(),
            async authorize(tx, attempt, verified) {
              requireAllowed(
                verified === true &&
                  Date.parse(input.proofExpiresAt) > Date.parse(authoritativeTimeValue(attempt.time)),
              );
              const account = await locked(tx, input.accountId);
              requireAllowed(
                account.state === 'active' &&
                  account.kind === 'actor' &&
                  account.operatorAccountId === null &&
                  (input.purpose !== 'recovery' || account.fenced),
              );
              const floor = BigInt(account.minimumAuthnEpoch);
              requireAllowed(
                floor === BigInt(input.expectedMinimumAuthnEpoch) ||
                  floor === BigInt(input.expectedMinimumAuthnEpoch + 1),
              );
              return floor === BigInt(input.expectedMinimumAuthnEpoch) ? 'execute' : 'receipt-only';
            },
            denied: () => new LifecycleDeniedError(),
          },
        },
        async (tx, transactionId) => {
          const receipts = await authBarrier.run(tx, {
            route,
            account_id: input.accountId,
            receipt_id: derivedId(ID_NAMESPACE, `${transactionId}:fence`, route),
            transaction_id: transactionId,
            expected_floor: String(input.expectedMinimumAuthnEpoch),
            purpose: input.purpose,
          });
          requireAllowed(receipts[0]);
          return receipts[0];
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
          proof.receiptId &&
          epoch(proof.authnEpoch) &&
          /^[1-9][0-9]*$/.test(proof.minimumAuthnEpoch) &&
          BigInt(proof.authnEpoch) === BigInt(proof.minimumAuthnEpoch),
      );
      // Snapshot every field in the digest. Each native attempt must resolve
      // this same immutable witness again, with no account connection held.
      const binding = JSON.stringify(proof);
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'authentication-established',
          key: input.key,
          input: proof,
          authorization: {
            action: 'authentication-establish',
            resource: { route, id: input.accountId },
            async prepare() {
              const current = await resolveEvidence(config.recoveryEvidence, input.evidence);
              return current !== null && JSON.stringify(current) === binding;
            },
            async authorize(tx, attempt, verified) {
              requireAllowed(
                verified === true &&
                  (proof.expiresAt === undefined ||
                    Date.parse(proof.expiresAt) > Date.parse(authoritativeTimeValue(attempt.time))),
              );
              const account = await locked(tx, input.accountId);
              requireAllowed(
                account.state === 'active' &&
                  account.kind === 'actor' &&
                  account.operatorAccountId === null &&
                  account.receiptId === proof.receiptId &&
                  account.minimumAuthnEpoch === proof.minimumAuthnEpoch,
              );
              const receipt = await fenceRead.run(tx, {
                route,
                account_id: input.accountId,
                receipt_id: proof.receiptId,
              });
              requireAllowed(
                receipt &&
                  receipt.accountId === proof.accountId &&
                  receipt.receiptId === proof.receiptId &&
                  receipt.minimumAuthnEpoch === proof.minimumAuthnEpoch &&
                  receipt.kind === 'fence' &&
                  receipt.priorOperatorAccountId === null,
              );
              // An unfenced account can only retrieve this exact command's
              // receipt. A missing/mismatched receipt cannot execute an effect.
              return account.fenced ? 'execute' : 'receipt-only';
            },
            denied: () => new LifecycleDeniedError(),
          },
        },
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
 * parameter is verified kernel request context. Access prepares on every attempt before
 * checkout and the resource check executes on each real runCommand attempt.
 */
export function createLifecycleCommands(config: Boundary & { access: Access }) {
  const { pool, access } = config;
  const execute = lifecycleExecutor(pool, config.clock);
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
          const rows = await lockAccounts(tx, [input.organizationId, input.memberAccountId]);
          const org = rows.get(input.organizationId);
          const member = rows.get(input.memberAccountId);
          requireAllowed(await allowed(tx));
          requireAllowed(org?.kind === 'organization' && org.state === 'active' && !org.fenced && reservation);
          requireAllowed(member?.state === 'active');
          requireAllowed(
            await membershipEvidence.run(tx, {
              route: accountRoute(input.memberAccountId),
              account_id: input.memberAccountId,
              group_id: input.organizationId,
              reservation_id: input.reservationId,
            }),
          );
          // Keep the single command time for history, but never check owners
          // before a membership change already committed under this org lock.
          const guard = await membershipTime.run(tx, {
            route,
            organization_id: input.organizationId,
            at: authoritativeTimeValue(currentCommand(tx).time),
          });
          requireAllowed(guard?.at);
          const owners = await ownersRead.run(tx, {
            route,
            organization_id: input.organizationId,
            member_id: input.memberAccountId,
            at: guard.at,
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
    async tombstone(context: LifecycleRequest, input: LifecycleCommand & { continuation?: ContinuationBinding }) {
      input = { ...input };
      context = snapshotRequest(context);
      const continuation = input.continuation;
      if (continuation) validateContinuationBinding(continuation);
      const route = accountRoute(input.accountId);
      const authorization = await authorize(context, 'account:delete', input.accountId);
      const allowed = authorization.check;
      return execute(
        {
          route,
          id: input.accountId,
          kind: 'account-tombstoned',
          key: input.key,
          input: continuation
            ? {
                operationKey: continuation.operationKey,
                operationDigest: continuation.operationDigest,
                commandKeyPrefix: continuation.commandKeyPrefix,
              }
            : {},
          actor: context.actor,
          deadline: context.deadline,
          authorization,
        },
        async (tx, transactionId) => {
          const account = await locked(tx, input.accountId);
          requireAllowed(await allowed(tx));
          requireAllowed(account.state === 'active');
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
          const priorHandle = account.handle;
          const priorOperatorAccountId = account.operatorAccountId;
          const priorReservationId = account.operatorReservationId;
          const receipt = await fence(tx, account, true, transactionId);
          if (continuation) {
            await insertDeletionContinuation(tx, {
              accountId: account.accountId,
              handle: priorHandle,
              operatorAccountId: priorOperatorAccountId,
              reservationId: priorReservationId,
              binding: continuation,
              barrierReceiptId: receipt.receiptId,
              minimumAuthnEpoch: receipt.minimumAuthnEpoch,
              transactionId,
            });
          }
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
  } catch (error) {
    throwAccessUnavailable(error);
    return null;
  }
}
