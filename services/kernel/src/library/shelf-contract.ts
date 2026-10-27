import type { PoolClient } from 'pg';
import type { Actor } from '../request/access.ts';
import type { EntryState } from './entry-model.ts';
import type { ProgressSession } from './progress-model.ts';

/**
 * Types and independently implementable signatures for the private Library shelf reads. The prose contract is
 * `shelf-contract.md`. Nothing here is behaviour: every exported function that is not a pure rule throws until its
 * owning task replaces it. Existing `Entry` and `ProgressSession` stay unchanged; the shelf types are additive.
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
export const SHELF_ORDERS = ['lastActivity', 'finishedAt', 'createdAt'] as const;
export const SHELF_DIRECTIONS = ['desc', 'asc'] as const;
export type ShelfOrder = (typeof SHELF_ORDERS)[number];
export type ShelfDirection = (typeof SHELF_DIRECTIONS)[number];

/** The sort each status tab opens with. The web sends these explicitly; the API has no per-state default. */
export const SHELF_DEFAULT_ORDER: Readonly<Record<EntryState, ShelfOrder>> = {
  in_progress: 'lastActivity',
  planned: 'createdAt',
  completed: 'finishedAt',
  paused: 'lastActivity',
  dropped: 'lastActivity',
};

export const MAX_SHELF_PAGE_SIZE = 100;
export const DEFAULT_SHELF_PAGE_SIZE = 20;
export const MAX_SHELF_TYPE_LENGTH = 256;

/** A validated shelf request. `state` and `type` null mean unfiltered. `direction` defaults to `desc`. */
export type ShelfQuery = {
  state: EntryState | null;
  type: string | null;
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
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  finishedAt: string | null;
  activeProgressSession: ShelfSession | null;
};

export type ShelfPage = { entries: ShelfEntry[]; next: string | null };

export type ShelfTab = EntryState | 'all' | 'collections';
export type ShelfTabCount = { total: number; shown: number };
/** `shown` applies the type filter; without one it equals `total`. `collections` ignores the type filter. */
export type ShelfSummary = { tabs: Record<ShelfTab, ShelfTabCount> };
export type ShelfTypeCount = { type: string; count: number };
export type ShelfTypePage = { types: ShelfTypeCount[]; next: string | null };

// --- Storage rows (names are the migration's) ------------------------------------------------------------------

/** `library.progress_head`: one row per account and subject with persisted progress, kept after the entry is gone. */
export type ProgressHead = {
  accountId: string;
  subjectId: string;
  lastChangedAt: string;
  lastCompletedAt: string | null;
};

/** `library.shelf_count.bucket`. `all` counts every entry of the type; `collections` counts the account's Collections. */
export type ShelfBucket = EntryState | 'all' | 'collections';
/** `library.shelf_count`: `type` is the empty string for the rollup over all types and for `collections`. */
export type ShelfCountRow = { accountId: string; bucket: ShelfBucket; type: string; count: number };

/** What an entry contributes to the counters. */
export type ShelfPlacement = { state: EntryState; type: string };

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

/** Entry writer's call point for the counters. One statement; keys are sorted so the account's all-types row locks first. */
export interface ShelfCounters {
  /** Moves one entry between placements: `from` null on insert, `to` null on delete. */
  transition(write: ShelfWrite, from: ShelfPlacement | null, to: ShelfPlacement | null): Promise<void>;
  /** +1 on creating, -1 on deleting an active Collection. */
  collection(write: ShelfWrite, delta: 1 | -1): Promise<void>;
}

/** Fields the entry writer passes to the store so that the entry row carries the shelf columns. */
export type EntryShelfWrite = {
  /** Primary type read before the command from the subject's partition. Required on create, absent on update. */
  subjectType?: string;
};

// --- Cursor ---------------------------------------------------------------------------------------------------

/**
 * Account-owned opaque cursor helper: AES-256-GCM through the key ring, with route, viewer and query as associated
 * data, current and previous keys accepted. This module adopts it and does not wrap it; the type stays abstract until
 * the accounts task publishes the API.
 */
export interface ShelfCursorCodec {
  seal(scope: ShelfCursorScope, position: { epoch: number; after: ShelfSeek | string }): string;
  open(
    scope: ShelfCursorScope,
    token: string,
  ): { ok: true; epoch: number; after: ShelfSeek | string } | { ok: false; reason: 'invalid' | 'expired' };
}

export type ShelfCursorScope = {
  operation: 'library_entry.shelf' | 'library_entry.shelf_types';
  parameters: Readonly<Record<string, string | number | boolean | null>>;
};

/** Binds account, selected state, type, order and direction. Pure; a cursor never crosses any of them. */
export function shelfCursorScope(
  accountId: string,
  query: Pick<ShelfQuery, 'state' | 'type' | 'orderBy' | 'direction'>,
): ShelfCursorScope {
  return {
    operation: 'library_entry.shelf',
    parameters: {
      accountId,
      state: query.state,
      type: query.type,
      orderBy: query.orderBy,
      direction: query.direction,
    },
  };
}

