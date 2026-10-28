import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { normalizePublicRatingFigure } from './rating-source.ts';
import { subjectPartition, type IndexedStatement, type IndexedSubject, type SubjectSnapshot } from './source.ts';

export const MISSING_NAME = '\u{10FFFF}';
export const MAX_NAME_SORT_CHARACTERS = 512;

/** One nested fact. Qualifiers are `property=value` strings, unique and in source order. */
export type SubjectFact =
  | { property: string; value: string; qualifiers: string[] }
  | { property: string; year: number; qualifiers: string[] }
  | { property: string; amount: number; unit: string; qualifiers: string[] };

export type SubjectDocument = {
  id: string;
  partition: number;
  type: string;
  security_revision: number;
  names: string[];
  descriptions: string[];
  /** Native write preparation supplies null for normalized keys exceeding MAX_NAME_SORT_CHARACTERS. */
  name_sort: string | null;
  statements: string[];
  /** One entry per facet-capable statement, in source order, with exact duplicates removed. */
  facts: SubjectFact[];
  /** Declared relation facet properties whose complete value sets exceeded the source sample bound. */
  relation_facet_overflow?: string[];
  /** Active public Collections listing this subject. Omitted unless counts are supplied. */
  public_collection_count?: number;
  /** Published Global standard-question score and prior identity; absent figures omit both fields. */
  rating_score?: number | null;
  rating_prior_epoch?: number | null;
};

export type IndexAction =
  | { op: 'index'; id: string; version: bigint; document: SubjectDocument }
  | { op: 'delete'; id: string; version: bigint };

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function statementFact(statement: IndexedStatement): SubjectFact | undefined {
  const facet = statement.facet;
  if (facet === undefined) return undefined;
  const qualifiers = uniqueValues((statement.qualifiers ?? []).map((item) => `${item.property}=${item.value}`));
  const property = statement.property;
  switch (facet.kind) {
    case 'item':
    case 'code':
      return { property, value: statement.value, qualifiers };
    case 'time':
      return { property, year: facet.year, qualifiers };
    case 'quantity':
      return { property, amount: facet.amount, unit: facet.unit, qualifiers };
  }
}

/** Facet-capable statements only, in source order. An exact duplicate fact is dropped. */
function subjectFacts(statements: readonly IndexedStatement[]): SubjectFact[] {
  const facts: SubjectFact[] = [];
  const seen = new Set<string>();
  for (const statement of statements) {
    const fact = statementFact(statement);
    if (fact === undefined) continue;
    const identity = JSON.stringify(fact);
    if (seen.has(identity)) continue;
    seen.add(identity);
    facts.push(fact);
  }
  return facts;
}

function subjectDocument(partition: number, subject: IndexedSubject): SubjectDocument {
  // The source owns standard-question proof; this boundary validates Global and exact subject binding.
  const rating =
    subject.publicRating === undefined
      ? undefined
      : normalizePublicRatingFigure(subject.publicRating, {
          questionId: subject.publicRating.questionId,
          populationId: GLOBAL_CONTEXT.id,
          subjectId: subject.id,
        });
  const labels = [...subject.labels].sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0));
  const names = uniqueValues([
    ...subject.labels.map((item) => item.value),
    ...subject.aliases.map((item) => item.value),
  ]);
  return {
    id: subject.id,
    partition,
    type: subject.type,
    security_revision: subject.securityRevision,
    names,
    descriptions: uniqueValues(subject.descriptions.map((item) => item.value)),
    name_sort: labels[0]?.value ?? MISSING_NAME,
    statements: uniqueValues(subject.statements.map((item) => `${item.property}=${item.value}`)),
    facts: subjectFacts(subject.statements),
    ...(rating === undefined ? {} : { rating_score: rating.score, rating_prior_epoch: rating.priorEpoch }),
    ...(subject.relationFacetOverflow === undefined || subject.relationFacetOverflow.length === 0
      ? {}
      : { relation_facet_overflow: uniqueValues(subject.relationFacetOverflow) }),
  };
}

export function documentActions(
  snapshot: SubjectSnapshot,
  ids: readonly string[],
  counts?: ReadonlyMap<string, number>,
): IndexAction[] {
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
    if (subject?.visibility === 'visible' && subject.redirect === null) {
      const document = subjectDocument(snapshot.partition, subject);
      actions.push({
        op: 'index',
        id,
        version: snapshot.position,
        document: counts === undefined ? document : { ...document, public_collection_count: counts.get(id) ?? 0 },
      });
    } else actions.push({ op: 'delete', id, version: snapshot.position });
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
