import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { commandAccessContext } from '../access/command-admission.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorRecord, DurableOperationAnchor } from '../access/durable-initiator.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
} from '../command/command.ts';
import { accessCommandAuthorization, type Access, type AccountActor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { seal, type KeyRing } from '../tokens/seal.ts';
import { enqueueMembership } from '../access/membership-work.ts';
import type { WorkClient } from '../work/client.ts';
import {
  MEMBERSHIP_OPERATION_COMMANDS,
  REALM_MEMBERSHIP_SEAL_SCOPE,
  membershipOperationAction,
  membershipSourceDigest,
  readRealmMembershipInterval,
  type MembershipOperationFacts,
  type MembershipOperationKind,
} from './membership.ts';
import readRealmSpace from './ban-realm.sql';
import createOperation from './membership-operation-create.sql';

export const REALM_JOIN_WORKFLOW = 'community.join';
export const REALM_LEAVE_WORKFLOW = 'community.leave';

export class RealmMembershipConflictError extends Error {
  readonly code = 'realm_membership_conflict';
  constructor() {
    super('Realm membership workflow ID was reused with different input');
    this.name = 'RealmMembershipConflictError';
  }
}

/** Durable parent input. The authorization field is a seal, never a bearer token. */
export type RealmMembershipWorkInput = {
  realmId: string;
  spaceId: string;
  memberAccountId: string;
  role: 'member' | null;
  authorization: string;
  reservationId?: string;
};

type JoinIntent = {
  realmId: string;
  spaceId: string;
  memberAccountId: string;
  role: 'member' | null;
  reservationId?: string;
  removal?: string;
};

function workflowId(operation: string, parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `${operation}:${digest}`;
}

function sameIntent(stored: unknown, intent: JoinIntent): boolean {
  if (!Array.isArray(stored) || stored.length !== 1) return false;
  const value = stored[0];
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    row.realmId === intent.realmId &&
    row.spaceId === intent.spaceId &&
    row.memberAccountId === intent.memberAccountId &&
    row.role === intent.role &&
    (typeof row.reservationId === 'string' ? row.reservationId : undefined) === intent.reservationId
  );
}

/** What accepting a join, leave or removal needs. The operation commits through Access, so no
 * seal ever stands in for the actor that Access authenticated.
 */
export type MembershipDependencies = Readonly<{
  pool: Pool;
  access: Access;
  clock?: () => Date;
  tokens: KeyRing;
  client: WorkClient;
}>;
type Acceptance = Readonly<{ deadline: number }>;

function referenceFor(tokens: KeyRing, kind: MembershipOperationKind, operationId: string, intent: JoinIntent): string {
  return seal(tokens, REALM_MEMBERSHIP_SEAL_SCOPE, {
    operationId,
    kind,
    realmId: intent.realmId,
    spaceId: intent.spaceId,
    memberAccountId: intent.memberAccountId,
    role: intent.role,
    ...(intent.reservationId === undefined ? {} : { reservationId: intent.reservationId }),
    ...(intent.removal === undefined ? {} : { removal: intent.removal }),
  });
}

/** Authenticate, authorize and commit the operation row with its creation receipt, in one
 * Realm-partition command. The row records the original actor, floor and delegation, so every
 * workflow step can restore that initiator later. A retry replays the receipt and its operation.
 */
