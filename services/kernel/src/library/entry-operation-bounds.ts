import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import page from './entry-state-history-page.sql';

/** Existing public page and per-subject retained-history limits. */
export const ENTRY_STATE_HISTORY_PAGE_LIMIT = 50;
export const ENTRY_STATE_HISTORY_RETAINED_LIMIT = 64;

type PageInput = Parameters<typeof page.run>[1];

const byteWork = (bytes: number): Bound => declareBound({
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

// JSON escaping is at most six bytes per character. States are 64 ASCII characters;
// command kind is one of the two native state-history writers. PostgreSQL integer
// text has at most eleven characters, UUID text 36, boolean text five. Reserve 64
// characters for the full PostgreSQL timestamptz range, timezone and BC suffix.
const projectedRow = {
  revision: -2147483648,
  priorRevision: -2147483648,
  beforeState: '\u0000'.repeat(64),
  afterState: '\u0000'.repeat(64),
  commandId: 'f'.repeat(36),
  commandKind: '\u0000'.repeat('library.entry.state.restore'.length),
  changedAt: '\u0000'.repeat(64),
  coverageComplete: false,
};
const rowBytes = Buffer.byteLength(JSON.stringify(projectedRow)) + 1;

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
    byteWork(Buffer.byteLength(page.sql)),
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
