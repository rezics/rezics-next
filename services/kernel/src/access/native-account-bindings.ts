import { accessClock, installAccessClock } from './access-clock.ts';
import { deadlineFor } from '../request/deadline.ts';
import type {
  AccountWorkflowPorts,
  AccountOperation,
  AuthSessionPort,
  AuthCredentialPort,
  AuthRecoveryPort,
  NativeWorkflowProofPorts as AuthWorkflowProofPorts,
  TrustedAccessPorts,
  BarrierProofPort,
  ProvisioningEvidencePort,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access, ActionCatalogue } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createDelegationCommands, DelegationDeniedError, readAssignment } from './delegation-commands.ts';
import { createGrantCommands, GrantDeniedError } from './grant-commands.ts';
import {
  type LifecycleRequest,
  type RecoveryEvidence,
  createLifecycleCommands,
  createLifecycleInternals,
  LifecycleDeniedError,
} from './lifecycle.ts';
import { createOperatorCommands, OperatorDeniedError } from './operator.ts';
import { createRecoveryCompletion } from './recovery-completion.ts';

import { createAuthBindings, AuthBindingDeniedError } from './auth-bindings.ts';
import { createRegistrationProofBindings } from './registration-proof.ts';
import { createAuthBarrierCapabilities } from './auth-barriers.ts';
import { createCredentialCapability } from './auth-credential-capability.ts';
import { createOperatorSessionCapability } from './auth-session-capability.ts';
import {
  createCommittedContinuations,
  ContinuationDeniedError,
  COMMITTED_CONTINUATION_RESUME_BUDGET_MS,
} from './committed-continuations.ts';
import {
  createWorkflowApprovals,
  workflowApprovalBinding,
  WorkflowApprovalUnavailableError,
} from './workflow-approvals.ts';
import { readAccount } from './account-data.ts';
import { routeOf } from '../route/route.ts';
import { seal, unseal } from '../tokens/seal.ts';
import { ResourceAccessWriteDeniedError } from './resource-denials.ts';
import { IdempotencyConflictError } from '../command/command.ts';

/** Auth-host-owned receipt/staging point-read closures, never request fields or
 * fixture maps. Persist the real createPending command reference under the exact
 * account/reservation pair. A missing pending reference denies provisioning;
 * provisioningEvidence resolves actual committed Auth evidence for that pair.
 * Each callback must have a concrete bounded implementation, without enumerating
 * staging records, command receipts, or lifecycle history to locate a match.
 */
export type NativeWorkflowProofPorts = {
  recordPending(input: { accountId: string; reservationId: string; reference: string }): Promise<void>;
  pendingReference(input: { accountId: string; reservationId: string }): Promise<string | null>;
  provisioningEvidence(input: { accountId: string; reservationId: string }): Promise<unknown>;
};
/** The Auth host composes the actual verifier factories with its private storage
 * and keys. Kernel receives verification capabilities only. Missing recovery
 * evidence must fail closed; it cannot be replaced by a synthetic receipt.
 */
export type NativeAccountBindingProofs = {
  provisioning: ProvisioningEvidencePort;
  barriers: BarrierProofPort;
  workflow: NativeWorkflowProofPorts;
  recoveryEvidence?: (reference: unknown) => Promise<RecoveryEvidence | null>;
};

export type NativeAccountBindingsConfig = {
  /** Borrowed kernel pool; its lifetime belongs to the caller. */
  pool: Pool;
  access: Access;
  actions: ActionCatalogue;
  routeKey: Uint8Array;
  /** Kernel command clock; production uses the authoritative system clock. */
  clock?: () => Date;
  referenceKeys: KeyRing;
  /** Deferred access permits Auth to consume trustedAccess during construction. */
  auth: () => AuthSessionPort & AuthCredentialPort & AuthRecoveryPort;
  proofs: NativeAccountBindingProofs;
};

