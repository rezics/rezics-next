/** TEST ONLY. ACCOUNT_AUTHORIZATION_DRIVER_MODULE is a path/file URL exporting
 * createAccountAuthorizationDriver(): Promise<AccountAuthorizationDriver>.
 * Bind real native Access commands, Auth and DBOS in isolated migrated databases.
 * No implementation, policy model, callback fixture authorization, map-backed
 * approval, synthetic receipt, or simulated cost counter satisfies this port.
 * Factory failure cleans partial setup; close stops workers and removes fixtures.
 *
 * Caller strings are harness handles for genuinely authenticated requests; only
 * the harness may retain tokens outside DBOS. Approve traverses the production
 * authenticated entry point. execute traverses real account workflows, resolving
 * capabilities inside EACH protected step and native command retry at time T.
 * Input objects are hostile data, never trusted context. Denied means no stored
 * response disclosure, including receipt IDs. Exceptions are not mapped to allow.
 * Setup may create real accounts/grants/consent/assignments and explicit negative
 * evidence. It may not implement command effects or the authorization decision.
 */
/** Untrusted transport input; native validation must require rename's handle and
 * expectedHandle, and reject fields inappropriate for its selected purpose.
 */
export type Operation = {
  kind: 'rename' | 'delete';
  accountId: string;
  key: string;
  handle?: string;
  expectedHandle?: string | null;
};
export type Approval = { outcome: 'approved'; reference: string; expiresAt: string };
export type Denied = { outcome: 'denied' };
/** Wire observation: denied responses must have ONLY outcome; permitted command
 * responses include receiptId/replayed. The frozen runtime assertions enforce
 * exact denial shape and receipt identity, independently of this transport type.
 */
export type Outcome = { outcome: 'denied' | 'permitted'; receiptId?: string; replayed?: boolean };
export type Fixture = {
  caller: string;
  otherClientCaller: string;
  unauthenticated: string;
  actorId: string;
  otherAccountId: string;
  clientId: string;
  scopes: string[];
  /** A current principal-created assignment to actorId, never a principal claim. */
  requestedBy: string;
  floor: string;
  rawAccessToken: string;
  rawRefreshToken: string;
  operation: Operation;
};
export type Revocation =
  | 'actor-grant'
  | 'consent'
  | 'principal-grant'
  | 'assignment'
  | 'scope'
  | 'epoch'
  | 'suspended'
  | 'deleted'
  | 'fence'
  | 'explicit-deny'
  | 'missing-evidence'
  | 'operator-relation';
export type Capability =
  | 'authorizeOperation'
  | 'verifyProvisioningReceipt'
  | 'consumeAuthAuthorization'
  | 'invalidateAccount'
  | 'authorizeRecovery';
