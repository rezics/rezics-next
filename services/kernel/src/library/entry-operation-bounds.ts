import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import { currentCommandWorkAssociation } from '../command/work.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import page from './entry-state-history-page.sql';
import entryPage from './entry-store-entry-page.sql';
import entryRead from './entry-store-entry-read.sql';
import historyRead from './entry-state-history-read.sql';
import partitionEpochRead from './entry-partition-epoch-read.sql';
import migrationPhaseRead from './entry-profile-migration-phase-read.sql';

/** Existing public page and per-subject retained-history limits. */
export const ENTRY_STATE_HISTORY_PAGE_LIMIT = 50;
export const ENTRY_STATE_HISTORY_RETAINED_LIMIT = 64;

type PageInput = Parameters<typeof page.run>[1];

const byteWork = (bytes: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes,
    engineRequests: 0,
  });

// The state history SQL returns two 64-character states, two signed integer revisions,
// one UUID, one fixed command kind, one PostgreSQL timestamp and one boolean.
const projectedHistoryRow = {
  revision: -2147483648,
  priorRevision: -2147483648,
  beforeState: '\u0000'.repeat(64),
  afterState: '\u0000'.repeat(64),
  commandId: 'f'.repeat(36),
  commandKind: '\u0000'.repeat('library.entry.state.restore'.length),
  changedAt: '\u0000'.repeat(64),
  coverageComplete: false,
};
const rowBytes = Buffer.byteLength(JSON.stringify(projectedHistoryRow)) + 1;

type EntryOperationKind =
  | 'library.entry.read'
  | 'library.entry.list'
  | 'library.entry.state-history'
  | 'library.entry.state-review';

/** Immutable direct Entry SQL declaration consumed at the existing native association boundary. */
export type EntryOperationPlan = Readonly<{
  kind: EntryOperationKind;
  serializedInput: string;
  direct: Bound;
  native: Readonly<{ dimensions: WorkDimensions; engineRequests: 0 }>;
}>;

type Statement = Readonly<{
  sql: string;
  nativeRows: number;
  outputBytes: number;
  bindBytes: number;
  candidates?: number;
  points?: number;
  emptySeeks?: number;
}>;

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized ?? 'null');
}

// The accepting Type is carried from the bounded canonical release artifact. JSON escaping can
// expand one UTF-8 source byte to at most six JSON bytes; profile IDs themselves are at most 64.
function profilePinBytes() {
  return memoizedValue(
    profilePinBytes,
    () =>
      Buffer.byteLength(
        JSON.stringify({
          provenance: 'profile',
          releaseDigest: `sha256:${'f'.repeat(64)}`,
          acceptingType: '',
          profileId: '',
        }),
      ) +
      RELEASE_LIMITS.bytes * 6 +
      64 * 6,
  );
}

function entryProjectionBytes() {
  return memoizedValue(
    entryProjectionBytes,
    () =>
      Buffer.byteLength(
        JSON.stringify({
          route: 2147483647,
          accountId: 'f'.repeat(36),
          subjectId: 'f'.repeat(36),
          requestedSubjectId: 'f'.repeat(36),
          incarnationId: 'f'.repeat(36),
          state: '\u0000'.repeat(64),
          revision: -2147483648,
          createdAt: '\u0000'.repeat(64),
          updatedAt: '\u0000'.repeat(64),
          transactionId: 'f'.repeat(36),
          libraryProfilePin: null,
        }),
      ) + profilePinBytes(),
  );
}

const partitionProjectionBytes = jsonBytes({ epoch: 2147483647 });
const migrationProjectionBytes = jsonBytes({ phase: 'legacy' });
function stateChangeProjectionBytes() {
  return memoizedValue(stateChangeProjectionBytes, () => rowBytes + profilePinBytes() * 2);
}

function statement(inputBytes: number, item: Statement): Bound {
  return declareBound({
    candidateKeys: item.candidates ?? 1,
    nativeRows: item.nativeRows,
    identityMetadataRows: 0,
    emptySeeks: item.emptySeeks ?? 1,
    nativePoints: item.points ?? 1,
    witnessKeys: 0,
    statements: 1,
    bytes: statementBytes(item) + inputBytes + item.bindBytes + item.outputBytes,
    engineRequests: 0,
  });
}

function statements(inputBytes: number, items: readonly Statement[]): Bound {
  return sumBounds(...items.map((item) => statement(inputBytes, item)));
}

const pointBindBytes = jsonBytes({ route: 2147483647, account_id: 'f'.repeat(36), subject_id: 'f'.repeat(36) });
const partitionBindBytes = jsonBytes({ partition_no: 2147483647 });
const legacyBindBytes = jsonBytes({ route: 2147483647, account_id: 'f'.repeat(36) });

