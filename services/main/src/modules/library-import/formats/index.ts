import { FILE_IMPORT_COST, FileImportInvalid, FileImportUnsupported,
  type CanonicalRow, type CsvMapping, type LibraryFileFormat, type FormatAdapter } from './contract.ts';
import { parseGoodreads } from './goodreads.ts';
import { parseStoryGraph } from './storygraph.ts';
import { parseGenericCsv } from './generic-csv.ts';
import { parseRezics } from './rezics.ts';
import { parseVndb } from './vndb.ts';
import { parseMal } from './mal.ts';
import { importRowBudget } from './bounds.ts';

export const adapters: Record<LibraryFileFormat, FormatAdapter> = {
  goodreads: parseGoodreads, storygraph: parseStoryGraph, 'generic-csv': parseGenericCsv, rezics: parseRezics, vndb: parseVndb, mal: parseMal,
};
export function parseLibraryFile(format: LibraryFileFormat, file: string, mapping?: CsvMapping): CanonicalRow[] {
  if (new TextEncoder().encode(file).length > FILE_IMPORT_COST.bytes) throw new FileImportInvalid('File exceeds 2 MiB');
  const adapter = adapters[format];
  if (!adapter) throw new FileImportUnsupported('Unsupported library file format');
  const rows = adapter(file, mapping);
  if (!rows.length || rows.length > FILE_IMPORT_COST.rows) throw new FileImportInvalid('Choose a file with 1 to 5,000 rows');
  const admit = importRowBudget();
  for (const row of rows) admit(row);
  return rows;
}
