import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Partition } from '../partition/partition.ts';
import type { CursorResult } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Access, Actor } from '../request/access.ts';
import type { EntryState } from './entry-model.ts';
import type { ProgressSession } from './progress-model.ts';
/**
 * Types and independently implementable signatures for the private Library shelf reads. The prose contract is
 * `shelf-contract.md`. Nothing here is behaviour: every exported function that is not a pure rule throws until its
 * owning task replaces it. Existing `Entry` and `ProgressSession` stay unchanged; the shelf types are additive.
 */
type Client = Pick<PoolClient, 'query'>;
export declare class ShelfContractNotImplementedError extends Error {
    constructor(operation: string);
}
export declare const ENTRY_STATES: readonly ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
export declare const SHELF_ORDERS: readonly ['lastActivity', 'finishedAt', 'createdAt'];
export declare const SHELF_DIRECTIONS: readonly ['desc', 'asc'];
export type ShelfOrder = (typeof SHELF_ORDERS)[number];
export type ShelfDirection = (typeof SHELF_DIRECTIONS)[number];
/** The sort each status tab opens with. The web sends these explicitly; the API has no per-state default. */
export declare const SHELF_DEFAULT_ORDER: Readonly<Record<EntryState, ShelfOrder>>;
export declare const MAX_SHELF_PAGE_SIZE = 100;
export declare const DEFAULT_SHELF_PAGE_SIZE = 20;
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
export type ShelfSeek = {
    key: string;
    subjectId: string;
};
/** The exact BASIC per-session shape of `GET /v1/progressSessions`. No account or transaction id. */
export type ShelfSession = Omit<ProgressSession, 'accountId' | 'transactionId'>;
/** Existing BASIC entry fields plus the shelf additions. FULL adds `subject` at the transport layer. */
export type ShelfEntry = {
    subjectId: string;
    state: EntryState;
    revision: number;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
    finishedAt: string | null;
    activeProgressSession: ShelfSession | null;
};
export type ShelfPage = {
    entries: ShelfEntry[];
    next: string | null;
};
export type ShelfTab = EntryState | 'all' | 'collections';
export type ShelfTabCount = {
    total: number;
    shown: number;
};
/** `shown` applies the type filter; without one it equals `total`. `collections` ignores the type filter. */
export type ShelfSummary = {
    tabs: Record<ShelfTab, ShelfTabCount>;
};
export type ShelfTypeCount = {
    type: string;
    count: number;
};
export type ShelfTypePage = {
    types: ShelfTypeCount[];
    next: string | null;
};
/** `library.progress_head`: one locked row per account and subject, initially empty; retained after entry deletion. */
export type ProgressHead = {
    accountId: string;
    subjectId: string;
    lastChangedAt: string | null;
    lastCompletedAt: string | null;
};
/** `library.shelf_count.bucket`. `all` counts every entry of the type; `collections` counts the account's Collections. */
export type ShelfBucket = EntryState | 'all' | 'collections';
/** Bounded UUID; the reserved nil UUID denotes the all-types rollup and Collections. */
export type ShelfCountRow = {
    accountId: string;
    bucket: ShelfBucket;
    typeId: string;
    count: number;
};
/** What an entry contributes to the counters. */
export type ShelfPlacement = {
    state: EntryState;
    typeId: string;
};
/** Every call runs in the owning account's command transaction. `time` is the command's authoritative T. */
export type ShelfWrite = {
    client: Client;
    route: number;
    accountId: string;
};
export type ProgressTouch = {
    subjectId: string;
    time: string;
    /** True for a session completion only. Abandon, start and record pass false. */
    completed: boolean;
};
/** What the entry writer reads from the head it has locked. Both are null before the first session change. */
export type HeadSnapshot = {
    lastChangedAt: string | null;
    lastCompletedAt: string | null;
};
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
/** Entry writer's call point for the counters. One statement; keys are sorted so the account's all-types row locks first. */
export interface ShelfCounters {
    /** Moves one entry between placements: `from` null on insert, `to` null on delete. */
    transition(write: ShelfWrite, from: ShelfPlacement | null, to: ShelfPlacement | null): Promise<void>;
    /** +1 on creating, -1 on deleting an active Collection. */
    collection(write: ShelfWrite, delta: 1 | -1): Promise<void>;
}
/** Fields the entry writer passes to the store so that the entry row carries the shelf columns. */
export type EntryShelfWrite = {
    /** Required on create, absent on state update; resolved before the command, outside receipt input. */
    type?: {
        typeId: string;
        sourceId: string;
        stamp: ShelfSourceStamp;
    };
    /** Immutable creation transaction identity, retained across state changes. */
    incarnationId?: string;
};
/** Structural port for tokens/list-cursor.ts; no dependency on its runtime or local cryptography. */
export type ShelfCursorBinding = {
    route: string;
    viewer: string | null;
    query: Readonly<Record<string, string | number | boolean | null>>;
};
export type ShelfCursorPosition = {
    epoch: number;
    after: readonly (string | number)[];
};
export interface ShelfCursorCodec {
    encode(ring: KeyRing, binding: ShelfCursorBinding, position: ShelfCursorPosition, now: Date): Promise<string>;
    decode(ring: KeyRing, binding: ShelfCursorBinding, token: string, now: Date): Promise<CursorResult>;
}
/** Normalize once before SQL and binding. The caller has validated orderBy and resolved the public type. */
export declare function normalizeShelfQuery(query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>): ShelfQuery;
/** Bind every effective predicate and page size; cursor and presentation view are not predicates. */
export declare function shelfCursorBinding(accountId: string, query: Pick<ShelfQuery, 'orderBy'> & Partial<Omit<ShelfQuery, 'orderBy'>>): ShelfCursorBinding;
export declare function shelfTypeCursorBinding(accountId: string, limit: number): ShelfCursorBinding;
export declare const SHELF_TYPE_CHUNK_BYTES = 256;
export declare const SHELF_TYPE_EDGE_BATCH = 100;
/** Enough for a complete release-bounded ASCII identifier and the JSON envelope; no per-type cap. */
export declare const SHELF_TYPE_RESPONSE_BYTES: number;
export type ShelfTypeIdentity = {
    typeId: string;
    type: string;
    byteLength: number;
};
export type ShelfTypeReservation = {
    reservationId: string;
};
export type ShelfTypeResolution = {
    done: true;
    typeId: string;
} | {
    done: false;
    reservation: ShelfTypeReservation;
};
/** Owner authorization and partition fencing precede each call; reads never allocate. */
export interface ShelfTypeKeys {
    /** Digest-root full equality, else exact chunk trie. Null becomes 400 invalid_argument before cursor decode. */
    lookup(client: Client, route: number, accountId: string, fullType: string): Promise<string | null>;
    /** Native reservation retains large text. At most 100 trie edges per transaction, no partial published identity. */
    reserve(write: ShelfWrite, fullType: string): Promise<ShelfTypeResolution>;
    continue(write: ShelfWrite, reservation: ShelfTypeReservation): Promise<ShelfTypeResolution>;
}
export declare function createShelfTypeKeys(): ShelfTypeKeys;
/** One bounded statement set: at most `limit + 1` entry rows and one active-session probe per returned entry. */
export type ShelfRows = {
    entries: ShelfEntry[];
    more: boolean;
};
/** Date adapters return candidates before the independent active-session enrichment. */
export type ShelfDateRows = {
    entries: Omit<ShelfEntry, 'activeProgressSession'>[];
    more: boolean;
};
export interface ShelfDateReader {
    page(client: Client, route: number, accountId: string, query: ShelfQuery, after: ShelfSeek | null): Promise<ShelfDateRows>;
}
export interface ShelfActiveReader {
    sessions(client: Client, route: number, accountId: string, subjectIds: readonly string[]): Promise<Map<string, ShelfSession>>;
}
export interface ShelfPageReader {
    /** Same RR client and effective predicate as binding. Never counts/sorts beyond the bounded page. */
    page(client: Client, route: number, accountId: string, query: ShelfQuery, after: ShelfSeek | null): Promise<ShelfRows>;
}
export interface ShelfSummaryReader {
    summary(client: Client, route: number, accountId: string, typeId: string | null): Promise<ShelfSummary>;
}
export type ShelfFacetRows = {
    types: ShelfTypeCount[];
    more: boolean;
    after: string | null;
};
export interface ShelfFacetReader {
    /** Discover keys/counts/lengths first; fetch full values only for the byte-budgeted emitted prefix. */
    types(client: Client, route: number, accountId: string, after: string | null, limit: number, byteBudget: number): Promise<ShelfFacetRows>;
}
export interface ShelfReader extends ShelfPageReader, ShelfSummaryReader, ShelfFacetReader {
}
export type ShelfReads = {
    listShelf(actor: Actor, query: unknown): Promise<ShelfPage>;
    summary(actor: Actor, input: {
        type?: string;
    }): Promise<ShelfSummary>;
    listTypes(actor: Actor, input: {
        cursor?: string;
        limit?: number;
    }): Promise<ShelfTypePage>;
};
export type ShelfReadDependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock: KernelClock;
    pageReader: ShelfPageReader;
    summaryReader: ShelfSummaryReader;
    facetReader: ShelfFacetReader;
    typeKeys: ShelfTypeKeys;
    cursors: ShelfCursorCodec;
};
/**
 * Domain-level read service. `listShelf` requires `library_entry:list` and `progress_session:list`; the other two
 * require `library_entry:list` only. It admits the owner as `listEntries` does and reads at repeatable read.
 */
