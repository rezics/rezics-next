/** Maximum consented scopes in a session or durable actor snapshot. */
export const MAX_CONSENTED_SCOPES = 512;
/** Maximum joined ASCII scope bytes, including the single-space separators. */
export const MAX_CONSENTED_SCOPE_OCTETS = 66_047;

export interface AccessAccount {
  accountId: string;
  kind: 'actor' | 'organization';
  state: 'pending' | 'active' | 'suspended' | 'deleted';
  authnEpoch: number;
  automated: boolean;
  fenced?: boolean;
}

export interface InvalidationReceipt {
  receiptId: string;
  accountId: string;
  minimumAuthnEpoch: number;
}

export type EffectPurpose = 'session' | 'set-password' | 'remove-password' | 'add-key' | 'remove-key';
export type CredentialPurpose = Exclude<EffectPurpose, 'session'>;
/** Passkeys are managed only by their human owner, never by an operator. */
export type PasskeyPurpose = 'add-passkey' | 'remove-passkey';
/** Every purpose recorded in the shared credential stage and floor stores. */
export type CredentialFloorPurpose = CredentialPurpose | PasskeyPurpose;

/** Auth-owned nonsecret commitment, never credential material or permission context.
 * The keyed digest binds version, stage locator, immutable (subject, operationKey),
 * exact purpose, normalized payload, selected credential row identity/version,
 * human, client and exact consented scopes. Null row identity/version denotes
 * expected absence, including a first password or new key. Caller hashes are
 * comparisons only; only Auth establishes provenance. Changed input under a used
 * key conflicts even after consumption or restart. Access/DBOS retain only these
 * locators, never passwords, private keys, cookies, JWTs or SessionProof objects.
 */
export interface CredentialEffectBinding<Purpose extends CredentialFloorPurpose = CredentialPurpose> {
  operationKey: string;
  effectReference: string;
  effectDigest: string;
  subjectAccountId: string;
  purpose: Purpose;
  credentialRowId: string | null;
  credentialRowVersion: string | null;
  actingHumanId: string;
  clientId: string;
  scopes: string[];
}

/** Expected current identity and immutable operation; an optional digest only compares. */
export type CredentialEffectExpectation<Purpose extends CredentialFloorPurpose = CredentialPurpose> = Pick<
  CredentialEffectBinding<Purpose>,
  'operationKey' | 'subjectAccountId' | 'purpose' | 'actingHumanId' | 'clientId' | 'scopes'
> & { effectDigest?: string };

/** Auth-owned read closure, supplied only by trusted host composition. Point-read
 * the committed stage and verify its keyed provenance, exact expected binding and
 * selected credential row/version. After commit resolve the exact terminal receipt,
 * never treat the old row version as new mutation authority. No minting path, Auth
 * database/key/runtime exposure to the kernel, or caller digest as provenance.
 */
export interface CredentialEffectVerifier {
  <Purpose extends CredentialFloorPurpose>(
    reference: string,
    expected: CredentialEffectExpectation<Purpose>,
  ): Promise<CredentialEffectBinding<Purpose>>;
  (reference: string, expected: CredentialEffectExpectation): Promise<CredentialEffectBinding>;
}

export type CredentialFloorBinding = CredentialEffectBinding<CredentialFloorPurpose>;

/** Exact credential consume result. Auth compares every field with its own stage
 * before writing; a session/device approval or broad credential opening cannot
 * substitute. A durable reference is a locator, never current authorization.
 */
export interface CredentialEffectAuthorization<
  Purpose extends CredentialFloorPurpose = CredentialPurpose,
> extends EffectAuthorizationBase {
  operationKey: string;
  effectReference: string;
  effectDigest: string;
  purpose: Purpose;
}

/** A committed native floor receipt, bound to the exact stage and consumed opening.
 * minimumAuthnEpoch must equal previousFloor + 1 and the existing fence is preserved.
 * Resolve provenance from native storage; equal caller epochs/foreign receipts deny.
 */
export interface CredentialFloorReceipt extends InvalidationReceipt {
  operationKey: string;
  effectReference: string;
  effectDigest: string;
  purpose: CredentialFloorPurpose;
  openingReceiptId: string;
  previousFloor: number;
  fenced: boolean;
}

