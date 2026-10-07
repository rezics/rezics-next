import { emptyRow, FILE_IMPORT_COST, FileImportInvalid, type CanonicalRow, type CsvMapping } from './contract.ts';
import { csvRecords, sourceDate } from './csv.ts';
import { importRowBudget } from './bounds.ts';

/** User-selected headers/statuses; RFC 4180 checked 2026-10-01.
 * No source-specific assumptions or guessed chapter-to-page conversion. */
export function inspectGenericCsv(file: string) {
  const { headers, records } = csvRecords(file);
  return { headers, distinctValues: Object.fromEntries(headers.map(header => [header,
    [...new Set(records.map(row => row[header]!))].slice(0, FILE_IMPORT_COST.statuses)])) };
}
export function parseGenericCsv(file: string, mapping?: CsvMapping): CanonicalRow[] {
  if (!mapping) throw new FileImportInvalid('Choose a title column and status mapping');
  const { headers, records } = csvRecords(file);
  for (const name of [mapping.title, mapping.author, mapping.status, mapping.progress, mapping.startedOn, mapping.finishedOn]) {
    if (name !== undefined && !headers.includes(name)) throw new FileImportInvalid(`CSV column ${name} is missing`);
  }
  const admit = importRowBudget();
  return records.map((raw, index) => {
    const title = raw[mapping.title]!.trim();
    if (!title) throw new FileImportInvalid(`CSV row ${index + 2} needs a title`);
    const row = emptyRow(String(index + 2), title, raw);
    row.creators = mapping.author && raw[mapping.author]?.trim() ? [raw[mapping.author]!.trim()] : [];
    const status = mapping.status ? raw[mapping.status]! : '';
    row.status = mapping.status && Object.hasOwn(mapping.statuses,status) ? mapping.statuses[status] ?? null : null;
    row.startedOn = mapping.startedOn ? sourceDate(raw[mapping.startedOn]!) : null;
    row.finishedOn = mapping.finishedOn ? sourceDate(raw[mapping.finishedOn]!) : null;
    const p = mapping.progress ? raw[mapping.progress]!.trim() : '';
    if (/^\d+(?:\.\d+)?%$/.test(p) && Number(p.slice(0, -1)) <= 100) row.progress = { unit: 'percentage', value: Number(p.slice(0, -1)) };
    else if (mapping.progressUnit && /^\d+(?:\.\d+)?$/.test(p)) {
      const value = Number(p), unit = mapping.progressUnit;
      if (unit === 'page' ? Number.isSafeInteger(value) : value <= 100) row.progress = { unit, value };
    }
    return admit(row);
  });
}
