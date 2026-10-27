/**
 * LIBRARY_DELETION_DRIVER: absolute path/file URL exporting
 * createLibraryDeletionDriver(): Promise<LibraryDeletionDriver>.
 *
 * Each factory owns an isolated migrated PostgreSQL database, real signed Auth
 * credentials/Access grants and native DBOS runtime. All mutations use actual
 * createKernel.handle routes or the corresponding production command when no
 * route exists. Restore/purge ports require real production implementations;
 * this interface does not supply a deletion engine or an alternate policy model.
 * No fake positive Access, Map-backed runtime, adapter-side filtering, synthetic
 * counts/checkpoints or fixture writes implementing deletion/restore/purge.
 * Provision through supported entry/copy/member/Collection/label/log commands;
 * session/unit/history fixtures use start/record/complete/abandon, never invented
 * audit-row delete APIs. Factory failure and close clean only owned resources.
 *
 * Reply.response is the original HTTP Response (native command errors are mapped
 * losslessly to the same product status). value maps field names only, never
 * repairs wire errors or derives policy. Inspection uses independent read-only
 * native connections, includes deleted rows, and reads persisted checkpoints,
 * receipt identities and evidence locators. Clock/barriers instrument production
 * clocks/transactions/workers, never implement effects. The due scheduler runs
 * automatically when time advances; drain only waits for native durable work.
 */
import type { ListingObservation } from '../services/kernel/src/library/listing-freshness-contract.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Values = { [key: string]: Json };
export type Kind = 'entry' | 'copy' | 'member' | 'collection' | 'label' | 'assignment' | 'log';
export type Persona = 'owner' | 'other' | 'anonymous' | 'suspended' | 'platform';
export type Surface =
  | 'point'
  | 'entries'
  | 'state'
  | 'everything'
  | 'continue'
  | 'search'
  | 'item-list'
  | 'sitemap'
  | 'public-pairs'
  | 'feed';
