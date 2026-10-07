import { emptyRow, FileImportInvalid, type CanonicalRow } from './contract.ts';
import { csvRecords, sourceDate, sourceIsbn, sourceShelves } from './csv.ts';
import { importRowBudget } from './bounds.ts';

/** Reader's Export Library CSV: https://www.goodreads.com/review/import
 * and https://help.goodreads.com/s/question/0D51H00005hWFXaSAO
 * checked 2026-10-01; the help article currently returns 404. */
export function parseGoodreads(file: string): CanonicalRow[] {
  const { records, headers } = csvRecords(file);
  if (!headers.includes('Title') || !headers.includes('Exclusive Shelf')) throw new FileImportInvalid('Choose a Goodreads library export');
  const admit = importRowBudget();
  return records.map((raw, index) => {
    if (!raw.Title?.trim()) throw new FileImportInvalid(`CSV row ${index + 2} needs a title`);
    const row = emptyRow(raw['Book Id'] || String(index + 2), raw.Title.trim(), raw);
    row.creators = raw.Author?.trim() ? [raw.Author.trim()] : [];
    const isbn = sourceIsbn(raw.ISBN13 ?? '') ?? sourceIsbn(raw.ISBN ?? '');
    row.identifiers = isbn ? [{ provider: 'isbn13', value: isbn }] : [];
    row.shelves = sourceShelves(raw.Bookshelves ?? '');
    const status = raw['Exclusive Shelf']?.toLowerCase();
    row.status = status === 'read' ? 'read' : status === 'currently-reading' ? 'reading'
      : status === 'to-read' ? 'want-to-read' : null;
    if ([status, ...row.shelves.map(v => v.toLowerCase())].some(v => ['dnf', 'dropped', 'did-not-finish'].includes(v ?? ''))) row.status = 'dnf';
    row.startedOn = sourceDate(raw['Date Started'] ?? ''); row.finishedOn = sourceDate(raw['Date Read'] ?? '');
    const rating = Number(raw['My Rating']);
    if (rating >= 1 && rating <= 5) row.score = { value: rating, min: 1, max: 5, step: 1 };
    if (raw['My Review']?.trim()) row.review = { text: raw['My Review'].trim(), language: 'und', spoiler: false };
    const count = Number(raw['Read Count']);
    if (raw['Read Count']?.trim() && Number.isSafeInteger(count) && count >= 0) row.readCount = count;
    return admit(row);
  });
}
