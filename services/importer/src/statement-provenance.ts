import { sourceDigest } from '@rezics/conversion/support';
import type { BatchStatement } from '@rezics/definitions/bulk';

/** Native read metadata is not part of a submitted statement's semantic provenance. */
function content(value: unknown) {
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

/** Content stores an imported synopsis as a locator and the SHA-256 of the normalized document JSON. */
export function showcaseStatementMatches(actual: unknown, expected: BatchStatement): boolean {
  if (expected.property.id !== 'schema:abstract') return sameStatementProvenance(actual, expected);
  try {
    sourceDigest(actual);
    sourceDigest(expected);
    const reviewed = content(actual);
    const submitted = content(expected);
    const stored = reviewed.value.type === 'value' ? reviewed.value.content : null;
    const authored = submitted.value.type === 'value' ? submitted.value.content : null;
    if (isObject(stored) && typeof stored.document === 'string' && isObject(authored) && isObject(authored.document)) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(stored.document)) return false;
      submitted.value = {
        type: 'value',
        content: { document: stored.document, digest: sourceDigest(authored.document), language: authored.language },
      };
    }
    return sourceDigest(reviewed) === sourceDigest(submitted);
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
