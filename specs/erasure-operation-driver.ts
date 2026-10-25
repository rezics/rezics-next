/**
 * Test-only real-driver port. ERASURE_OPERATION_DRIVER is an absolute file path
 * or file URL exporting createErasureOperationDriver(): Promise<ErasureOperationDriver>.
 * Each factory provisions an isolated, migrated PostgreSQL namespace and real
 * native DBOS workflow runtime. Factory failures clean partial setup; close()
 * stops workers and removes namespace fixtures, receipts and native workflow state.
 *
 * All actions go through actual createKernel.handle HTTP, Auth-issued signed JWTs,
 * real Access evidence and production command/idempotency/LRO code. Anonymous has
 * no bearer. Never implement a model, fake Access, observer product simulation,
 * alternate scheduler, cached response, synthetic progress or fixture writes that
 * perform an action's effects. Only provisioning and explicit authority mutations
 * may write fixture data. Inspection uses independent read-only DB connections.
 * Reply.response is the complete original HTTP Response. value is only a lossless
 * field-name mapping of JSON read through clone(), including AIP metadata/result
 * fields; errors have no value. Do not repair an invalid wire operation in mapping.
 */
export type Persona = 'anonymous' | 'author' | 'legal' | 'unrelated' | 'suspended' | 'revoked';
export interface Reply<T> { response: Response; value?: T }
export interface Operation {
  name: string;
  done: boolean;
  metadata: { total: number; processed: number; steps: number };
  response?: { erasedPosts: number };
  /** Actual AIP/google.rpc.Status; PERMISSION_DENIED is code 7. */
  error?: { code: number; message: string; details?: unknown[] };
}
export interface Revision {
  id: string;
  digest: string;
  body: string | null;
  availability: 'available' | 'erased';
}
export interface Fixture {
  thread: string;
  partition: number;
  authorId: string;
  /** Unique searchable prefix present in every targeted revision, no unrelated body. */
  marker: string;
  targeted: { id: string; revisions: { id: string; digest: string; body: string }[] }[];
}
export interface Inspection {
  /** All content rows in the fixture, including other-author/other-partition sentinels. */
  posts: { id: string; erased: boolean; visibility: string }[];
  revisions: { id: string; postId: string; body: string | null; erased: boolean; digest: string }[];
  operations: { name: string }[];
  effects: { id: string; postId: string }[];
  /** Complete persisted raw payloads, including delivered events and prior receipts. */
  receipts: unknown[];
  outbox: unknown[];
}
export interface Trace {
  /** Product domain commands after seed; include initiation, steps and point commands. */
  commands: { writePartitions: number[]; threadScanRows: number }[];
  /**
   * Actual native logical batches, including a batch stopped by authorization.
   * Exclude physical purge pages; include no reconstructed fixture observations.
   * postIds are attempted targets; checks come from real anchored Access calls.
   * at is the authoritative batch transaction time T, not adapter wall time.
   */
  steps: {
    postIds: string[];
    at: string;
    checks: { postId: string; action: string; partition: number; at: string; allowed: boolean }[];
  }[];
}
export interface GrowthResult {
  measurement: 'initiation' | 'status' | 'native-step';
  scales: number[];
  seedCalls: number;
  rows: 'constant';
  statements: 'constant';
  buffers: 'logarithmic';
  passed: boolean;
  /** Actual harness measurements, not estimates, EXPLAIN costs or adapter counters. */
  samples: { scale: number; rows: number; statements: number; buffers: number }[];
}
export interface ErasureOperationDriver {
  close(): Promise<void>;
  /**
   * Create exactly posts targeted posts with revisions distinct histories each,
   * through production publish/edit commands, all in one thread partition. Also
   * create unrelated-author history in that thread and another-partition sentinel.
   * Keep the thread's first post unrelated so targeted contains the entire selection.
   * Drain real search projection before returning; reset command instrumentation.
   * Author has only own-erasure rights. Legal has explicit legal post:erase and
   * moderation:takedown grants/scopes/consent, no authorship. Unrelated has only
   * account:read on itself. Suspended has matching grants but is currently suspended;
   * revoked has real previously issued credentials with currently revoked grants.
   * Author/legal have the full own-account status formula (actor grant, consented
   * scope, principal grant where applicable). Preserve authorized exact-history
   * reads for author after erasure; erasure authority changes do not revoke reads.
   */
  seed(input: { posts: number; revisions: number }): Promise<Fixture>;
  /** POST threads/{id}:erase; authorId is untrusted JSON selection, key is the
   * actual Idempotency-Key. Replay sends the same serialized request and credentials.
   * Preserve the stored original 202 on replay even after native completion. */
  erase(actor: Persona, threadId: string, authorId: string, key: string): Promise<Reply<Operation>>;
  /** GET operations/{id}; own-account formula AND exact authenticated initiator.
   * Evaluate current suspension/revocation before disclosing status or a receipt. */
  status(actor: Persona, name: string): Promise<Reply<Operation>>;
  /** Valid correctly routed operation name with no corresponding durable operation. */
  unknownOperation(): string;
  readRevision(actor: Persona, postId: string, revisionId: string): Promise<Reply<Revision>>;
  edit(actor: Persona, postId: string, body: string, key: string): Promise<Reply<unknown>>;
  erasePost(actor: Persona, postId: string, key: string): Promise<Reply<unknown>>;
  takedown(actor: Persona, postId: string, key: string): Promise<Reply<unknown>>;
  /**
   * Deterministic production test barriers in ACTUAL native DBOS execution: hold
   * before the first logical batch and before physical revision-page purge. step
   * releases exactly one logical batch, waits for its committed native boundary,
   * then parks before the next batch; purge remains paused. Return committed post
   * IDs from persisted native evidence. No timers/sleeps to manufacture progress.
   * These controls never change workflow outputs, policy or domain data.
   */
  barrier(mode: 'hold'): Promise<void>;
  step(name: string): Promise<string[]>;
  /** Release barriers; await terminal native execution AND all physical purge pages
   * for logically erased posts, even if a later logical batch terminates in denial.
   * Drain actual search/outbox workers to their durable completion boundaries. */
  finish(name: string): Promise<void>;
  /** Stop and recreate the real native worker/runtime against the SAME durable DBOS
   * and application databases. Preserve held barriers and original workflow identity.
   * No new initiation, fixture-driven continuation or in-memory scheduler. */
  restart(): Promise<void>;
  /** Mutate ONLY this actual authority axis, preserving other grants and credentials.
   * post:erase affects every selected post, including future steps; allow restores
   * the revoked grant. suspension revoke suspends; allow reactivates. Account axes
   * independently remove actor grant, consented scope or applicable principal grant.
   * Await authoritative commit before returning; do not issue replacement JWTs. */
  authority(actor: Persona, axis: 'account:read' | 'account:read-scope' | 'account:read-principal' | 'post:erase' | 'suspension', mode: 'allow' | 'revoke'): Promise<void>;
  /** Last authority mutation's committed authoritative timestamp, comparable to T. */
  authorityTime(): Promise<string>;
  /** Stable row ordering; never infer erasure/purge/effects from command arguments. */
  inspect(fixture: Fixture): Promise<Inspection>;
  trace(): Promise<Trace>;
  /** Real search endpoint result IDs, without adapter filtering. */
  search(query: string): Promise<string[]>;
  /**
   * MUST invoke the shared checkGrowth harness through the REAL API/worker paths.
   * One seed(scale) per scale using the same seed, reused across all measurements;
   * seedCalls reports those three actual calls. Grow unrelated same-partition
   * catalogue/content/revision rows at 32/256/2048; fix the target neighbourhood,
   * history pages and one <=100-post changed batch. Vary bounded changed rows
   * separately, never conflate their work with unrelated-data growth.
   * Measure fixed initiation, status and exactly one native bounded step, including
   * their real SQL and worker work. The shared harness must assert rows/statements
   * constant and native buffers logarithmic, and propagate any failure by throwing.
   * Return its actual samples and classifications. No alternate evaluator, fake
   * counts, disabled planner, observer simulation or wall-clock thresholds. This
   * port freezes future binding obligations; it is not itself a growth harness.
   */
  checkGrowth(input: { seed: number; scales: [32, 256, 2048]; measurements: ['initiation', 'status', 'native-step'] }): Promise<GrowthResult[]>;
}