function operationStatements(kind: EntryOperationKind, input: unknown, limit: number): readonly Statement[] {
  const historyInput = {
    route: 2147483647,
    account_id: 'f'.repeat(36),
    subject_id: 'f'.repeat(36),
    incarnation_id: 'f'.repeat(36),
    after_revision: -2147483648,
    limit,
  };
  const historyBindBytes = jsonBytes(historyInput);
  const options = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const hasCursor = typeof options.cursor === 'string';
  const listLimit = limit;
  const listBindBytes = jsonBytes({
    route: 2147483647,
    account_id: 'f'.repeat(36),
    state: '\u0000'.repeat(64),
    after_updated_at: '\u0000'.repeat(64),
    after_subject_id: 'f'.repeat(36),
    has_cursor: hasCursor,
    limit: listLimit,
  });
  switch (kind) {
    case 'library.entry.read':
      return [
        {
          sql: entryRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: pointBindBytes,
          outputBytes: entryProjectionBytes(),
        },
        {
          sql: entryRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: pointBindBytes,
          outputBytes: entryProjectionBytes(),
        },
        {
          sql: migrationPhaseRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: legacyBindBytes,
          outputBytes: migrationProjectionBytes,
        },
        {
          sql: migrationPhaseRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: legacyBindBytes,
          outputBytes: migrationProjectionBytes,
        },
      ];
    case 'library.entry.list':
      return [
        {
          sql: entryPage.sql,
          nativeRows: listLimit * (hasCursor ? 2 : 1),
          candidates: listLimit * (hasCursor ? 2 : 1),
          points: 1,
          emptySeeks: 2,
          bindBytes: listBindBytes,
          outputBytes: entryProjectionBytes() * listLimit,
        },
        {
          sql: partitionEpochRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: partitionBindBytes,
          outputBytes: partitionProjectionBytes,
        },
        {
          sql: migrationPhaseRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: legacyBindBytes,
          outputBytes: migrationProjectionBytes,
        },
      ];
    case 'library.entry.state-history':
      return [
        {
          sql: entryRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: pointBindBytes,
          outputBytes: entryProjectionBytes(),
        },
        {
          sql: migrationPhaseRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: legacyBindBytes,
          outputBytes: migrationProjectionBytes,
        },
        {
          sql: partitionEpochRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: partitionBindBytes,
          outputBytes: partitionProjectionBytes,
        },
        {
          sql: page.sql,
          nativeRows: ENTRY_STATE_HISTORY_RETAINED_LIMIT,
          candidates: limit,
          points: 1,
          bindBytes: historyBindBytes,
          outputBytes: rowBytes * Math.min(ENTRY_STATE_HISTORY_RETAINED_LIMIT, limit),
        },
      ];
    case 'library.entry.state-review':
      return [
        {
          sql: entryRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: pointBindBytes,
          outputBytes: entryProjectionBytes(),
        },
        {
          sql: migrationPhaseRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: legacyBindBytes,
          outputBytes: migrationProjectionBytes,
        },
        {
          sql: historyRead.sql,
          nativeRows: 1,
          candidates: 1,
          points: 1,
          bindBytes: historyBindBytes,
          outputBytes: stateChangeProjectionBytes(),
        },
      ];
  }
}

/** Build the direct Entry SQL portion before the caller enters its native execution boundary. */
export function entryOperationPlan(
  kind: EntryOperationKind,
  input: unknown,
  limit = ENTRY_STATE_HISTORY_PAGE_LIMIT,
): EntryOperationPlan {
  const serializedInput = JSON.stringify(input) ?? 'null';
  const direct = statements(Buffer.byteLength(serializedInput), operationStatements(kind, input, limit));
  const dimensions: WorkDimensions = Object.freeze({
    candidateKeys: direct.candidateKeys,
    nativeRows: direct.nativeRows,
    identityMetadataRows: direct.identityMetadataRows,
    emptySeeks: direct.emptySeeks,
    nativePoints: direct.nativePoints,
    witnessKeys: direct.witnessKeys,
    statements: direct.statements,
    bytes: direct.bytes,
  });
  return Object.freeze({
    kind,
    serializedInput,
    direct,
    native: Object.freeze({ dimensions, engineRequests: 0 as const }),
  });
}

/** Snapshot reads reserve before dispatch and settle the original bound on success or refusal. */
export async function withEntryOperation<T>(plan: EntryOperationPlan, dispatch: () => Promise<T>): Promise<T> {
  const commandWork = currentCommandWorkAssociation();
  if (!commandWork) return dispatch();
  return commandWork.run(plan.kind, plan.native.dimensions, dispatch);
}

/** A single SQL leaf, not account admission, a transaction allowance or execution evidence. */
export type EntryHistoryPagePlan = Readonly<{
  kind: 'entry.state-history.page';
  input: Readonly<PageInput>;
  total: Bound;
}>;

/**
 * Construct before dispatch from the caller's already validated page (including its
 * sentinel). The nullable keyset predicate can discard retained rows, so LIMIT is
 * never used as the examined-row bound. The retained set has at most 64 rows across
 * all incarnations; no foreign owner or unrelated subject is scanned by this leaf.
 */
export function entryHistoryPagePlan(input: PageInput): EntryHistoryPagePlan {
  const original = Object.freeze({ ...input });
  const total = sumBounds(
    declareBound({
      candidateKeys: input.page_limit,
      nativeRows: ENTRY_STATE_HISTORY_RETAINED_LIMIT,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 0,
      // This SQL leaf makes no Search engine call.
      engineRequests: 0,
    }),
    byteWork(statementBytes(page)),
    // Include the original serialized operands independently of the output. JSON
    // names/escaping overbound the positional PostgreSQL parameter payload.
    byteWork(Buffer.byteLength(JSON.stringify(original))),
    repeatBound(byteWork(rowBytes), input.page_limit),
    byteWork(2), // JSON array delimiters, including an empty result.
  );
  return Object.freeze({ kind: 'entry.state-history.page', input: original, total });
}

/** Execute the retained operands on the caller's original authorized snapshot client. */
export function executeEntryHistoryPage(
  client: Parameters<typeof page.run>[0],
  plan: EntryHistoryPagePlan,
): ReturnType<typeof page.run> {
  return page.run(client, plan.input);
}
