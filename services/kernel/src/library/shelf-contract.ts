import type { Pool, PoolClient } from 'pg';
import { createShelfTypeKeys as nativeShelfTypeKeys, type ShelfTypeKeysOptions } from './shelf-type-keys.ts';
import { createShelfCounters as nativeShelfCounters } from './shelf-counters.ts';
import type { KernelClock } from '../clock.ts';
import type { Partition } from '../partition/partition.ts';
import type { CursorResult } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Access, Actor } from '../request/access.ts';
import type { EntryState } from './entry-model.ts';
import type { ProgressSession } from './progress-model.ts';
import type { ShelfMaintenanceCheckpoint, ShelfMaintenanceOps } from './shelf-maintenance-ops-contract.ts';

/**
 * Types and independently implementable signatures for the private Library shelf reads. The prose contract is
 * `shelf-contract.md`. Read admission, native type-key and counter factories are concrete re-exports;
 * remaining projection ports below throw until their owning implementation is composed.
 * Entry and progress storage layouts stay unchanged; shelf types are additive.
 */

type Client = Pick<PoolClient, 'query'>;

export class ShelfContractNotImplementedError extends Error {
  constructor(operation: string) {
    super(`Library shelf operation is not implemented: ${operation}`);
    this.name = 'ShelfContractNotImplementedError';
  }
}

function notImplemented(operation: string): never {
  throw new ShelfContractNotImplementedError(operation);
}

// --- Query model ----------------------------------------------------------------------------------------------

export const ENTRY_STATES = ['planned', 'in_progress', 'completed', 'paused', 'dropped'] as const;
export type LegacyEntryState = (typeof ENTRY_STATES)[number];
export function isLegacyEntryState(value: string): value is LegacyEntryState {
  return ENTRY_STATES.some((state) => state === value);
}
/** Original profile vocabulary grammar; chronological reads preserve the exact state identifier. */
export function isShelfEntryState(value: string): boolean {
  return /^[a-z][a-z0-9_.-]{0,63}$(?![\s\S])/.test(value);
}
export const SHELF_ORDERS = ['lastActivity', 'finishedAt', 'createdAt'] as const;
export const SHELF_DIRECTIONS = ['desc', 'asc'] as const;
export type ShelfOrder = (typeof SHELF_ORDERS)[number];
export type ShelfDirection = (typeof SHELF_DIRECTIONS)[number];

/** The sort each status tab opens with. The web sends these explicitly; the API has no per-state default. */
export const SHELF_DEFAULT_ORDER: Readonly<Record<LegacyEntryState, ShelfOrder>> = {
  in_progress: 'lastActivity',
  planned: 'createdAt',
  completed: 'finishedAt',
  paused: 'lastActivity',
  dropped: 'lastActivity',
};

export const MAX_SHELF_PAGE_SIZE = 100;
export const DEFAULT_SHELF_PAGE_SIZE = 20;

/** Effective SQL predicate after exact owner-scoped full-CURIE resolution. Null means unfiltered. */
export type ShelfQuery = {
  state: EntryState | null;
  typeId: string | null;
  orderBy: ShelfOrder;
  direction: ShelfDirection;
  limit: number;
  cursor?: string;
};

/**
 * The seek position after the last row of a page. `key` is the exact stored `timestamptz` text, microseconds kept,
 * never passed through `Date`. It is the empty string for a row whose finished date is null.
 */
export type ShelfSeek = { key: string; subjectId: string };

// --- Result model ---------------------------------------------------------------------------------------------

/** The exact BASIC per-session shape of `GET /v1/progressSessions`. No account or transaction id. */
export type ShelfSession = Omit<ProgressSession, 'accountId' | 'transactionId'>;

/** Existing BASIC entry fields plus the shelf additions. FULL adds `subject` at the transport layer. */
export type ShelfEntry = {
  subjectId: string;
  incarnationId?: string | null;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  finishedAt: string | null;
  activeProgressSession: ShelfSession | null;
};

export type ShelfPage = { entries: ShelfEntry[]; next: string | null };

