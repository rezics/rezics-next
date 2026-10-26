/** TEST ONLY. NATIVE_ACCOUNT_WORKFLOW_DRIVER_MODULE exports
 * createNativeAccountWorkflowDriver(): Promise<NativeAccountWorkflowDriver>.
 * Transport production commands/DBOS and independently observe migrated databases.
 * No evaluator, seeded grant-policy outputs, provisioning Set, approval Map,
 * synthetic receipt, fabricated Actor, JWT signer or substitute fixture qualifies.
 * Use the actual openImportIdentity/createNativeContentSystem ordinary composition,
 * approved governance bootstrap CLI, Auth registration/consent/token and native
 * grant/delegation commands. SQL is limited to schema setup and observation.
 * Factory failure cleans partial setup; close stops owned hosts/pools/fixtures.
 * Errors throw; only actual native refusal maps to the exact denied wire shape.
 * Website-provider and personal-consent safeguard work is outside this port.
 */
export type Responsibility = { operatorAccountId: string; subjectAccountId: string; reservationId: string };
/** Native AccountOperation business fields; authorization is supplied separately
 * as the persisted approval locator, never a context or bearer in DBOS. */
export type Operation =
  | { kind: 'organization'; handle: string }
  | { kind: 'transfer'; previous: Responsibility; expectedVersion: string; operatorAccountId: string }
  | { kind: 'delete'; accountId: string; responsibility?: Responsibility }
  | { kind: 'fence-operator'; accountId: string }
  | { kind: 'opening'; operatorAccountId: string; subjectAccountId: string };
export type Work = { operationKey: string; operation: Operation };
export type Family = 'organization' | 'transfer' | 'subject-delete' | 'operator-delete' | 'fence-operator' | 'opening';
export type Identity = {
  actorId: string;
  clientId: string;
  scopes: string[];
  requestedBy: string | null;
  epoch: string;
};
export type Fixture = {
  family: Family;
  work: Work;
  caller: string;
  otherClientCaller: string;
  identity: Identity;
  ownerId: string;
  nextOperatorId: string;
  subjectId: string;
  otherSubjectId: string;
  organizationId: string;
  handle: string;
  /** Actual configured native operator management action, not a test action. */
  managementAction: string;
};
export type Denied = { outcome: 'denied' };
export type Approval = { outcome: 'approved'; reference: string; expiresAt: string };
export type Result = Denied | { outcome: 'permitted'; accountId: string; receiptId: string; value: unknown };
export type Step = { name: string; target: string };
export type ProtectedStep = Step & { authority: 'caller' | 'committed-continuation' };
export type Revocation =
  | 'actor-grant'
  | 'client-consent'
  | 'scope'
  | 'principal-grant'
  | 'assignment'
  | 'actor-epoch'
  | 'actor-fenced'
  | 'missing-evidence'
  | 'operator-relation'
  | 'organization-membership';
export type Receipt = {
  id: string;
  kind: string;
  key: string;
  digest: string;
  transactionId: string;
  response: unknown;
};
export type Snapshot = {
  accounts: {
    id: string;
    kind: 'human' | 'automated' | 'organization';
    state: string;
    fenced: boolean;
    floor: string;
    operatorId: string | null;
    version: string;
  }[];
  responsibilities: (Responsibility & { terminal: boolean; held: boolean })[];
  ownerInverses: { organizationId: string; ownerId: string; reservationId: string; held: boolean; terminal: boolean }[];
  memberships: { organizationId: string; accountId: string; role: 'owner' | 'member'; reservationId: string }[];
  /** Exact native current count plus independently read current eligible humans. */
  owners: { organizationId: string; nativeCount: number; activeHumans: string[] }[];
  handles: { handle: string; accountId: string; phase: string }[];
  /** Complete stable native temporal membership/grant/deny rows, including prior
   * versions. Read-only fixture observation, outside measured production work. */
  history: unknown[];
  /** Business command receipts, including internal effects; exclude approval and
   * authority-transition bookkeeping, never omit retained history. */
  receipts: Receipt[];
  /** Stable native Auth effect/session identities, not harness counters. */
  authEffects: unknown[];
};
/** A committed service continuation is NOT another user approval. This is an
 * observation of native storage, never a caller-mintable capability input. */