export type NativeAccountBindings = {
  trustedAccess: TrustedAccessPorts;
  workflowPorts: AccountWorkflowPorts<LifecycleRequest>;
  lifecycle: ReturnType<typeof createLifecycleCommands>;
  internalLifecycle: ReturnType<typeof createLifecycleInternals>;
  operators: ReturnType<typeof createOperatorCommands>;
  grants: ReturnType<typeof createGrantCommands>;
  delegations: ReturnType<typeof createDelegationCommands>;
  continuations: ReturnType<typeof createCommittedContinuations>;
};

export class NativeAccountBindingsUnavailableError extends Error {
  constructor() {
    super('Native account binding capability is unavailable');
    this.name = 'NativeAccountBindingsUnavailableError';
  }
}

/** Ordinary production composition with independently anchored native commands.
 *
 * The Auth host consumes trustedAccess and supplies workflowPorts to durable
 * createAccountWorkflows registration. Registration records the real pending
 * command reference, uses actual Auth committed provisioning evidence, then
 * executes native claimHandle and activate commands. Protected workflow steps
 * resolve native persisted approvals to LifecycleRequest inside each step that
 * takes a new effect, and never again to complete an effect already committed;
 * neither bearer tokens nor request contexts enter DBOS or approval Maps.
 *
 * Automated creation proves its operator relation and pending receipt before
 * real Auth credentialless/own-credential ownership. A real operator session
 * capability then uses normal /token issuance and native JWKS-backed Access.
 * Test clients register normally through Auth.internal.registerClient with
 * explicit action scopes, independently of website-client/provider identities
 * and media:complete. No fixture outcome SQL or JWT resigning supplies authority.
 * Human recovery clears only through Auth's actual committed establishment
 * witness, revalidated against the native current fence receipt on every attempt.
 *
 * Only the approved bootstrap CLI establishes the grantor's initial platform
 * role. Subsequent grant/delegation commands apply the exact Global Context
 * formula through native Access. Missing Auth-owned proof capabilities
 * deny rather than manufacturing receipts. Whole-goal outcomes require their
 * actual implementations; this contract supplies no alternative outcome path.
 *
 * The host owns its Auth database, DBOS system schema, staging/signing keys,
 * workflow registration, launch and shutdown. This factory accepts none of that
 * configuration and owns no pools. It performs no I/O or runtime launch.
 *
 * Implementation budget: R=N+U*t+M (subjects/history, activity, media); fixed
 * native point-command steps and exact Auth staging/receipt reads, plus bounded
 * actor-side formula O((1+K)log G), K<=1000. No hidden enumeration or scan to find
 * a receipt/reference or the whole lifecycle history is permitted.
 */
const AUTOMATED_PROVISIONING = 'access.workflow-automated-provisioning.v1';
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new AuthBindingDeniedError();
  return value;
}

function translateNativeRefusal(error: unknown): never {
  if (
    error instanceof LifecycleDeniedError ||
    error instanceof GrantDeniedError ||
    error instanceof DelegationDeniedError ||
    error instanceof ResourceAccessWriteDeniedError ||
    error instanceof OperatorDeniedError ||
    error instanceof ContinuationDeniedError ||
    error instanceof IdempotencyConflictError
  )
    throw new AuthBindingDeniedError();
  throw error;
}

/** Keep native command details inside the kernel. Auth receives only a fixed
 * refusal status, while infrastructure and programming errors retain identity. */
function authWorkflowBoundary<T extends object>(ports: T): T {
  return new Proxy(ports, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(value, target, args);
          return result &&
            (typeof result === 'object' || typeof result === 'function') &&
            'then' in result &&
            typeof result.then === 'function'
            ? Promise.resolve(result).catch(translateNativeRefusal)
            : result;
        } catch (error) {
          return translateNativeRefusal(error);
        }
      };
    },
  });
}

/** Pure assembly: all I/O occurs in returned capabilities. The Auth getter is
 * retained only by the live session capability and is never called here. */
