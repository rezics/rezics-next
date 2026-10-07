import { type ImportApi, ImportError, type ImportRow } from './import-api.ts';

/** Where a row stands for the reader: Main's match, or the choice made on it. */
export type RowGroup = 'matched' | 'ambiguous' | 'not-found' | 'private';
export const rowGroups: readonly RowGroup[] = ['ambiguous', 'not-found', 'matched', 'private'];

export function groupOf(row: ImportRow): RowGroup {
  if (row.resolution?.choice === 'private') return 'private';
  if (row.resolution?.choice === 'apply') return 'matched';
  return row.match?.kind === 'matched' ? 'matched' : row.match?.kind === 'not-found' ? 'not-found' : 'ambiguous';
}

/** Main refuses to apply while a row has neither a match nor a choice. */
export const needsChoice = (row: ImportRow) => {
  const group = groupOf(row);
  return group === 'ambiguous' || group === 'not-found';
};

export function countGroups(rows: readonly ImportRow[]): Record<RowGroup, number> {
  const counts: Record<RowGroup, number> = { matched: 0, ambiguous: 0, 'not-found': 0, private: 0 };
  for (const row of rows) counts[groupOf(row)] += 1;
  return counts;
}

/** Main seals the reviewed choices when apply starts, so any applied row means the review is over. */
export const applyStarted = (rows: readonly ImportRow[]) => rows.some(row => row.outcome !== null);
export const applyFinished = (rows: readonly ImportRow[]) => rows.length > 0 && rows.every(row => row.outcome !== null);

export function replaceRow(rows: readonly ImportRow[], row: ImportRow): ImportRow[] {
  return rows.map(item => item.index === row.index ? row : item);
}

/** Rows are read this many pages at a time; Main matches the rows of each page it reads. */
export const PARALLEL_PAGES = 3;

/**
 * Every row of an upload. The first page shows how many rows a page holds and the cursors that follow are
 * its multiples, so the rest are read in parallel; `onRows` gets the rows so far, in order.
 */
export async function loadAllRows(api: ImportApi, id: string, total: number, onRows: (rows: ImportRow[]) => void = () => {},
  active: () => boolean = () => true, signal?: AbortSignal): Promise<ImportRow[]> {
  const first = await api.rows(id, -1, { signal });
  const found = new Map<number, ImportRow>(first.rows.map(row => [row.index, row]));
  const ordered = () => [...found.values()].sort((a, b) => a.index - b.index);
  onRows(ordered());
  const size = first.rows.length;
  const cursors: number[] = [];
  if (first.nextCursor !== null && size) for (let at = first.nextCursor; at < total - 1; at += size) cursors.push(at);
  await Promise.all(Array.from({ length: PARALLEL_PAGES }, async () => {
    while (cursors.length && active()) {
      const page = await api.rows(id, cursors.shift()!, { signal });
      for (const row of page.rows) found.set(row.index, row);
      onRows(ordered());
    }
  }));
  const rows = ordered();
  if (active() && rows.length !== total) throw new ImportError('invalid', 'Main answered fewer rows than the upload has');
  return rows;
}

/** The row Main now holds at `index`, after a choice or a conflict. */
export async function reloadRow(api: ImportApi, id: string, index: number, signal?: AbortSignal): Promise<ImportRow | undefined> {
  const page = await api.rows(id, index - 1, { signal });
  return page.rows.find(row => row.index === index);
}