export type BarrierFault = 'account' | 'previous-floor' | 'new-floor' | 'receipt' | 'untrusted-proof' | 'stale-proof';
export type AuthPurpose = 'session' | 'set-password' | 'remove-password' | 'add-key' | 'remove-key';
export interface AccountAuthorizationDriver {
  /** Fresh independent accounts/handles per call; does not erase prior fixtures.
   * Includes automated subject + second subject, two humans/clients, own and wrong
   * credentials, and a pending human registration. All controls are fully allowed.
   * Named operation is a multi-step native rename with all required grants.
   */
  seed(): Promise<Fixture>;
  approve(caller: string, operation: Operation): Promise<Approval | Denied>;
  /** Independent DB read of immutable stored binding, excluding reference itself. */
  reference(reference: string): Promise<null | {
    actorId: string;
    clientId: string;
    scopes: string[];
    requestedBy: string | null;
    target: string;
    purpose: string;
    operationKey: string;
    digest: string;
    expiresAt: string;
  }>;
  /** Native canonical digest of complete operation/key, excluding its reference. */
  operationDigest(operation: Operation): Promise<string>;
  execute(
    reference: unknown,
    operation: Operation,
    checkpoint?: {
      beforeStep: string;
      run(): Promise<void>;
    },
  ): Promise<Outcome>;
  resolveAs(caller: string, reference: string, operation: Operation): Promise<Outcome>;
  /** Enumerate every production protected step for this workflow, including
   * coordination writes. Hook pauses immediately before that step's authorization,
   * not after it. It cannot replace/call around production authorization. After
   * callback, effectsAfterCheckpoint counts actual committed effects past pause.
   */
  protectedSteps(operation: Operation): Promise<string[]>;
  effectsAfterCheckpoint(fixture: Fixture): Promise<number>;
  /** Commit a real authority mutation, or make authoritative evidence unavailable.
   * 'scope' removes the required consented scope; 'epoch' raises the Access floor.
   * Revoke must finish before the paused production step resumes.
   */
  revoke(fixture: Fixture, fact: Revocation): Promise<void>;
  restoreGrant(fixture: Fixture): Promise<void>;
  /** Independent SQL/native receipts: no driver-maintained effect counters.
   * Counts target business effects and Auth effects, excluding authority mutations,
   * approval records, coordination setup and denial bookkeeping. Retain receipt
   * identity/state so equality detects changed effects even with unchanged counts.
   */
  snapshot(fixture: Fixture): Promise<{ effects: number; authEffects: number; state: unknown }>;
  /** Kill/recreate production worker processes and volatile caches; retain only
   * databases, configuration and harness credentials. Run real DBOS recovery.
   * No reapproval, callback registration of fixture maps or reference reinsertion.
   */
  restart(): Promise<void>;
  restartAccessReader(): Promise<void>;
  /** Wait past authoritative expiry, disable scheduled GC for this test. Never
   * rewrite expiry or bypass clock checks. Expired row remains independently read.
   */
  awaitExpiry(reference: string): Promise<void>;
  signInAutomated(fixture: Fixture, credential: 'own' | 'other' | 'none'): Promise<Outcome>;
  /** Native authorizeOpening + exact Auth-purpose binding, not a broad new right. */
  opening(fixture: Fixture, purpose: AuthPurpose): Promise<Approval>;
  consumeOpening(
    fixture: Fixture,
    reference: string,
    mismatch?: 'subject' | 'purpose' | 'human' | 'client' | 'expired' | 'remove-key',
  ): Promise<Outcome>;
  /** Real createPending command transaction, including deliberately held/rolled
   * back transactions for negatives. No synthetic committed command response.
   */
  pendingProof(
    fixture: Fixture,
    state:
      | 'committed'
      | 'rolled-back'
      | 'uncommitted'
      | 'expired'
      | 'wrong-kind'
      | 'other-account'
      | 'reservation-only'
      | 'shape-only',
  ): Promise<string>;
  provision(fixture: Fixture, reference: string): Promise<Outcome>;
  /** Run actual Auth consent reduction / trusted recovery establishment. Faults
   * substitute evidence only at the untrusted boundary. The hook occurs after
   * Access COMMIT but BEFORE any Auth mutation. Recovery starts with fenced human;
   * valid proof is obtained through Auth, never a caller-provided epoch flag.
   */
  barrier(
    fixture: Fixture,
    kind: 'consent' | 'recovery',
    fault?: BarrierFault,
    beforeAuth?: (barrier: {
      accountId: string;
      previousFloor: string;
      newFloor: string;
      receiptId: string;
    }) => Promise<void>,
  ): Promise<Outcome>;
  fence(accountId: string): Promise<{ receiptId: string; floor: string; fenced: boolean } | null>;
  oldSessionAllowed(fixture: Fixture): Promise<boolean>;
  /** Omit named production capability in composition and invoke its real
   * protected path with otherwise valid evidence; cannot merely return denied.
   */
  withoutCapability(fixture: Fixture, capability: Capability): Promise<Outcome>;
  nativeException(
    fixture: Fixture,
    scenario:
      | 'self-read'
      | 'fenced-human-recovery'
      | 'other-account-read'
      | 'automated-recovery'
      | 'organization-recovery'
      | 'stale-recovery'
      | 'generic-write',
  ): Promise<Outcome>;
  /** Inspect actual persisted DBOS args/results/errors/checkpoints, including
   * nested workflows. Compare fixture secrets and parse serialized context shapes;
   * do not search only for field names or accept a harness-generated empty list.
   */
  durableState(fixture: Fixture): Promise<{
    records: number;
    references: number;
    accessTokens: number;
    refreshTokens: number;
    plaintextCredentials: number;
    actorContexts: number;
  }>;
  close(): Promise<void>;
}

/** Future product growth binding uses shared openGrowthDatabase/seed/checkGrowth
 * from services/kernel/test/support/growth.ts, actual auto_explain captures and
 * scales [1,8,64]. Run independent series varying unrelated subjects, unrelated
 * history and same approving-anchor history, with fixed target/evidence and K.
 * Population N+U*t+M grows; K<=1000 grants per actor/principal. Include all nested
 * reference/receipt/account/evidence/formula SQL, transactions and retries.
 * Reference seek alone has constant examined rows/statements, logarithmic buffers;
 * full formula costs O((1+K)logG). No request enumerates history. Seed with real
 * receipts, consumed openings and expired references, ANALYZE outside capture.
 * Measure GC separately with B<=1000 and O(B) rows; one consumption changes O(1).
 * This suite's missing-driver verifier makes no production growth claim.
 */
export interface AuthorizationGrowthSeed {
  scale: 1 | 8 | 64;
  axis: 'subjects' | 'unrelated-history' | 'same-anchor-history';
  grantsPerActor: number;
  expiryBatch: number;
}
