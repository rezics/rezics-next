import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import type { BatchStatement } from '@rezics/definitions/bulk';

/** Native read metadata is not part of a submitted statement's semantic provenance. */
function content(value: unknown): unknown {
  const row = value as BatchStatement;
  const snak = (part: Pick<BatchStatement, 'property' | 'value'>) => ({
    property: { id: typeof part.property === 'string' ? part.property : part.property.id },
    value: part.value,
  });
  return {
    ...snak(row),
    qualifiers: (row.qualifiers ?? []).map(snak),
    references: (row.references ?? []).map((reference) => ({ parts: reference.parts.map(snak) })),
  };
}

export function sameStatementProvenance(actual: unknown, expected: unknown): boolean {
  try {
    // Keep the importer's bounded descriptor-only admission before reading projected fields.
    sourceDigest(actual);
    sourceDigest(expected);
    return sourceDigest(content(actual)) === sourceDigest(content(expected));
  } catch {
    return false;
  }
}