/** Credential-only trusted floor hook. Bind Auth's verified stage, already consumed
 * opening, expected previous subject floor, immutable key and purpose. Commit the
 * exact next floor before mutation for password replacement/remove-password/remove-key;
 * add-key and first password installation do not advance it. Recheck current
 * authority, including the operator for automation, and preserve fences. Never widen
 * consent/recovery hooks or relabel this effect as either. The in-flight own-human
 * operation may finish against only its exact committed barrier and unchanged next
 * floor; its invalidated source session grants no consume/replay authority.
 */
export type CredentialFloorPort<Purpose extends CredentialFloorPurpose = CredentialFloorPurpose> = (input: {
  /** Auth's request deadline; kernel request paths always pass it. */
  deadline?: number;
  stage: CredentialEffectBinding<Purpose>;
  consumedOpening: CredentialEffectAuthorization<Purpose>;
  expectedPreviousFloor: number;
  key: string;
  purpose: Purpose;
}) => Promise<CredentialFloorReceipt>;

const credentialRequestDeadlines = new WeakMap<SessionProof, number>();

/** Preserve the active request deadline while Auth invokes a credential port.
 * Normally the port input carries the deadline directly. This context lets
 * trusted adapters that only forward the proof keep the same request boundary.
 */
export async function withCredentialRequestDeadline<T>(
  proof: SessionProof,
  deadline: number,
  work: () => Promise<T>,
): Promise<T> {
  const previous = credentialRequestDeadlines.get(proof);
  credentialRequestDeadlines.set(proof, deadline);
  try {
    return await work();
  } finally {
    if (previous === undefined) credentialRequestDeadlines.delete(proof);
    else credentialRequestDeadlines.set(proof, previous);
  }
}

/** Read only the deadline attached to this live trusted proof callback. */
export function credentialRequestDeadline(proof: SessionProof): number | undefined {
  return credentialRequestDeadlines.get(proof);
}

/** The session input stays byte-for-byte equivalent to the existing contract. */
export type SessionAuthorizationInput = {
  authorization: string;
  subjectAccountId: string;
  purpose: 'session';
  human: SessionProof;
};

/** One exact credential purpose; both immutable stage locators are mandatory. */
export type CredentialAuthorizationInput = {
  [Purpose in CredentialPurpose]: Omit<SessionAuthorizationInput, 'purpose'> & {
    purpose: Purpose;
    operationKey: string;
    effectReference: string;
    /** Auth's request deadline. SessionAuthorizationInput remains unchanged. */
    deadline?: number;
  };
}[CredentialPurpose];

export type PasskeyAuthorizationInput = Omit<CredentialAuthorizationInput, 'purpose'> & { purpose: PasskeyPurpose };
export type CredentialFloorAuthorizationInput = CredentialAuthorizationInput | PasskeyAuthorizationInput;
export type AuthorizationConsumeInput = SessionAuthorizationInput | CredentialAuthorizationInput;

interface EffectAuthorizationBase {
  receiptId: string;
  subjectAccountId: string;
  actingHumanId: string;
  operatorAccountId: string | null;
  clientId: string;
  scopes: string[];
  humanEpoch: number;
  subjectEpoch: number;
  expiresAt: string;
  invalidation?: InvalidationReceipt;
}

/** A consumed durable Access authorization, never a caller-supplied approval.
 * Native credential results carry the complete credential extension. The unbound
 * branch cannot carry a partial credential binding. Auth must compare the native
 * extension to its stage.
 */
export type EffectAuthorization =
  | (EffectAuthorizationBase & {
      purpose: EffectPurpose;
      operationKey?: undefined;
      effectReference?: undefined;
      effectDigest?: undefined;
    })
  | CredentialEffectAuthorization;

/** Current, principal-created assignment evidence from the Access owner. */
export type AssignmentProof =
  | { kind: 'none' | 'unresolved' }
  | { kind: 'resolved'; principalId: string; assignedActorId: string; requestId: string; valid: string };

/** A committed Access barrier receipt bound to its account, purpose, operation and floor. */
export type BarrierReceipt = {
  accountId: string;
  purpose: BarrierProof['purpose'];
  operationKey: string;
  receiptId: string;
  minimumAuthnEpoch: number;
};