async function acceptOperation(
  deps: MembershipDependencies,
  actor: AccountActor,
  kind: MembershipOperationKind,
  commandKey: string,
  intent: JoinIntent,
  context: Acceptance,
): Promise<{ operationId: string }> {
  const route = routeOf(intent.realmId);
  if (route === null) throw new GrantDeniedError();
  const { pool } = deps;
  const target = Object.freeze({ route, id: intent.realmId });
  const commandKind = MEMBERSHIP_OPERATION_COMMANDS[kind];
  const identity = principalCommandIdentity(actor);
  const facts: MembershipOperationFacts = {
    realmId: intent.realmId,
    spaceId: intent.spaceId,
    memberAccountId: intent.memberAccountId,
    reservationId: intent.reservationId ?? null,
    banId: intent.removal ?? null,
  };
  const requestDigest = createHash('sha256')
    .update(canonicalize([identity, commandKind, facts])!)
    .digest();
  // Copy only verified identity fields; never serialize a bearer or caller extras.
  const snapshot = {
    kind: 'account' as const,
    accountId: actor.accountId,
    clientId: actor.clientId,
    scopes: [...actor.scopes],
    requestedBy: actor.requestedBy,
    authnEpoch: actor.authnEpoch,
  };
  const action = membershipOperationAction(kind, actor.accountId, intent.memberAccountId);
  const base = await accessCommandAuthorization(
    deps.access,
    actor,
    action,
    target,
    { pool, deadline: context.deadline },
    () => new GrantDeniedError(),
  );
  let captured: Awaited<ReturnType<typeof captureDurableInitiator>> | undefined;
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      captured = undefined;
      const proof = await base.prepare!(attempt);
      try {
        // After admission at this live T and before any write; Access without admission refuses.
        captured = await captureDurableInitiator(
          commandAccessContext({ pool, deadline: context.deadline }, attempt),
          actor,
        );
      } catch (error) {
        if (error instanceof AccessUnavailableError) throw error;
        throw new GrantDeniedError();
      }
      return proof;
    },
  };
  const operationId = newId(route);
  const operation: DurableOperationAnchor = { route, id: operationId, kind: commandKind, sourceId: operationId };
  const outcome = await runCommand(
    pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: { kind: commandKind, key: commandKey, digest: requestDigest },
      authorization,
    },
    async (tx, command) => {
      if (!captured) throw new GrantDeniedError();
      const at = authoritativeTimeValue(command.time);
      const realm = await readRealmSpace.run(tx, { route, realm_id: intent.realmId, at });
      if (!realm || realm.spaceId !== intent.spaceId) throw new GrantDeniedError();
      const sourceDigest = membershipSourceDigest(operation, target, facts);
      const record: DurableInitiatorRecord = {
        operation,
        initiatorAccountId: snapshot.accountId,
        actor: snapshot,
        recordedTransactionId: command.transactionId,
        sourceDigest,
        ...captured,
        creation: {
          commandKind,
          idempotencyKey: commandKey,
          requestDigest: requestDigest.toString('hex'),
          target,
        },
      };
      await createOperation.run(tx, {
        route,
        operation_id: operationId,
        kind,
        realm_id: intent.realmId,
        space_id: intent.spaceId,
        member_account_id: intent.memberAccountId,
        reservation_id: facts.reservationId,
        ban_id: facts.banId,
        initiator_id: snapshot.accountId,
        client_id: snapshot.clientId,
        scopes: snapshot.scopes,
        requested_by: snapshot.requestedBy,
        authn_epoch: BigInt(snapshot.authnEpoch),
        at,
        transaction_id: command.transactionId,
        source_digest: sourceDigest,
        original_minimum_authn_epoch: captured.originalAccount.minimumAuthnEpoch,
        original_operator_account_id: captured.originalAccount.operatorAccountId,
        original_delegation_transaction_id: captured.originalDelegation?.transactionId ?? null,
        original_delegation_issued_valid: captured.originalDelegation?.issuedValid ?? null,
        creation_command_kind: record.creation.commandKind,
        creation_idempotency_key: record.creation.idempotencyKey,
        creation_request_digest: record.creation.requestDigest,
        creation_target_route: target.route,
        creation_target_id: target.id,
      });
      return {
        value: { operationId, durableInitiator: durableInitiatorCommitment(record) },
        events: [
          {
            type: 'com.rezics.community.realm.membership.requested.v1',
            subject: intent.realmId,
            data: {
              realmId: intent.realmId,
              accountId: intent.memberAccountId,
              operationId,
              kind,
              at,
              transactionId: command.transactionId,
            },
          },
        ],
      };
    },
  );
  return { operationId: outcome.value.operationId };
}

async function enqueue(
  deps: MembershipDependencies,
  workflowName: string,
  id: string,
  actor: AccountActor,
  kind: 'join' | 'leave',
  intent: JoinIntent,
  context: Acceptance,
): Promise<{ workflowId: string }> {
  const { client, tokens } = deps;
  const accepted = await acceptOperation(deps, actor, kind, id, intent, context);
  const stored = await client.getWorkflow(id);
  if (stored) {
    if (stored.workflowName !== workflowName || !sameIntent(stored.input, intent))
      throw new RealmMembershipConflictError();
    return { workflowId: id };
  }
  const body: RealmMembershipWorkInput = {
    ...intent,
    authorization: referenceFor(tokens, kind, accepted.operationId, intent),
  };
  await client.enqueue<(input: RealmMembershipWorkInput) => Promise<void>>(
    {
      workflowName,
      queueName: 'workflows',
      workflowID: id,
      workflowIDReusePolicy: 'return-existing',
    },
    body,
  );
  const written = await client.getWorkflow(id);
  if (written?.workflowName !== workflowName || canonicalize(written.input) !== canonicalize([body]))
    throw new RealmMembershipConflictError();
  return { workflowId: id };
}

