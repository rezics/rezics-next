import type { SubjectRead } from '@rezics/client';

export const SELECTED_SYNOPSIS_PROPERTY = 'schema:abstract';
export const SELECTED_SYNOPSIS_VISIT_ADDRESS_BYTE_CAP = 2048;

/** Catalogue-owned selection operands. Visit admission stays on the existing Sources seam. */
export type SelectedSynopsisSelection = {
  candidateId: string;
  documentId: string;
  digest: string;
  language: string;
  locale: string;
  context?: string;
  realm?: string;
  release?: string;
  subjectRelease?: string;
  source?: string;
  expanded?: boolean;
  focus?: 'reading' | 'evidence';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map browser visit intent to the released Subject HTTP query, preserving every comparison operand. */
export function selectedSynopsisQuery(selection: SelectedSynopsisSelection): string | undefined {
  // External fragments also serve ordinary return navigation, whose release token grammar is broader.
  // A token such as "old" cannot address a Definitions release on the Subject operation.
  const releaseDigest = /^sha256:[0-9a-f]{64}$/;
  if (
    !selection.subjectRelease ||
    !releaseDigest.test(selection.subjectRelease) ||
    (selection.release !== undefined && !releaseDigest.test(selection.release))
  )
    return;
  return JSON.stringify({
    statement: selection.candidateId,
    document: selection.documentId,
    digest: selection.digest,
    language: selection.language,
    context: selection.context,
    release: selection.subjectRelease,
    ...(selection.release ? { pageRelease: selection.release } : {}),
  });
}

const closed = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).every((key) => keys.includes(key));

/** Native HTTP transport is external input, including its optional selected component. */
export function selectedSynopsisResponse(value: unknown): value is NonNullable<SubjectRead['selectedSynopsis']> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!isRecord(value)) return false;
  if (value.kind !== 'matched')
    return ['changed', 'missing', 'unsupported', 'unavailable'].includes(String(value.kind)) && closed(value, ['kind']);
  if (
    !closed(value, ['kind', 'fact', 'context', 'release']) ||
    typeof value.context !== 'string' ||
    typeof value.release !== 'string' ||
    !isRecord(value.fact)
  )
    return false;
  const fact = value.fact;
  const snak = (part: unknown): boolean => {
    if (
      !isRecord(part) ||
      !isRecord(part.property) ||
      !isRecord(part.value) ||
      !closed(part.property, ['id', 'data_type']) ||
      typeof part.property.id !== 'string' ||
      typeof part.property.data_type !== 'string'
    )
      return false;
    if (part.value.type === 'value')
      return (
        closed(part.value, ['type', 'content']) &&
        Object.hasOwn(part.value, 'content') &&
        part.property.data_type !== 'document' &&
        part.property.data_type !== 'media'
      );
    return ['somevalue', 'novalue'].includes(String(part.value.type)) && closed(part.value, ['type']);
  };
  const part = (value: unknown) => isRecord(value) && closed(value, ['property', 'value']) && snak(value);
  return (
    closed(fact, ['id', 'rank', 'property', 'value', 'qualifiers', 'references']) &&
    typeof fact.id === 'string' &&
    uuid.test(fact.id) &&
    ['normal', 'preferred'].includes(String(fact.rank)) &&
    snak(fact) &&
    isRecord(fact.property) &&
    fact.property.id === SELECTED_SYNOPSIS_PROPERTY &&
    fact.property.data_type === 'document' &&
    isRecord(fact.value) &&
    fact.value.type === 'somevalue' &&
    Array.isArray(fact.qualifiers) &&
    fact.qualifiers.length <= 16 &&
    fact.qualifiers.every(part) &&
    Array.isArray(fact.references) &&
    fact.references.length <= 16 &&
    fact.references.every(
      (reference) =>
        isRecord(reference) &&
        closed(reference, ['hash', 'parts']) &&
        typeof reference.hash === 'string' &&
        Array.isArray(reference.parts) &&
        reference.parts.length <= 16 &&
        reference.parts.every(part),
    )
  );
}
