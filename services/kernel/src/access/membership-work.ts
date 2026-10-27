import { registerOrganizationCloseWork } from './organization-close-work.ts';
import { registerOperatorFenceWork } from './operator-fence-work.ts';
import type { MembershipWorkInput, MembershipWorkResult, MembershipWorkflowPorts } from '@rezics/auth-contract';
import {
  MEMBERSHIP_WORKFLOW_NAME,
  isMembershipAuthorizationReference,
  registerMembershipWorkflows,
} from '@rezics/auth/membership-workflows';
import canonicalize from 'canonicalize';
import { routeOf } from '../route/route.ts';
import { accountsWorkModule as writeRateExpiryWorkModule } from './write-rate-expiry.ts';
import type { WorkClient } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import {
  createMembershipInverseCommands,
  type RealmMembershipAuthority,
  type MembershipReservation,
} from './membership-inverse.ts';
import { createAccess as trustedPermissionAccess } from './permission.ts';
import { createAccess, createWorkflowApprovals } from './index.ts';
import {
  readMembershipRouteKey,
  readMembershipWorkConfig,
  type MembershipWorkConfig,
} from './membership-work-config.ts';
import type { Access } from '../request/access.ts';
import { createAccountAgentEffect } from './account-agent-effect.ts';
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
  /** Enqueue check and later step resolution for a Realm principal. */
  authorize(reference: string, input: MembershipWorkInput): Promise<LifecycleRequest>;
  publish(
    context: LifecycleRequest,
    input: Extract<MembershipWorkInput, { kind: 'membership' }>,
    reservation: MembershipReservation,
    key: string,
  ): Promise<unknown>;
  terminalize(reservation: MembershipReservation, key: string): Promise<unknown>;
};
type MembershipWorkContext = Pick<WorkContext, 'pool' | 'env'>;
type Options = { authorize?: MembershipAuthorization; access?: Access; realm?: RealmMembershipCommands };

/** Native Access-only ports. Direct component construction defers approval
 * configuration until use; WorkModule registration validates it eagerly. */
export function createMembershipWorkPorts(
  context: MembershipWorkContext,
  options: Options = {},
): MembershipWorkflowPorts<LifecycleRequest> {
  return membershipWorkPorts(context, options);
}
function membershipWorkPorts(
  context: MembershipWorkContext,
  options: Options,
  config?: MembershipWorkConfig,
): MembershipWorkflowPorts<LifecycleRequest> {
  const routeKey = config?.routeKey ?? readMembershipRouteKey(context.env);
  const internal = createLifecycleInternals({
    pool: context.pool,
    routeKey,
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  // Explicit trusted test injection retains the low-level fixture adapter.
  // Production always restores identity through installed Access's approval bridge.
  const trusted = options.authorize
    ? (options.access ??
      trustedPermissionAccess({
        actions: new Map(LIFECYCLE_ACTIONS),
        accountEvidence: (_actor, request) => request.account,
      }))
    : undefined;
  let installed: { access: Access; approvals: ReturnType<typeof createWorkflowApprovals> } | undefined;
  function native() {
    if (!installed) {
      const settings = config ?? readMembershipWorkConfig(context.env);
      const actions = new Map(LIFECYCLE_ACTIONS);
      const access = options.access ?? createAccess({ actions, auth: settings.auth });
      installed = {
        access,
        approvals: createWorkflowApprovals({
          pool: context.pool,
          access,
          actions,
          referenceKeys: settings.referenceKeys,
        }),
      };
    }
    return installed;
  }
  const commands = () => createLifecycleCommands({ pool: context.pool, access: trusted ?? native().access });
  const inverse = createMembershipInverseCommands({
    pool: context.pool,
    ...(options.realm ? { realmAuthority: options.realm.authority } : {}),
  });
  function realm() {
    if (!options.realm) throw new RealmMembershipUnavailableError();
    return options.realm;
  }
  return {
    async authorize(reference, input) {
      // Realm enqueue and publication both resolve through the installed port.
      // Organization creation and membership keep their existing resolver.
      if (input.kind === 'membership' && input.principal.kind === 'realm') return realm().authorize(reference, input);
      if (options.authorize) return options.authorize(reference, input);
      if (input.kind !== 'membership' || input.principal.kind !== 'organization')
        throw new MembershipAuthorizationUnavailableError();
      return native().approvals.resolve(
        reference,
        {
          kind: 'membership',
          organizationId: input.principal.id,
          memberAccountId: input.memberAccountId,
          role: input.role,
          ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
          authorization: reference,
        },
        { pool: context.pool, deadline: Date.now() + 30_000 },
      );
    },
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
      if (
        held.accountId !== input.memberAccountId ||
        held.principal.kind !== input.principal.kind ||
        held.principal.id !== input.principal.id ||
        (input.reservationId !== undefined && held.reservationId !== input.reservationId)
      )
        throw new MembershipAuthorizationUnavailableError();
      if (input.principal.kind === 'realm') return realm().publish(request, input, held, key);
      return commands().setMembership(request, {
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
  ports: MembershipWorkflowPorts<LifecycleRequest> = membershipWorkPorts(
    context,
    {},
    readMembershipWorkConfig(context.env),
  ),
): void {
  registerMembershipWorkflows(ports);
}
export function createAccountsWorkModule(options: Options = {}): WorkModule {
  return {
    name: 'accounts',
    async register(context) {
      const { registerAgentVerificationWork } = await import('./agent-verification-work.ts');
      registerAgentVerificationWork(context);
      const config = options.authorize ? undefined : readMembershipWorkConfig(context.env);
      registerAccounts(context, membershipWorkPorts(context, options, config));
      context.addEffects([createAccountAgentEffect(context.pool)]);
      if (config) registerOperatorFenceWork(context, config.referenceKeys);
      registerOrganizationCloseWork(context);
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
    !isMembershipAuthorizationReference(input.authorization)
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
      : [
          input.memberAccountId,
          input.principal.id,
          ...(input.reservationId === undefined ? [] : [input.reservationId]),
        ];
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
