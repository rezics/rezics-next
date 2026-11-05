/**
 * LIBRARY_LISTING_FRESHNESS_DRIVER: absolute path/file URL exporting
 * createLibraryListingFreshnessDriver(): Promise<LibraryListingFreshnessDriver>.
 * Each instance owns an isolated migrated PostgreSQL DB and real Access/Auth
 * fixtures. close releases only its resources, including failed/partial setup.
 * Automatic listing dispatch starts held so tests control actual first applies.
 *
 * All fixture changes use production Collection/member/semantic commands, with
 * real runCommand/core position/outbox commits. No raw store writes like the old
 * listing tests, UUID ordering, fake counters, modeled policy or expected states.
 * sync/observe/apply invoke production source and target paths; apply is the real
 * native command seam, not a driver implementation of comparison/privacy rules.
 * Collection sources and subject targets use different partitions. Inspection
 * covers listing-owned state/evidence only, not semantic fixture creation rows.
 * Inspection returns actual persisted rows in stable key order. Measurement uses
 * real SQL/EXPLAIN counters, never constants or replay in place of mutation.
 */
import type {
  ListingApplyResult,
  ListingKey,
  ListingObservation,
  ListingSourceFence,
  ListingVersion,
} from '../services/kernel/src/library/listing-freshness-contract.ts';

export interface ListingInspection {
  pairs: ListingVersion[];
  versions: ListingVersion[];
  fences: ListingSourceFence[];
  listings: { subjectId: string; publicCollectionCount: number; revision: number }[];
  receipts: { transactionId: string; response: unknown }[];
  events: { type: string; subject: string; data: unknown }[];
  /** All listing target rows/receipts/outbox for this subject, including new holder stores. */
  targetRows: { relation: string; row: unknown }[];
}

export interface SourceTrace {
  partitionClient: string;
  truthClient: string;
  isolation: string;
  sourceReleasedBeforeTarget: boolean;
  sourceCommittedPosition: bigint;
}

export interface LibraryListingFreshnessDriver {
  provisionSubject(): Promise<string>;
  provisionCollection(input: {
    subjectId: string;
    visibility: 'public' | 'private' | 'unlisted';
    copies?: number;
    note?: string;
  }): Promise<{ id: string; memberIds: string[] }>;
  setVisibility(collectionId: string, visibility: 'public' | 'private' | 'unlisted'): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  appendMember(collectionId: string, subjectId: string): Promise<string>;
  removeMember(collectionId: string, memberId: string): Promise<void>;
  sync(key: ListingKey): Promise<ListingApplyResult>;
  observe(key: ListingKey): Promise<ListingObservation>;
  /** May deliberately receive a corrupted equal-stamp payload to test native invariant rejection. */
  apply(observation: ListingObservation): Promise<ListingApplyResult>;
  /** Parks a real sync after source release, BEFORE its first target command; resume is idempotent. */
  pauseNextObservation(key: ListingKey): Promise<{
    reached: Promise<ListingObservation>;
    resume(): Promise<void>;
  }>;
  inspect(subjectId: string): Promise<ListingInspection>;
  sourceTrace(): Promise<SourceTrace>;
  /** Real reader; positive public pairs only, stable Collection-id order. */
  publicPage(subjectId: string, after: string | null, limit: number): Promise<{ collectionId: string }[]>;
  /** Native reverse version seek, raw limit <=100; full immutable tuple continuation, not OFFSET. */
  reverseHistoryPage(
    collectionId: string,
    after: string | null,
    limit: number,
  ): Promise<{
    rows: ListingVersion[];
    next: string | null;
    examined: number;
  }>;
  /** Actual dependency failure/ownership fencing, not a fabricated zero or fake result. */
  sourceFault(collectionId: string, state: 'moved' | 'unavailable' | 'clear'): Promise<void>;
  /** Seed only an empty fixture partition's core position; subsequent truth changes are real commands. */
  initializeSourcePosition(position: bigint): Promise<void>;
  /** Inject a failure after target native mutations and before command commit. */
  failNextTargetCommit(): Promise<void>;
  /** Unrelated commands in the SAME source partition; no special ordering of their UUIDs/times. */
  advanceSource(commands: number): Promise<void>;
  /** Seed 128*scale real command histories per axis, scoped to this subject. */
  seed(
    subjectId: string,
    scale: number,
    axis: 'unrelated' | 'current_public_pairs' | 'obsolete_public_pairs',
  ): Promise<void>;
  measure<T>(body: () => Promise<T>): Promise<{
    value: T;
    statements: number;
    rows: number;
    buffers: number;
    sequentialRelations: string[]; // listing/source/member data relations, excluding tiny core metadata
  }>;
  /**
   * Before any normal fixture, start at the real pre-guard schema and prepare
   * the exact old listing-apply.sql on an owned connection. Real old commands
   * create a current public pair (multiplicity one) and never-public private/unlisted
   * Collections, each on its own subject so absence assertions are unambiguous.
   * activateFreshness then runs the actual paged bootstrap/cutover on this DB.
   */
  legacyFixture(): Promise<{
    public: ListingKey;
    private: ListingKey;
    unlisted: ListingKey;
  }>;
  activateFreshness(): Promise<void>;
  /** Execute the saved old prepared SQL in a NEW transaction after cutover; return/rethrow DB result. */
  applyUnversioned(key: ListingKey, multiplicity: number): Promise<void>;
  close(): Promise<void>;
}
