import { Value } from 'typebox/value';
import { canonicalRow, FILE_IMPORT_COST, FileImportInvalid, type CanonicalRow } from './contract.ts';

/** Count serialized evidence without building a second, potentially amplified
 * copy. Depth is checked before descending, including arbitrary private fields. */
export function importJsonBytes(value: unknown, maximum: number): number {
  let bytes = 0;
  const add = (count: number) => {
    bytes += count;
    if (bytes > maximum) throw new FileImportInvalid('Import evidence exceeds its byte budget');
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > FILE_IMPORT_COST.nesting) throw new FileImportInvalid('Import evidence nesting exceeds its budget');
    if (item && typeof item === 'object') {
      add(2);
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) { if (i) add(1); visit(item[i],depth+1); }
      } else {
        let index = 0;
        for (const [key,child] of Object.entries(item)) {
          if (child === undefined) continue;
          if (index++) add(1);
          add(Buffer.byteLength(JSON.stringify(key))+1);
          visit(child,depth+1);
        }
      }
    } else {
      add(Buffer.byteLength(JSON.stringify(item) ?? 'null'));
    }
  };
  visit(value,0);
  return bytes;
}

export function importRowBudget() {
  let count = 0, bytes = 0;
  return (row: CanonicalRow): CanonicalRow => {
    if (++count > FILE_IMPORT_COST.rows) throw new FileImportInvalid('Choose a file with 1 to 5,000 rows');
    // Portable retained rows already include their private decision envelope.
    bytes += importJsonBytes(row,row.kind === 'retained' ? FILE_IMPORT_COST.bytes-16384 : FILE_IMPORT_COST.rowBytes);
    if (bytes > FILE_IMPORT_COST.parsedBytes) throw new FileImportInvalid('Parsed import evidence exceeds its byte budget');
    if (!Value.Check(canonicalRow,row)) throw new FileImportInvalid('File contains an invalid or oversized row');
    return row;
  };
}
