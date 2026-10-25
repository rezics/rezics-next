import type { CredentialEffect, EffectPurpose, SessionProof } from '../services/auth/src/index.ts';

/** TEST ONLY. NATIVE_CREDENTIAL_EFFECT_DRIVER_MODULE must export
 * createNativeCredentialEffectDriver(): Promise<NativeCredentialEffectDriver>.
 * Transport actual Auth commands/HTTP, installed Access authentication/formula,
 * native operator authorizeOpening/consumeOpening and DBOS checkpoints only.
 * No private evaluator, substitute Access, approval Set/map, synthetic receipt,
 * effect implementation or adapter-side authorization. Missing hooks remain red.
 * Isolated migrated databases; factory failure and close clean owned resources.
 * Only native refusal maps to denial; infrastructure errors must throw.
 * Caller handles retain real harness credentials outside Access/DBOS. Every call
 * authenticates through Auth; JSON proof/epoch/actor fields confer no authority.
 */
export type Purpose = Exclude<EffectPurpose, 'session'>;
export type Mode = 'own-human' | 'human-operator' | 'organization-operator';
export type Reply<T> = { response: Response; value?: T };
/** Nonsecret hostile transport data. Digest is Auth's secret-keyed commitment,
 * never a caller hash accepted as provenance. Native Auth resolves effectRef.
 */
export type Operation = {
  key: string;
  subjectId: string;
  purpose: Purpose;
  effectRef: string;
  digest: string;
};
export type Approval = { reference: string; expiresAt: string };
export type Result = { receiptId: string; replayed: boolean };
export type Fixture = {
  mode: Mode;
  humanId: string;
  subjectId: string;
  otherSubjectId: string;
  organizationId: string;
  operatorId: string | null;
  caller: string;
  otherHuman: string;
  otherClient: string;
  automatedCaller: string;
  unauthenticated: string;
  clientId: string;
  scopes: string[];
  floor: string;
  /** Auth-valid candidate password, different candidate, existing removable key,
   * new public key and its private fixture material for persistence inspection.
   * Seed installs an OLD password and two removable keys; candidate password/key
   * are absent. otherExistingKid selects a different actual credential row.
   */
  password: string;
  otherPassword: string;
  existingKid: string;
  otherExistingKid: string;
  newKey: Extract<CredentialEffect, { publicJwk: unknown }>;
  privateKey: string;
  rawAccessToken: string;
  rawRefreshToken: string;
};
export type Binding = Operation & {
  humanId: string;
  clientId: string;
  scopes: string[];
  operatorId: string | null;
  nativePurpose: 'credential-management' | null;
  openingId: string | null;
  createdAt: string;
  expiresAt: string;
};
export type Snapshot = {
  /** Complete credential rows, native opening consumption and Auth effect rows,
   * target floors and session identities. Stable independent SQL, including all
   * fixture targets; exclude setup/staging/approval and denial bookkeeping.
   * state includes consumed_at for every opening existing at snapshot time.
   */
  state: unknown;
  floor: string;
  sessions: string[];
  committed: (Operation & { receiptId: string })[];
  passwordInstalled: boolean;
  candidatePasswordMatches: boolean;
  keyIds: string[];
};
export type Revocation =
  | 'actor-grant'
  | 'consent'
  | 'scope'
  | 'explicit-deny'
  | 'missing-evidence'
  | 'human-floor'
  | 'subject-floor'
  | 'operator-floor'
  | 'human-suspended'
  | 'subject-deleted'
  | 'subject-fenced'
  | 'operator-relation'
  | 'organization-membership';