export function shelfTypeCursorScope(accountId: string): ShelfCursorScope {
  return { operation: 'library_entry.shelf_types', parameters: { accountId } };
}

// --- Reader ---------------------------------------------------------------------------------------------------

/** One bounded statement set: at most `limit + 1` entry rows and one active-session probe per returned entry. */
export type ShelfRows = { entries: ShelfEntry[]; more: boolean };

export interface ShelfReader {
  /** Reads inside the caller's repeatable-read transaction. Never counts, sorts or groups beyond the page. */
  page(
    client: Client,
    route: number,
    accountId: string,
    query: ShelfQuery,
    after: ShelfSeek | null,
  ): Promise<ShelfRows>;
  summary(client: Client, route: number, accountId: string, type: string | null): Promise<ShelfSummary>;
  types(
    client: Client,
    route: number,
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<ShelfTypeCount[]>;
}

export type ShelfReads = {
  listShelf(actor: Actor, query: unknown): Promise<ShelfPage>;
  summary(actor: Actor, input: { type?: string }): Promise<ShelfSummary>;
  listTypes(actor: Actor, input: { cursor?: string; limit?: number }): Promise<ShelfTypePage>;
};

export type ShelfReadDependencies = {
  reader: ShelfReader;
  cursors: ShelfCursorCodec;
};

/**
 * Domain-level read service. `listShelf` requires `library_entry:list` and `progress_session:list`; the other two
 * require `library_entry:list` only. It admits the owner as `listEntries` does and reads at repeatable read.
 */
export function createShelfReads(_dependencies: ShelfReadDependencies): ShelfReads {
  return {
    listShelf: () => notImplemented('listShelf'),
    summary: () => notImplemented('summary'),
    listTypes: () => notImplemented('listTypes'),
  };
}

// --- Storage and writes (stubs) -------------------------------------------------------------------------------

export function createShelfHeads(): ShelfHeads {
  return { ensure: () => notImplemented('ShelfHeads.ensure') };
}

export function createProgressActivity(): ProgressActivity {
  return { touch: () => notImplemented('ProgressActivity.touch') };
}

export function createShelfCounters(): ShelfCounters {
  return {
    transition: () => notImplemented('ShelfCounters.transition'),
    collection: () => notImplemented('ShelfCounters.collection'),
  };
}

/** Maintenance only: recomputes one account's counters from its entries under the counter lock. */
export function rebuildShelfCounters(_write: ShelfWrite): Promise<{ rows: number }> {
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

export function shelfTypeVerifyWorkflowId(accountId: string, subjectId: string): string {
  return `shelf-type-verify:${accountId}:${subjectId}`;
}

/** Source of the current primary type: semantic's `readItemTypes` (visible rows only, at most 256 ids). */
export type ShelfTypeSource = (ids: readonly string[]) => Promise<Map<string, string>>;

/**
 * Both source events. `revised`: the entries whose type source is `subjectId` take its current type. `merged`: the
 * entries whose type source is the merged-away `subjectId` take the survivor's current type and the survivor as their
 * new type source, so later revisions of the survivor reach them.
 */
export type ShelfTypeChange =
  | { kind: 'revised'; subjectId: string; revision: number }
  | { kind: 'merged'; subjectId: string; survivorId: string };

export type ShelfRetypePage = { accounts: number; entries: number; next: { route: number; accountId: string } | null };

/**
 * One workflow step: retypes at most `limit` entries of one partition whose type differs, in one transaction per
 * account route group, and adjusts the counters of each touched account in the same transaction.
 */
export function retypeShelfEntries(
  _client: Client,
  _partition: number,
  _change: ShelfTypeChange,
  _type: string,
  _after: { route: number; accountId: string } | null,
  _limit: number,
): Promise<ShelfRetypePage> {
  return notImplemented('retypeShelfEntries');
}

/** Workflow entry: reads the current type once, then walks the partitions that exist, one bounded page per step. */
export function syncShelfSubjectType(_change: ShelfTypeChange, _source: ShelfTypeSource): Promise<void> {
  return notImplemented('syncShelfSubjectType');
}

/** Post-commit check of one new entry against the current type. Closes the race with a type change. */
export function verifyShelfEntryType(_accountId: string, _subjectId: string, _source: ShelfTypeSource): Promise<void> {
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
export function admitShelfRead(_actor: Actor, _deadline: number, _clock: () => Date): Promise<void> {
  return notImplemented('admitShelfRead');
}

export type ShelfListQuery = {
  state?: EntryState;
  orderBy?: ShelfOrder;
  direction?: ShelfDirection;
  type?: string;
  view?: 'BASIC' | 'FULL';
  limit?: number;
  cursor?: string;
};
