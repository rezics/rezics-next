import { isRecord } from './shared';

/** Admit the whole native page before a preview limit can hide a foreign identity. */
export function relationItemRows(value: unknown, kind: 'links' | 'relations'): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return;
  const rows: Record<string, unknown>[] = [];
  for (const row of value) {
    if (!isRecord(row)) return;
    const target = kind === 'links' ? row.subject : row.target;
    // A forward row may carry only an external value, with no local subject target.
    if (!(typeof target === 'string' && target.trim()) && !(kind === 'relations' && target === null)) return;
    if (row.summary !== undefined && row.summary !== null) {
      if (!isRecord(row.summary) || row.summary.id !== target) return;
    }
    if (kind === 'links' && row.assertion !== undefined) {
      // The DTO supplies an assertion for this statement, but no holder subject on the assertion.
      if (!isRecord(row.assertion) || typeof row.statement !== 'string' || row.assertion.id !== row.statement) return;
    }
    if (kind === 'relations' && !isRecord(row.statement)) return;
    rows.push(row);
  }
  return rows;
}
