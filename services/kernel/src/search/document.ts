import { calendarInterval, isCalendarDate } from '@rezics/filter';
import { SEARCH_GLOBAL_CONTEXT as GLOBAL_CONTEXT } from './global-context.ts';
import { normalizePublicRatingFigure } from './rating-source.ts';
import { subjectPartition, type IndexedStatement, type IndexedSubject, type SubjectSnapshot } from './source.ts';
import { DOCUMENT_TEXT_COST, DOCUMENT_TEXT_RECIPE } from './document-text.ts';
import { publicNames } from './document-names.ts';
import { creditSearchFields, type CreditedNameDocument, type CreditSearchFields } from './credit-search-document.ts';

export const MISSING_NAME = '\u{10FFFF}';
export const MAX_NAME_SORT_CHARACTERS = 512;

/** One nested fact. Qualifiers are `property=value` strings, unique and in source order. */
export type SubjectFact =
  | { property: string; value: string; qualifiers: string[] }
  | {
      property: string;
      year: number;
      month?: number;
      day?: number;
      time_lower: string;
      time_upper: string;
      qualifiers: string[];
    }
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
  /** An incomplete creator projection publishes no names. */
  credit_search_complete: boolean;
  credited_names: CreditedNameDocument[];
  /** Coverage remains explicit when a bounded native projection is incomplete or unavailable. */
  document_text_coverage?: 'complete' | 'partial' | 'unsupported' | 'preparing' | 'unavailable';
  /** Opaque current native Subject observation chosen by the page reference selector. */
  document_text_observation?: string;
  /** Nested documents keep phrases inside one document and one actual language. */
  document_texts?: {
    candidate: string;
    document: string;
    digest: string;
    language: string;
    revision: number;
    recipe: string;
    extraction: string;
    complete: boolean;
    text: string;
  }[];
};

export type IndexAction<Document extends SubjectDocument = SubjectDocument> =
  | { op: 'index'; id: string; version: bigint; document: Document }
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
      if (!isCalendarDate(facet)) return undefined;
      const interval = calendarInterval(facet);
      return {
        property,
        year: facet.year,
        ...(facet.month === undefined ? {} : { month: facet.month }),
        ...(facet.day === undefined ? {} : { day: facet.day }),
        time_lower: interval.lower,
        time_upper: interval.upper,
        qualifiers,
      };
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

function documentTextFields(
  subject: IndexedSubject,
  partition: number,
): Pick<SubjectDocument, 'document_text_coverage' | 'document_text_observation' | 'document_texts'> {
  const projection = subject.documentText;
  if (!projection) return {};
  const { selection } = projection;
  if (
    selection.subject !== subject.id ||
    !selection.observation ||
    selection.observation.length > 2048 ||
    subjectPartition(selection.subject) !== partition ||
    selection.references.length > DOCUMENT_TEXT_COST().documents ||
    projection.documents.length > DOCUMENT_TEXT_COST().documents
  )
    throw new TypeError('Document text projection is not bound to the indexed subject');
  const admittedReferences = new Set(
    selection.references.map((reference) =>
      [reference.candidate, reference.document, reference.digest, reference.language].join('\0'),
    ),
  );
  let textBytes = 0;
  const documents = projection.documents.map(({ reference, revision, recipe, extraction, complete, text }) => {
    if (
      !admittedReferences.has(
        [reference.candidate, reference.document, reference.digest, reference.language].join('\0'),
      ) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      recipe !== DOCUMENT_TEXT_RECIPE ||
      !/^[0-9a-f]{64}$/.test(extraction) ||
      typeof complete !== 'boolean' ||
      !text.isWellFormed()
    )
      throw new TypeError('Document text projection contains an invalid source value');
    textBytes += Buffer.byteLength(text, 'utf8');
    return {
      candidate: reference.candidate,
      document: reference.document,
      digest: reference.digest,
      language: reference.language,
      revision,
      recipe,
      extraction,
      complete,
      text,
    };
  });
  const serialized = { coverage: projection.coverage, documents };
  if (
    textBytes > DOCUMENT_TEXT_COST().textBytesPerSubject ||
    Buffer.byteLength(JSON.stringify(serialized), 'utf8') > DOCUMENT_TEXT_COST().serializedBytesPerSubject
  )
    throw new TypeError('Document text projection exceeds its retained bounds');
  return {
    document_text_coverage: projection.coverage,
    document_text_observation: selection.observation,
    ...(documents.length === 0 ? {} : { document_texts: documents }),
  };
}

