/**
 * Test-only binding: CONTENT_DISCLOSURE_DRIVER is an absolute path or file URL
 * exporting createContentDisclosureDriver(): Promise<ContentDisclosureDriver>.
 * Each factory creates an isolated namespace in migrated PostgreSQL. close()
 * removes fixtures, grants, receipts, reports and queued effects after failure;
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
  hash: string;
  body: string | null;
  availability: 'available' | 'erased';
}
export interface Content extends Target {
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
  board(): Promise<Content>;
  publish(input: {
    board: Content;
    thread?: Content;
    parent?: Content;
    author?: 'author' | 'unrelated';
    body: string;
    /** Equal instants exercise the immutable ID tie-break. */
    createdAt?: string;
    missingSemanticSubject?: boolean;
  }): Promise<Content>;
  edit(target: Content, body: string): Promise<Revision>;
  /** Privileged fixture visibility command, not a substitute disclosure rule. */
  protect(target: Target): Promise<void>;
  /** Actual read and exact-history grants, including authorized erased tombstones. */
  grantRead(persona: Persona, target: Target): Promise<void>;
  setModeration(persona: 'moderator', target: Target, mode: 'allow' | 'deny' | 'revoke'): Promise<void>;
  /** Fail the actual authoritative container/evidence read, not the evaluator. */
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
  report(
    persona: Persona,
    input: {
      target: Target;
      revisionId?: string;
      evidence?: string;
      key: string;
      botToken?: string;
      verified?: boolean;
    },
  ): Promise<Reply<{ reportId: string }>>;
  /** Token traverses the trusted Turnstile test verification port, not a boolean bypass. */
  verifiedBotToken(): Promise<string>;
  inspectReports(persona: Persona, target: Target): Promise<Reply<Report[]>>;
  observe(target: Target): Promise<Observation>;
  /** Real search/projection API; drain is an explicit bounded worker barrier. */
  search(persona: Persona, query: string): Promise<Reply<Page>>;
}
