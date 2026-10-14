import { InvalidStructureObject, type OccurrenceRecord } from './format.ts';

/** Owners name which local uses a field can reference; Structure enforces the candidate membership. */
export interface StructureReferencePolicy {
  targetRole: string;
  predicates: readonly string[];
  references(record: Pick<OccurrenceRecord, 'qualifier'>): readonly string[];
}

export function checkStructureReferences(candidate: readonly OccurrenceRecord[],
  retained: ReadonlyMap<string, OccurrenceRecord>, policy?: StructureReferencePolicy): void {
  if (!policy) return;
  const pending = new Map(candidate.map(record => [record.occurrence, record]));
  for (const record of candidate) {
    if (record.state !== 'active') continue;
    for (const reference of policy.references(record)) {
      const target = pending.get(reference) ?? retained.get(reference);
      if (!target || target.state !== 'active' || target.role !== policy.targetRole) {
        throw new InvalidStructureObject(`reference is not an active ${policy.targetRole} occurrence of this composition`);
      }
    }
  }
}