/** Internal application ports. Never construct these results from HTTP fields. */
interface SharedAccessPorts {
  /** Sign-in may expose a suspended human's state privately for a refusal after credential verification. */
  readAccount(accountId: string, purpose?: 'signin'): Promise<AccessAccount | null>;
  /** Deleted and fenced accounts only. Ordinary reads stay empty for those rows. */
  readErasureAccount?(accountId: string): Promise<AccessAccount | null>;
  /** Private pending read bound to the exact verified native registration command. */
  readProvisioningAccount?(
    accountId: string,
    commandReference: string,
  ): Promise<(AccessAccount & { registrationId: string; expiresAt: string }) | null>;
  /** Bind Access readAssignment: checks provenance, actor, validity, revocation and principal state/fence. */
  readAssignment?(requestedBy: string, assignedActorId: string): Promise<AssignmentProof>;
  authorizeProvisioning(commandReference: string): Promise<ProvisioningAuthorization>;
  /** Consume once while rechecking relationship, formula, floors and client evidence.
   * Exact credential calls return CredentialEffectAuthorization; Auth compares its
   * operationKey, effectReference, effectDigest, purpose and subject with its own
   * immutable stage before writing. A credential purpose requires both locators.
   */
  consumeAuthorization?(input: AuthorizationConsumeInput): Promise<EffectAuthorization>;
  /** Commit a durable floor increase before returning; never clear an existing fence. */
  invalidateAccount?:
    | ((input: {
        accountId: string;
        previousEpoch: number;
        reason: 'consent-reduction' | 'session-revocation' | 'logout' | 'refresh-replay';
        proofReference?: string;
        operationKey?: string;
        /** Exactly the operator opening that created the reducing session of an automated account. */
        openingReceiptId?: string;
      }) => Promise<InvalidationReceipt>)
    | undefined;
  /** Recovery-only authoritative read may expose a fenced active human's current floor. */
  readRecoveryAccount?(accountId: string): Promise<AccessAccount | null>;
  /** Cleanup after a barrier reads every account the barrier fenced, of either kind, with its fence flag and floor. */
  readFencedAccount(accountId: string): Promise<AccessAccount | null>;
  /** Confirm the exact committed receipt before Auth applies any barrier effect. */
  confirmBarrier(input: BarrierReceipt): Promise<boolean>;
  /** Clear the fence a consent reduction raised after its Auth effects complete. */
  completeBarrier?(input: BarrierReceipt): Promise<void>;
  /** Reject a stale proof; commit an invalidation barrier without clearing any fence. */
  authorizeRecovery?(input: {
    accountId: string;
    proofEpoch: number;
    proofReference?: string;
    operationKey?: string;
  }): Promise<InvalidationReceipt>;
  /** Trusted Auth-host composition only, after a successful native credential
   * transaction commits and releases its connection. The nonsecret locator
   * resolves to the actual Auth witness; Access authorizes the exact current
   * receipt/floor before execution or replay. HTTP success awaits completion. */
  completeRecovery?: (reference: string) => Promise<void>;
}

/** Native approval and floor ports for the purposes installed by the host. */
export interface CredentialApprovalPorts<Purpose extends CredentialFloorPurpose> {
  /** Trusted native credential capability. Missing ports fail closed. Approval
   * creates the exact native opening; revalidation repeats current authorization
   * at the Auth commit boundary and before disclosing a saved result. The exact
   * floor receipt permits only this in-flight operation against its own barrier. */
  approveCredentialEffect?(input: {
    stage: CredentialEffectBinding<Purpose>;
    human: SessionProof;
    /** Deadline of the request Auth is serving. */
    deadline?: number;
  }): Promise<{ reference: string; expiresAt: string }>;
  /** Resolve the exact native opening from authorization and compare its binding
   * to stage. Repeat the same formula, current human/operator/subject state,
   * fences, floors, consent, evidence and original expiry on every call. replay
   * permits saved-result disclosure only; it never reopens a consumed approval.
   * floorReceipt permits only the exact in-flight own-human barrier exception.
   * No proof or permission context may be retained after this callback. */
  revalidateCredentialEffect?(input: {
    stage: CredentialEffectBinding<Purpose>;
    human: SessionProof;
    authorization: string;
    consumedOpening?: CredentialEffectAuthorization<Purpose>;
    floorReceipt?: CredentialFloorReceipt;
    replay: boolean;
    /** Deadline of the request Auth is serving. */
    deadline?: number;
  }): Promise<void>;
  advanceCredentialFloor?(input: Parameters<CredentialFloorPort<Purpose>>[0]): Promise<CredentialFloorReceipt>;
}

/** Explicit opt-in keeps existing password/key-only hosts typed to their four purposes. */
export type PasskeyTrustedAccessPorts = SharedAccessPorts &
  CredentialApprovalPorts<CredentialFloorPurpose> & {
    passkeys: true;
    /** Own-human passkey consumer; operator entry points retain CredentialPurpose. */
    consumePasskeyAuthorization(
      input: PasskeyAuthorizationInput,
    ): Promise<CredentialEffectAuthorization<PasskeyPurpose>>;
  };

