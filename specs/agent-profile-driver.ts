/**
 * Test-only binding. AGENT_PROFILE_DRIVER is an absolute path or file URL exporting
 * createAgentProfileDriver(): Promise<AgentProfileDriver>. Each factory owns isolated
 * migrated fixtures, real Auth issuance, native Access and createKernel.handle.
 * request returns the ORIGINAL Response, without rewriting status, headers or JSON.
 * No fake authorization, profile model, synthetic page reads or direct profile SQL writes.
 * Failed setup cleans partial resources; close removes only this factory's resources.
 *
 * Build callers from services/kernel/test/support/personas.ts: alice, bob,
 * organization, software with operator, suspended, revoked, unscoped(action), anonymous.
 * That shared fixture is supplied by the implementation task; this specification
 * deliberately does not import a not-yet-present product binding.
 * Alice has ordinary self account:read/account:update authority and consent. Bob and
 * the software operator have no account:update grant on Alice or the software account.
 * revoked is a revoked Alice credential that previously passed this same PATCH;
 * software has ordinary self-update authority with its own independent credential.
 * Operator management alone is not a grant to perform the software actor's actions.
 * Open required exposure gates through ordinary grants, not a permissive Access stub.
 *
 * Install native Person, Organization and SoftwareApplication agent templates with
 * real public identity, accountPosts and accountCollections reads. Alice has exactly
 * one public post and collection, created/published through native HTTP commands.
 * Every account has populated private data: privateValues contains distinct nonempty
 * private string witnesses (including credentials/controller/contact data), never
 * public names/IDs or default booleans. No private fields may enter public responses.
 * Fixtures expose IDs and inputs, not precomputed expected HTTP answers.
 */
export const AGENT_PROFILE_MISSING_DRIVER = 'Agent profile outcome driver is required';

export type Credential = string; // A real bearer token, never an asserted actor.
export interface Account {
  accountId: string;
  handle: string;
  displayName: string;
  subjectId: string;
}
export interface Principal extends Account {
  credential: Credential;
}
export interface AgentProfileFixture {
  alice: Principal;
  bob: Principal;
  organization: Account;
  software: Principal & { operator: Principal };
  suspended: Principal;
  revoked: Principal;
  anonymous: null;
  privateValues: string[];
  publicPostId: string;
  publicCollectionId: string;
}
export interface ProfilePatch {
  displayName?: string | null;
  biography?: string | null;
  avatar?: string | null;
  links?: { label: string; url: string }[];
  publicViews?: Partial<Record<'posts' | 'reviews' | 'collections' | 'realms', boolean>>;
  speakersListed?: boolean;
}
export interface ProfileInspection {
  /** Persisted presentation (including immutable identity fields), verification and
   * preference state; stable ordering. Exclude volatile read/rate bookkeeping.
   */
  profile: unknown;
  verification: unknown;
  preferences: unknown;
  /** Actual committed profile-command receipts and account-updated outbox events.
   * Exclude setup, preference/verification commands, rate accounting and read logs.
   * Retain IDs and stored payloads so equality detects duplicate or altered effects.
   */
  receipts: { id: string; value: unknown }[];
  events: { id: string; data: unknown }[];
}
export interface AgentProfileDriver {
  fixture(): Promise<AgentProfileFixture>;
  /** Alice's real token with only the named consented scope removed; grants unchanged. */
  unscoped(action: 'account:update'): Promise<Credential>;
  request(credential: Credential | null, path: string, init?: RequestInit): Promise<Response>;
  /** Create a visible catalogue Person, submit Alice's requestVerification and have
   * governance approve through ordinary HTTP routes. Await native durable completion.
   * Return the original submission/approval responses, never fabricated receipts.
   */
  verifyPerson(person: Principal): Promise<{ subjectId: string; request: Response; approval: Response }>;
  /** Ordinary suspension command and its durable barriers, never raw lifecycle SQL. */
  suspend(account: Account): Promise<void>;
  /** Reserve and upload an actual avatar owned by uploader; completed also runs
   * upload completion and processing to availability. Incomplete remains reserved.
   */
  uploadAvatar(uploader: Principal, state: 'completed' | 'incomplete'): Promise<{ mediaId: string }>;
  /** Read authoritative native rows/receipts/outbox, never a driver-maintained counter. */
  inspect(account: Account): Promise<ProfileInspection>;
  close(): Promise<void>;
}
