import { Value } from 'typebox/value';
import { canonicalRow, FILE_IMPORT_COST, FileImportInvalid, FileImportUnsupported,
  type CanonicalRow, type CsvMapping, type LibraryFileFormat, type FormatAdapter } from './contract.ts';
import { parseGoodreads } from './goodreads.ts';
import { parseStoryGraph } from './storygraph.ts';
import { parseGenericCsv } from './generic-csv.ts';
import { parseRezics } from './rezics.ts';
import { parseVndb } from './vndb.ts';

/** XML adapters use this same interface once the maintained parser is declared. */
export const adapters: Partial<Record<LibraryFileFormat, FormatAdapter>> = {
  goodreads: parseGoodreads, storygraph: parseStoryGraph, 'generic-csv': parseGenericCsv, rezics: parseRezics, vndb: parseVndb,
};
export function parseLibraryFile(format: LibraryFileFormat, file: string, mapping?: CsvMapping): CanonicalRow[] {
  if (new TextEncoder().encode(file).length > FILE_IMPORT_COST.bytes) throw new FileImportInvalid('File exceeds 2 MiB');
  const adapter = adapters[format];
  if (!adapter) throw new FileImportUnsupported('MyAnimeList imports are not available yet');
  const rows = adapter(file, mapping);
  if (!rows.length || rows.length > FILE_IMPORT_COST.rows) throw new FileImportInvalid('Choose a file with 1 to 5,000 rows');
  if (rows.some(row => !Value.Check(canonicalRow, row))) throw new FileImportInvalid('File contains an invalid or oversized row');
  // Each source record must remain exportable with its private decision evidence.
  // Portable retained rows already include that envelope and may fill a page.
  if (rows.some(row => new TextEncoder().encode(JSON.stringify(row)).length
    > (row.kind === 'retained' ? FILE_IMPORT_COST.bytes - 16384 : FILE_IMPORT_COST.rowBytes))) {
    throw new FileImportInvalid('A source row is too large to preserve in an export page');
  }
  return rows;
}