export declare function createShelfReads(_dependencies: ShelfReadDependencies): ShelfReads;
export declare function createShelfHeads(): ShelfHeads;
export declare function createProgressActivity(): ProgressActivity;
export declare function createShelfCounters(): ShelfCounters;
/** Maintenance only; the caller holds a writer fence across every batch and the final counter-generation swap. */
export type ShelfRebuildBatch = {
    fenceId: string;
    generationId: string;
    afterSubjectId: string | null;
    limit: number;
};
export declare function rebuildShelfCounters(_write: ShelfWrite, _batch: ShelfRebuildBatch): Promise<{
    rows: number;
    next: string | null;
}>;
export declare const SHELF_TYPE_SYNC_WORKFLOW = "library.shelfTypeSync";
export declare const SHELF_TYPE_VERIFY_WORKFLOW = "library.shelfTypeVerify";
/** One run per source revision or merge. A redelivered or reordered event finds its existing workflow. */
export declare function shelfTypeSyncWorkflowId(change: ShelfTypeChange): string;
/** CloudEvent.id is immutable and already available; no event payload change is needed. */
export declare function shelfTypeVerifyWorkflowId(eventId: string): string;
/**
 * Comparable only within one source partition: epoch then position (bigint, never number).
 * Crossing a source owner requires a freshly validated binding, not comparison of unrelated positions.
 */
