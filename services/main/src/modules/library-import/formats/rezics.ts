import { FILE_IMPORT_COST, FileImportInvalid, type CanonicalRow } from './contract.ts';
import { importRowBudget } from './bounds.ts';

/** Our portable owner bundle; pages may be imported individually or joined as
 * {profile, rows}. Snapshot/cursor fields do not become another account's authority. */
export function parseRezics(file: string): CanonicalRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(file); } catch { throw new FileImportInvalid('Malformed REZICS export JSON'); }
  if (!parsed || typeof parsed !== 'object' || !('profile' in parsed) || parsed.profile !== 'rezics-library-export-v1'
    || !('rows' in parsed) || !Array.isArray(parsed.rows)) {
    throw new FileImportInvalid('Choose a rezics-library-export-v1 bundle');
  }
  if (!parsed.rows.length || parsed.rows.length > FILE_IMPORT_COST.rows) throw new FileImportInvalid('Choose a file with 1 to 5,000 rows');
  const admit = importRowBudget();
  return parsed.rows.map(row => {
    if (!row || typeof row !== 'object') throw new FileImportInvalid('File contains an invalid row');
    return admit(row as CanonicalRow);
  });
}
