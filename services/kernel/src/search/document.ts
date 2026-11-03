import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { normalizePublicRatingFigure } from './rating-source.ts';
import { subjectPartition, type IndexedStatement, type IndexedSubject, type SubjectSnapshot } from './source.ts';
import { discoveryIdentity, type AccountSnapshot } from './discovery.ts';

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

/** Public index allowlist. Live profile/verification/avatar data is always hydrated by Accounts. */
export type AccountDocument = {
  family: 'account';
  kind: 'account';
  identity: string;
  id: string;
  partition: number;
  account_revision: string;
  active_handle: string | null;
  names: string[];
  name_sort: string | null;
  descriptions: [];
  statements: [];
  facts: [];
  relation_facet_overflow: [];
};

export type DiscoverySubjectDocument = SubjectDocument & { family: 'subject'; kind: string; identity: string };
export type SearchDocument = SubjectDocument | AccountDocument;

export type IndexAction<Document extends SearchDocument = SubjectDocument> =
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

/** The caller admits the native snapshot before constructing these positioned replacements/deletes. */
export function accountDocumentActions(
  snapshot: AccountSnapshot,
  ids: readonly string[],
): IndexAction<AccountDocument>[] {
  const requested = new Set(ids);
  const seen = new Set<string>();
  for (const id of requested) {
    if (subjectPartition(id) !== snapshot.partition) throw new RangeError('Account key is outside its partition');
  }
  for (const account of snapshot.accounts) {
    if (subjectPartition(account.id) !== snapshot.partition || !requested.has(account.id) || seen.has(account.id))
      throw new TypeError('Account snapshot contains a duplicate, foreign or unrequested key');
    seen.add(account.id);
  }
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
  return [...requested].map((id) => {
    const identity = discoveryIdentity('accounts', id);
    const account = accounts.get(id);
    if (!account) return { op: 'delete', id: identity, version: snapshot.position };
    const names = uniqueValues([account.handle, account.displayName].filter((name) => name !== null));
    return {
      op: 'index',
      id: identity,
      version: snapshot.position,
      document: {
        family: 'account',
        kind: 'account',
        identity,
        id,
        partition: snapshot.partition,
        account_revision: account.revision.toString(),
        active_handle: account.handle,
        names,
        name_sort: account.displayName ?? account.handle ?? MISSING_NAME,
        descriptions: [],
        statements: [],
        facts: [],
        relation_facet_overflow: [],
      },
    };
  });
}

/** Same Subject projection and native version; only the new generation's identity envelope changes. */
export function discoverySubjectActions(
  snapshot: SubjectSnapshot,
  ids: readonly string[],
  counts?: ReadonlyMap<string, number>,
): IndexAction<DiscoverySubjectDocument>[] {
  return documentActions(snapshot, ids, counts).map((action) => {
    const id = discoveryIdentity('semantic', action.id);
    if (action.op === 'delete') return { ...action, id };
    if (action.document.type === 'account') throw new TypeError('Discovery kind collision');
    return {
      ...action,
      id,
      document: { ...action.document, family: 'subject', kind: action.document.type, identity: id },
    };
  });
}

export function bulkLines<Document extends SearchDocument>(
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
import { isCalendarDate } from '@rezics/filter';
