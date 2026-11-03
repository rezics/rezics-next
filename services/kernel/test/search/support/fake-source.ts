import { PARTITIONS } from '../../../src/route/route.ts';
import { holdsCurrentStatements } from '../../../src/search/current-leaf.ts';
import {
  MAX_RELATION_FACET_PROBES,
  subjectPartition,
  type IndexedSubject,
  type SubjectSource,
} from '../../../src/search/source.ts';

// Sources isolate their subjects but observe the same partition clock as the file's shared native outbox.
const positions = new Map<number, bigint>();

export function createFakeSource(): SubjectSource & {
  matchRelationFacets: NonNullable<SubjectSource['matchRelationFacets']>;
  put(subject: IndexedSubject): void;
  remove(id: string): void;
  advance(partition: number): void;
} {
  const subjects = new Map<string, IndexedSubject>();
  const currentPosition = (partition: number) => positions.get(partition) ?? 0n;
  const advance = (partition: number) => positions.set(partition, currentPosition(partition) + 1n);

  return {
    put(subject) {
      const partition = subjectPartition(subject.id);
      subjects.set(subject.id, subject);
      advance(partition);
    },
    remove(id) {
      const partition = subjectPartition(id);
      subjects.delete(id);
      advance(partition);
    },
    advance,
    async matchRelationFacets(partition, probes) {
      if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
        throw new RangeError('Invalid partition');
      if (probes.length > MAX_RELATION_FACET_PROBES)
        throw new RangeError(`Relation facet matching accepts at most ${MAX_RELATION_FACET_PROBES} probes`);
      for (const probe of probes) {
        if (subjectPartition(probe.subject) !== partition)
          throw new RangeError('Subject id routes to a different partition');
      }
      return probes.map((probe) => {
        const subject = subjects.get(probe.subject);
        if (!subject || subject.visibility !== 'visible' || subject.redirect !== null) return false;
        return holdsCurrentStatements(subject.statements, {
          facet: 'statement',
          property: probe.property,
          values: [probe.value],
          ...(probe.qualifiers ? { qualifiers: probe.qualifiers } : {}),
        });
      });
    },
    async read(partition, ids) {
      for (const id of ids) {
        if (subjectPartition(id) !== partition) throw new RangeError('Subject id routes to a different partition');
      }
      const wanted = new Set(ids);
      return {
        partition,
        position: currentPosition(partition),
        subjects: [...subjects.values()].filter((subject) => wanted.has(subject.id)),
      };
    },
    async count(partition) {
      let count = 0;
      for (const subject of subjects.values())
        if (subjectPartition(subject.id) === partition && subject.visibility === 'visible' && subject.redirect === null)
          count++;
      return { position: currentPosition(partition), count };
    },
  };
}
