import {
  MEMBERSHIP_WORKFLOW_NAME,
  registerMembershipWorkflows,
  type MembershipWorkInput,
  type MembershipWorkResult,
  type MembershipWorkflowPorts,
} from '@rezics/auth/membership-workflows';
import canonicalize from 'canonicalize';
import { routeOf } from '../route/route.ts';
import { ConfigError } from '../commerce/config.ts';
import { accountsWorkModule as writeRateExpiryWorkModule } from './write-rate-expiry.ts';
import type { WorkClient } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import {
  createMembershipInverseCommands,
  type RealmMembershipAuthority,
  type MembershipReservation,
} from './membership-inverse.ts';
import { createAccess } from './permission.ts';
import type { Access } from '../request/access.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  type LifecycleRequest,
} from './lifecycle.ts';

export class MembershipWorkConflictError extends Error {
  readonly code = 'membership_work_conflict';
  constructor() {
    super('Membership workflow ID was reused with different input');
  }
}
export class MembershipAuthorizationUnavailableError extends Error {
  readonly code = 'membership_authorization_unavailable';
  constructor() {
    super('Durable membership authorization reference resolver is unavailable');
  }
}
export class RealmMembershipUnavailableError extends Error {
  readonly code = 'realm_membership_unavailable';
  constructor() {
    super('Realm membership command adapter is unavailable');
  }
}
export type MembershipAuthorization = (reference: string, input: MembershipWorkInput) => Promise<LifecycleRequest>;
/** Installed by the owning Realm module. Following a Realm has no operation here. */
export type RealmMembershipCommands = {
  authority: RealmMembershipAuthority;
  publish(
    context: LifecycleRequest,
    input: Extract<MembershipWorkInput, { kind: 'membership' }>,
    reservation: MembershipReservation,
    key: string,
  ): Promise<unknown>;
  terminalize(reservation: MembershipReservation, key: string): Promise<unknown>;
};
type Options = { authorize?: MembershipAuthorization; access?: Access; realm?: RealmMembershipCommands };

/** Native Access-only ports. No Auth host, database, key or maintenance runtime
 * is constructed here. The capability owner must inject a durable resolver. */
export function createMembershipWorkPorts(
  context: WorkContext,
  options: Options = {},
): MembershipWorkflowPorts<LifecycleRequest> {
  const encoded = context.env.KERNEL_ROUTE_KEY ?? '';
  const routeKey = Buffer.from(encoded, 'base64url');
  if (routeKey.length !== 32 || routeKey.toString('base64url') !== encoded) throw new ConfigError('KERNEL_ROUTE_KEY');
  const internal = createLifecycleInternals({
    pool: context.pool,
    routeKey,
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const access =
    options.access ??
    createAccess({ actions: new Map(LIFECYCLE_ACTIONS), accountEvidence: (_actor, request) => request.account });
  const commands = createLifecycleCommands({ pool: context.pool, access });
  const inverse = createMembershipInverseCommands({
    pool: context.pool,
    ...(options.realm ? { realmAuthority: options.realm.authority } : {}),
  });
  function realm() {
    if (!options.realm) throw new RealmMembershipUnavailableError();
    return options.realm;
  }
  return {
    authorize:
      options.authorize ??
      (async () => {
        throw new MembershipAuthorizationUnavailableError();
      }),
    actorAccountId: (request) => request.actor.accountId,
    reserve(input) {
      if (input.principal.kind === 'realm') realm();
      return inverse.reserve(input);
    },
    async publish(request, input, held, key) {
      if (input.kind === 'organization') {
        if (held.accountId !== request.actor.accountId) throw new MembershipAuthorizationUnavailableError();
        return internal.createOrganization({
          organizationId: input.organizationId,
          ownerAccountId: held.accountId,
          ownerReservationId: held.reservationId,
          key,
        });
      }
      if (input.principal.kind === 'realm') return realm().publish(request, input, held, key);
      return commands.setMembership(request, {
        organizationId: input.principal.id,
        memberAccountId: held.accountId,
        reservationId: held.reservationId,
        role: input.role,
        key,
      });
    },
    async terminalize(held, key) {
      if (held.principal.kind === 'realm') return realm().terminalize(held, key);
      return internal.terminalizeMembership({
        organizationId: held.principal.id,
        memberAccountId: held.accountId,
        reservationId: held.reservationId,
        key,
      });
    },
    release: (input) => inverse.release(input),
  };
}
export function registerAccounts(
  context: WorkContext,
  ports: MembershipWorkflowPorts<LifecycleRequest> = createMembershipWorkPorts(context),
): void {
  registerMembershipWorkflows(ports);
}
export function createAccountsWorkModule(options: Options = {}): WorkModule {
  return {
    name: 'accounts',
    async register(context) {
      registerAccounts(context, createMembershipWorkPorts(context, options));
      await writeRateExpiryWorkModule.register(context);
    },
  };
}
export const accountsWorkModule: WorkModule = createAccountsWorkModule();

/** Caller creates/closes the enqueue-only client through createWorkClient.
 * Input must contain only an opaque durable authorization reference. */
export async function enqueueMembership(client: WorkClient, workflowId: string, input: MembershipWorkInput) {
  // Reject unknown fields rather than persisting accidental credentials/context.
  const fields =
    input.kind === 'organization'
      ? ['kind', 'organizationId', 'authorization']
      : ['kind', 'principal', 'memberAccountId', 'role', 'reservationId', 'authorization'];
  if (
    typeof workflowId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:_/-]{0,199}$/.test(workflowId) ||
    Object.keys(input).some((field) => !fields.includes(field)) ||
    typeof input.authorization !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:_/-]{0,255}$/.test(input.authorization)
  )
    throw new Error('Invalid membership work input');
  if (
    input.kind !== 'organization' &&
    (input.kind !== 'membership' ||
      !input.principal ||
      Object.keys(input.principal).some((field) => !['kind', 'id'].includes(field)) ||
      !['organization', 'realm'].includes(input.principal.kind) ||
      !['owner', 'member', null].includes(input.role))
  )
    throw new Error('Invalid membership work input');
  const ids =
    input.kind === 'organization'
      ? [input.organizationId]
      : [input.memberAccountId, input.principal.id, ...(input.reservationId ? [input.reservationId] : [])];
  if (ids.some((id) => typeof id !== 'string' || routeOf(id) === null))
    throw new Error('Invalid membership work input');
  const snapshot = structuredClone(input);
  const handle = await client.enqueue<(input: MembershipWorkInput) => Promise<MembershipWorkResult>>(
    {
      workflowName: MEMBERSHIP_WORKFLOW_NAME,
      queueName: 'workflows',
      workflowID: workflowId,
      workflowIDReusePolicy: 'return-existing',
    },
    snapshot,
  );
  const stored = await client.getWorkflow(workflowId);
  if (stored?.workflowName !== MEMBERSHIP_WORKFLOW_NAME || canonicalize(stored.input) !== canonicalize([snapshot]))
    throw new MembershipWorkConflictError();
  return handle;
}
