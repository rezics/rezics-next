/** TEST ONLY. DURABLE_INITIATOR_DRIVER_MODULE is an absolute path/file URL exporting
 * createDurableInitiatorDriver(): Promise<DurableInitiatorDriver>.
 * Use actual Auth-issued credentials, native registration/consent/grant/delegation
 * commands, ordinary kernel Access composition, migrated PostgreSQL and real DBOS.
 * Initial positive operations MUST be authenticated native creates/commits, never
 * SQL-inserted tuples, synthetic receipts or fixture callbacks. Driver methods
 * transport actual operations/checkpoints and independently read observations;
 * no policy/approval Maps/Sets, evaluator, fake Access or substitute workflow.
 * Lossless field mapping is allowed; never repair wire results or infer writes.
 * Factory errors clean partial setup; close stops owned workers/pools/databases.
 * No stopped personal-consent or website-provider work is part of this binding.
 */
export type Anchor = Readonly<{ domain: string; route: number; id: string }>;
export type Tuple = Readonly<{
  actor: string;
  client: string;
  scopes: readonly string[];
  /** Exact native requested_by reference, not just a principal account ID. */
  delegator: string | null;
  authnEpoch: number;
  recordedFloor: string;
}>;
export type Fixture = {
  /** Test-process credentials only; none may appear in durable storage. */
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tuple: Tuple;
  principalId: string | null;
  threadId: string;
  authorId: string;
  key: string;
  /** Real native second action, granted/consented currently but outside tuple.scopes. */
  outsideAction: string;
};
export type SeedMode = 'delegated' | 'direct' | 'organization' | 'realm';
export type Point = {
  id: string;
  kind: 'step' | 'result' | 'cached-result';
  action: string;
  resource: { route: number; id: string };
  purpose: string;
};
export type OperationRow = {
  anchor: Anchor;
  kind: 'content.author_erasure';
  purpose: string;
  key: string;
  digest: string;
  tuple: Tuple;
  target: { threadId: string; authorId: string };
  transactionId: string;
  /** Actual committed native source identity, not an adapter-generated ID. */
  workflowId: string;
  source: { epoch: number; partition: number; position: string; eventIndex: number };
};
export type Snapshot = {
  operation: OperationRow | null;
  creationReceipt: null | {
    id: string;
    transactionId: string;
    key: string;
    digest: string;
    operation: Anchor;
  };
  /** Native writes that physically complete logical erasures already committed:
   * cleanup command receipts, their events and outbox rows, and the bodies/media
   * they change, stably ordered. Classify them by native receipt kind, never by
   * adapter policy. */
  cleanup: unknown[];
  /** Writes of protected points, each committed under the restored initiator at
   * its own authoritative T, excluding cleanup. Complete native writes, stably
   * ordered, including stored replies. Exclude DBOS scheduling/terminal-denial
   * bookkeeping, not domain effects. */
  protected: { receipts: unknown[]; effects: unknown[]; outbox: unknown[]; resources: unknown[] };
  /** Complete persisted operation, DBOS inputs/checkpoints/results, receipts/events.
   * No adapter redaction or hand-counted credential/authority summaries. */
  durableRecords: {
    source: 'operation' | 'dbos-input' | 'dbos-checkpoint' | 'dbos-result' | 'receipt' | 'event';
    value: unknown;
  }[];
};
export type Denied = { outcome: 'denied' };
export type Result = Denied | { outcome: 'permitted'; value: unknown; receiptId?: string; replayed: boolean };
export type ReadStage = 'operation' | 'provenance' | 'account' | 'consent' | 'delegation' | 'membership' | 'resource';
export type ReadEvent =
  // connection identifies one checkout lease, even if the physical client is reused.
  | { kind: 'acquire' | 'release'; connection: string }
  | { kind: 'read'; connection: string; stage: ReadStage; anchor: string; partitions: number[] };
export type Attempt = {
  result: Result;
  /** Actual executor/read AuthoritativeTime object and its value, never caller T. */
  time: object;
  at: string;
  checks: { action: string; resource: { route: number; id: string }; at: string; time: object; allowed: boolean }[];
  reads: ReadEvent[];
};
/** Each mutation changes ONLY the named authoritative fact; preserve all others.
 * Native commands are required where available. Explicit missing/corrupt/stale
 * evidence fixtures may use isolated DB fault injection, never as positive proof.
 * Return the actual committed transition time. No reissued/re-signed JWTs. */
export type Mutation =
  | 'actor-grant'
  | 'principal-grant'
  | 'client-missing'
  | 'consent-missing'
  | 'consent-revoked'
  | 'consent-reduced'
  | 'delegation-missing'
  | 'delegation-changed-actor'
  | 'delegation-changed-principal'
  | 'delegation-revoked'
  | 'suspended'
  | 'tombstoned'
  | 'fenced'
  | 'account-missing'
  | 'epoch-floor-increased'
  | 'organization-membership'
  | 'realm-membership'
  /** The Realm owner bans the initiating account with the native Realm ban command. */
  | 'realm-block';