export type Checkpoint = 'before-native-consume' | 'after-native-consume-before-auth-commit';
export interface NativeCredentialEffectDriver {
  /** Fresh independent fully allowed fixture, K<=1000. Org operator includes a
   * current eligible human member with management authority. Automated sign-in
   * uses its own OLD credential, independent of operator management permission.
   * Scope is genuinely consented and signed, not an adapter boolean.
   */
  seed(mode: Mode, sessions?: number): Promise<Fixture>;
  /** Actual Auth staging: validate/hash only in Auth, keyed commitment and secret
   * material only in Auth storage; immutable (subject,key) binding. No approval.
   */
  stage(
    caller: string,
    input: { key: string; subjectId: string; credential: CredentialEffect },
  ): Promise<Reply<Operation>>;
  approve(caller: string, operation: Operation): Promise<Reply<Approval>>;
  /** Input is deliberately hostile. Invoke actual protected credential command,
   * live accessTokenForProof in Auth callback, and native one-use CAS. Checkpoint
   * pauses real code before the named barrier; callback cannot replace policy.
   */
  apply(
    caller: string,
    reference: unknown,
    operation: Operation,
    checkpoint?: { at: Checkpoint; run(): Promise<void> },
  ): Promise<Reply<Result>>;
  /** Native authorizeOpening with purpose credential-management or session, with
   * genuine current human; no exact credential narrowing. Used only as hostile
   * input to credential apply, never a replacement implementation of approve.
   */
  broadOpening(f: Fixture, purpose: 'credential-management' | 'session'): Promise<string>;
  /** Invoke the existing Auth session entry or guarded device HTTP request with a
   * credential reference. Unimplemented device transport refuses; this port does
   * not request a device implementation or an alternate issuance path. */
  otherPurpose(
    caller: string,
    reference: string,
    subjectId: string,
    purpose: 'session' | 'device',
  ): Promise<Reply<unknown>>;
  /** Independent reads of exact Auth binding AND native opening where present;
   * never reconstruct binding from arguments or a cached approval result.
   */
  binding(reference: string): Promise<Binding>;
  inspect(f: Fixture): Promise<Snapshot>;
  /** Attempt native operator conversion through its normal command and holds;
   * never corrupt relation rows or bypass the responsibility safeguard. */
  automateOperator(f: Fixture): Promise<Reply<unknown>>;
  revoke(f: Fixture, fact: Revocation): Promise<void>;
  signInAutomated(f: Fixture, credential: 'own' | 'wrong' | 'none'): Promise<Reply<SessionProof>>;
  /** Real current human login after floor increase; no token refresh or proof copy. */
  authenticateAgain(f: Fixture): Promise<string>;
  /** Wait through authoritative expiry with GC disabled; do not rewrite expiry. */
  awaitExpiry(reference: string): Promise<void>;
  /** Execute until actual native consume or atomic Auth credential+success receipt
   * COMMIT, drop acknowledgement, terminate workers and volatile caches. Returns
   * only after the specified durable checkpoint; no synthetic rollback/result.
   */
  loseAcknowledgement(
    f: Fixture,
    a: Approval,
    op: Operation,
    at: 'opening-consumed' | 'effect-committed',
  ): Promise<void>;
  restart(): Promise<void>;
  /** Actual Access rows and DBOS args/results/errors/checkpoints, recursively.
   * Compare fixture secret values AND serialized permission-context structure.
   */
  persisted(f: Fixture): Promise<{
    accessRows: number;
    durableRows: number;
    nonsecretReferences: number;
    plaintextPasswords: number;
    privateKeys: number;
    tokens: number;
    permissionContexts: number;
    /** Actual native password hashes/public JWK/effect bodies in Access or DBOS,
     * excluding only the Auth-owned keyed commitment and nonsecret locator. */
    credentialPayloads: number;
  }>;
  close(): Promise<void>;
}

/** Future product cost proof: checkGrowth at THREE scales [1,8,64], separate
 * same-subject consumed-opening, old Auth-effect and unrelated-owner series.
 * Capture real nested SQL/plans, fixed selected subject/formula K<=1000/output:
 * one route-led exact opening and one exact Auth effect/credential seek, current
 * account and existing actor-side formula O(log R+(1+K)log G), R=N+U*t+M.
 * Rows/statements fixed, buffers logarithmic; one credential mutation and <=64
 * sessions on revocation. No history/all-account scan, wall-clock gate, planner
 * forcing or simulated counters. Native expiry cleanup <=1000 rows per tick.
 * This interface and missing-driver verifier provide no native product proof.
 */