export type Continuation = {
  reference: string;
  operationKey: string;
  operationDigest: string;
  barrierReceiptId: string;
  expiresAt: string;
  /** Root entries committed with the barrier, followed by every committed page
   * allowlist chained from it, in commit order (read-only observation). */
  allowed: { step: string; target: string; key: string; digest: string }[];
};
export interface NativeAccountWorkflowDriver {
  /** Independent fixtures, genuine fully allowed original human/client/scopes;
   * every caller acts through a principal-created assignment except opening,
   * whose caller acts as the person itself. Normal self-management uses the SAME formula.
   * Organization creation requires the decided documented parent/action; absence
   * is an explicit failure, never an inferred Global grant or skipped scenario.
   * Platform authority uses only the actual approved Global root when decided.
   * Automated setup belongs to ordinary composition, not this adapter.
   * subjects controls affected count only; organizationOperator uses an actual
   * organization with an eligible owner and a backup human owner for removal
   * controls; independentCredentials uses real Auth.
   * operator-delete is drained by default; heldResponsibilities deliberately
   * retains native holds for the deletion refusal control.
   * The transfer fixture's caller manages both the source and the destination
   * operator, so one approval carries both. Transfer is co-approved: the source
   * manager's authorization and the destination manager's acceptance, bound to
   * one immutable transfer record. One person may give both only when authorized
   * for both. Two-person acceptance is proven by the implementation's own tests.
   * fence-operator is platform governance. Its action is account:suspend on the
   * Global Context 00000000-0000-8000-8000-000000000000, and its root barrier is
   * the native suspension of the operator. The caller is platform staff holding
   * the governance role from the approved bootstrap; ownerId is the operator
   * being fenced. The caller keeps its authority after the barrier, so its
   * result is the suspension, while the fanout continues under the committed
   * continuation.
   */
  fixture(
    family: Family,
    options?: {
      subjects?: number;
      organizationOperator?: boolean;
      independentCredentials?: boolean;
      heldResponsibilities?: boolean;
    },
  ): Promise<Fixture>;
  approve(caller: string, work: Work): Promise<Approval | Denied>;
  /** Exact immutable workflow_approval + native binding/create receipts. */
  approval(reference: string): Promise<
    | null
    | (Identity & {
        operationKey: string;
        operation: Operation;
        digest: string;
        expiresAt: string;
        action: string;
        resourceId: string;
        creationReceiptId: string;
      })
  >;
  /** Native canonical business-operation/key digest, not a local formula. */
  digest(work: Work): Promise<string>;
  execute(
    caller: string,
    reference: unknown,
    work: Work,
    hook?: {
      before: Step;
      /** attempt-T pauses after approval resolution/preparation but before the
       * actual native authoritative guard/read, also on receipt-replay attempts. */
      boundary?: 'step' | 'attempt-T';
      run(): Promise<void>;
    },
  ): Promise<Result>;
  /** Enumerate actual registered protected steps, including reads, holds,
   * internal commands, each fanout target and retries. No adapter-authored list.
   * Hooks pause BEFORE fresh resolution/attempt T, with no connection held.
   * Background continuation workers remain paused until continueCommitted.
   * Only deletion/fencing effects after their committed terminal barrier can
   * declare committed-continuation authority; all other steps require caller.
   * Lists have stable phase/target ordering across equivalent fresh fixtures.
   */
  protectedSteps(fixture: Fixture): Promise<ProtectedStep[]>;
  /** Commit real native authority changes, preserving original tokens/scopes.
   * scope obtains an actually reduced native ceiling, not edited JWT claims.
   * missing-evidence interrupts the real authority reader, never replaces Access.
   */
  revoke(fixture: Fixture, fact: Revocation): Promise<void>;
  snapshot(fixture: Fixture): Promise<Snapshot>;
  /** Stop the actual worker immediately after the specified committed step and
   * before its DBOS acknowledgement. Observe interrupted transport, no fake throw
   * in place of a crash. restart discards workers/caches; retain only databases,
   * keys and original harness credentials. No reapproval or capability reinsertion.
   */
  crashAfter(fixture: Fixture, reference: string, step: Step): Promise<void>;
  restart(): Promise<void>;
  continuation(fixture: Fixture): Promise<Continuation | null>;
  /** Internal production scheduler port; never resolve stale user approval here.
   * A hostile override must traverse native continuation verification. Only the
   * committed exact allowlist can act; return no private user workflow response.
   */
  continueCommitted(
    reference: string,
    override?: Partial<Continuation>,
    hook?: {
      before: Step;
      run(): Promise<void>;
    },
  ): Promise<Denied | { outcome: 'continued' }>;
  continuationEffects(
    fixture: Fixture,
  ): Promise<{ step: string; target: string; key: string; digest: string; receiptId: string }[]>;
  /** Await actual SQL expiry with GC paused; do not edit timestamps. */
  awaitExpiry(reference: string): Promise<void>;
  /** Real current management, real login/session/JWT validation for every operated
   * account (including independent credentials), and old/new resource grant use.
   * No observer predicts formula outcomes from account kind or operator fields.
   */
  access(fixture: Fixture): Promise<{
    oldManagement: boolean;
    newManagement: boolean;
    oldSessionsValid: boolean;
    independentLogin: boolean;
    inheritedResourceAccess: boolean;
  }>;
  /** Invoke native membership/delete/suspend commands against the last human
   * owner; do not mutate rows or substitute an owner policy.
   * lastOwner(f, 'suspend') is platform staff suspending the last owner through
   * the native suspension command.
   */
  lastOwner(fixture: Fixture, action: 'remove' | 'demote' | 'delete' | 'suspend'): Promise<Result>;
  /** Real native opening workflow + existing live-human Auth capability. Never
   * implement proof/JWT issuance in this driver. mismatch changes untrusted input. */
  consumeOpening(
    fixture: Fixture,
    mismatch?: 'subject' | 'purpose' | 'human' | 'client' | 'relation' | 'epoch',
  ): Promise<Result>;
  /** Actual signed-keyset native list. Tampering reuses the returned cursor on
   * another operator/epoch or changes its bytes; it must reach native decoding. */
  page(
    fixture: Fixture,
    limit: number,
    cursor?: string,
    mismatch?: 'operator' | 'epoch' | 'bytes',
  ): Promise<Denied | { operators: { reservationId: string; subjectAccountId: string }[]; next: string | null }>;
  /** Inspect actual DBOS args/results/errors, including nested page workflows. */
  durableState(fixture: Fixture): Promise<{
    records: number;
    approvals: number;
    bearerTokens: number;
    refreshTokens: number;
    credentials: number;
    actorContexts: number;
  }>;
  close(): Promise<void>;
}