export type ShelfTab = LegacyEntryState | 'all' | 'collections';
export type ShelfTabCount = { total: number; shown: number };
/** `shown` applies the type filter; without one it equals `total`. `collections` ignores the type filter. */
export type ShelfSummary = { tabs: Record<ShelfTab, ShelfTabCount> };
export type ShelfTypeCount = { type: string; count: number };
export type ShelfTypePage = { types: ShelfTypeCount[]; next: string | null };

// --- Storage rows (names are the migration's) ------------------------------------------------------------------

/** `library.progress_head`: one locked row per account and subject, initially empty; retained after entry deletion. */
export type ProgressHead = {
  accountId: string;
  subjectId: string;
  lastChangedAt: string | null;
  lastCompletedAt: string | null;
};

/** `library.shelf_count.bucket`. `all` counts every entry of the type; `collections` counts the account's Collections. */
export type ShelfBucket = LegacyEntryState | 'all' | 'collections';
/** Bounded UUID; the reserved nil UUID denotes the all-types rollup and Collections. */
export type ShelfCountRow = { accountId: string; bucket: ShelfBucket; typeId: string; count: number };

/** What an entry contributes to the counters. */
export type ShelfPlacement = { state: EntryState; typeId: string };

// --- Injected helpers -----------------------------------------------------------------------------------------

/** Every call runs in the owning account's command transaction. `time` is the command's authoritative T. */
export type ShelfWrite = { client: Client; route: number; accountId: string };

export type ProgressTouch = {
  subjectId: string;
  time: string;
  /** True for a session completion only. Abandon, start and record pass false. */
  completed: boolean;
};

/** What the entry writer reads from the head it has locked. Both are null before the first session change. */
export type HeadSnapshot = { lastChangedAt: string | null; lastCompletedAt: string | null };

/**
 * Serialization point between entry and progress writes on one subject. `ensure` upserts the account and subject head
 * with a no-op update, which locks it, and returns its timestamps. One statement, called before the entry statement.
 */
export interface ShelfHeads {
  ensure(write: ShelfWrite, subjectId: string): Promise<HeadSnapshot>;
}

/**
 * Progress writer's single call point, after its session statement succeeds. Two statements: the first upserts the head
 * with the later of its columns and `time` (`lastCompletedAt` too when `completed`) and takes its lock; the second, a new
 * statement, raises the existing entry's `activity_at` (and `finished_at` when `completed`) the same way and does nothing
 * when there is no entry. It never inserts or edits an entry's state, revision, `created_at` or `updated_at`.
 */
export interface ProgressActivity {
  touch(write: ShelfWrite, touch: ProgressTouch): Promise<void>;
}

/** Entry writer counter port. Native owner generation locks before sorted counter keys; all-types all locks first. */
export interface ShelfCounters {
  /** Moves one entry between placements: `from` null on insert, `to` null on delete. */
  transition(write: ShelfWrite, from: ShelfPlacement | null, to: ShelfPlacement | null): Promise<void>;
  /** +1 on creating, -1 on deleting an active Collection. */
  collection(write: ShelfWrite, delta: 1 | -1): Promise<void>;
}

/** Fields the entry writer passes to the store so that the entry row carries the shelf columns. */
export type EntryShelfWrite = {
  /** Required on create, absent on state update; resolved before the command, outside receipt input. */
  type?: { typeId: string; sourceId: string; stamp: ShelfSourceStamp };
  /** Immutable creation transaction identity, retained across state changes. */
  incarnationId?: string;
};

// --- Cursor ---------------------------------------------------------------------------------------------------

/** Structural port for tokens/list-cursor.ts; no dependency on its runtime or local cryptography. */
export type ShelfCursorBinding = {
  route: string;
  viewer: string | null;
  query: Readonly<Record<string, string | number | boolean | null>>;
};
export type ShelfCursorPosition = { epoch: number; after: readonly (string | number)[] };
export interface ShelfCursorCodec {
  encode(ring: KeyRing, binding: ShelfCursorBinding, position: ShelfCursorPosition, now: Date): Promise<string>;
  decode(ring: KeyRing, binding: ShelfCursorBinding, token: string, now: Date): Promise<CursorResult>;
}

