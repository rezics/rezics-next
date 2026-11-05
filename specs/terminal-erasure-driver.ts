import type { Persona as Credential } from '../services/kernel/test/support/personas.ts';

/**
 * TERMINAL_ERASURE_DRIVER is an absolute path/file URL exporting
 * createTerminalErasureDriver(): Promise<TerminalErasureDriver>.
 * Each factory owns isolated migrated databases, real Auth/Access and native
 * DBOS workers. Build alice and bob with createPersonas, PERSONAS_VERSION 1;
 * preserve their original signed bearers throughout, including after deletion.
 * Factory failure and close clean only resources owned by this factory.
 *
 * Actions use real HTTP handlers and production commands/workers. No policy
 * evaluator, fake Access, response filtering, substitute scheduler, synthetic
 * tombstones, computed outcomes or fixture writes performing erasure effects.
 * Reply.response is the complete original Response; value only losslessly maps
 * JSON field names read through clone(). Never repair or omit wire fields.
 * Missing production surfaces remain failures, never successful empty results.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Values = { [key: string]: Json };
export type Persona = 'anonymous' | 'alice' | 'bob';
export interface Reply<T> {
  response: Response;
  value?: T;
}
/** Routed native HTTP request; no expected result or authorization decision. */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Json;
  /** May carry real provider signatures/idempotency keys, never identity overrides. */
  headers?: Record<string, string>;
}
export type Kind =
  | 'profile'
  | 'entry'
  | 'label'
  | 'readingSession'
  | 'log'
  | 'follow'
  | 'followCount'
  | 'privateCollection'
  | 'unlistedCollection'
  | 'offer'
  | 'order'
  | 'entitlement'
  | 'preparedExport'
  | 'zoneSource';
export type Role =
  | 'author'
  | 'editor'
  | 'uploader'
  | 'reporter'
  | 'buyer'
  | 'seller'
  | 'delegate'
  | 'operator'
  | 'member'
  | 'actingHuman';
export interface Target {
  id: string;
  marker: string;
  point: HttpRequest;
  /** All applicable listing/search/count/export/media/Zone routes and old cursors. */
  surfaces: HttpRequest[];
}
export interface Fixture {
  alice: Credential & { handle: string };
  bob: Credential & { handle: string };
  records: Record<Kind, Target>;
  barrierReads: Record<'private' | 'unlisted' | 'export' | 'count' | 'media', HttpRequest>;
  writes: Record<'entry' | 'export' | 'media' | 'producer', HttpRequest>;
  /** Independent private payload for EACH role, not ten aliases of an authored row.
   * Historical operator/member responsibilities are already resolved through real
   * transfer/leave commands, so they do not block confirmation. */
  roles: Record<Role, { marker: string; reader: 'alice' | 'bob'; read: HttpRequest }>;
  history: Record<'private' | 'unlisted' | 'deleted', { marker: string; read: HttpRequest }>;
  publishedLog: Target;
  publicPost: { read: HttpRequest; id: string; body: string; archivedMarker: string };
  publicCollection: {
    read: HttpRequest;
    id: string;
    generation: string;
    subjectIds: string[];
    pendingOnlyId: string;
    privateSourceMarker: string;
  };
  financial: {
    ordinaryReads: HttpRequest[];
    /** Exact required payload and deadline from the real pre-existing legal
     * retention obligation, NOT an adapter-selected erasure allowlist or TTL. */
    requiredSubset: Values;
    expiresAt: string;
    seededAt: string;
  };
  /** Queued before erasure, parked before its actual effect transaction. */
  pending: { start: HttpRequest; read: HttpRequest; marker: string };
  restore: HttpRequest;
  /** Previously successful real import request, with its original replay identity. */
  importReplay: HttpRequest;
  /** Valid signed provider callback for the seeded order, not a forged callback. */
  lateWebhook: HttpRequest;
  register: HttpRequest;
  handleLookup: HttpRequest;
  bobReply: HttpRequest;
  bobFollow: HttpRequest;
  /** Bob's follow is a Bob-owned record: its erased target becomes attribution
   * without an account link. It cannot contribute to any Alice follow count.
   * Unrelated Bob entry, label, Collection and entitlement positive controls. */
  bobSentinels: HttpRequest[];
}
export interface PublishedPost {
  id: string;
  body: string;
  attribution: Values;
}
export interface PublishedCollection {
  id: string;
  generation: string;
  subjectIds: string[];
  attribution: Values;
}
export interface BobReply {
  id: string;
  body: string;
  authorId: string;
  parent: { postId: string; attribution: Values };
}
export interface BobFollow {
  id: string;
  ownerId: string;
  target: Values;
}
export type Store = 'sources' | 'receipts' | 'outbox' | 'provenance' | 'search' | 'imports' | 'revisions' | 'effects';
export interface Inspection {
  /** Complete persisted rows/payloads, including archived, deleted, delivered and
   * failed records. Stable order, independent read-only native connections, exact
   * fixture locators; never reconstruct results from requests or drop fields.
   * sources covers the entire original private source graph for every kind and
   * role, including media backing objects. effects selects the pending producer's
   * product effects, not erasure bookkeeping. */
  rows: Json[];
}
export interface TerminalErasureDriver {
  close(): Promise<void>;
  /** Provision all listed kinds/roles via native commands, with distinct private
   * markers copied into every named store. Include archived private/unlisted/
   * already-deleted versions, an older public-post revision, a published log,
   * public dynamic generation A fully published and B parked before publication
   * with a private-only member, one retained financial order, Bob's reply and
   * follow of Alice, and unrelated Bob sentinels. Drain completed projections
   * before returning; B remains held until finish. register creates a distinct
   * new human/handle through ordinary registration, without choosing its ID.
   * Bob has genuine authority to replay the previously successful import. */
  seed(): Promise<Fixture>;
  /** Always authenticates the selected persona using its ORIGINAL issued bearer;
   * anonymous has no Authorization header. Transport complete native responses. */
  request<T = Json>(actor: Persona, request: HttpRequest): Promise<Reply<T>>;
  /** Real fresh authentication; proof is an opaque native handle, not fabricated evidence. */
  freshAuthentication(actor: 'alice'): Promise<Reply<{ proof: string }>>;
  /** Actual account deletion HTTP request; omitted proof/wrong typed text must
   * reach the real workflow. This port never implements the confirmation policy. */
  erase(actor: Persona, input: { freshProof?: string; confirmation: string }, key: string): Promise<Reply<Json>>;
  /** Production barriers hold erasure and producers BEFORE effect guards; no
   * worker runs between confirmation and explicit finish. No domain-row edits. */
  barrier(mode: 'hold'): Promise<void>;
  /** Release barriers; await durable completion of erasure, import, webhook,
   * media/export producers, search and outbox, including stale queued attempts. */
  finish(): Promise<void>;
  inspect(fixture: Fixture, store: Store): Promise<Inspection>;
  /** Raw retained financial payload plus actual retention/access metadata. */
  financial(fixture: Fixture): Promise<{ payload: Values; expiresAt: string; access: string }[]>;
  /** Instrument the production clock and due scheduler, never rewrite retention rows. */
  setTime(instant: string): Promise<void>;
}