export type TrustedAccessPorts =
  | (SharedAccessPorts &
      CredentialApprovalPorts<CredentialPurpose> & {
        passkeys?: false;
        consumePasskeyAuthorization?: undefined;
      })
  | PasskeyTrustedAccessPorts;

export interface SessionProof {
  account_id: string;
  client_id: string;
  scope: string[];
  authn_epoch: number;
  auth_time: number;
  amr: string[];
}

/** Transport-neutral shapes of the existing Access command inputs/results.
 * Production ports return the complete native CommandOutcome, including receipt
 * position/transactionId. The coordinator consumes only its nonsecret value. */
type Result<T> = Promise<{ value: T }>;
type Command = { accountId: string; key: string };
export type WorkflowMembership = { organizationId: string; memberAccountId: string; reservationId: string };
export type WorkflowResponsibility = { operatorAccountId: string; subjectAccountId: string; reservationId: string };
export type WorkflowAccount = {
  accountId: string;
  handle: string | null;
  operatorAccountId: string | null;
  state: string;
  fenced: boolean;
};

export type WorkflowHandleTransition = Command & {
  handle: string;
  expectedHandle: string | null;
  reservationId: string;
  operationId: string;
};
export type WorkflowContext = { actor: { accountId: string } };
type Reservation = { handle: string; accountId: string; reservationId: string; expiresAt: string };
export type WorkflowFence = {
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  kind: string;
  priorOperatorAccountId: string | null;
};
type ContinuationBinding = { operationKey: string; operationDigest: string; commandKeyPrefix: string };
type ContinuationEntry = { step: string; target: string; key: string; digest: string };
type ContinuationView = {
  reference: string;
  operationKey: string;
  operationDigest: string;
  commandKeyPrefix: string;
  barrierReceiptId: string;
  expiresAt: string;
  allowlist: ContinuationEntry[];
};
export type AccountOperation =
  | { kind: 'rename'; accountId: string; handle: string; expectedHandle: string | null; authorization: string }
  | { kind: 'organization'; handle: string; authorization: string }
  | { kind: 'revoke'; accountId: string }
  | {
      kind: 'membership';
      organizationId: string;
      memberAccountId: string;
      role: 'owner' | 'member' | null;
      reservationId?: string;
      authorization: string;
    }
  | {
      kind: 'automated';
      registrationId: string;
      operatorAccountId: string;
      authorization: string;
      handle?: string;
      operationKey?: string;
    }
  | {
      kind: 'transfer';
      previous: WorkflowResponsibility;
      expectedVersion: string;
      operatorAccountId: string;
      authorization: string;
    }
  | { kind: 'delete'; accountId: string; responsibility?: WorkflowResponsibility; authorization: string }
  | { kind: 'fence-operator'; accountId: string; authorization: string }
  | { kind: 'consent'; accountId: string; clientId: string; scopes: string[]; authorization: string }
  | { kind: 'client-reduction'; clientId: string; scopes: string[]; firstParty: boolean; authorization: string }
  | { kind: 'opening'; operatorAccountId: string; subjectAccountId: string; authorization: string };

