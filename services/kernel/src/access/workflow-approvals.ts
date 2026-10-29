import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { HANDLE_LOOKUP_PATTERN, isClaimHandle } from './handle-policy.ts';
import { accessClock } from './access-clock.ts';
import { accessEvidence, throwEvidenceFailure } from './evidence.ts';
import { requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import { createSuspensionCommands } from './suspension.ts';
import { createSessionRevocationCommands } from './session-revocation.ts';
import type { CredentialFloorBinding as CredentialEffectBinding } from '@rezics/auth-contract';
import credentialConsume from './workflow-approvals-credential-consume.sql';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type {
  AccountOperation as ContractAccountOperation,
  NativeWorkflowProofPorts,
  WorkflowResponsibility,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, ActionCatalogue } from '../request/access.ts';
import { seal, unseal, type KeyRing } from '../tokens/seal.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { authoritativeTimeValue, runCommand, type CommandAuthorization } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineClient, within } from './authenticate.ts';
import { readAccount } from './account-data.ts';
import {
  APPROVAL_REFERENCE_PURPOSE,
  approvalRowDigest,
  readApprovedIdentity,
  ApprovalIdentityUnavailableError,
  verifiedKernelExpiry,
  type ApprovalRow,
} from './approved-identity.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import type { LifecycleRequest } from './lifecycle.ts';
import credentialRead from './auth-credential-capability-workflow-read.sql';
import approvalInsert from './workflow-approvals-insert.sql';
import approvalSweep from './workflow-approvals-sweep.sql';
import clientManagementAnchor from './workflow-approvals-client-anchor.sql';
import tombstoneOperator from './workflow-approvals-tombstone-operator.sql';
import ownersRead from './lifecycle-owners.sql';
import operatorAccount from './operator-account.sql';
import operatorSlot from './operator-slot.sql';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';

export const MAX_WORKFLOW_APPROVAL_LIFETIME_MS = 300_000;
/** Host composition registers these workflow actions without a kernel HTTP route. */
export const WORKFLOW_APPROVAL_ACTIONS: ActionCatalogue = new Map([['client:manage', { anonymous: false }]]);
/** Nonsecret integrity-bound locator only; no actor, credentials or authority. */
export type WorkflowApproval = { reference: string; expiresAt: string };
export type WorkflowApprovalConfig = { pool: Pool; access: Access; actions: ActionCatalogue; referenceKeys: KeyRing };
export type CredentialOperation = Pick<
  CredentialEffectBinding,
  'subjectAccountId' | 'purpose' | 'operationKey' | 'effectReference' | 'effectDigest'
> & { kind: 'credential'; subjectEpoch: number; authorization: string };
type TransferOperation = Extract<ContractAccountOperation, { kind: 'transfer' }> & { acceptance?: string };
/** The contract's revoke carries no approval reference; this adapter binds one and denies a request without. */
type RevokeOperation = { kind: 'revoke'; accountId: string; authorization?: string };
type TransferAcceptanceOperation = {
  kind: 'transfer-acceptance';
  previous: WorkflowResponsibility;
  expectedVersion: string;
  operatorAccountId: string;
  sourceOperationKey: string;
  authorization: string;
};
type AccountOperation = (
  | Exclude<ContractAccountOperation, { kind: 'transfer' | 'revoke' }>
  | RevokeOperation
  | TransferOperation
  | TransferAcceptanceOperation
) & { operationKey?: string };
type NativeOperation = AccountOperation | CredentialOperation;
export type WorkflowApprovalRequest = { operationKey: string; operation: AccountOperation };
export type WorkflowApprovalBinding = Readonly<{
  operationKey: string;
  digest: string;
  expiresAt: string;
  /** Stable across fresh approvals and DBOS attempts. Append a fixed native step
   * name, and keep the native command's complete input digest on every retry. */
  commandKeyPrefix: string;
}>;
const bindings = new WeakMap<LifecycleRequest, WorkflowApprovalBinding>();
/** Return only durable binding metadata; never serialize the resolved context. */
export function workflowApprovalBinding(request: LifecycleRequest): WorkflowApprovalBinding | undefined {
  return bindings.get(request);
}
export class WorkflowApprovalUnavailableError extends Error {
  readonly status = 503;

  constructor() {
    super('Durable workflow approvals are unavailable');
    this.name = 'WorkflowApprovalUnavailableError';
  }
}
export class WorkflowApprovalDeniedError extends Error {
  readonly status = 403;

  constructor() {
    super('Durable workflow approval denied');
    this.name = 'WorkflowApprovalDeniedError';
  }
}
const denied = () => new WorkflowApprovalDeniedError();
function requireAllowed(value: unknown): asserts value {
  if (!value) throw denied();
}
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const handle = isClaimHandle;
const id = (value: unknown): value is string => typeof value === 'string' && routeOf(value) !== null;
const text = (value: unknown, max = 255): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

type NativeKind =
  | 'fence-operator'
  | 'revoke'
  | 'rename'
  | 'delete'
  | 'membership'
  | 'automated'
  | 'opening'
  | 'organization'
  | 'client-reduction'
  | 'transfer'
  | 'transfer-acceptance';
type Descriptor = { action: string; target: string; targetKind: 'actor' | 'organization' | 'either' | 'global' };
/** Server-owned closed descriptors. Missing adapters deny explicitly; a catalogue
 * entry alone can never manufacture native authority for one of these kinds. */
const unavailableAdapters = {
  consent: 'Auth consent reduction',
} as const satisfies Record<Exclude<AccountOperation['kind'], NativeKind>, string>;

function operationSnapshot(value: NativeOperation): { operation: NativeOperation; descriptor: Descriptor } {
  requireAllowed(value && typeof value === 'object' && !Array.isArray(value));
  const encoded = canonicalize(value);
  const encodedLimit =
    value.kind === 'client-reduction' ? MAX_CONSENTED_SCOPE_OCTETS + 2 * MAX_CONSENTED_SCOPES + 2048 : 12000;
  requireAllowed(typeof encoded === 'string' && Buffer.byteLength(encoded) <= encodedLimit);
  const operation = JSON.parse(encoded) as NativeOperation;
  // The requested workflow key is resolution metadata. Automated creation also
  // binds it in its business input, so retain it for that operation's digest.
  if (operation.kind !== 'automated' && operation.kind !== 'credential') delete operation.operationKey;
  if (Object.hasOwn(unavailableAdapters, operation.kind)) throw new WorkflowApprovalUnavailableError();
  let descriptor: Descriptor;
  let fields: string[];
  switch (operation.kind) {
    case 'fence-operator':
      requireAllowed(id(operation.accountId));
      fields = ['kind', 'accountId', 'authorization'];
      descriptor = { action: 'account:suspend', target: PLATFORM_RESOURCE.id, targetKind: 'global' };
      break;
    case 'revoke':
      requireAllowed(id(operation.accountId));
      fields = ['kind', 'accountId', 'authorization'];
      // Platform governance; the subject itself is chosen by operationDescriptor.
      descriptor = { action: 'account:suspend', target: PLATFORM_RESOURCE.id, targetKind: 'global' };
      break;
    case 'client-reduction':
      requireAllowed(
        text(operation.clientId, 1024) &&
          typeof operation.firstParty === 'boolean' &&
          Array.isArray(operation.scopes) &&
          operation.scopes.length <= MAX_CONSENTED_SCOPES &&
          operation.scopes.every((scope) => text(scope, 128) && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)),
      );
      fields = ['kind', 'clientId', 'firstParty', 'scopes', 'authorization'];
      descriptor = { action: 'client:manage', target: PLATFORM_RESOURCE.id, targetKind: 'global' };
      break;
    case 'credential':
      requireAllowed(
        id(operation.subjectAccountId) &&
          text(operation.operationKey) &&
          text(operation.effectReference, 4096) &&
          /^[a-f0-9]{64}$/.test(operation.effectDigest) &&
          ['set-password', 'remove-password', 'add-key', 'remove-key', 'add-passkey', 'remove-passkey'].includes(
            operation.purpose,
          ) &&
          Number.isSafeInteger(operation.subjectEpoch) &&
          operation.subjectEpoch > 0,
      );
      fields = [
        'kind',
        'subjectAccountId',
        'purpose',
        'operationKey',
        'effectReference',
        'effectDigest',
        'subjectEpoch',
        'authorization',
      ];
      descriptor = { action: 'account:manage', target: operation.subjectAccountId, targetKind: 'actor' };
      break;
    case 'automated':
      requireAllowed(
        id(operation.operatorAccountId) &&
          typeof operation.registrationId === 'string' &&
          operation.registrationId.length <= 128 &&
          handle(operation.handle) &&
          text(operation.operationKey, 128),
      );
      fields = ['kind', 'registrationId', 'operatorAccountId', 'handle', 'operationKey', 'authorization'];
      descriptor = { action: 'account:manage', target: operation.operatorAccountId, targetKind: 'either' };
      break;
    case 'opening':
      requireAllowed(
        id(operation.operatorAccountId) &&
          id(operation.subjectAccountId) &&
          operation.operatorAccountId !== operation.subjectAccountId,
      );
      fields = ['kind', 'operatorAccountId', 'subjectAccountId', 'authorization'];
      descriptor = { action: 'account:manage', target: operation.operatorAccountId, targetKind: 'either' };
      break;
    case 'organization':
      requireAllowed(handle(operation.handle));
      fields = ['kind', 'handle', 'authorization'];
      descriptor = { action: 'organization:create', target: PLATFORM_RESOURCE.id, targetKind: 'global' };
      break;
    case 'rename':
      requireAllowed(
        id(operation.accountId) &&
          handle(operation.handle) &&
          (operation.expectedHandle === null ||
            (typeof operation.expectedHandle === 'string' && HANDLE_LOOKUP_PATTERN.test(operation.expectedHandle))),
      );
      fields = ['kind', 'accountId', 'handle', 'expectedHandle', 'authorization'];
      descriptor = { action: 'account:update', target: operation.accountId, targetKind: 'either' };
      break;
    case 'delete':
      requireAllowed(id(operation.accountId));
      if (operation.responsibility !== undefined) {
        const r = operation.responsibility;
        requireAllowed(
          r &&
            id(r.operatorAccountId) &&
            id(r.subjectAccountId) &&
            r.subjectAccountId === operation.accountId &&
            text(r.reservationId),
        );
        requireAllowed(Object.keys(r).sort().join(',') === 'operatorAccountId,reservationId,subjectAccountId');
      }
      fields = ['kind', 'accountId', 'responsibility', 'authorization'];
      descriptor = { action: 'account:delete', target: operation.accountId, targetKind: 'either' };
      break;
    case 'transfer':
      requireAllowed(
        id(operation.previous?.operatorAccountId) &&
          id(operation.previous?.subjectAccountId) &&
          text(operation.previous?.reservationId) &&
          Object.keys(operation.previous).sort().join(',') === 'operatorAccountId,reservationId,subjectAccountId' &&
          id(operation.operatorAccountId) &&
          operation.operatorAccountId !== operation.previous.operatorAccountId &&
          operation.operatorAccountId !== operation.previous.subjectAccountId &&
          typeof operation.expectedVersion === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(operation.expectedVersion) &&
          (operation.acceptance === undefined || text(operation.acceptance, 4096)),
      );
      fields = ['kind', 'previous', 'expectedVersion', 'operatorAccountId', 'acceptance', 'authorization'];
      descriptor = {
        action: 'account:manage',
        target: operation.previous.operatorAccountId,
        targetKind: 'either',
      };
      break;
    case 'transfer-acceptance':
      requireAllowed(
        id(operation.previous?.operatorAccountId) &&
          id(operation.previous?.subjectAccountId) &&
          text(operation.previous?.reservationId) &&
          Object.keys(operation.previous).sort().join(',') === 'operatorAccountId,reservationId,subjectAccountId' &&
          id(operation.operatorAccountId) &&
          operation.operatorAccountId !== operation.previous.operatorAccountId &&
          operation.operatorAccountId !== operation.previous.subjectAccountId &&
          typeof operation.expectedVersion === 'string' &&
          /^(0|[1-9][0-9]*)$/.test(operation.expectedVersion) &&
          text(operation.sourceOperationKey, 128),
      );
      fields = ['kind', 'previous', 'expectedVersion', 'operatorAccountId', 'sourceOperationKey', 'authorization'];
      descriptor = { action: 'account:manage', target: operation.operatorAccountId, targetKind: 'either' };
      break;
    case 'membership':
      requireAllowed(
        id(operation.organizationId) &&
          id(operation.memberAccountId) &&
          [null, 'owner', 'member'].includes(operation.role),
      );
      requireAllowed(operation.reservationId === undefined || text(operation.reservationId));
      fields = ['kind', 'organizationId', 'memberAccountId', 'role', 'reservationId', 'authorization'];
      descriptor = { action: 'organization:membership', target: operation.organizationId, targetKind: 'organization' };
      break;
    default:
      throw denied();
  }
  requireAllowed(text(operation.authorization, 4096) && Object.keys(operation).every((key) => fields.includes(key)));
  return { operation, descriptor };
}
// The reference is transport metadata, not part of the business operation.
// Never persist it: a hostile authorization field may itself contain a bearer.
function businessOperation(operation: NativeOperation): unknown {
  const { authorization: _reference, ...complete } = operation as AccountOperation & { authorization?: string };
  return complete;
}
const resourceOf = (descriptor: Descriptor) => ({ route: routeOf(descriptor.target)!, id: descriptor.target });
function anchor(descriptor: Descriptor) {
  const resource = resourceOf(descriptor);
  return {
    resource,
    async validate(client: Parameters<Access['authorize']>[0]) {
      if (descriptor.targetKind === 'global') return !!(await clientManagementAnchor.run(client, {}));
      const account = await readAccount(client, resource.route, resource.id);
      return (
        !!account &&
        account.state === 'active' &&
        !account.fenced &&
        (descriptor.targetKind === 'either' || account.kind === descriptor.targetKind) &&
        (descriptor.action !== 'account:manage' ||
          descriptor.targetKind !== 'actor' ||
          account.operatorAccountId === null)
      );
    },
  };
}

