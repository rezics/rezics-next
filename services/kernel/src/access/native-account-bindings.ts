import type {
  AccountWorkflowPorts,
  AuthService,
  TrustedAccessPorts,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
} from '@rezics/auth';
import type { Pool } from 'pg';
import type { Access, ActionCatalogue } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { createDelegationCommands } from './delegation-commands.ts';
import type { createGrantCommands } from './grant-commands.ts';
import type {
  LifecycleRequest,
  RecoveryEvidence,
  createLifecycleCommands,
  createLifecycleInternals,
} from './lifecycle.ts';
import type { createOperatorCommands } from './operator.ts';

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
  provisioning: ReturnType<typeof createProvisioningEvidenceVerifier>;
  barriers: ReturnType<typeof createBarrierProofVerifier>;
  workflow: NativeWorkflowProofPorts;
  recoveryEvidence?: (reference: unknown) => Promise<RecoveryEvidence | null>;
};

export type NativeAccountBindingsConfig = {
  /** Borrowed kernel pool; its lifetime belongs to the caller. */
  pool: Pool;
  access: Access;
  actions: ActionCatalogue;
  routeKey: Uint8Array;
  referenceKeys: KeyRing;
  /** Deferred access permits Auth to consume trustedAccess during construction. */
  auth: () => AuthService;
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
};

export class NativeAccountBindingsUnavailableError extends Error {
  constructor() {
    super('Native account bindings are unavailable until production composition is implemented');
    this.name = 'NativeAccountBindingsUnavailableError';
  }
}

/** Production composition contract; this stub proves no product behavior.
 *
 * The Auth host consumes trustedAccess and supplies workflowPorts to durable
 * createAccountWorkflows registration. Registration records the real pending
 * command reference, uses actual Auth committed provisioning evidence, then
 * executes native claimHandle and activate commands. Protected workflow steps
 * resolve native persisted approvals to LifecycleRequest inside each step;
 * neither bearer tokens nor request contexts enter DBOS or approval Maps.
 *
 * Automated creation proves its operator relation and pending receipt before
 * real Auth credentialless/own-credential ownership. A real operator session
 * capability then uses normal /token issuance and native JWKS-backed Access.
 * Test clients register normally through Auth.internal.registerClient with
 * explicit action scopes, independently of website-client/provider identities
 * and media:complete. No fixture outcome SQL or JWT resigning supplies authority.
 *
 * Only the approved bootstrap CLI establishes the grantor's initial platform
 * role. Subsequent grant/delegation commands apply the exact Global Context
 * formula through native Access. Unsupported recovery or credential capability
 * denies rather than manufacturing receipts. Whole-goal outcomes require their
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
export function createNativeAccountBindings(_config: NativeAccountBindingsConfig): NativeAccountBindings {
  throw new NativeAccountBindingsUnavailableError();
}