export interface Reply<T> {
  response: Response;
  value?: T;
}
export interface Target {
  kind: Kind;
  id: string;
  ownerId: string;
  subjectId: string;
  collectionId: string | null;
  /** Stable source incarnation distinguishes replacement of an owner/subject slot. */
  incarnation: string;
  revision: number;
  generation: number;
  deletedAt: string | null;
  restoreUntil: string | null;
  values: Values;
  profilePin: Json;
}
export interface Fixture {
  target: Target;
  /** Unique payload string written by the native create command, never in a safe skeleton. */
  marker: string;
  /** Ordinary live surface with an unambiguous target identity before deletion. */
  primary: Surface;
  sentinelId: string;
  /** Public fixtures contain a second page, an unrelated public sentinel, and no
   * other fact supporting this target on its primary personal surface. */
}
export interface Page {
  /** Actual endpoint records; id is lossless stable identity mapping, not test-side selection. */
  items: ({ id: string } & Values)[];
  next: string | null;
}
export interface Inspection {
  target: Target | null;
  /** Full native target graph, including private payload and retained structural rows. */
  rows: { relation: string; id: string; payload: Values }[];
  receipts: { action: string; key: string; transactionId: string }[];
  /** Full payloads reached through exact receipt/outbox/workflow locators for this target. */
  evidence: Json[];
  checkpoints: { generation: number; phase: string; sequence: number; after: string | null }[];
  publicCollectionCount: number;
  pairs: { collectionId: string; multiplicity: number }[];
}
export interface PageTrace {
  transactionId: string;
  generation: number;
  phase: string;
  sequence: number;
  sourceLimit: number;
  /** Actual selected source keys, including held/rejected rows and any lookahead. */
  examinedKeys: string[];
  after: string | null;
  rowsExamined: number;
  sharedBlocks: number;
  statements: number;
  effects: number;
  bytes: number;
  /** Native transaction guard observations, not a driver's authorization decision. */
  guard: { generation: number; time: string; dueAt: string; held: boolean; earlyGrant: boolean };
  /** Source SQL and EXPLAIN ANALYZE JSON, including filters/loops/buffers. */
  sourceSql: string;
  plan: Json;
  index: string;
  selection: 'source-page-before-filter' | 'partial-due-pending-index';
  /** For a partial index include its actual pg_indexes definition. */
  indexDefinition: string;
}
export interface LibraryDeletionDriver {
  close(): Promise<void>;
  seed(
    kind: Kind,
    options?: {
      visibility?: 'private' | 'unlisted' | 'public';
      historyRows?: number;
      duplicateSibling?: boolean;
    },
  ): Promise<Fixture>;
  /** Current kernel clock, shared by command, Access and due worker. */
  now(): Promise<string>;
  setTime(instant: string): Promise<void>;
  delete(actor: Persona, target: Target, key: string): Promise<Reply<Target>>;
  restore(actor: Persona, target: Target, key: string): Promise<Reply<Target>>;
  /** Separate explicit route/parameter, never the default delete path. */
  earlyPurge(actor: Persona, target: Target, key: string): Promise<Reply<unknown>>;
  read(actor: Persona, surface: Surface, fixture: Fixture, cursor?: string): Promise<Reply<Page>>;
  deletionState(actor: Persona, target: Target): Promise<Reply<Target>>;
  reference(actor: Persona, target: Target): Promise<Reply<Values>>;
  inspect(fixture: Fixture): Promise<Inspection>;
  /** Revoke real current owner authority without replacing issued credentials. */
  revokeOwner(): Promise<void>;
  legalHold(target: Target, held: boolean): Promise<void>;
  drain(): Promise<void>;
  /** Exact actual page attempts/commits, including rolled-back attempts. */
  trace(): Promise<{ committed: PageTrace[]; rolledBack: PageTrace[]; pageByteLimit: number }>;
  /** Crash at actual transaction/delivery seams; restart uses the SAME durable stores. */
  crashNext(point: 'before-commit' | 'after-commit-before-enqueue'): Promise<void>;
  restart(): Promise<void>;
  /** Park a production destructive page before its writing transaction's guard.
   * after-durable-capture parks the actual committed record-purge task delivery at deletion T,
   * before its due wait/guard, retaining that original payload across restoration. */
  holdNextPurge(
    stage?: 'before-guard' | 'after-durable-capture',
  ): Promise<{ reached: Promise<void>; resume(): Promise<void> }>;
  /** Production operations create a collision; never mutate tombstones directly. */
  createConflict(fixture: Fixture, kind: 'replacement' | 'ordinal' | 'capacity' | 'name'): Promise<Target>;
  removeCurrentProfile(fixture: Fixture): Promise<void>;
  /** A new value under the now absent profile, through its normal production API. */
  writeNewProfiledValue(fixture: Fixture): Promise<Reply<unknown>>;
  /** Actual listing source observation, applied later by the production target command. */
  observe(fixture: Fixture): Promise<ListingObservation>;
  apply(observation: ListingObservation): Promise<void>;
  /** Accounts-owned terminal deletion; no Library-local account restore or generation. */
  accountDelete(): Promise<{ deletedAt: string }>;
  /** Built-in dynamic public output A committed, B pending; B contains a private-only subject.
   * Also seed active private/unlisted, previously-public-now-unlisted and already-deleted
   * Collections plus a published log. No user-saved query API is introduced. */
  retentionFixture(): Promise<{
    public: Fixture;
    generationA: string[];
    pendingOnlyId: string;
    erased: Fixture[];
    privateSourceMarker: string;
  }>;
  /** Actual raw retained published generation and de-identified attribution. */
  retained(fixture: Fixture): Promise<{
    generation: string;
    subjectIds: string[];
    attribution: Values;
    privateSource: Json;
  }>;
  /** Same seeder at each legal geometric population, <=4096 total rows per axis;
   * grow unrelated same-partition and held-before-due rows while fixing one P-row
   * target page. Reset instrumentation AFTER production fixture commands.
   * No pre-deletion, mocked EXPLAIN, or counting only returned/deleted rows. */
  growthSeed(scale: number): Promise<Fixture>;
}