export interface AccountWorkflowPorts<Context = WorkflowContext> {
  registrationTarget(key: string): string;
  reserveHandle(input: { handle: string; accountId: string; key: string }, context?: Context): Result<Reservation>;
  createPending(
    input: Command & { handle: string; reservationId: string },
  ): Result<{ accountId: string; registrationId: string; expiresAt: string }>;
  claimHandle(
    input: Command & { handle: string; reservationId: string; evidence?: unknown },
  ): Result<{ accountId: string; handle: string }>;
  activate(input: Command & { evidence: unknown }): Result<{ accountId: string }>;
  expireRegistration(input: Command & { handle: string; reservationId: string }): Result<unknown>;
  releaseExpiredRegistrationHandle(input: Command & { handle: string; reservationId: string }): Result<unknown>;
  provisioningReference(input: {
    accountId: string;
    reservationId: string;
    operation?: AccountOperation;
  }): Promise<string>;
  provisioningEvidence(input: { accountId: string; reservationId: string }): Promise<unknown>;
  raiseFence(input: Command): Result<WorkflowFence>;
  /** Resolve a durable approval to an authenticated kernel context. Recheck
   * current authorization; never synthesize a context from public JSON. Called
   * inside each protected step, so context/private facts never enter DBOS. */
  authorizeOperation?(reference: string, operation: AccountOperation): Promise<Context>;
  /** Native hosts deny legacy operations with no durable authorization field.
   * Callback-only historical hosts may omit this adapter. */
  authorizeUnprotectedOperation?(operation: AccountOperation): Promise<void>;
  actorAccountId?(context: Context): string;
  stableCommandKey?(context: Context, phase: string): string;
  /** Durable approval metadata for the resolved context. Absent on historical hosts. */
  approvalBinding?(context: Context): { operationKey: string; digest: string; commandKeyPrefix: string } | undefined;
  readContinuation?(operationKey: string, accountId: string): Promise<ContinuationView | null>;
  authorizeContinuation?(reference: string, entry: ContinuationEntry): Promise<{ receiptId: string }>;
  holdHandle?(input: WorkflowHandleTransition): Result<unknown>;
  transitionAccountHandle?(context: Context, input: WorkflowHandleTransition): Result<unknown>;
  finalizeHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  redirectTransitionHandle?(input: WorkflowHandleTransition): Result<unknown>;
  completeHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  cancelHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  releaseHandleTransition?(input: WorkflowHandleTransition): Result<unknown>;
  provisionManagementDefaults?(input: { operatorAccountId: string; key: string }): Result<unknown>;
  readAccount(accountId: string): Promise<WorkflowAccount | null>;
  setMembership?(
    context: Context,
    input: WorkflowMembership & { role: 'owner' | 'member' | null; key: string },
  ): Result<unknown>;
  releaseMembershipCoordination?(input: WorkflowMembership & { key: string }): Result<unknown>;
  reserveResponsibility?(input: {
    operatorAccountId: string;
    subjectAccountId: string;
    key: string;
  }): Result<WorkflowResponsibility>;
  recordOperatorRelation?(
    input: WorkflowResponsibility & { expectedOperatorAccountId: string | null; expectedVersion: string; key: string },
    pending?: { reservationId: string; operation: AccountOperation },
  ): Result<WorkflowResponsibility & { version: string }>;
  retireResponsibility?(input: WorkflowResponsibility & { key: string }): Result<unknown>;
  releaseResponsibility?(input: WorkflowResponsibility & { key: string }): Result<unknown>;
  responsibilityPage?(input: {
    operatorAccountId: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ operators: { reservationId: string; subjectAccountId: string }[]; next: string | null }>;
  tombstone?(context: Context, input: Command & { continuation?: ContinuationBinding }): Result<WorkflowFence>;
  redirectHandle?(input: Command & { handle: string }): Result<unknown>;
  authorizeOpening?(
    context: Context,
    input: { operatorAccountId: string; subjectAccountId: string; purpose: 'session'; key: string },
  ): Result<{ receiptId: string }>;
  reserveCoordination?(
    input: Command & { relatedAccountId: string; purpose: 'membership' | 'operator' },
  ): Result<{ accountId: string; relatedAccountId: string; purpose: string; reservationId: string }>;
  createOrganization?(input: {
    organizationId: string;
    ownerAccountId: string;
    ownerReservationId: string;
    key: string;
  }): Result<{ accountId: string; ownerAccountId: string }>;
  bootstrapOrganizationHandle?(
    input: WorkflowHandleTransition & { ownerAccountId: string; ownerReservationId: string },
  ): Result<unknown>;
}

/** Extra trusted Access result. All facts describe the original pending command,
 * not HTTP fields, Auth staging, or a later account authentication floor. */
export interface ProvisioningReceiptMetadata {
  registrationId: string;
  reservationId: string;
  authnEpoch: number;
  expiresAt: string;
}
export interface ProvisioningAuthorization {
  accountId: string;
  receipt?: ProvisioningReceiptMetadata;
}
export interface ProvisioningEvidenceLocator extends ProvisioningReceiptMetadata {
  receiptKey: string;
  accountId: string;
}
/** Nonsecret exact locator. Possession authorizes neither provisioning nor activation. */
export interface ProvisioningEvidenceReference extends ProvisioningEvidenceLocator {
  version: 1;
  credentialId: string;
}
/** Structurally matches Access without importing the kernel at runtime. */
export interface ProvisioningEvidence {
  accountId: string;
  registrationId: string;
  authIdentityId: string;
  authnEpoch: number;
}
export interface ProvisioningResult {
  accountId: string;
  /** Absent for legacy trust fixtures without exact pending receipt metadata. */
  provisioningEvidence?: ProvisioningEvidenceReference;
}

export type NativeWorkflowPair = { accountId: string; reservationId: string };
export type AutomatedCreationBinding = Omit<Extract<AccountOperation, { kind: 'automated' }>, 'authorization'>;
export type NativeWorkflowProofPorts = {
  recordPending(input: NativeWorkflowPair & { reference: string }): Promise<void>;
  pendingReference(input: NativeWorkflowPair): Promise<string | null>;
  provisioningEvidence(input: NativeWorkflowPair): Promise<unknown>;
  /** Optional capabilities fail closed for automated creation when absent. */
  recordAutomatedPending?(input: NativeWorkflowPair & { reference: string }): Promise<void>;
  automatedReference?(input: NativeWorkflowPair): Promise<string | null>;
  creationBinding?(input: {
    registrationId: string;
    operationKey: string;
    accountId?: string;
    reservationId?: string;
  }): Promise<AutomatedCreationBinding | null>;
};

export type MembershipPrincipal = { kind: 'organization' | 'realm'; id: string };
export type MembershipWorkInput =
  | {
      kind: 'membership';
      principal: MembershipPrincipal;
      memberAccountId: string;
      role: 'owner' | 'member' | null;
      reservationId?: string;
      authorization: string;
    }
  | { kind: 'organization'; organizationId: string; authorization: string };
export type MembershipWorkReservation = { accountId: string; principal: MembershipPrincipal; reservationId: string };
export type MembershipWorkResult =
  | { status: 'completed'; accountId: string; reservationId: string }
  | { status: 'membership_limit'; code: 'membership_limit' };
export interface MembershipWorkflowPorts<Context> {
  authorize(reference: string, input: MembershipWorkInput): Promise<Context>;
  actorAccountId(context: Context): string;
  reserve(input: { accountId: string; principal: MembershipPrincipal; key: string }): Result<MembershipWorkReservation>;
  publish(
    context: Context,
    input: MembershipWorkInput,
    reservation: MembershipWorkReservation,
    key: string,
  ): Promise<unknown>;
  terminalize(reservation: MembershipWorkReservation, key: string): Promise<unknown>;
  release(input: MembershipWorkReservation & { key: string }): Promise<unknown>;
}

/** Nonsecret reference resolution; this receipt confers no authority by itself. */
export type BarrierProof = Readonly<{
  accountId: string;
  purpose: 'consent-reduction' | 'recovery';
  previousEpoch: number;
  operationKey: string;
  digest: string;
  expiresAt: string;
  /** Only a consent reduction from an operator-opened session binds the opening Auth committed for it. */
  openingReceiptId?: string;
}>;

export type BarrierProofExpectation = Pick<
  BarrierProof,
  'accountId' | 'purpose' | 'previousEpoch' | 'operationKey' | 'openingReceiptId'
>;

/** Committed successful native Auth recovery, bound to the exact Access barrier
 * and a new credential establishment. Structurally matches Access evidence. */
export type RecoveryEstablishmentEvidence = Readonly<{
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  authnEpoch: number;
  establishmentId: string;
  /** Original source-proof expiry; resolving a witness never renews it. */
  expiresAt: string;
}>;

/** Auth capabilities consumed by kernel session composition. */
export interface AuthSessionPort {
  internal: {
    accessTokenForProof(proof: SessionProof): Promise<string>;
  };
}

export interface AuthCredentialPort {
  internal: {
    verifyCredentialEffect: CredentialEffectVerifier;
  };
}

export interface AuthRecoveryPort {
  internal: {
    resolveRecoveryEstablishment(reference: unknown): Promise<RecoveryEstablishmentEvidence | null>;
  };
}

export type BarrierProofVerifier = (
  reference: string,
  expected: BarrierProofExpectation,
) => Promise<BarrierProof | null>;
export interface BarrierProofPort {
  verify: BarrierProofVerifier;
}
export type ProvisioningEvidenceVerifier = (reference: unknown) => Promise<ProvisioningEvidence | null>;
export interface ProvisioningEvidencePort {
  resolve: ProvisioningEvidenceVerifier;
}
export type BarrierProofVerifierFactory<Database> = (options: { database: Database }) => BarrierProofPort;
export type ProvisioningEvidenceVerifierFactory<Database> = (options: {
  database: Database;
}) => ProvisioningEvidencePort;
