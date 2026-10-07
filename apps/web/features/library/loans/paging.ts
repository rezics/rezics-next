import type { RecordPage, RecordResult } from './types.ts';

// One list at a time, the same way an edition list continues: keep what is
// already shown, append the next page, and leave that list in place when the
// next page fails.

export interface RecordList<T> {
  items: T[];
  nextCursor: string | null;
  failed: boolean;
}

export function appendRecords<T extends { id: string }>(current: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...page.filter(item => !seen.has(item.id))];
}

/** Append one page. A failure keeps the records already listed and asks for a retry. */
export function reduceRecordPage<T extends { id: string }>(current: RecordList<T>, read: RecordResult<RecordPage<T>>):
  RecordList<T> {
  if (!read.ok) return { ...current, failed: true };
  return { items: appendRecords(current.items, read.data.items), nextCursor: read.data.nextCursor, failed: false };
}

/** Another page remains, or a failed continuation can be retried without discarding the list. */
export function recordContinuation(list: { items: readonly unknown[]; nextCursor: string | null; failed: boolean }):
  'more' | 'retry' | null {
  if (list.failed && list.items.length > 0) return 'retry';
  return list.nextCursor ? 'more' : null;
}

const empty = { items: [], nextCursor: null, failed: false };

/** Follow cursors until the list ends. Callers that show a button use `reduceRecordPage` one page at a time. */
export async function loadRecordPages<T extends { id: string }>(
  read: (cursor: string | null) => Promise<RecordResult<RecordPage<T>>>,
  bound = 50,
): Promise<RecordList<T>> {
  let list: RecordList<T> = empty;
  const seen = new Set<string>();
  for (let page = 0; page < bound; page++) {
    const readPage = await read(list.nextCursor);
    list = reduceRecordPage(list, readPage);
    if (!readPage.ok || !list.nextCursor || seen.has(list.nextCursor)) return list;
    seen.add(list.nextCursor);
  }
  return list;
}