export function createNativeAccountBindings(config: NativeAccountBindingsConfig): NativeAccountBindings {
  const { pool, access, actions, referenceKeys, proofs } = config;
  if (config.clock) installAccessClock(access, config.clock);
  const workflow = proofs.workflow as AuthWorkflowProofPorts;
  const internalLifecycle = createLifecycleInternals({
    pool,
    routeKey: config.routeKey,
    access,
    clock: accessClock(access),
    provisioningEvidence: (evidence) => proofs.provisioning.resolve(evidence),
    recoveryEvidence: (evidence) => proofs.recoveryEvidence?.(evidence) ?? Promise.resolve(null),
  });
  const lifecycle = createLifecycleCommands({
    pool,
    access,
    clock: accessClock(access),
  });
  const continuations = createCommittedContinuations({
    pool,
    access,
    referenceKeys,
    clock: accessClock(access),
  });
  const operators = createOperatorCommands({
    pool,
    access,
    actions,
    managementAction: 'account:manage',
    cursorKeys: referenceKeys,
  });
  const grants = createGrantCommands({ pool, access, managementAction: 'access:grant' });
  const delegations = createDelegationCommands({ pool, access, action: 'access:delegate' });
  const registration = createRegistrationProofBindings({ pool, access, referenceKeys });
  const barriers = createAuthBarrierCapabilities({ lifecycle: internalLifecycle, access, proofs: proofs.barriers });
  const session = createOperatorSessionCapability({
    pool,
    access,
    operators,
    referenceKeys,
    accessTokenForProof: (proof) => config.auth().internal.accessTokenForProof(proof),
  });
  const approvals = createWorkflowApprovals({
    pool,
    access,
    actions,
    referenceKeys,
    creationBinding: (input: { registrationId: string; operationKey: string }) =>
      workflow.creationBinding?.(input) ?? Promise.resolve(null),
  });
  // Construction remains independent of the Auth host and database handles.
  let credential: ReturnType<typeof createCredentialCapability> | undefined;
  const credentialCapability = () =>
    (credential ??= createCredentialCapability({
      pool,
      access,
      operators,
      workflowApprovals: approvals,
      referenceKeys,
      accessTokenForProof: (proof) => config.auth().internal.accessTokenForProof(proof),
      verifyCredentialEffect: (reference, expected) =>
        config.auth().internal.verifyCredentialEffect(reference, expected),
    }));
  const boundary = () => ({ pool, deadline: deadlineFor(COMMITTED_CONTINUATION_RESUME_BUDGET_MS) });
  const trustedAccess: TrustedAccessPorts = {
    ...createAuthBindings({
      pool,
      access,
      ...createRecoveryCompletion({
        pool,
        routeKey: config.routeKey,
        auth: config.auth,
        clock: accessClock(access),
      }),
      ...registration,
      consumeAuthAuthorization: (input) =>
        input.purpose === 'session'
          ? session.consumeAuthAuthorization(input)
          : credentialCapability().consumeAuthAuthorization(
              input as Parameters<ReturnType<typeof createCredentialCapability>['consumeAuthAuthorization']>[0],
            ),
      async verifyPendingIdentity(reference) {
        const envelope = unseal(referenceKeys, AUTOMATED_PROVISIONING, reference) as
          | { reference?: unknown; operation?: AccountOperation }
          | undefined;
        if (!envelope) {
          const identity = await registration.verifyNativePendingIdentity(reference);
          return identity?.automated ? null : identity;
        }
        if (
          Object.keys(envelope).sort().join(',') !== 'operation,reference' ||
          typeof envelope.reference !== 'string' ||
          envelope.operation?.kind !== 'automated'
        )
          return null;
        const operation = envelope.operation;
        await approvals.resolve(operation.authorization, operation, boundary());
        const identity = await registration.verifyNativePendingIdentity(envelope.reference);
        if (
          !identity?.automated ||
          identity.operatorAccountId !== operation.operatorAccountId ||
          operation.registrationId === '' ||
          !operation.operationKey
        )
          return null;
        const stage = await workflow.creationBinding?.({
          registrationId: operation.registrationId,
          operationKey: operation.operationKey,
          accountId: identity.accountId,
          reservationId: identity.registrationId,
        });
        if (!stage) return null;
        // Auth's immutable stage reader bound this registration to the approved
        // descriptor above; the same stage must own this pending account pair.
        const exact = await workflow.automatedReference?.({
          accountId: identity.accountId,
          reservationId: identity.registrationId,
        });
        return exact === envelope.reference ? identity : null;
      },
    }),
    ...barriers.trustedAccess,
    approveCredentialEffect: (input) => credentialCapability().approveCredentialEffect(input),
    revalidateCredentialEffect: (input) => credentialCapability().revalidateCredentialEffect(input),
    advanceCredentialFloor: (input) => credentialCapability().advanceCredentialFloor(input),
    readAssignment: (requestedBy, assignedActorId) =>
      readAssignment(pool, requestedBy, assignedActorId, accessClock(access)),
  };
  const workflowPorts: AccountWorkflowPorts<LifecycleRequest> = authWorkflowBoundary({
    ...internalLifecycle,
    ...operators,
    ...lifecycle,
    async createPending(input) {
      const outcome = await internalLifecycle.createPending(input);
      // Await the native command's COMMIT first. On interruption replay uses the
      // same native input/key and persists its original reference exactly once.
      const pair = { accountId: input.accountId, reservationId: input.reservationId };
      if (!(await workflow.pendingReference(pair))) {
        const reference = required(await registration.createProvisioningReference({ input, outcome }));
        await workflow.recordPending({ ...pair, reference });
      }
      return outcome;
    },
    async recordOperatorRelation(input, pending) {
      if (
        pending &&
        (pending.operation.kind !== 'automated' || pending.operation.operatorAccountId !== input.operatorAccountId)
      )
        throw new AuthBindingDeniedError();
      const outcome = await operators.recordOperatorRelation(input);
      if (pending) {
        const pair = { accountId: input.subjectAccountId, reservationId: pending.reservationId };
        if (!(await workflow.automatedReference?.(pair))) {
          const reference = required(
            await registration.createAutomatedProvisioningReference({
              input,
              outcome,
              pendingReference: required(await workflow.pendingReference(pair)),
            }),
          );
          await required(workflow.recordAutomatedPending)({ ...pair, reference });
        }
      }
      return outcome;
    },
    async provisioningReference(input) {
      if (input.operation?.kind === 'automated') {
        await approvals.resolve(input.operation.authorization, input.operation, boundary());
        const reference = required(await workflow.automatedReference?.(input));
        return seal(referenceKeys, AUTOMATED_PROVISIONING, { reference, operation: input.operation });
      }
      return required(await workflow.pendingReference(input));
    },
    provisioningEvidence: (input) => workflow.provisioningEvidence(input),
    authorizeOperation: (reference, operation) => approvals.resolve(reference, operation, boundary()),
    authorizeUnprotectedOperation: async () => {
      // Native workflows provide no authority capability for unapproved operations.
      throw new WorkflowApprovalUnavailableError();
    },
    actorAccountId: (context) => context.actor.accountId,
    stableCommandKey: (context, phase) => `${required(workflowApprovalBinding(context)).commandKeyPrefix}:${phase}`,
    approvalBinding: (context) => workflowApprovalBinding(context),
    readContinuation: (operationKey, accountId) => continuations.read(operationKey, accountId),
    authorizeContinuation: (reference, entry) => continuations.authorizeStep(reference, entry),
    readAccount: async (accountId) => {
      const route = routeOf(accountId);
      return route === null ? null : readAccount(pool, route, accountId);
    },
    async authorizeOpening(context, input) {
      const actor = context.actor;
      const account = await readAccount(pool, required(routeOf(actor.accountId)), actor.accountId);
      const outcome = await operators.authorizeOpening({ ...context, account }, input);
      return { ...outcome, value: { receiptId: session.createOpeningReference(outcome.value) } };
    },
  });
  return {
    trustedAccess,
    workflowPorts,
    lifecycle,
    internalLifecycle,
    operators,
    grants,
    delegations,
    continuations,
  };
}
