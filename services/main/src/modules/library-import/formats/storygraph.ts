import { emptyRow, FileImportInvalid, type CanonicalRow } from './contract.ts';
import { csvRecords, sourceDate, sourceIsbn, sourceShelves } from './csv.ts';
import { importRowBudget } from './bounds.ts';

/** Reader's Manage Account data export: https://app.thestorygraph.com/manage-account
 * https://thestorygraph.freshdesk.com/support/solutions/articles/79000142013
 * checked 2026-10-01; account exports require sign-in. Unknown fields remain private. */
export function parseStoryGraph(file: string): CanonicalRow[] {
  const { headers, records } = csvRecords(file);
  if (!headers.includes('Title') || !headers.includes('Read Status')) throw new FileImportInvalid('Choose a StoryGraph export');
  const admit = importRowBudget();
  return records.map((raw, index) => {
    if (!raw.Title?.trim()) throw new FileImportInvalid(`CSV row ${index + 2} needs a title`);
    const row = emptyRow(raw['ISBN/UID'] || String(index + 2), raw.Title.trim(), raw);
    row.creators = raw.Authors?.trim() ? raw.Authors.split(',').map(v => v.trim()) : [];
    const isbn = sourceIsbn(raw['ISBN/UID'] ?? '');
    row.identifiers = isbn ? [{ provider: 'isbn13', value: isbn }] : [];
    const statuses = { read: 'read', 'to-read': 'want-to-read', 'want to read': 'want-to-read',
      'currently-reading': 'reading', 'currently reading': 'reading', paused: 'paused', dnf: 'dnf', 'did not finish': 'dnf' } as const;
    const status = raw['Read Status']?.toLowerCase() ?? '';
    row.status = Object.hasOwn(statuses,status) ? statuses[status as keyof typeof statuses] : null;
    row.shelves = sourceShelves(raw.Tags ?? '');
    const range = (raw['Dates Read'] ?? '').match(/(\d{4}[/-]\d{2}[/-]\d{2})\s*(?:-|to)\s*(\d{4}[/-]\d{2}[/-]\d{2})/);
    row.startedOn = sourceDate(raw['Date Started'] ?? range?.[1] ?? '');
    row.finishedOn = sourceDate(raw['Last Date Read'] ?? range?.[2] ?? '');
    const rating = Number(raw['Star Rating']);
    if (rating >= 0.25 && rating <= 5) row.score = { value: rating, min: 0.25, max: 5, step: 0.25 };
    if (raw.Review?.trim()) row.review = { text: raw.Review.trim(), language: 'und', spoiler: false };
    const count = Number(raw['Read Count']);
    if (raw['Read Count']?.trim() && Number.isSafeInteger(count) && count >= 0) row.readCount = count;
    return admit(row);
  });
}
