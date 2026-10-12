import { ImportError, type ImportRequestOptions, type ImportRow } from './import-api.ts';

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

interface RowPage<Cursor> { rows: ImportRow[]; nextCursor: Cursor | null }
/** The start sentinel belongs to ImportApi; every subsequent position belongs to Main. */
interface RowsApi<Cursor> {
  rows: (id: string, cursor: Cursor | -1, options?: ImportRequestOptions) => Promise<RowPage<Cursor>>;
}

async function* rowPages<Cursor>(api: RowsApi<Cursor>, id: string, active: () => boolean, signal?: AbortSignal) {
  let cursor: Cursor | -1 | null = -1;
  const visited = new Set<Cursor | -1>();
  while (cursor !== null && active()) {
    signal?.throwIfAborted();
    if (visited.has(cursor)) throw new ImportError('invalid', 'Main repeated an import row continuation');
    visited.add(cursor);
    const page = await api.rows(id, cursor, { signal });
    signal?.throwIfAborted();
    if (!active()) return;
    yield page;
    cursor = page.nextCursor;
  }
}

/** Every row of an upload, following Main's continuation; `onRows` receives progress in row order. */
export async function loadAllRows<Cursor>(api: RowsApi<Cursor>, id: string, total: number, onRows: (rows: ImportRow[]) => void = () => {},
  active: () => boolean = () => true, signal?: AbortSignal): Promise<ImportRow[]> {
  const found = new Map<number, ImportRow>();
  const ordered = () => [...found.values()].sort((a, b) => a.index - b.index);
  for await (const page of rowPages(api, id, active, signal)) {
    for (const row of page.rows) found.set(row.index, row);
    onRows(ordered());
  }
  const rows = ordered();
  if (active() && rows.length !== total) throw new ImportError('invalid', 'Main answered fewer rows than the upload has');
  return rows;
}

/** The row Main now holds at `index`, after a choice or a conflict. */
export async function reloadRow<Cursor>(api: RowsApi<Cursor>, id: string, index: number, signal?: AbortSignal): Promise<ImportRow | undefined> {
  for await (const page of rowPages(api, id, () => true, signal)) {
    const row = page.rows.find(row => row.index === index);
    if (row) return row;
  }
  return undefined;
}
