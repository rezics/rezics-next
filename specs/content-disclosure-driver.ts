/**
 * Test-only binding: CONTENT_DISCLOSURE_DRIVER is an absolute path or file URL
 * exporting createContentDisclosureDriver(): Promise<ContentDisclosureDriver>.
 * Each factory creates an isolated namespace in migrated PostgreSQL. close()
 * removes fixtures, grants, receipts, reports, queued effects and recorded wire
 * requests after failure;
 * factory failure cleans its own partial setup. Unexpected adapter errors throw.
 *
 * Every API operation below uses actual createKernel(...).handle with real
 * Access and Auth-issued JWTs for author, unrelated author, moderator and
 * suspended account. Anonymous requests carry no credentials. Provision may
 * install accounts/grants and control clocks, evidence reads and projection lag
 * at test-only boundaries; it must never evaluate visibility, forge verified
 * claims, seed responses or replace product commands with direct SQL writes.
 * Content creation/editing and control commands use real product boundaries.
 *
 * Board candidates live in the board partition; authoritative thread/post rows
 * live in the thread partition (fixtures must use distinct partitions). Outbox
 * delivery is asynchronous, idempotent and replayable, without cross-partition
 * SQL joins. Projection controls affect delivery only, never final disclosure.
 * Related semantic IDs in fixtures deliberately have no corresponding subjects.
 *
 * Replies retain the complete unmodified HTTP Response. value maps only field
 * names/IDs from that response to the types below; it cannot filter, synthesize
 * results or suppress errors. Observation is narrowly scoped, read-only SQL over
 * this namespace's authoritative revision, command-log/outbox and report rows.
 * It must not infer persisted evidence from command inputs or API responses.
 */
