import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { seal, type KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { REALM_MEMBERSHIP_SEAL_SCOPE, readRealmMembershipInterval, realmMembershipActorScopes } from './membership.ts';

export const REALM_JOIN_WORKFLOW = 'community.join';
export const REALM_LEAVE_WORKFLOW = 'community.leave';

const MEMBERSHIP_REFERENCE_TTL_MS = 5 * 60 * 1000;

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

function referenceFor(tokens: KeyRing, actor: AccountActor, intent: JoinIntent): string {
  const scopes = realmMembershipActorScopes({
    actorAccountId: actor.accountId,
    memberAccountId: intent.memberAccountId,
    role: intent.role,
  });
  return seal(tokens, REALM_MEMBERSHIP_SEAL_SCOPE, {
    accountId: actor.accountId,
    clientId: actor.clientId,
    requestedBy: actor.requestedBy,
    authnEpoch: actor.authnEpoch,
    scopes,
    realmId: intent.realmId,
    spaceId: intent.spaceId,
    memberAccountId: intent.memberAccountId,
    role: intent.role,
    ...(intent.reservationId === undefined ? {} : { reservationId: intent.reservationId }),
    expiresAt: Date.now() + MEMBERSHIP_REFERENCE_TTL_MS,
  });
}

async function enqueue(
  client: WorkClient,
  workflowName: string,
  id: string,
  actor: AccountActor,
  tokens: KeyRing,
  intent: JoinIntent,
): Promise<{ workflowId: string }> {
  const stored = await client.getWorkflow(id);
  if (stored) {
    if (stored.workflowName !== workflowName || !sameIntent(stored.input, intent))
      throw new RealmMembershipConflictError();
    return { workflowId: id };
  }
  const body: RealmMembershipWorkInput = { ...intent, authorization: referenceFor(tokens, actor, intent) };
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

/** Enqueue the durable self-join or add-member workflow. A repeated key returns the same id. */
export async function enqueueRealmJoin(
  client: WorkClient,
  input: {
    tokens: KeyRing;
    actor: AccountActor;
    realmId: string;
    spaceId: string;
    memberAccountId: string;
    idempotencyKey: string;
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
    client,
    REALM_JOIN_WORKFLOW,
    workflowId(REALM_JOIN_WORKFLOW, [input.actor.accountId, input.realmId, input.idempotencyKey]),
    input.actor,
    input.tokens,
    intent,
  );
}

/** Enqueue leave. Role null closes the interval at T and does not unfollow. */
export async function enqueueRealmLeave(
  client: WorkClient,
  input: {
    tokens: KeyRing;
    actor: AccountActor;
    realmId: string;
    spaceId: string;
    reservationId: string;
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
    client,
    REALM_LEAVE_WORKFLOW,
    workflowId(REALM_LEAVE_WORKFLOW, [input.actor.accountId, input.realmId, input.reservationId]),
    input.actor,
    input.tokens,
    intent,
  );
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
