/**
 * Test-only contract. ACCOUNT_LIFECYCLE_OUTCOME_DRIVER is an absolute path or
 * file URL exporting createAccountLifecycleDriver(): Promise<AccountLifecycleDriver>.
 * Each call creates an isolated namespace; close() removes its accounts, Auth
 * credentials, sessions, handles, receipts and other fixtures even after failure.
 * Factory failure must clean up any partially created namespace itself.
 *
 * Bind commands to the production account boundary, persistent authoritative
 * data and real Better Auth issuance/validation. Never implement policy in this
 * adapter, seed precomputed outcomes, or substitute a parallel identity system.
 * Reads expose persisted evidence, not echoed command arguments. Auth inventory
 * must enumerate all identity/credential owners, including accidental duplicates;
 * an internal one-to-one Better Auth ID mapping is normalized to account IDs.
 * No table placement, database topology, HTTP route or session transport is fixed.
 *
 * Time and failure hooks are test boundary controls only. Production semantics
 * use authoritative time. advanceTo runs due lifecycle work to completion.
 * IDs/handles/keys below are namespace-local labels mapped by the adapter.
 * Denied commands return 'denied' and commit no requested change. Commands await
 * durable completion unless a documented registration/revocation barrier stops them.
 */
export type Outcome = 'permitted' | 'denied';
export interface Credential {
  readonly opaque: unknown;
}
export interface Session {
  readonly opaque: unknown;
}
export interface Token {
  readonly opaque: unknown;
}
export interface RecoveryProof {
  readonly opaque: unknown;
}
export type Login = { outcome: 'denied' } | { outcome: 'authenticated'; session: Session };
export interface Account {
  id: string;
  kind: 'actor' | 'organization';
  handle: string;
  operatorId: string | null;
  state: 'pending' | 'active' | 'suspended' | 'deleted';
  minimumAuthnEpoch: number;
  fenced: boolean;
}
export interface Registration {
  accountId: string;
  expiresAt: string;
}
export interface PublicView {
  id: string;
  kind: 'actor' | 'organization';
  automated: boolean;
  operatorId?: string;
  /** Complete public response, including nested fields, before test normalization. */
  raw: unknown;
}
export interface FenceReceipt {
  id: string;
  accountId: string;
  minimumAuthnEpoch: number;
}
export interface AccountLifecycleDriver {
  close(): Promise<void>;
  advanceTo(instant: string): Promise<void>;
  /** Start/retry the real registration workflow, paused after claiming a handle. */
  beginRegistration(input: { handle: string; key: string; kind?: string }): Promise<Registration | 'denied'>;
  newCredential(kind: 'password' | 'key'): Promise<Credential>;
  /** Stop after Auth installation, before activation; retries must be idempotent. */
  installRegistrationCredential(registration: Registration, credential: Credential): Promise<Outcome>;
  activate(registration: Registration): Promise<Outcome>;
  account(id: string): Promise<Account>;
  resolveHandle(handle: string): Promise<{ accountId: string; redirect: boolean } | null>;
  authInventory(): Promise<{ identityAccountIds: string[]; credentialAccountIds: string[] }>;
  signIn(subjectId: string, credential?: Credential): Promise<Login>;
  openSession(actingHuman: Session, subjectId: string): Promise<Login>;
  session(session: Session): Promise<{ subjectId: string; actingHumanId: string; authnEpoch: number }>;
  issueToken(session: Session): Promise<Token | 'denied'>;
  validateSession(session: Session): Promise<Outcome>;
  validateToken(token: Token): Promise<Outcome>;
  createOrganization(owner: Session, handle: string): Promise<string>;
  createAutomated(actingHuman: Session, operatorId: string, handle: string): Promise<string | 'denied'>;
  patchAccount(
    actingHuman: Session,
    id: string,
    patch: { id?: string; kind?: string; handle?: string },
  ): Promise<Outcome>;
  setOperator(actingHuman: Session, id: string, operatorId: string): Promise<Outcome>;
  /** The destination operator's manager accepts operating id; the source's next setOperator to operatorId uses it. */
  acceptOperator(actingHuman: Session, id: string, operatorId: string): Promise<Outcome>;
  setManagement(actingHuman: Session, operatorId: string, humanId: string, allowed: boolean): Promise<Outcome>;
  setMembership(
    owner: Session,
    organizationId: string,
    accountId: string,
    role: 'owner' | 'member' | null,
  ): Promise<Outcome>;
  members(organizationId: string): Promise<{ accountId: string; role: 'owner' | 'member' }[]>;
  setCredential(manager: Session, subjectId: string, credential: Credential, installed: boolean): Promise<Outcome>;
  startEmailRecovery(subjectId: string): Promise<RecoveryProof | 'denied'>;
  recover(subjectId: string, proof: RecoveryProof): Promise<Outcome>;
  /** Privileged fixture setup through real private settings/consent boundaries. */
  populatePrivateData(subjectId: string): Promise<{ secretValues: string[]; populated: boolean }>;
  profile(subjectId: string): Promise<PublicView>;
  attribution(subjectId: string): Promise<PublicView>;
  audit(
    subjectId: string,
  ): Promise<{ action: 'session-opened'; actingHumanId: string; subjectId: string; operatorId: string }[]>;
  /** Real fixture resource and direct grants; test resource has no ambient grants. */
  createResource(owner: Session): Promise<string>;
  grantResource(owner: Session, resourceId: string, accountId: string): Promise<Outcome>;
  useResource(session: Session, resourceId: string): Promise<Outcome>;
  deleteAccount(actingHuman: Session, subjectId: string): Promise<Outcome>;
  /** Privileged moderation boundary; must fence dependent automated actors too. */
  suspend(subjectId: string): Promise<Outcome>;
  /**
   * Invoke the real Access-first invalidation workflow. Hook runs immediately
   * before calling Auth, including before any revocation side effect. Receipt and
   * account reads inside it use an independent authoritative read/transaction.
   * failAuthRevocation injects an Auth outage, not a failure of the Access commit.
   * Hook exceptions propagate; they must never become a revocation-failed result.
   */
  revokeSessions(
    subjectId: string,
    controls: {
      beforeAuthRevocation: () => Promise<void>;
      failAuthRevocation?: boolean;
    },
  ): Promise<'revoked' | 'revocation-failed'>;
  fenceReceipt(subjectId: string): Promise<FenceReceipt | null>;
}
