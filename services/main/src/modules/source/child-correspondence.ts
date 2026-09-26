import { createHash } from 'node:crypto';
import { SourceConversionInvalid, type OpenLibraryConversionStore,
  type OpenLibraryWorkProjection } from './open-library-conversion.ts';

type ChildField = 'authors' | 'subjects';
type ChildStatus = 'matched' | 'changed' | 'added' | 'removed' | 'ambiguous' | 'unresolved';

export interface SourceChildOccurrence {
  occurrence: string;
  ordinal: number;
  sourceKey: string;
  roleKey: string | null;
  status: ChildStatus;
  correspondence: string | null;
}

export interface SourceChildCorrespondence {
  profile: 'open-library-work-child-correspondence-v1';
  state: 'assessed';
  record: string;
  baseConversion: string;
  candidateConversion: string;
  fields: Array<{ field: ChildField; coverage: 'complete' | 'unavailable';
    base: SourceChildOccurrence[]; candidate: SourceChildOccurrence[] }>;
}

type Child = { sourceKey: string; roleKey: string | null };

function children(projection: OpenLibraryWorkProjection, field: ChildField): Child[] | null {
  if (field === 'authors') return projection.authorRefs;
  return projection.subjects?.map(sourceKey => ({ sourceKey, roleKey: null })) ?? null;
}

export function sourceChildOccurrence(observation: string, field: ChildField, ordinal: number): string {
  const digest = createHash('sha256').update(JSON.stringify({ observation, field, ordinal }))
    .digest('hex');
  return `urn:rezics:source-occurrence:${digest}`;
}

function counted(list: Child[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const child of list) counts.set(child.sourceKey,
    (counts.get(child.sourceKey) ?? 0) + 1);
  return counts;
}

function assessedField(field: ChildField, baseObservation: string,
  candidateObservation: string, base: Child[] | null, candidate: Child[] | null):
  SourceChildCorrespondence['fields'][number] {
  const coverage = base === null || candidate === null ? 'unavailable' : 'complete';
  const baseList = base ?? [];
  const candidateList = candidate ?? [];
  const baseCounts = counted(baseList);
  const candidateCounts = counted(candidateList);
  const baseUnique = new Map(baseList.map((child, ordinal) => [child.sourceKey, ordinal]));
  const candidateUnique = new Map(candidateList.map((child, ordinal) =>
    [child.sourceKey, ordinal]));
  const mapSide = (list: Child[], ownObservation: string, otherObservation: string,
    ownCounts: Map<string, number>, otherCounts: Map<string, number>,
    otherUnique: Map<string, number>, otherList: Child[], side: 'base' | 'candidate') =>
    list.map((child, ordinal): SourceChildOccurrence => {
      const otherOrdinal = otherUnique.get(child.sourceKey);
      const ambiguous = (ownCounts.get(child.sourceKey) ?? 0) > 1
        || (otherCounts.get(child.sourceKey) ?? 0) > 1;
      const status: ChildStatus = coverage === 'unavailable' ? 'unresolved'
        : ambiguous ? 'ambiguous'
        : otherOrdinal === undefined ? (side === 'base' ? 'removed' : 'added')
        : child.roleKey === otherList[otherOrdinal]!.roleKey ? 'matched' : 'changed';
      return { occurrence: sourceChildOccurrence(ownObservation, field, ordinal), ordinal,
        sourceKey: child.sourceKey, roleKey: child.roleKey, status,
        correspondence: status === 'matched' || status === 'changed'
          ? sourceChildOccurrence(otherObservation, field, otherOrdinal!) : null };
    });
  return { field, coverage,
    base: mapSide(baseList, baseObservation, candidateObservation, baseCounts,
      candidateCounts, candidateUnique, candidateList, 'base'),
    candidate: mapSide(candidateList, candidateObservation, baseObservation,
      candidateCounts, baseCounts, baseUnique, baseList, 'candidate') };
}

/** Observation-qualified positions are never silently promoted to native child IDs. */
export async function compareSourceChildren(conversions: OpenLibraryConversionStore,
  principalId: string, baseId: string, candidateId: string):
  Promise<SourceChildCorrespondence | null> {
  const [base, candidate] = await Promise.all([
    conversions.verifiedRead(principalId, baseId),
    conversions.verifiedRead(principalId, candidateId),
  ]);
  if (!base || !candidate) return null;
  if (base.observation.record !== candidate.observation.record) {
    throw new SourceConversionInvalid('source child comparisons require one SourceRecord');
  }
  return { profile: 'open-library-work-child-correspondence-v1', state: 'assessed',
    record: base.observation.record, baseConversion: base.conversion.conversion,
    candidateConversion: candidate.conversion.conversion,
    fields: (['authors', 'subjects'] as const).map(field => assessedField(field,
      base.observation.observation, candidate.observation.observation,
      children(base.conversion.projection, field),
      children(candidate.conversion.projection, field))) };
}