function subjectDocument(partition: number, subject: IndexedSubject, credit: CreditSearchFields): SubjectDocument {
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
  const names = uniqueValues(Array.from(publicNames(subject), ({ value }) => value));
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
    ...documentTextFields(subject, partition),
    ...(rating === undefined ? {} : { rating_score: rating.score, rating_prior_epoch: rating.priorEpoch }),
    ...(subject.relationFacetOverflow === undefined || subject.relationFacetOverflow.length === 0
      ? {}
      : { relation_facet_overflow: uniqueValues(subject.relationFacetOverflow) }),
    ...credit,
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
      const credit = creditSearchFields(snapshot.creditSearch?.get(id));
      const document = subjectDocument(snapshot.partition, subject, credit);
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

export function bulkLines<Document extends SubjectDocument>(
  index: string,
  actions: readonly IndexAction<Document>[],
): unknown[] {
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function languageValues(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => record(item) && typeof item.language === 'string' && typeof item.value === 'string')
  );
}

/** Validate all returned evidence, including records that will produce deletes, before any projection I/O. */
export function validateIndexObservation(
  snapshot: SubjectSnapshot,
  partition: number,
  ids: readonly string[],
  obligation: bigint,
  native = false,
): Map<string, IndexedSubject> {
  if (!record(snapshot) || snapshot.partition !== partition)
    throw new TypeError('Source snapshot does not observe the requested partition');
  if (
    typeof snapshot.position !== 'bigint' ||
    snapshot.position < obligation ||
    snapshot.position < 0n ||
    snapshot.position > (native ? 9_223_372_036_854_775_807n : BigInt(Number.MAX_SAFE_INTEGER))
  )
    throw new TypeError('Source snapshot position must be a valid bigint version covering the captured batch');
  if (!Array.isArray(snapshot.subjects) || snapshot.subjects.length > ids.length)
    throw new TypeError('Source snapshot must contain unique requested records');
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
      throw new TypeError('Source snapshot contains a duplicate or unrequested subject');
    if (
      typeof subject.type !== 'string' ||
      !['visible', 'hidden', 'taken_down'].includes(subject.visibility) ||
      (subject.redirect !== null && (typeof subject.redirect !== 'string' || !subject.redirect)) ||
      !Number.isSafeInteger(subject.securityRevision) ||
      subject.securityRevision < 0 ||
      !languageValues(subject.labels) ||
      !languageValues(subject.aliases) ||
      !languageValues(subject.descriptions) ||
      !Array.isArray(subject.statements) ||
      (subject.relationFacetOverflow !== undefined &&
        (!Array.isArray(subject.relationFacetOverflow) ||
          !subject.relationFacetOverflow.every((property) => typeof property === 'string')))
    )
      throw new TypeError('Source snapshot contains invalid subject state');
    if (subject.redirect !== null) subjectPartition(subject.redirect);
    for (const statement of subject.statements) {
      if (
        !record(statement) ||
        typeof statement.property !== 'string' ||
        typeof statement.value !== 'string' ||
        (statement.qualifiers !== undefined &&
          (!Array.isArray(statement.qualifiers) ||
            !statement.qualifiers.every(
              (item) => record(item) && typeof item.property === 'string' && typeof item.value === 'string',
            )))
      )
        throw new TypeError('Source snapshot contains invalid statement state');
      const facet = statement.facet;
      if (facet === undefined) continue;
      if (
        !record(facet) ||
        !['item', 'code', 'time', 'quantity'].includes(facet.kind) ||
        (facet.kind === 'time' && !isCalendarDate(facet)) ||
        (facet.kind === 'quantity' && (!Number.isFinite(facet.amount) || typeof facet.unit !== 'string'))
      )
        throw new TypeError('Source snapshot contains invalid facet state');
    }
    if (subject.publicRating !== undefined)
      normalizePublicRatingFigure(subject.publicRating, {
        questionId: subject.publicRating.questionId,
        populationId: GLOBAL_CONTEXT.id,
        subjectId: subject.id,
      });
    subjects.set(subject.id, subject);
  }
  return subjects;
}
