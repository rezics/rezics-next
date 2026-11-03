import type { PoolClient } from 'pg';
import append from './entry-state-history-append.sql';
import markIncomplete from './entry-state-history-mark-incomplete.sql';
import page from './entry-state-history-page.sql';
import prune from './entry-state-history-prune.sql';
import read from './entry-state-history-read.sql';
import readLocked from './entry-state-history-read-locked.sql';

type Client = Pick<PoolClient, 'query'>;
type OwnerKey = { route: number; accountId: string; subjectId: string; incarnationId: string };
export type EntryStateChangeRow = Awaited<ReturnType<typeof read.run>>;
export type EntryStateHistoryPageRow = Awaited<ReturnType<typeof page.run>>[number];

function key(input: OwnerKey) {
  return {
    route: input.route,
    account_id: input.accountId,
    subject_id: input.subjectId,
    incarnation_id: input.incarnationId,
  };
}

/** Capture one real native transition, then retain only the newest 64 rows for this incarnation. */
export async function captureEntryStateChange(
  client: Client,
  input: OwnerKey & {
    priorRevision: number | null;
    revision: number;
    beforeState: string | null;
    beforeProfilePin: unknown;
    afterState: string;
    afterProfilePin: unknown;
    commandId: string;
    commandKind: 'library.entry.put' | 'library.entry.state.restore';
    changedAt: string;
  },
): Promise<void> {
  const rows = await append.run(client, {
    ...key(input),
    prior_revision: input.priorRevision,
    revision: input.revision,
    before_state: input.beforeState,
    before_profile_pin: input.beforeProfilePin,
    after_state: input.afterState,
    after_profile_pin: input.afterProfilePin,
    command_id: input.commandId,
    command_kind: input.commandKind,
    changed_at: input.changedAt,
  });
  if (rows.length !== 1) throw new Error('Entry state history capture did not insert one change');
  const removed = await prune.run(client, {
    route: input.route,
    account_id: input.accountId,
    subject_id: input.subjectId,
  });
  for (const incarnationId of new Set(removed.map((row) => row.incarnationId)))
    await markIncomplete.run(client, {
      route: input.route,
      account_id: input.accountId,
      subject_id: input.subjectId,
      incarnation_id: incarnationId,
    });
}

export function pageEntryStateChanges(
  client: Client,
  input: OwnerKey & { afterRevision: number | null; limit: number },
): Promise<EntryStateHistoryPageRow[]> {
  return page.run(client, {
    ...key(input),
    after_revision: input.afterRevision,
    page_limit: input.limit,
  });
}

export async function readEntryStateChange(
  client: Client,
  input: OwnerKey & { revision: number; lock?: boolean },
): Promise<NonNullable<EntryStateChangeRow> | null> {
  const args = { ...key(input), revision: input.revision };
  return input.lock ? ((await readLocked.run(client, args)) ?? null) : ((await read.run(client, args)) ?? null);
}