type CredentialWorkflowPorts = {
  approveCredentialForActor(
    actor: AccountActor,
    binding: CredentialEffectBinding,
    context: AccessContext,
  ): Promise<WorkflowApproval>;
  readConsumedCredential(reference: string, context: AccessContext): ReturnType<typeof credentialRead.run>;
  approveCredential(token: string, binding: CredentialEffectBinding, context: AccessContext): Promise<WorkflowApproval>;
  consumeCredential(
    reference: string,
    binding: CredentialEffectBinding,
    caller: AccountActor,
    context: AccessContext,
  ): Promise<{ receiptId: string; expiresAt: string; subjectEpoch: number }>;
};
const credentialApprovals = new WeakMap<object, CredentialWorkflowPorts>();
/** Trusted credential capability only. Generic workflow/session APIs stay closed. */
export function credentialWorkflowApprovals(api: ReturnType<typeof createWorkflowApprovals>): CredentialWorkflowPorts {
  const native = credentialApprovals.get(api);
  requireAllowed(native);
  return native;
}

/** Native durable approval storage only. Resolve once in each step that takes a
 * new effect for the person, before that effect: every resolution prepares its
 * own evidence at its own T and nothing is written before it passes. A step that
 * only completes an effect already committed runs under that effect's record and
 * is not resolved again; the actor is never re-authorized against state the
 * operation itself changed. The actual command still authorizes at its own T.
 * Auth consent reductions invalidate these original scopes through the shared
 * Access epoch floor. No Auth database, introspection or runtime is consulted.
 */
