import { isCalendarDate } from '@rezics/filter';
import { SearchUnavailableError } from './opensearch.ts';
import { subjectPartition, type IndexedSubject } from './source.ts';

export const REQUEST_SOURCE_KEYS = 256;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown, valid: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value)) return false;
  // Iteration visits holes too: an incomplete record is not absence.
  for (const item of value) if (!valid(item)) return false;
  return true;
}

const term = (value: unknown) => record(value) && typeof value.language === 'string' && typeof value.value === 'string';
const pair = (value: unknown) => record(value) && typeof value.property === 'string' && typeof value.value === 'string';

function routable(value: unknown): boolean {
  return typeof value === 'string' && subjectPartition(value) >= 0;
}

function statement(value: unknown): boolean {
  if (!pair(value) || !record(value)) return false;
  if (value.qualifiers !== undefined && !list(value.qualifiers, pair)) return false;
  const facet = value.facet;
  if (facet === undefined) return true;
  if (!record(facet)) return false;
  return (
    facet.kind === 'item' ||
    facet.kind === 'code' ||
    (facet.kind === 'time' && isCalendarDate(facet)) ||
    (facet.kind === 'quantity' &&
      typeof facet.amount === 'number' &&
      Number.isFinite(facet.amount) &&
      typeof facet.unit === 'string')
  );
}

/** Bind current evidence to this exact bounded request before consumers use any returned facts. */
export function validateRequestSourceSnapshot(
  snapshot: unknown,
  partition: number,
  ids: readonly string[],
): Map<string, IndexedSubject> {
  try {
    if (
      ids.length > REQUEST_SOURCE_KEYS ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => subjectPartition(id) !== partition)
    )
      throw new Error('Invalid requested keys');
    if (
      !record(snapshot) ||
      snapshot.partition !== partition ||
      typeof snapshot.position !== 'bigint' ||
      snapshot.position < 0n ||
      !Array.isArray(snapshot.subjects)
    )
      throw new Error('Invalid observation');
    const requested = new Set(ids);
    const subjects = new Map<string, IndexedSubject>();
    for (const subject of snapshot.subjects) {
      if (
        !record(subject) ||
        typeof subject.id !== 'string' ||
        subjectPartition(subject.id) !== partition ||
        !requested.has(subject.id) ||
        subjects.has(subject.id)
      )
        throw new Error('Invalid returned keys');
      if (
        !['visible', 'hidden', 'taken_down'].includes(subject.visibility as string) ||
        (subject.redirect !== null && !routable(subject.redirect)) ||
        !Number.isSafeInteger(subject.securityRevision) ||
        (subject.securityRevision as number) < 0
      )
        throw new Error('Invalid returned metadata');
      subjects.set(subject.id, subject as unknown as IndexedSubject);
    }
    // Establish custody and security metadata for the complete observation before reading facts.
    for (const subject of subjects.values()) {
      if (
        typeof subject.type !== 'string' ||
        !list(subject.labels, term) ||
        !list(subject.aliases, term) ||
        !list(subject.descriptions, term) ||
        !list(subject.statements, statement) ||
        (subject.relationFacetOverflow !== undefined &&
          !list(subject.relationFacetOverflow, (p) => typeof p === 'string'))
      )
        throw new Error('Invalid returned state');
    }
    return subjects;
  } catch (cause) {
    throw new SearchUnavailableError('Invalid current Source observation', { cause });
  }
}