/** Accept and enqueue the durable self-join or add-member workflow. A repeated key returns the same id. */
export async function enqueueRealmJoin(
  deps: MembershipDependencies,
  input: {
    actor: AccountActor;
    realmId: string;
    spaceId: string;
    memberAccountId: string;
    idempotencyKey: string;
    deadline: number;
  },
): Promise<{ workflowId: string }> {
  if (routeOf(input.realmId) === null || routeOf(input.spaceId) === null || routeOf(input.memberAccountId) === null)
    throw new GrantDeniedError();
  const intent: JoinIntent = {
    realmId: input.realmId,
    spaceId: input.spaceId,
    memberAccountId: input.memberAccountId,
    role: 'member',
  };
  return enqueue(
    deps,
    REALM_JOIN_WORKFLOW,
    workflowId(REALM_JOIN_WORKFLOW, [input.actor.accountId, input.realmId, input.idempotencyKey]),
    input.actor,
    'join',
    intent,
    input,
  );
}

/** Accept and enqueue leave. Role null closes the interval at T and does not unfollow. */
export async function enqueueRealmLeave(
  deps: MembershipDependencies,
  input: {
    actor: AccountActor;
    realmId: string;
    spaceId: string;
    reservationId: string;
    deadline: number;
  },
): Promise<{ workflowId: string }> {
  if (
    routeOf(input.realmId) === null ||
    routeOf(input.spaceId) === null ||
    routeOf(input.reservationId) !== routeOf(input.actor.accountId)
  )
    throw new GrantDeniedError();
  const intent: JoinIntent = {
    realmId: input.realmId,
    spaceId: input.spaceId,
    memberAccountId: input.actor.accountId,
    role: null,
    reservationId: input.reservationId,
  };
  return enqueue(
    deps,
    REALM_LEAVE_WORKFLOW,
    workflowId(REALM_LEAVE_WORKFLOW, [input.actor.accountId, input.realmId, input.reservationId]),
    input.actor,
    'leave',
    intent,
    input,
  );
}

/** Ban removal uses the same native leave steps, with a distinct durable key for each ban.
 * Its operation commits the moderator's realm:ban, restored at each step on the exact Realm,
 * member and reservation.
 */
export async function enqueueRealmRemoval(
  deps: MembershipDependencies,
  input: {
    actor: AccountActor;
    realmId: string;
    spaceId: string;
    memberAccountId: string;
    reservationId: string;
    banId: string;
    deadline: number;
  },
): Promise<{ workflowId: string }> {
  if (
    routeOf(input.realmId) === null ||
    routeOf(input.spaceId) === null ||
    routeOf(input.memberAccountId) === null ||
    !input.actor.scopes.includes('realm:ban') ||
    routeOf(input.banId) === null ||
    routeOf(input.reservationId) !== routeOf(input.memberAccountId)
  )
    throw new GrantDeniedError();
  const id = workflowId('realm:ban', [input.realmId, input.memberAccountId, input.banId]);
  const intent: JoinIntent = {
    realmId: input.realmId,
    spaceId: input.spaceId,
    memberAccountId: input.memberAccountId,
    role: null,
    reservationId: input.reservationId,
    removal: input.banId,
  };
  const accepted = await acceptOperation(deps, input.actor, 'removal', id, intent, input);
  const { client } = deps;
  const stored = await client.getWorkflow(id);
  if (stored) {
    const body = Array.isArray(stored.input) ? (stored.input[0] as Record<string, unknown> | undefined) : undefined;
    const principal = body?.principal as Record<string, unknown> | undefined;
    if (
      stored.workflowName !== 'accounts.membership' ||
      body?.kind !== 'membership' ||
      principal?.kind !== 'realm' ||
      principal.id !== input.realmId ||
      body.memberAccountId !== input.memberAccountId ||
      body.role !== null ||
      body.reservationId !== input.reservationId
    )
      throw new RealmMembershipConflictError();
    return { workflowId: id };
  }
  await enqueueMembership(client, id, {
    kind: 'membership',
    principal: { kind: 'realm', id: input.realmId },
    memberAccountId: input.memberAccountId,
    role: null,
    reservationId: input.reservationId,
    authorization: referenceFor(deps.tokens, 'removal', accepted.operationId, intent),
  });
  return { workflowId: id };
}

export async function readOwnRealmMembership(
  pool: Pool,
  realmId: string,
  accountId: string,
  at: string,
): Promise<{ state: 'member'; since: string } | { state: 'none'; since: null }> {
  const interval = await readRealmMembershipInterval(pool, realmId, accountId, at);
  return interval ? { state: 'member', since: interval.since } : { state: 'none', since: null };
}
