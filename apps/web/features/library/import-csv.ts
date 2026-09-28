/** Browser-side parsing keeps the export off the server until the reader confirms selected rows. */
export const LIBRARY_IMPORT_COST = { bytes: 2 * 1024 * 1024, rows: 5_000, columns: 64,
  cellCharacters: 20_000, shelvesPerRow: 20 } as const;

export type LibraryImportFormat = 'goodreads' | 'storygraph';
export interface ImportedBook {
  row: number;
  sourceId: string;
  title: string;
  author: string;
  isbn: string | null;
  status: 'want-to-read' | 'reading' | 'read' | null;
  shelves: string[];
  rating: number | null;
  startedOn: string | null;
  finishedOn: string | null;
  review: string | null;
}
export interface ParsedLibraryImport { format: LibraryImportFormat; books: ImportedBook[] }
export class LibraryImportInvalid extends Error {}

function records(csv: string): string[][] {
  if (new TextEncoder().encode(csv).length > LIBRARY_IMPORT_COST.bytes) {
    throw new LibraryImportInvalid('Export exceeds 2 MiB');
  }
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted) quoted = false;
      else if (!cell) quoted = true;
      else throw new LibraryImportInvalid('Malformed CSV quote');
    } else if (ch === ',' && !quoted) {
      row.push(cell); cell = '';
      if (row.length >= LIBRARY_IMPORT_COST.columns) throw new LibraryImportInvalid('Too many columns');
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && csv[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      if (rows.length > LIBRARY_IMPORT_COST.rows + 1) throw new LibraryImportInvalid('Too many books');
    } else {
      cell += ch;
      if (cell.length > LIBRARY_IMPORT_COST.cellCharacters) throw new LibraryImportInvalid('Cell is too long');
    }
  }
  if (quoted) throw new LibraryImportInvalid('Unclosed CSV quote');
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

const date = (raw: string): string | null => {
  const value = raw.trim().replaceAll('/', '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
};
const isbn = (raw: string): string | null => {
  const value = raw.replace(/^="?/, '').replace(/"$/, '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return /^\d{13}$|^\d{9}[\dX]$/.test(value) ? value : null;
};
const rating = (raw: string): number | null => {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 && value <= 5 ? value : null;
};
const review = (raw: string): string | null => {
  const text = raw.trim();
  if (text.length > 8_000) throw new LibraryImportInvalid('A review exceeds 8,000 characters');
  return text || null;
};
const shelves = (raw: string) => [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))]
  .slice(0, LIBRARY_IMPORT_COST.shelvesPerRow);

/** Supports the named columns in exports from both services; unknown columns stay untouched. */
export function parseLibraryImport(csv: string): ParsedLibraryImport {
  const rows = records(csv.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new LibraryImportInvalid('The CSV has no books');
  const header = rows[0]!.map(value => value.trim().toLowerCase());
  if (new Set(header).size !== header.length) throw new LibraryImportInvalid('Duplicate CSV column');
  const format: LibraryImportFormat = header.includes('exclusive shelf') ? 'goodreads'
    : header.includes('read status') ? 'storygraph'
      : (() => { throw new LibraryImportInvalid('Choose a Goodreads or StoryGraph export'); })();
  const pick = (row: string[], name: string) => row[header.indexOf(name)]?.trim() ?? '';
  if (!header.includes('title') || !header.includes(format === 'goodreads' ? 'author' : 'authors')) {
    throw new LibraryImportInvalid('Title and author columns are required');
  }
  const books = rows.slice(1).map((row, index): ImportedBook => {
    if (row.length > header.length) throw new LibraryImportInvalid(`Row ${index + 2} has too many columns`);
    const title = pick(row, 'title'), author = pick(row, format === 'goodreads' ? 'author' : 'authors');
    if (!title || !author) throw new LibraryImportInvalid(`Row ${index + 2} needs a title and author`);
    const statusText = pick(row, format === 'goodreads' ? 'exclusive shelf' : 'read status').toLowerCase();
    const status = ['read', 'to-read', 'currently-reading'].includes(statusText)
      ? statusText === 'to-read' ? 'want-to-read' as const : statusText === 'currently-reading' ? 'reading' as const
        : 'read' as const
      : statusText === 'want to read' ? 'want-to-read' as const
        : statusText === 'currently reading' ? 'reading' as const : null;
    const range = pick(row, 'dates read').match(/(\d{4}[/-]\d{2}[/-]\d{2})\s*(?:-|to)\s*(\d{4}[/-]\d{2}[/-]\d{2})/i);
    const startedOn = date(pick(row, 'date started')) ?? (range ? date(range[1]!) : null);
    const finishedOn = date(pick(row, format === 'goodreads' ? 'date read' : 'last date read'))
      ?? (range ? date(range[2]!) : null);
    return { row: index + 2, sourceId: pick(row, format === 'goodreads' ? 'book id' : 'isbn/uid')
      || `${index + 2}:${title}:${author}`, title, author,
    isbn: isbn(pick(row, format === 'goodreads' ? 'isbn13' : 'isbn/uid'))
      ?? isbn(pick(row, 'isbn')),
    status, shelves: shelves(pick(row, format === 'goodreads' ? 'bookshelves' : 'tags')),
    rating: rating(pick(row, format === 'goodreads' ? 'my rating' : 'star rating')),
    startedOn, finishedOn, review: review(pick(row, format === 'goodreads' ? 'my review' : 'review')) };
  });
  return { format, books };
}
