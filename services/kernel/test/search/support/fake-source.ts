import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../../src/search/source.ts';

export function createFakeSource(): SubjectSource & {
  put(subject: IndexedSubject): void;
  remove(id: string): void;
  advance(partition: number): void;
} {
  const subjects = new Map<string, IndexedSubject>();
  const positions = new Map<number, bigint>();
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
