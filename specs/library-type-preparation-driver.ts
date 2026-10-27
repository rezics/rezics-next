/**
 * TEST ONLY. LIBRARY_TYPE_PREPARATION_DRIVER is an absolute path/file URL exporting
 * createLibraryTypePreparationDriver(): Promise<LibraryTypePreparationDriver>.
 * Each instance owns an isolated migrated database, real Access/tokens/semantic
 * fixtures and the production kernel plus its ordinary durable effects executor.
 * close releases only resources it owns, including partial setup.
 *
 * Requests use createKernel(...).handle and existing headers/receipt digests.
 * Fixture changes use real semantic/account/library commands. No policy model,
 * fabricated expected keys, direct source writes, fake authorization or normalized
 * outcomes. The only digest override is injected into the actual composed keys.
 * Metadata dispatch starts held; ordinary fixture work is allowed to settle.
 * Pauses/crashes instrument actual production boundaries, not a simulated runner.
 * Inspection reads real rows/history/SQL in stable key order and excludes fixture
 * creation effects from the entry-owned effects snapshot. All measurements are
 * observed, including source client identity, transaction/lock and byte counters.
 */
import type {
  PreparedType,
  TypePreparationEvidence,
  TypePreparationIntent,
} from '../services/kernel/src/library/type-preparation-contract.ts';
import type { EntryState } from '../services/kernel/src/library/entry-model.ts';

export interface PreparationFixture {
  accountId: string;
  subjectId: string;
  requestKey: string;
}

export type PreparationCrash =
  | 'reserve-before-commit'
  | 'reserve-after-commit-before-enqueue'
  | 'reserve-after-enqueue-before-ack'
  | 'page-before-commit'
  | 'page-after-commit-before-enqueue'
  | 'page-after-enqueue-before-ack'
  | 'page-after-ack-before-dispatch'
  | 'final-before-commit'
  | 'final-after-commit-before-ack'
  | 'entry-after-commit-before-response';

export interface PreparationInspection {
  evidence: TypePreparationEvidence[];
  ready: PreparedType[];
  intents: TypePreparationIntent[];
  dictionary: { typeId: string; type: string; byteLength: number }[];
  /** storage is the actual pg_attribute.attstorage code for the staged bytea column. */
  reservations: { reservationId: string; byteLength: number; offset: number; storage: string }[];
  pageReceipts: { preparationId: string; chunk: number; offset: number; receiptKey: string }[];
  /** All ordinary user-effect state/receipts/outbox, including any new partial-entry/operation store. */
  effects: {
    entries: { subjectId: string; typeId: string; sourceId: string; revision: number; state: EntryState }[];
    counters: unknown[];
    heads: unknown[];
    activity: unknown[];
    follows: unknown[];
    collections: unknown[];
    receipts: { key: string; digest: string; response: unknown }[];
    events: unknown[];
    operations: unknown[];
  };
  /** Exhaustive preparation-owned rows/receipts/events, for read non-allocation and purge assertions. */
  metadataRows: { relation: string; row: unknown }[];
  /** Actual DBOS args/results, event data and page receipt payloads, including failed/replayed attempts. */
  workflowPayloads: unknown[];
  /** Includes any initial reserve page; initialization/final full-value copies are separate from staging. */
  pages: {
    transactionId: string;
    chunk: number;
    offsetBefore: number;
    offsetAfter: number;
    edgeOperations: number;
    sliceBytes: number;
    sliceStatements: number;
    stagingWholeValueBytes: number;
    accountShareLocked: boolean;
    gateChecked: boolean;
    sourceChecked: boolean;
  }[];
  observations: {
    sourceId: string;
    partition: number;
    epoch: number;
    position: string;
    partitionClient: string;
    typeClient: string;
    redirectClient: string;
    isolation: string;
    releasedBeforeAccount: boolean;
  }[];
  /** Actual SQL/protocol source reads, including retries; measure before mapping returned JS values. */
  sourceReads: {
    phase: 'initial' | 'page' | 'publication' | 'consume';
    sourceId: string;
    partitionClient: string;
    identityClient: string;
    /** Null only when no type query ran; discarding selected text does not count as zero bytes. */
    typeClient: string | null;
    typeBytes: number;
  }[];
  requests: {
    reservationTransactions: number;
    continuationTransactions: number;
    sourceConnectionsWhileWaiting: number;
    accountConnectionsWhileWaiting: number;
    deadline: number;
    returnedAt: number;
  }[];
}

export interface LibraryTypePreparationDriver {
  fixture(input: { type: string; digest?: 'constant'; requestBudgetMs?: number }): Promise<PreparationFixture>;
  /** Reserve/finish via real metadata producer, without any user entry effect. */
  primeType(fixture: PreparationFixture, type: string): Promise<void>;
  request(
    fixture: PreparationFixture,
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
    requestKey?: string,
    persona?: 'owner' | 'other' | 'unreadable' | 'revoked',
  ): Promise<Response>;
  inspect(fixture: PreparationFixture): Promise<PreparationInspection>;
  /** Exact production owner lookup, read-only and independent of inspection/expected keys. */
  lookup(fixture: PreparationFixture, fullType: string): Promise<string | null>;
  /** Drain real metadata effects/relay to idle, then hold dispatch again; user effects require explicit requests. */
  settleMetadata(): Promise<void>;
  /** Both pauses are after source release and BEFORE account/gate admission, with no native lock held. */
  pauseNext(
    fixture: PreparationFixture,
    boundary: 'before-publication' | 'before-entry-effect',
  ): Promise<{
    reached: Promise<void>;
    resume(): Promise<void>;
  }>;
  crashNext(fixture: PreparationFixture, boundary: PreparationCrash): Promise<void>;
  /** Restart only this driver's executor and replay native logs/receipts; no forced cursor advancement. */
  recover(): Promise<void>;
  reviseType(fixture: PreparationFixture, type: string): Promise<void>;
  /** Real unrelated semantic identity command in the same source partition; no raw SQL/model increment. */
  advanceUnrelatedSource(fixture: PreparationFixture): Promise<void>;
  mergeSource(fixture: PreparationFixture, survivorType: string): Promise<{ survivorId: string }>;
  rebuildOwner(fixture: PreparationFixture): Promise<void>;
  deleteOwner(fixture: PreparationFixture): Promise<void>;
  removeSource(fixture: PreparationFixture): Promise<void>;
  closeGate(fixture: PreparationFixture): Promise<void>;
  revokeEntryAccess(fixture: PreparationFixture): Promise<void>;
  /** Native persistence fault seam only; never used to manufacture source observations. */
  damage(fixture: PreparationFixture, what: 'missing-evidence' | 'stale-reservation'): Promise<TypePreparationIntent>;
  /** Deliver a captured real event to its actual production effect, without re-creating its native evidence. */
  redeliver(intent: TypePreparationIntent): Promise<void>;
  /**
   * Pause two real producers AFTER observation, give them the same native binding
   * but distinct retained bytes at the persistence fault seam, then release together.
   * Returns their actual settlement statuses; at least one must reject the invariant.
   */
  raceConflictingInput(fixture: PreparationFixture): Promise<PromiseSettledResult<unknown>[]>;
  close(): Promise<void>;
}