export type ShelfSourceStamp = {
    partition: number;
    epoch: number;
    position: bigint;
};
export type ShelfTypeObservation = {
    sourceId: string;
    type: string;
    stamp: ShelfSourceStamp;
};
export type ShelfSourceSnapshot = {
    /** Present even when a merged/invisible source has no visible type observation. */
    binding: {
        sourceId: string;
        stamp: ShelfSourceStamp;
    };
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
export type ShelfTypeChange = {
    kind: 'revised';
    subjectId: string;
    revision: number;
} | {
    kind: 'merged';
    subjectId: string;
    survivorId: string;
};
export type ShelfRetypeAfter = {
    route: number;
    accountId: string;
    subjectId: string;
};
export type ShelfRetypePage = {
    accounts: number;
    entries: number;
    next: ShelfRetypeAfter | null;
};
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
export declare function observeShelfType(_dependencies: Pick<ShelfProjectionDependencies, 'pool' | 'source'>, _subjectId: string): Promise<ShelfSourceSnapshot>;
/**
 * Metadata CAS: current incarnation/transaction/source/stamp must match; stale stamps never lower state.
 * On false, a bounded retry rereads entry AND source binding. No entry revision/time/event mutation.
 */
export declare function applyShelfEntryType(_write: ShelfWrite, _subjectId: string, _input: ShelfTypeApply): Promise<boolean>;
/** Full tuple seek retains every same-account tail. Each candidate uses a metadata CAS and atomic counter deltas. */
export declare function retypeShelfEntries(_dependencies: ShelfProjectionDependencies, _partition: number, _observation: ShelfSourceSnapshot, _after: ShelfRetypeAfter | null, _limit: number): Promise<ShelfRetypePage>;
/** Bounded existing-partition visits plus holder pages. Retries revalidate source binding and source truth. */
export declare function syncShelfSubjectType(_change: ShelfTypeChange, _dependencies: ShelfProjectionDependencies): Promise<void>;
/** Event-keyed work verifies current incarnation even after state changes or recreation, with bounded CAS/retry. */
export declare function verifyShelfEntryType(_eventId: string, _accountId: string, _subjectId: string, _dependencies: ShelfProjectionDependencies): Promise<void>;
export declare const SHELF_LIST_ACTION = "library_entry:list";
export declare const SHELF_PROGRESS_ACTION = "progress_session:list";
export declare const SHELF_PROGRESS_GATE = "reading_progress";
/**
 * Called by the list route when `orderBy` is present. Refuses with `forbidden` unless the actor holds
 * `progress_session:list`, and with `platform_closed` unless the `reading_progress` gate admits it, using the shared
 * `admitGroup` of `access/gates/admission.ts` with `clientAction` `progress_session:list`. The `personal_library` gate
 * is the route's own and is not repeated here.
 */
export type ShelfAdmissionDependencies = Pick<ShelfReadDependencies, 'pool' | 'access' | 'clock'>;
export declare function admitShelfRead(_dependencies: ShelfAdmissionDependencies, _actor: Actor, _deadline: number): Promise<void>;
export type ShelfListQuery = {
    state?: EntryState;
    orderBy?: ShelfOrder;
    direction?: ShelfDirection;
    type?: string;
    view?: 'BASIC' | 'FULL';
    limit?: number;
    cursor?: string;
};
export {};
