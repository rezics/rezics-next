import type { KernelClient } from '@rezics/client';
import { libraryFullQuery } from '../reads';
import {
  receiveEntry,
  receivePage,
  receiveReview,
  type CurrentEntry,
  type EntryStatePage,
  type EntryStateReview,
} from './contract';

export type HistoryRead<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'missing' | 'stale' | 'retired' | 'denied' | 'unavailable' };
export type RestoreCommand = {
  subjectId: string;
  changeRevision: number;
  incarnationId: string;
  currentRevision: number;
  key: string;
};
export type RestoreResult =
  | { kind: 'recorded'; entry: CurrentEntry }
  | { kind: 'stale' | 'state_unavailable' | 'unchanged' | 'missing' | 'retired' | 'denied' | 'rejected' | 'uncertain' };

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const outer = error as Record<string, unknown>;
  const inner = outer.value && typeof outer.value === 'object' ? outer.value as Record<string, unknown> : outer;
  return typeof inner.code === 'string' ? inner.code : null;
}

function readFailure(status: number, error: unknown): Exclude<HistoryRead<never>, { kind: 'ready' }> {
  if (status === 404) return { kind: 'missing' };
  if (status === 401) return { kind: 'retired' };
  if (status === 403) return { kind: 'denied' };
  if (codeOf(error) === 'stale_cursor') return { kind: 'stale' };
  return { kind: 'unavailable' };
}

export async function listEntryStateHistory(
  client: KernelClient,
  authorization: string,
  subjectId: string,
  cursor?: string,
  limit = 20,
): Promise<HistoryRead<EntryStatePage>> {
  try {
    const result = await client.libraryEntries({ subjectId }).stateHistory.get({
      query: { limit, ...(cursor === undefined ? {} : { cursor }) },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error) return readFailure(result.status, result.error);
    const page = receivePage(result.data);
    return page && page.changes.length <= limit ? { kind: 'ready', value: page } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function reviewEntryStateChange(
  client: KernelClient,
  authorization: string,
  subjectId: string,
  changeRevision: number,
): Promise<HistoryRead<EntryStateReview>> {
  try {
    const result = await client.libraryEntries({ subjectId }).stateHistory({ changeRevision }).get({
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error) return readFailure(result.status, result.error);
    const review = receiveReview(result.data);
    return review ? { kind: 'ready', value: review } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The same command object supplies every deliberate replay after an uncertain result. */
export async function restoreEntryState(
  client: KernelClient,
  authorization: string,
  command: RestoreCommand,
): Promise<RestoreResult> {
  try {
    const headers = { authorization, 'idempotency-key': JSON.stringify(command.key) };
    const result = await client
      .libraryEntries({ subjectId: command.subjectId })
      .stateHistory({ changeRevision: command.changeRevision })
      .$restore.post(
        { incarnationId: command.incarnationId, currentRevision: command.currentRevision },
        {
          headers,
          fetch: { cache: 'no-store', redirect: 'manual' },
        },
      );
    if (!result.error) {
      const entry = receiveEntry(result.data?.libraryEntry, command.subjectId);
      return entry &&
        entry.incarnationId === command.incarnationId &&
        entry.revision > command.currentRevision
        ? { kind: 'recorded', entry }
        : { kind: 'uncertain' };
    }
    if (result.status >= 500) return { kind: 'uncertain' };
    if (result.status === 404) return { kind: 'missing' };
    if (result.status === 401) return { kind: 'retired' };
    if (result.status === 403) return { kind: 'denied' };
    if (result.status === 409) {
      switch (codeOf(result.error)) {
        case 'library_entry_state_restore_stale': return { kind: 'stale' };
        case 'library_entry_state_restore_unavailable': return { kind: 'state_unavailable' };
        case 'library_entry_state_restore_unchanged': return { kind: 'unchanged' };
      }
    }
    return { kind: 'rejected' };
  } catch {
    // A transport failure can follow the native commit. Only the original key and operands may be retried.
    return { kind: 'uncertain' };
  }
}

export async function readCurrentEntry(
  client: KernelClient,
  authorization: string,
  subjectId: string,
): Promise<HistoryRead<CurrentEntry>> {
  try {
    const result = await client.libraryEntries({ subjectId }).get({
      query: libraryFullQuery(),
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (result.error) return readFailure(result.status, result.error);
    const entry = receiveEntry(result.data?.libraryEntry, subjectId);
    return entry ? { kind: 'ready', value: entry } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
