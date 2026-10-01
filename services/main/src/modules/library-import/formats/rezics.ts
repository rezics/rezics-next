import { Value } from 'typebox/value';
import { canonicalRow, FileImportInvalid, type CanonicalRow } from './contract.ts';

/** Our portable owner bundle; pages may be imported individually or joined as
 * {profile, rows}. Snapshot/cursor fields do not become another account's authority. */
export function parseRezics(file: string): CanonicalRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(file); } catch { throw new FileImportInvalid('Malformed REZICS export JSON'); }
  if (!parsed || typeof parsed !== 'object' || !('profile' in parsed) || parsed.profile !== 'rezics-library-export-v1'
    || !('rows' in parsed) || !Array.isArray(parsed.rows) || parsed.rows.some(row => !Value.Check(canonicalRow, row))) {
    throw new FileImportInvalid('Choose a rezics-library-export-v1 bundle');
  }
  return parsed.rows as CanonicalRow[];
}