export function createWorkflowApprovals<Config extends WorkflowApprovalConfig>(config: Config) {
  // The optional Auth-owned exact stage reader is a transport capability. It can
  // prove allocation of a server registration, never approve a business operation.
  const creationBinding = (
    config as WorkflowApprovalConfig & { creationBinding?: NativeWorkflowProofPorts['creationBinding'] }
  ).creationBinding;
  function boundary(context: AccessContext): AccessContext {
    requireAccessDeadline(context.deadline);
    requireAllowed(context.pool === config.pool && Number.isFinite(context.deadline));
    return { pool: config.pool, deadline: context.deadline };
  }
  function authorization(
    actor: AccountActor,
    descriptor: Descriptor,
    context: AccessContext,
    observeDeadline?: (deadline: number) => void,
  ): CommandAuthorization {
    requireAccessDeadline(context.deadline);
    requireAllowed(config.actions.has(descriptor.action));
    const authority = resourceAuthorization({
      access: observeDeadline
        ? {
            ...config.access,
            async prepare(...args) {
              requireAllowed(config.access.prepare);
              const evidence = await config.access.prepare(...args);
              const deadline = permissionEvidenceDeadline(evidence);
              requireAllowed(deadline !== undefined);
              observeDeadline(deadline);
              return evidence;
            },
          }
        : config.access,
      actor,
      action: descriptor.action,
      anchor: anchor(descriptor),
      context: { ...context, partition: partitionOf(routeOf(actor.accountId)!) },
    });
    if (descriptor.action !== 'organization:create') return authority;
    return {
      ...authority,
      async prepare(attempt) {
        await requireHuman(actor);
        return authority.prepare?.(attempt);
      },
    };
  }
  /** An automated account is deleted by the managers of its current operator; only the
   * account itself holds its own delete action. The active relation is one anchored point
   * read; a post-commit resolution matches the tombstone receipt to this operation's effect.
   * A person's sessions are revoked by the person under its own account management or by
   * platform governance, and by nobody else: no read decides it. */
  async function operationDescriptor(
    actor: AccountActor,
    operation: NativeOperation,
    descriptor: Descriptor,
    deadline: number,
    approval?: ApprovalRow,
  ): Promise<Descriptor> {
    if (operation.kind === 'revoke')
      return actor.accountId === operation.accountId
        ? { action: 'account:manage', target: operation.accountId, targetKind: 'actor' }
        : descriptor;
    if (operation.kind !== 'delete' || actor.accountId === operation.accountId) return descriptor;
    const subject = await within(deadline, () =>
      withConnection(config.pool, (client) =>
        readAccount(deadlineClient(client, deadline), routeOf(operation.accountId)!, operation.accountId),
      ),
    );
    if (subject?.kind === 'organization' && subject.state === 'active') {
      const owners = await within(deadline, () =>
        withConnection(config.pool, (client) =>
          ownersRead.run(deadlineClient(client, deadline), {
            route: routeOf(operation.accountId)!,
            organization_id: operation.accountId,
            member_id: actor.accountId,
            at: accessClock(config.access)().toISOString(),
          }),
        ),
      );
      if (owners && owners.owners > 0)
        return { action: 'account:manage', target: operation.accountId, targetKind: 'organization' };
    }
    if (subject?.kind === 'actor' && subject.state === 'active' && subject.operatorAccountId !== null)
      return { action: 'account:manage', target: subject.operatorAccountId, targetKind: 'either' };
    if (subject?.kind !== 'actor' || subject.state !== 'deleted' || !approval) return descriptor;
    const subjectRoute = routeOf(operation.accountId)!;
    const priorOperator = await within(deadline, () =>
      withConnection(config.pool, (client) =>
        tombstoneOperator.run(deadlineClient(client, deadline), {
          route: subjectRoute,
          account_id: operation.accountId,
          approval_route: approval.route,
          approval_id: approval.approvalId,
          partition_no: partitionOf(subjectRoute),
          actor_id: actor.accountId,
          idempotency_key: `${subjectRoute}:wf:${hash([actor.accountId, approval.operationKey])}:tombstone`,
        }),
      ),
    );
    return priorOperator?.priorOperatorAccountId
      ? { action: 'account:manage', target: priorOperator.priorOperatorAccountId, targetKind: 'either' }
      : descriptor;
  }
  /** A person is an actor without an operator. It may act for a principal through a
   * principal assignment: the approval stores that reference (`requestedBy`), and
   * every step's formula rechecks the assignment and the principal's grant at its T. */
  async function requireHuman(actor: AccountActor) {
    const account = await readAccount(config.pool, routeOf(actor.accountId)!, actor.accountId);
    requireAllowed(account?.kind === 'actor' && account.operatorAccountId === null);
  }

  async function authorizeActor(
    actor: AccountActor,
    descriptor: Descriptor,
    context: AccessContext,
    deadline: number,
  ): Promise<void> {
    requireAccessDeadline(deadline);
    requireAllowed(config.actions.has(descriptor.action) && config.access.prepare);
    const evidence = await config.access.prepare(actor, descriptor.action, resourceOf(descriptor), {
      pool: config.pool,
      deadline,
    });
    // The final native formula obtains authoritative SQL T. Identity/principal
    // preparation has released its connections before this resource checkout.
    // The actor observation made when the approval was restored is older than
    // this T: a consent reduction, raised floor or fence in between must deny, so
    // the actor row is read again after the formula has fixed its T.
    const allowed = await within(deadline, () =>
      withConnection(config.pool, async (client) => {
        const boundedClient = deadlineClient(client, deadline);
        if (
          !(await accessEvidence(() => anchor(descriptor).validate(boundedClient), denied, deadline)) ||
          !(await config.access.authorize(boundedClient, actor, descriptor.action, resourceOf(descriptor), evidence))
        )
          return false;
        const current = await readAccount(boundedClient, routeOf(actor.accountId)!, actor.accountId);
        return (
          !!current &&
          current.kind === 'actor' &&
          current.state === 'active' &&
          !current.fenced &&
          BigInt(actor.authnEpoch) >= current.minimumAuthnEpoch
        );
      }),
    );
    requireAccessDeadline(deadline);
    requireAllowed(allowed);
  }
  async function validateTransferRecord(
    operation: Extract<AccountOperation, { kind: 'transfer' }>,
    deadline: number,
  ): Promise<void> {
    const subjectRoute = routeOf(operation.previous.subjectAccountId)!;
    const destinationRoute = routeOf(operation.operatorAccountId)!;
    const subject = await within(deadline, () =>
      withConnection(config.pool, (client) =>
        operatorAccount.run(deadlineClient(client, deadline), {
          route: subjectRoute,
          account_id: operation.previous.subjectAccountId,
        }),
      ),
    );
    const destination = await within(deadline, () =>
      withConnection(config.pool, (client) =>
        operatorAccount.run(deadlineClient(client, deadline), {
          route: destinationRoute,
          account_id: operation.operatorAccountId,
        }),
      ),
    );
    requireAllowed(
      subject &&
        subject.kind === 'actor' &&
        subject.state === 'active' &&
        !subject.fenced &&
        destination &&
        destination.state === 'active' &&
        !destination.fenced &&
        destination.operatorAccountId === null,
    );
    const expectedVersion = BigInt(operation.expectedVersion);
    if (
      subject.operatorAccountId === operation.previous.operatorAccountId &&
      subject.reservationId === operation.previous.reservationId &&
      BigInt(subject.version) === expectedVersion
    )
      return;
    requireAllowed(
      subject.operatorAccountId === operation.operatorAccountId && BigInt(subject.version) === expectedVersion + 1n,
    );
    const oldSlot = await within(deadline, () =>
      withConnection(config.pool, (client) =>
        operatorSlot.run(deadlineClient(client, deadline), {
          route: subjectRoute,
          subject_id: operation.previous.subjectAccountId,
          reservation_id: operation.previous.reservationId,
        }),
      ),
    );
    // The relation command terminalizes the old slot atomically with publication.
    requireAllowed(oldSlot?.terminal === true && oldSlot.operatorAccountId === operation.previous.operatorAccountId);
    requireAccessDeadline(deadline);
  }
  async function resolveSingle(
    reference: string,
    input: AccountOperation,
    context: AccessContext,
    caller?: AccountActor,
  ) {
    const bounded = boundary(context);
    const { operation, descriptor: native } = operationSnapshot(input);
    const { row, actor } = await within(bounded.deadline, () =>
      readApprovedIdentity(config.access, config.referenceKeys, reference, bounded),
    );
    // The reference binds the stored key; caller-supplied resolution metadata must match it.
    requireAllowed(input.operationKey === undefined || input.operationKey === row.operationKey);
    const descriptor = await operationDescriptor(actor, operation, native, bounded.deadline, row);
    requireAllowed(
      !caller ||
        (caller.accountId === actor.accountId &&
          caller.clientId === actor.clientId &&
          caller.requestedBy === actor.requestedBy &&
          canonicalize([...caller.scopes].sort()) === canonicalize([...actor.scopes].sort())),
    );
    if (operation.kind === 'organization') await requireHuman(actor);
    requireAllowed(
      operation.kind !== 'revoke' || actor.accountId !== operation.accountId || actor.requestedBy === null,
    );
    let approvedOperation = operation;
    if (operation.kind === 'automated' && operation.registrationId !== '') {
      if (!creationBinding) throw new WorkflowApprovalUnavailableError();
      requireAllowed(operation.operationKey === row.operationKey);
      const initial = await creationBinding({
        registrationId: operation.registrationId,
        operationKey: row.operationKey,
      });
      requireAllowed(initial && initial.registrationId === '' && canonicalize(initial) === canonicalize(row.operation));
      approvedOperation = { ...operation, registrationId: '' };
    }
    requireAllowed(
      hash([row.operationKey, businessOperation(approvedOperation)]) === row.digest &&
        canonicalize(row.operation) === canonicalize(businessOperation(approvedOperation)),
    );
    const deadline = bounded.deadline;
    await authorizeActor(actor, descriptor, bounded, deadline);
    // A resolved approval is a live, server-owned context. Expose the native
    // barrier only for this closed operation, bound to its target and stable
    // command key. Auth never supplies an arbitrary suspension command or actor.
    const request: LifecycleRequest = Object.freeze({
      actor,
      deadline,
      ...(operation.kind === 'fence-operator'
        ? {
            suspendOperator: async () =>
              (
                await createSuspensionCommands({
                  pool: config.pool,
                  access: config.access,
                  clock: accessClock(config.access),
                }).suspend(
                  { actor, pool: config.pool, deadline },
                  {
                    accountId: operation.accountId,
                    key: `wf:${hash([actor.accountId, row.operationKey])}:fence`,
                    continuation: {
                      operationKey: row.operationKey,
                      operationDigest: row.digest,
                      commandKeyPrefix: `wf:${hash([actor.accountId, row.operationKey])}`,
                      approvalExpiresAt: row.expiresAt,
                    },
                  },
                )
              ).value,
          }
        : {}),
      ...(operation.kind === 'revoke'
        ? {
            revokeSessions: async () =>
              (
                await createSessionRevocationCommands({
                  pool: config.pool,
                  access: config.access,
                  clock: accessClock(config.access),
                }).revoke(
                  { actor, pool: config.pool, deadline },
                  {
                    accountId: operation.accountId,
                    key: `wf:${hash([actor.accountId, row.operationKey])}:revoke`,
                    continuation: {
                      operationKey: row.operationKey,
                      operationDigest: row.digest,
                      commandKeyPrefix: `wf:${hash([actor.accountId, row.operationKey])}`,
                      approvalExpiresAt: row.expiresAt,
                    },
                  },
                )
              ).value,
          }
        : {}),
    });
    bindings.set(
      request,
      Object.freeze({
        operationKey: row.operationKey,
        digest: row.digest,
        expiresAt: row.expiresAt,
        commandKeyPrefix: `wf:${hash([actor.accountId, row.operationKey])}`,
      }),
    );
    return { request, row, actor, operation, descriptor };
  }
  async function resolve(
    reference: string,
    input: AccountOperation,
    context: AccessContext,
    caller?: AccountActor,
  ): Promise<LifecycleRequest> {
    const bounded = boundary(context);
    requireAllowed(operationSnapshot(input).operation.kind !== 'transfer-acceptance');
    const source = await resolveSingle(reference, input, bounded, caller);
    if (source.operation.kind === 'transfer') {
      await validateTransferRecord(source.operation, source.request.deadline);
      const destination: Descriptor = {
        action: 'account:manage',
        target: source.operation.operatorAccountId,
        targetKind: 'either',
      };
      if (source.operation.acceptance !== undefined) {
        const acceptance: AccountOperation = {
          kind: 'transfer-acceptance',
          operationKey: source.row.operationKey,
          previous: source.operation.previous,
          expectedVersion: source.operation.expectedVersion,
          operatorAccountId: source.operation.operatorAccountId,
          sourceOperationKey: source.row.operationKey,
          authorization: source.operation.acceptance,
        };
        await resolveSingle(source.operation.acceptance, acceptance, bounded);
      } else {
        await authorizeActor(source.actor, destination, bounded, source.request.deadline);
      }
    }
    return source.request;
  }
  async function approve(
    token: string | AccountActor,
    input: { operationKey: string; operation: NativeOperation },
    context: AccessContext,
  ): Promise<WorkflowApproval> {
    let requestDeadline: number | undefined;
    try {
      const bounded = boundary(context);
      requestDeadline = bounded.deadline;
      requireAllowed(input && text(input.operationKey));
      const operationKey = input.operationKey;
      const { operation, descriptor: native } = operationSnapshot(input.operation);
      requireAllowed(operation.kind !== 'transfer-acceptance' || operation.sourceOperationKey === operationKey);
      requireAllowed(
        operation.kind !== 'automated' || (operation.registrationId === '' && operation.operationKey === operationKey),
      );
      const actor = typeof token === 'string' ? await config.access.authenticate(token, bounded) : token;
      if (operation.kind === 'credential')
        requireAllowed(actor.accountId === operation.subjectAccountId && actor.requestedBy === null);
      if (operation.kind === 'revoke')
        requireAllowed(actor.accountId !== operation.accountId || actor.requestedBy === null);
      const expires = verifiedKernelExpiry(config.access, actor, bounded);
      const deadline = bounded.deadline;
      const descriptor = await operationDescriptor(actor, operation, native, deadline);
      const route = routeOf(actor.accountId)!;
      const digest = hash([operationKey, businessOperation(operation)]);
      // A fresh credential approval observes a new floor without changing Auth's
      // immutable effect. The approval row still binds that exact observed floor.
      const bindingDigest =
        operation.kind === 'credential'
          ? hash([
              operationKey,
              {
                kind: operation.kind,
                subjectAccountId: operation.subjectAccountId,
                purpose: operation.purpose,
                operationKey: operation.operationKey,
                effectReference: operation.effectReference,
                effectDigest: operation.effectDigest,
              },
            ])
          : digest;
      const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
      // A native exact receipt permanently binds this logical key to one complete
      // operation and original actor/client/principal. Fresh approval may resume
      // it, but a different digest cannot produce another business effect.
      await runCommand(
        config.pool,
        {
          partition: partitionOf(route),
          clock: accessClock(config.access),
          deadline,
          basis,
          authorization: authorization(actor, descriptor, { pool: config.pool, deadline }),
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'access.workflow-approval.binding',
            key: `${route}:${hash(operationKey)}`,
            digest: Buffer.from(hash([basis, bindingDigest]), 'hex'),
          },
        },
        async () => ({
          value: { operationKey, digest: bindingDigest },
          events: [{ type: 'com.rezics.access.workflow-bound.v1', data: { digest: bindingDigest } }],
        }),
      );
      const approvalId = newId(route);
      let evidenceDeadline = expires;
      const result = await runCommand(
        config.pool,
        {
          partition: partitionOf(route),
          clock: accessClock(config.access),
          deadline,
          basis,
          authorization: authorization(
            actor,
            descriptor,
            { pool: config.pool, deadline },
            operation.kind === 'credential'
              ? (value) => {
                  evidenceDeadline = value;
                }
              : undefined,
          ),
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'access.workflow-approval.create',
            key: `${route}:${approvalId}`,
            digest: Buffer.from(digest, 'hex'),
          },
        },
        async (tx, command) => {
          const rows = await approvalInsert.run(tx, {
            route,
            approval_id: approvalId,
            actor_id: actor.accountId,
            client_id: actor.clientId,
            scopes: [...actor.scopes],
            requested_by: actor.requestedBy,
            authn_epoch: actor.authnEpoch,
            operation_key: operationKey,
            operation: businessOperation(operation),
            digest,
            at: authoritativeTimeValue(command.time),
            jwt_expires_at: new Date(expires).toISOString(),
            evidence_expires_at: new Date(evidenceDeadline).toISOString(),
            transaction_id: command.transactionId,
          });
          const row = rows[0];
          requireAllowed(row);
          const value = {
            reference: seal(config.referenceKeys, APPROVAL_REFERENCE_PURPOSE, {
              route,
              id: approvalId,
              binding: approvalRowDigest(row),
            }),
            expiresAt: new Date(row.expiresAt).toISOString(),
          };
          return {
            value,
            events: [
              {
                type: 'com.rezics.access.workflow-approved.v1',
                subject: actor.accountId,
                data: { approvalId, digest },
              },
            ],
          };
        },
      );
      return result.value;
    } catch (error) {
      throwAccessUnavailable(error, requestDeadline);
      throwEvidenceFailure(error);
      if (error instanceof WorkflowApprovalUnavailableError || error instanceof ApprovalIdentityUnavailableError)
        throw error;
      throw denied();
    }
  }
  const native: CredentialWorkflowPorts = {
    async readConsumedCredential(reference, context) {
      const bounded = boundary(context);
      const located = unseal(config.referenceKeys, APPROVAL_REFERENCE_PURPOSE, reference) as
        | { route: number; id: string; binding: string }
        | undefined;
      requireAllowed(located && routeOf(located.id) === located.route);
      const row = await credentialRead.run(bounded.pool, {
        route: located.route,
        receipt_id: located.id,
        at: accessClock(config.access)().toISOString(),
      });
      requireAllowed(row);
      const { data: _native, ...immutable } = row;
      requireAllowed(approvalRowDigest(immutable) === located.binding);
      return row;
    },
    async approveCredential(token, binding, context) {
      const bounded = boundary(context);
      return native.approveCredentialForActor(await config.access.authenticate(token, bounded), binding, bounded);
    },
    async approveCredentialForActor(actor, binding, context) {
      const bounded = boundary(context);
      requireAllowed(
        actor.accountId === binding.actingHumanId &&
          actor.accountId === binding.subjectAccountId &&
          actor.clientId === binding.clientId &&
          canonicalize(actor.scopes) === canonicalize(binding.scopes) &&
          actor.requestedBy === null,
      );
      const subject = await readAccount(config.pool, routeOf(binding.subjectAccountId)!, binding.subjectAccountId);
      requireAllowed(
        subject &&
          subject.kind === 'actor' &&
          subject.operatorAccountId === null &&
          subject.state === 'active' &&
          !subject.fenced,
      );
      return approve(
        actor,
        {
          operationKey: binding.operationKey,
          operation: {
            kind: 'credential',
            subjectAccountId: binding.subjectAccountId,
            purpose: binding.purpose,
            operationKey: binding.operationKey,
            effectReference: binding.effectReference,
            effectDigest: binding.effectDigest,
            subjectEpoch: Number(subject.minimumAuthnEpoch),
            authorization: 'credential',
          },
        },
        bounded,
      );
    },
    async consumeCredential(
      reference: string,
      binding: CredentialEffectBinding,
      caller: AccountActor,
      context: AccessContext,
    ) {
      const bounded = boundary(context);
      const { row, actor } = await readApprovedIdentity(config.access, config.referenceKeys, reference, bounded);
      const { operation, descriptor } = operationSnapshot({
        ...(row.operation as CredentialOperation),
        authorization: 'credential',
      });
      requireAllowed(
        operation.kind === 'credential' &&
          actor.accountId === operation.subjectAccountId &&
          actor.accountId === caller.accountId &&
          actor.clientId === caller.clientId &&
          actor.authnEpoch === caller.authnEpoch &&
          actor.requestedBy === null &&
          caller.requestedBy === null &&
          canonicalize(actor.scopes) === canonicalize(caller.scopes),
      );
      requireAllowed(
        operation.operationKey === binding.operationKey &&
          operation.subjectAccountId === binding.subjectAccountId &&
          operation.purpose === binding.purpose &&
          operation.effectReference === binding.effectReference &&
          operation.effectDigest === binding.effectDigest,
      );
      const result = await runCommand(
        config.pool,
        {
          partition: partitionOf(row.route),
          clock: accessClock(config.access),
          deadline: bounded.deadline,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          authorization: authorization(actor, descriptor, bounded),
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'access.workflow-approval.credential-consume',
            key: `${row.route}:${row.approvalId}`,
            digest: Buffer.from(row.digest, 'hex'),
          },
        },
        async (tx, command) => {
          const subject = await readAccount(tx, row.route, operation.subjectAccountId);
          requireAllowed(
            subject &&
              subject.minimumAuthnEpoch === BigInt(operation.subjectEpoch) &&
              subject.operatorAccountId === null &&
              subject.state === 'active' &&
              !subject.fenced,
          );
          const consumed = await credentialConsume.run(tx, {
            route: row.route,
            approval_id: row.approvalId,
            digest: row.digest,
            at: authoritativeTimeValue(command.time),
            transaction_id: command.transactionId,
          });
          requireAllowed(consumed[0]);
          return {
            value: { receiptId: row.approvalId, expiresAt: row.expiresAt, subjectEpoch: operation.subjectEpoch },
            events: [
              { type: 'com.rezics.access.credential-approved-consumed.v1', data: { approvalId: row.approvalId } },
            ],
          };
        },
      ).catch((error: unknown) => {
        // The shared native formula reports a grant refusal. At this Auth
        // boundary it is an approval denial, never binding unavailability.
        if (error instanceof GrantDeniedError) throw denied();
        throw error;
      });
      requireAllowed(!result.replayed);
      return result.value;
    },
  };
  const api = {
    approve: (token: string, input: WorkflowApprovalRequest, context: AccessContext) => approve(token, input, context),
    /** Trusted server workflow port, never an unauthenticated HTTP endpoint. */
    async resolve(reference: string, operation: AccountOperation, context: AccessContext): Promise<LifecycleRequest> {
      let requestDeadline: number | undefined;
      try {
        const bounded = boundary(context);
        requestDeadline = bounded.deadline;
        return await resolve(reference, operation, bounded);
      } catch (error) {
        throwAccessUnavailable(error, requestDeadline);
        throwEvidenceFailure(error);
        if (error instanceof WorkflowApprovalUnavailableError || error instanceof ApprovalIdentityUnavailableError)
          throw error;
        throw denied();
      }
    },
    async resolveForCaller(
      token: string,
      reference: string,
      operation: AccountOperation,
      context: AccessContext,
    ): Promise<LifecycleRequest> {
      let requestDeadline: number | undefined;
      try {
        const bounded = boundary(context);
        requestDeadline = bounded.deadline;
        const caller = await config.access.authenticate(token, bounded);
        return await resolve(reference, operation, bounded, caller);
      } catch (error) {
        throwAccessUnavailable(error, requestDeadline);
        throwEvidenceFailure(error);
        if (error instanceof WorkflowApprovalUnavailableError || error instanceof ApprovalIdentityUnavailableError)
          throw error;
        throw denied();
      }
    },
  };
  credentialApprovals.set(api, native);
  return api;
}

/** Internal scheduling port; one route/partition and at most 1000 exact expiry
 * keys per command. Expiry correctness never depends on this cleanup running. */
export async function sweepWorkflowApprovals(pool: Pool, route: number, limit: number): Promise<number> {
  requireAllowed(
    Number.isInteger(route) && route >= 0 && route <= 65535 && Number.isInteger(limit) && limit >= 1 && limit <= 1000,
  );
  const result = await runCommand(pool, { partition: partitionOf(route) }, async (tx, command) => {
    const rows = await approvalSweep.run(tx, { route, limit, at: authoritativeTimeValue(command.time) });
    return {
      value: rows.length,
      events: [{ type: 'com.rezics.access.workflow-approvals-swept.v1', data: { route, count: rows.length } }],
    };
  });
  return result.value;
}
