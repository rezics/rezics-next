import { subjectPartition, type IndexedSubject, type SubjectSnapshot } from './source.ts';

export const MISSING_NAME = '\u{10FFFF}';

export type SubjectDocument = {
  partition: number;
  type: string;
  security_revision: number;
  names: string[];
  descriptions: string[];
  name_sort: string;
  statements: string[];
};

export type IndexAction =
  | { op: 'index'; id: string; version: bigint; document: SubjectDocument }
  | { op: 'delete'; id: string; version: bigint };

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function subjectDocument(partition: number, subject: IndexedSubject): SubjectDocument {
  const labels = [...subject.labels].sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0));
  const names = uniqueValues([
    ...subject.labels.map((item) => item.value),
    ...subject.aliases.map((item) => item.value),
  ]);
  return {
    partition,
    type: subject.type,
    security_revision: subject.securityRevision,
    names,
    descriptions: uniqueValues(subject.descriptions.map((item) => item.value)),
    name_sort: labels[0]?.value ?? MISSING_NAME,
    statements: uniqueValues(subject.statements.map((item) => `${item.property}=${item.value}`)),
  };
}

export function documentActions(snapshot: SubjectSnapshot, ids: readonly string[]): IndexAction[] {
  const subjects = new Map<string, IndexedSubject>();
  for (const subject of snapshot.subjects) {
    if (subjectPartition(subject.id) !== snapshot.partition)
      throw new RangeError('Snapshot contains a subject outside its partition');
    subjects.set(subject.id, subject);
  }

  const seen = new Set<string>();
  const actions: IndexAction[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const subject = subjects.get(id);
    if (subject?.visibility === 'visible' && subject.redirect === null)
      actions.push({
        op: 'index',
        id,
        version: snapshot.position,
        document: subjectDocument(snapshot.partition, subject),
      });
    else actions.push({ op: 'delete', id, version: snapshot.position });
  }
  return actions;
}

export function bulkLines(index: string, actions: readonly IndexAction[]): unknown[] {
  const lines: unknown[] = [];
  for (const action of actions) {
    if (action.version < 0n || action.version > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError('External version exceeds the safe integer range');
    const version = Number(action.version);
    if (action.op === 'index') {
      lines.push({ index: { _index: index, _id: action.id, version, version_type: 'external' } }, action.document);
    } else lines.push({ delete: { _index: index, _id: action.id, version, version_type: 'external' } });
  }
  return lines;
}