export type Persona = 'anonymous' | 'author' | 'unrelated' | 'moderator' | 'suspended';
export type Target = { kind: 'board' | 'thread' | 'post'; id: string };
export interface Revision {
  id: string;
  hash: string | null;
  body: string | null;
  availability: 'available' | 'erased';
}
export interface Board extends Target {
  kind: 'board';
  partition: number;
}
export interface Content extends Target {
  kind: 'thread' | 'post';
  partition: number;
  revision: Revision;
}
export interface Item {
  id: string;
  revision: Revision;
}
export interface Page {
  items: Item[];
  next: string | null;
}
export interface Reply<T> {
  response: Response;
  value?: T;
}
export interface Effect {
  id: string;
  kind: 'takedown' | 'erasure' | 'report';
  partition: number;
  transactionId: string;
}
export interface Report {
  id: string;
  anchorId: string;
  partition: number;
  target: Target;
  revisionId: string | null;
  evidence: string | null;
  transactionId: string;
}
export interface Observation {
  visibility: 'public' | 'protected' | 'taken_down';
  securityRevision: string;
  /** Transaction that last changed visibility/securityRevision. */
  transactionId: string;
  revisions: Revision[];
  effects: Effect[];
  reports: Report[];
}
export interface ContentDisclosureDriver {
  close(): Promise<void>;
  /**
   * Provision moderation:takedown for moderator in the target partition, including
   * matching JWT scopes/client consent. Suspended has the same grants/scopes but
   * authoritative suspended account state. Author/unrelated lack moderation.
   */
  board(): Promise<Board>;
  publish(input: {
    board: Board;
    thread?: Content;
    parent?: Content;
    author?: 'author' | 'unrelated';
    body: string;
    /** Select the actual production Idempotency-Key header. */
    key?: string;
    /** Equal instants exercise the immutable ID tie-break. */
    createdAt?: string;
    missingSemanticSubject?: boolean;
  }): Promise<Content>;
  /** Optional key selects the actual production Idempotency-Key header. */
  edit(target: Content, body: string, key?: string): Promise<Revision>;
  /**
   * Reissue the EXACT recorded serialized publish/edit HTTP request: method,
   * URL, headers (including Idempotency-Key) and body, with the same still-valid
   * account credentials through createKernel.handle. Record wire requests only;
   * never regenerate document IDs, model a command result or cache a response.
   * Map only the real response. Keep parent creation and owner read/edit grants
   * valid for these scenarios; authorization and final disclosure are product work.
   * runCommand receipts retain stable resource/revision IDs and non-authored
   * metadata only, never document bytes, search text or authored title. HTTP
   * hydrates exact storage and final-discloses on both fresh commands and replay.
   */
  replayCommand(key: string): Promise<Reply<Item>>;
  /**
   * Read actual persisted receipt response payloads and outbox event payloads
   * for content commands in this target thread's scope, including delivered
   * events. Arrays use stable row order and contain complete raw JSON payloads,
   * with no redaction or reconstruction from adapter inputs/responses. Read-only
   * DB observation; no policy emulation. close() removes these rows and recorded
   * requests.
   */
  inspectCommandCopies(target: Target): Promise<{ receipts: unknown[]; events: unknown[] }>;
  /** Privileged fixture visibility command; changes domain visibility only, never roles/grants. */
  protect(target: Target): Promise<void>;
  /**
   * Remove the creator's actual read-authorizing roles/grants on this target via
   * real Access rows/commands, never adapter policy. Creation installs type owner
   * and standing roles from catalogue data; their read authority is explicit.
   * May revoke an indivisible owner role in full; this scenario has no later edit.
   * Preserve identity, account state, scopes and all other resources. Install no
   * overriding denial: a subsequent grantRead must still authorize protected read.
   */
  revokeCreatorReadAuthority(target: Target): Promise<void>;
  /** Actual read and exact-history grants, including authorized erased tombstones. */
  grantRead(persona: Persona, target: Target): Promise<void>;
  setModeration(persona: 'moderator', target: Target, mode: 'allow' | 'deny' | 'revoke'): Promise<void>;
  /**
   * Fail the actual authoritative container/evidence read, not the evaluator.
   * Preserve catalogue anonymous flags so missing trusted public eligibility
   * cannot be concealed by changing the catalogue's anonymous allowance.
   */
  failContainer(target: Target, failure: 'missing' | 'unavailable'): Promise<void>;
  /** drain resumes delivery to a bounded barrier; replay redelivers prior effects. */
  projection(mode: 'pause' | 'drain' | 'replay'): Promise<void>;
  /** Advance the real cursor verification clock by >15 min, keeping JWTs valid. */
  expireCursors(): Promise<void>;
  /**
   * Stateless signed keyset: newest orders (createdAt, immutable ID) descending;
   * oldest reverses both. Default query is empty and sort is newest. Bind board,
   * query/sort and verified viewer; advance by scanned candidate even if hidden.
   * Invalid, tampered, expired or mismatched cursor: RFC 9457 invalid_request
   * (400), effect_status not_applicable, no result fields or content bytes.
   */
  list(
    persona: Persona,
    board: Target,
    input: {
      limit: number;
      cursor?: string;
      sort?: 'newest' | 'oldest';
      query?: string;
    },
  ): Promise<Reply<Page>>;
  read(persona: Persona, target: Target, revisionId?: string): Promise<Reply<Item>>;
  /** A syntactically valid, correctly routed ID with no persisted resource. */
  missing(kind: Target['kind']): Target;
  takedown(
    persona: Persona,
    target: Target,
    key: string,
    untrusted?: {
      actor?: 'moderator';
      action?: 'moderation:takedown';
    },
  ): Promise<Reply<{ securityRevision: string }>>;
  /** Erase every revision authored by this account in this thread's scope. */
  erase(persona: Persona, thread: Target, author: 'author', key: string): Promise<Reply<unknown>>;
  /**
   * Use actual kernel HTTP/Auth/Access/shared receipts and trusted verification.
   * Receipt identity includes principal_kind (account | anonymous) and
   * principal_id; anonymous uses 00000000-0000-0000-0000-000000000000 as a kind
   * marker, never an account.
   * Do not provision a dummy account or an alternate content receipt engine.
   * Anonymous keys are client-generated UUIDv4 (122-bit possession proof).
   * Missing, malformed or non-v4 keys return invalid_request (400), with no
   * anchored report or effect, even when trusted bot verification succeeds.
   * Turnstile and rate limits stay in front; the anonymous floor must authorize
   * at authoritative T before receipt lookup or stored response disclosure.
   * Missing trusted public eligibility never falls back to a catalogue flag.
   * Replay requires the same semantic digest of target/revision/evidence;
   * changed payload returns idempotency_conflict (422), without stored response.
   * Ephemeral Turnstile proof, like bearer proof, is authentication evidence and
   * excluded from that digest. Successful submissions, replays and digest
   * conflicts each require a fresh valid bot proof; invalid-proof tests must
   * still traverse and fail the real verification boundary.
   */
  report(
    persona: Persona,
    input: {
      target: Target;
      revisionId?: string;
      evidence?: string;
      /** Optional only to test a missing header: omit it on HTTP, never invent a default. */
      key?: string;
      botToken?: string;
      verified?: boolean;
    },
  ): Promise<Reply<{ reportId: string }>>;
  /** Fresh token traverses the trusted Turnstile test verification port, not a boolean bypass. */
  verifiedBotToken(): Promise<string>;
  inspectReports(persona: Persona, target: Target): Promise<Reply<Report[]>>;
  observe(target: Target): Promise<Observation>;
}