/** Normalize once before SQL and binding. The caller has validated orderBy and resolved the public type. */
export function normalizeShelfQuery(
  query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>,
): ShelfQuery {
  return {
    state: query.state ?? null,
    typeId: query.typeId ?? null,
    orderBy: query.orderBy,
    direction: query.direction ?? 'desc',
    limit: query.limit ?? DEFAULT_SHELF_PAGE_SIZE,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

/** Bind every effective predicate and page size; cursor and presentation view are not predicates. */
export function shelfCursorBinding(
  accountId: string,
  query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>,
): ShelfCursorBinding {
  const { cursor: _cursor, ...effective } = normalizeShelfQuery(query);
  return { route: 'GET /v1/libraryEntries', viewer: accountId, query: effective };
}

export function shelfTypeCursorBinding(accountId: string, limit: number): ShelfCursorBinding {
  return { route: 'GET /v1/libraryShelfTypes', viewer: accountId, query: { limit } };
}

// --- Exact private type identity ------------------------------------------------------------------------------

export const SHELF_TYPE_CHUNK_BYTES = 256;
export const SHELF_TYPE_EDGE_BATCH = 100;
/** Enough for a complete release-bounded ASCII identifier and the JSON envelope; no per-type cap. */
export const SHELF_TYPE_RESPONSE_BYTES = 8 * 1024 * 1024;
export type ShelfTypeIdentity = { typeId: string; type: string; byteLength: number };
export type ShelfTypeReservation = { reservationId: string };
export type ShelfTypeResolution = { done: true; typeId: string } | { done: false; reservation: ShelfTypeReservation };

/** Owner authorization and partition fencing precede each call; reads never allocate. */
export interface ShelfTypeKeys {
  /** Digest-root full equality, else exact chunk trie. Null becomes 400 invalid_argument before cursor decode. */
  lookup(client: Client, route: number, accountId: string, fullType: string): Promise<string | null>;
  /** Native reservation retains large text. At most 100 trie edges per transaction, no partial published identity. */
  reserve(write: ShelfWrite, fullType: string): Promise<ShelfTypeResolution>;
  continue(write: ShelfWrite, reservation: ShelfTypeReservation): Promise<ShelfTypeResolution>;
}

/** Native factory; caller admission remains tied to the live owner transaction. */
export function createShelfTypeKeys(options?: ShelfTypeKeysOptions): ShelfTypeKeys {
  return nativeShelfTypeKeys(options);
}

// --- Reader ---------------------------------------------------------------------------------------------------

/** One bounded statement set: at most `limit + 1` entry rows and one active-session probe per returned entry. */
export type ShelfRows = { entries: ShelfEntry[]; more: boolean };
/** Date adapters return candidates before the independent active-session enrichment. */
export type ShelfDateRows = { entries: Omit<ShelfEntry, 'activeProgressSession'>[]; more: boolean };
export interface ShelfDateReader {
  page(
    client: Client,
    route: number,
    accountId: string,
    query: ShelfQuery,
    after: ShelfSeek | null,
  ): Promise<ShelfDateRows>;
}
export interface ShelfActiveReader {
  sessions(
    client: Client,
    route: number,
    accountId: string,
    subjectIds: readonly string[],
  ): Promise<Map<string, ShelfSession>>;
}

export interface ShelfPageReader {
  /** Same RR client and effective predicate as binding. Never counts/sorts beyond the bounded page. */
  page(
    client: Client,
    route: number,
    accountId: string,
    query: ShelfQuery,
    after: ShelfSeek | null,
  ): Promise<ShelfRows>;
}
export interface ShelfSummaryReader {
  summary(client: Client, route: number, accountId: string, typeId: string | null): Promise<ShelfSummary>;
}
export type ShelfFacetRows = { types: ShelfTypeCount[]; more: boolean; after: string | null };
export interface ShelfFacetReader {
  /** Discover keys/counts/lengths first; fetch full values only for the byte-budgeted emitted prefix. */
  types(
    client: Client,
    route: number,
    accountId: string,
    after: string | null,
    limit: number,
    byteBudget: number,
  ): Promise<ShelfFacetRows>;
}
export interface ShelfReader extends ShelfPageReader, ShelfSummaryReader, ShelfFacetReader {}

export type ShelfReads = {
  listShelf(actor: Actor, query: unknown): Promise<ShelfPage>;
  summary(actor: Actor, input: { type?: string }): Promise<ShelfSummary>;
  listTypes(actor: Actor, input: { cursor?: string; limit?: number }): Promise<ShelfTypePage>;
};

export type ShelfReadDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock: KernelClock;
  pageReader: ShelfPageReader;
  summaryReader: ShelfSummaryReader;
  facetReader: ShelfFacetReader;
  typeKeys: Pick<ShelfTypeKeys, 'lookup'>;
  cursors: ShelfCursorCodec;
  /** Native maintenance initialization, in an ordinary currently authorized owner command. */
  maintenance?: Pick<ShelfMaintenanceOps, 'initialize'>;
  /**
   * Reload the current native gate in the read's RR snapshot. The maintenance producer must supply this
   * adapter with its gate DDL; neither an initialization receipt nor caller metadata proves currentness.
   */
  generation?: ShelfReadGenerationReader;
};

export type ShelfReadGeneration = Pick<ShelfMaintenanceCheckpoint, 'epoch' | 'activeGeneration'> &
  Pick<Awaited<ReturnType<ShelfMaintenanceOps['initialize']>>, 'readiness'>;
export type ShelfReadGenerationReader = (
  client: Client,
  owner: ShelfMaintenanceCheckpoint['owner'],
) => Promise<ShelfReadGeneration>;

/**
 * Domain-level read service. `listShelf` requires `library_entry:list` and `progress_session:list`; the other two
 * require `library_entry:list` only. It admits the owner as `listEntries` does and reads at repeatable read.
 */
export { createShelfReads } from './shelf-reads.ts';

// --- Storage and writes (stubs) -------------------------------------------------------------------------------

export function createShelfHeads(): ShelfHeads {
  return { ensure: () => notImplemented('ShelfHeads.ensure') };
}

export function createProgressActivity(): ProgressActivity {
  return { touch: () => notImplemented('ProgressActivity.touch') };
}

export function createShelfCounters(): ShelfCounters {
  return nativeShelfCounters();
}

/** Maintenance only; the caller holds a writer fence across every batch and the final counter-generation swap. */
export type ShelfRebuildBatch = {
  fenceId: string;
  generationId: string;
  afterSubjectId: string | null;
  limit: number;
};
export function rebuildShelfCounters(
  _write: ShelfWrite,
  _batch: ShelfRebuildBatch,
): Promise<{ rows: number; next: string | null }> {
  return notImplemented('rebuildShelfCounters');
}

// --- Type projection ------------------------------------------------------------------------------------------

export const SHELF_TYPE_SYNC_WORKFLOW = 'library.shelfTypeSync';
export const SHELF_TYPE_VERIFY_WORKFLOW = 'library.shelfTypeVerify';

/** One run per source revision or merge. A redelivered or reordered event finds its existing workflow. */
export function shelfTypeSyncWorkflowId(change: ShelfTypeChange): string {
  return change.kind === 'revised'
    ? `shelf-type:${change.subjectId}:${change.revision}`
    : `shelf-type:${change.subjectId}:merged:${change.survivorId}`;
}

/** CloudEvent.id is immutable and already available; no event payload change is needed. */
export function shelfTypeVerifyWorkflowId(eventId: string): string {
  return `shelf-type-verify:${eventId}`;
}

/**
 * Comparable only within one source partition: epoch then position (bigint, never number).
 * Crossing a source owner requires a freshly validated binding, not comparison of unrelated positions.
 */
export type ShelfSourceStamp = { partition: number; epoch: number; position: bigint };
export type ShelfTypeObservation = { sourceId: string; type: string; stamp: ShelfSourceStamp };
export type ShelfSourceSnapshot = {
  /** Present even when a merged/invisible source has no visible type observation. */
  binding: { sourceId: string; stamp: ShelfSourceStamp };
  source: ShelfTypeObservation | null;
  /** Checked one-hop redirect in the SAME source snapshot, never trusted merely from an event payload. */
  survivorId: string | null;
};
export interface ShelfTypeSource {
  /** Both methods receive the SAME RR client in one authoritative source partition. */
  readPartition(client: Client, partition: number): Promise<Partition | null>;
  /** Authoritative semantic readItemTypes adapter; pass this client, never the pool. */
  readItemTypes(client: Client, ids: readonly string[]): Promise<Map<string, string>>;
  readSurvivor(client: Client, subjectId: string): Promise<string | null>;
}

export type ShelfTypeChange =
  | { kind: 'revised'; subjectId: string; revision: number }
  | { kind: 'merged'; subjectId: string; survivorId: string };

export type ShelfRetypeAfter = { route: number; accountId: string; subjectId: string };
export type ShelfRetypePage = { accounts: number; entries: number; next: ShelfRetypeAfter | null };
export type ShelfEntryTypeVersion = {
  incarnationId: string;
  transactionId: string;
  sourceId: string;
  stamp: ShelfSourceStamp;
};
export type ShelfTypeApply = {
  expected: ShelfEntryTypeVersion;
  observed: ShelfSourceSnapshot;
  /** Required on a source switch: separately observed at the survivor's owner, with its own stamp. */
  survivor: ShelfTypeObservation | null;
  typeId: string;
};
export type ShelfProjectionDependencies = {
  pool: Pool;
  source: ShelfTypeSource;
  typeKeys: ShelfTypeKeys;
  counters: ShelfCounters;
  clock: KernelClock;
};

/** Opens a fenced RR source snapshot, captures partition+type+merge together; moved owners are followed normally. */
export function observeShelfType(
  _dependencies: Pick<ShelfProjectionDependencies, 'pool' | 'source'>,
  _subjectId: string,
): Promise<ShelfSourceSnapshot> {
  return notImplemented('observeShelfType');
}

/**
 * Metadata CAS: current incarnation/transaction/source/stamp must match; stale stamps never lower state.
 * On false, a bounded retry rereads entry AND source binding. No entry revision/time/event mutation.
 */
export function applyShelfEntryType(_write: ShelfWrite, _subjectId: string, _input: ShelfTypeApply): Promise<boolean> {
  return notImplemented('applyShelfEntryType');
}

/** Full tuple seek retains every same-account tail. Each candidate uses a metadata CAS and atomic counter deltas. */
export function retypeShelfEntries(
  _dependencies: ShelfProjectionDependencies,
  _partition: number,
  _observation: ShelfSourceSnapshot,
  _after: ShelfRetypeAfter | null,
  _limit: number,
): Promise<ShelfRetypePage> {
  return notImplemented('retypeShelfEntries');
}

/** Bounded existing-partition visits plus holder pages. Retries revalidate source binding and source truth. */
export function syncShelfSubjectType(
  _change: ShelfTypeChange,
  _dependencies: ShelfProjectionDependencies,
): Promise<void> {
  return notImplemented('syncShelfSubjectType');
}

/** Event-keyed work verifies current incarnation even after state changes or recreation, with bounded CAS/retry. */
export function verifyShelfEntryType(
  _eventId: string,
  _accountId: string,
  _subjectId: string,
  _dependencies: ShelfProjectionDependencies,
): Promise<void> {
  return notImplemented('verifyShelfEntryType');
}

// --- HTTP ----------------------------------------------------------------------------------------------------

export const SHELF_LIST_ACTION = 'library_entry:list';
export const SHELF_PROGRESS_ACTION = 'progress_session:list';
export const SHELF_PROGRESS_GATE = 'reading_progress';

/**
 * Called by the list route when `orderBy` is present. Refuses with `forbidden` unless the actor holds
 * `progress_session:list`, and with `platform_closed` unless the `reading_progress` gate admits it, using the shared
 * `admitGroup` of `access/gates/admission.ts` with `clientAction` `progress_session:list`. The `personal_library` gate
 * is the route's own and is not repeated here.
 */
export type ShelfAdmissionDependencies = Pick<ShelfReadDependencies, 'pool' | 'access' | 'clock'>;
export { admitShelfRead } from './shelf-admission.ts';

export type ShelfListQuery = {
  state?: EntryState;
  orderBy?: ShelfOrder;
  direction?: ShelfDirection;
  type?: string;
  view?: 'BASIC' | 'FULL';
  limit?: number;
  cursor?: string;
};
