import type { LibraryRow } from './types.ts';

/** Collection membership belongs to an occurrence; personal status belongs to a Work. */
export const libraryRowKey = (row: LibraryRow): string => row.occurrence ?? row.work.id;

export function selectedLibraryRows(rows: readonly LibraryRow[], selected: ReadonlySet<string>): LibraryRow[] {
  return rows.filter(row => selected.has(libraryRowKey(row)));
}

/** Repeated collection members still make just one personal status command. */
export const selectedWorks = (rows: readonly LibraryRow[]): string[] => [...new Set(rows.map(row => row.work.id))];