/** Invoke the real production restore/command boundary with these adverse inputs
 * or isolated storage faults. No precomputed denied branch in the adapter.
 * Mutation attacks must attempt the native immutable write first; if rejected,
 * still try the changed restore input. Faults requiring absent/corrupt storage use
 * an isolated clone/transaction; leave the genuine original row/receipt intact.
 * protected inspection includes every fixture/sentinel partition, including clones.
 * Copied rows/receipts are negative only. Stale attacks start with actual native
 * authenticated evidence made stale before creation, never a positive forged row. */
export type Attack =
  | 'actor'
  | 'client'
  | 'delegator'
  | 'scopes'
  | 'oversized-anchor'
  | 'oversized-tuple'
  | 'oversized-key'
  | 'epoch'
  | 'recorded-floor'
  | 'operation-id'
  | 'operation-key'
  | 'operation-digest'
  | 'operation-kind'
  | 'partition'
  | 'domain'
  | 'thread'
  | 'author'
  | 'purpose'
  | 'resource'
  | 'action'
  | 'copied-row'
  | 'missing-row'
  | 'missing-receipt'
  | 'uncommitted-receipt'
  | 'rolled-back-create'
  | 'other-operation-receipt'
  | 'changed-transaction'
  | 'missing-source'
  | 'changed-source'
  | 'fixture-callback'
  | 'other-access'
  | 'other-pool'
  | 'originally-stale-tuple'
  | 'refresh-stale-floor'
  | 'serialized-actor'
  | 'bearer-context'
  | 'resigned-jwt'
  | 'caller-time'
  | 'reuse-step-proof';
export interface DurableInitiatorDriver {
  close(): Promise<void>;
  /** Delegated fixture has all three operands independently satisfied; direct has
   * no delegation. Org/Realm rights come solely from real matched membership.
   * Use enough real erasure targets for >=2 protected native batches. Also retain
   * an unrelated public post in that thread: no private read grant or read scope
   * for the initiator; native domain eligibility supplies its public read floor. */
  seed(mode?: SeedMode): Promise<Fixture>;
  /** Authenticate accessToken and run actual begin/commit. No actor JSON input.
   * Park the actual native worker before its first protected step. */
  create(fixture: Fixture): Promise<Denied | { outcome: 'committed'; operation: Anchor }>;
  inspect(operation: Anchor): Promise<Snapshot>;
  /** Actual native checkpoints registered so far, in workflow order: reached
   * protected batches, then live and cached result disclosures. A protected batch
   * appears once the workflow has read its page. No manufactured checkpoints or
   * alternate scheduler. */
  points(operation: Anchor): Promise<Point[]>;
  /** Advance earlier steps under unchanged authority, then park immediately BEFORE
   * this protected boundary; cached-result first materializes the native result. */
  park(operation: Anchor, pointId: string): Promise<void>;
  /** Run exactly this point, then let the worker run its unprotected steps and
   * stop before the next protected boundary, which it has then registered.
   * Only exact operation locator and native checkpoint ID enter the worker. It
   * obtains server T itself and re-reads committed identity. No Fixture/caller
   * Actor/token/time/approval is passed here, including via DBOS context. */
  advance(operation: Anchor, pointId: string): Promise<Attempt>;
  mutate(fixture: Fixture, mutation: Mutation): Promise<string>;
  /** Supply current rights natively after creation without changing recorded tuple. */
  grant(fixture: Fixture, mode: 'restore-actor' | 'add-outside-action'): Promise<void>;
  attack(operation: Anchor, pointId: string, attack: Attack, input?: unknown): Promise<Attempt>;
  /** Destroy/recreate Access, pools, worker process and native DBOS host, keeping
   * only committed databases and barrier identifiers. No memory proof survives. */
  restart(): Promise<void>;
  /** Deterministic trusted clock seam shared by Auth/Access/native executor; advance
   * past actual original JWT exp AND 300 seconds after creation. No re-signing,
   * token renewal, expiry-row rewriting or sleeping to synthesize observations. */
  passOriginalExpiry(fixture: Fixture): Promise<void>;
  /** Observe the existing native public-read formula on the thread's public post,
   * once anonymously and once with operation-restored identity at server read T.
   * Use the registered native read anchor/eligibility, not a new erasure step,
   * endpoint, policy callback or continuation exception. This is an internal
   * Access conformance read through the SAME resource authorization flow. */
  readPublic(operation: Anchor): Promise<{ point: Point; anonymous: Attempt; restored: Attempt }>;
  /** Independently read real current account/client/assignment state and grants.
   * Used to prove the changed axis and unchanged operands, not evaluate policy. */
  authority(fixture: Fixture): Promise<{
    state: string;
    fenced: boolean;
    floor: string;
    clientExists: boolean;
    consentScopes: string[] | null;
    delegation: unknown;
    actorGrants: unknown[];
    principalGrants: unknown[];
    memberships: unknown[];
    blocks: unknown[];
  }>;
}
