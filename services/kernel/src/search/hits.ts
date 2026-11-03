import type { CalendarDate, FilterRelease } from '@rezics/filter';
import { ProblemError, type FieldErrorCode } from '../http/problem.ts';
import { chooseLabel } from '../semantic/language.ts';
import { codeFacet, discloseFacetValues } from './facets.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';

export type HitOptions = { descriptions: boolean; languages?: readonly string[]; properties?: readonly string[] };
export type Fact =
  | { kind: 'item'; id: string; labels: Record<string, string> }
  | ({ kind: 'time' } & CalendarDate)
  | { kind: 'quantity'; amount: number; unit: string }
  | { kind: 'code'; value: string };
export type SearchHit = {
  id: string;
  type: string;
  labels: Record<string, string>;
  descriptions?: Record<string, string>;
  facts?: Record<string, Fact[]>;
};

const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const DESCRIPTION_LIMIT = 200;
const FACTS_PER_PROPERTY = 3;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function invalid(pointer: string, code: FieldErrorCode): never {
  throw new ProblemError('invalid_request', { errors: [{ pointer, code }] });
}

/** Shared result-slot admission for the legacy and opt-in discovery representations. */
export function validateSearchLimit(value: unknown): number {
  const limit = value === undefined ? 20 : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
    invalid('/limit', 'out_of_range');
  return limit;
}

/** Checks the opt-in hit fields; reports the first failing element only. */
export function validateHitOptions(request: {
  descriptions?: unknown;
  languages?: unknown;
  properties?: unknown;
}): HitOptions {
  const { descriptions, languages, properties } = request;
  if (descriptions !== undefined && typeof descriptions !== 'boolean') invalid('/descriptions', 'invalid_type');
  const options: HitOptions = { descriptions: descriptions === true };
  if (languages !== undefined) {
    if (!Array.isArray(languages)) invalid('/languages', 'invalid_type');
    if (languages.length < 1 || languages.length > 8) invalid('/languages', 'out_of_range');
    const seen = new Set<string>();
    languages.forEach((tag: unknown, index) => {
      if (typeof tag !== 'string') invalid(`/languages/${index}`, 'invalid_type');
      if (tag.length > 35 || !LANGUAGE.test(tag) || seen.has(tag)) invalid(`/languages/${index}`, 'invalid_format');
      seen.add(tag);
    });
    options.languages = languages as string[];
  }
  if (properties !== undefined) {
    if (!Array.isArray(properties)) invalid('/properties', 'invalid_type');
    if (properties.length < 1 || properties.length > 4) invalid('/properties', 'out_of_range');
    const seen = new Set<string>();
    properties.forEach((key: unknown, index) => {
      if (typeof key !== 'string') invalid(`/properties/${index}`, 'invalid_type');
      if (seen.has(key)) invalid(`/properties/${index}`, 'invalid_format');
      seen.add(key);
    });
    options.properties = properties as string[];
  }
  return options;
}

const FACT_DATATYPES = new Set(['wikibase-item', 'time', 'quantity']);

/** Every requested property must be an item, time, quantity or code property of the active release. */
export function admitProperties(properties: readonly string[], release: FilterRelease): void {
  properties.forEach((key, index) => {
    const definition = Object.hasOwn(release.properties, key) ? release.properties[key] : undefined;
    if (definition && (FACT_DATATYPES.has(definition.datatype) || codeFacet(release, key))) return;
    throw new ProblemError('unsupported_query', { errors: [{ pointer: `/properties/${index}`, code: 'unsupported' }] });
  });
}

/** At most 200 grapheme clusters: a longer text keeps 199, drops trailing white space and ends with an ellipsis. */
function cut(value: string): string {
  if (value.length <= DESCRIPTION_LIMIT) return value;
  let count = 0;
  let keep = 0;
  for (const { index } of graphemes.segment(value)) {
    if (count === DESCRIPTION_LIMIT) return `${value.slice(0, keep).trimEnd()}…`;
    if (count === DESCRIPTION_LIMIT - 1) keep = index;
    count++;
  }
  return value;
}

/** Texts by language, choosing one through the reader's chain when given. */
export function chooseTexts(
  list: IndexedSubject['labels'],
  languages: readonly string[] | undefined,
  original: string | undefined,
  map: (value: string) => string = (value) => value,
) {
  if (languages) {
    const chosen = chooseLabel(
      Object.fromEntries(list.map(({ language, value }) => [language, value])),
      languages,
      original,
    );
    return chosen ? { [chosen.language]: map(chosen.value) } : {};
  }
  return Object.fromEntries(list.map(({ language, value }) => [language, map(value)]));
}

function originalLanguage(subject: IndexedSubject): string | undefined {
  return subject.statements.find(({ property }) => property === 'schema:inLanguage')?.value;
}

export function projectHit(subject: IndexedSubject, { descriptions, languages }: HitOptions): SearchHit {
  const original = originalLanguage(subject);
  return {
    id: subject.id,
    type: subject.type,
    labels: chooseTexts(subject.labels, languages, original),
    ...(descriptions ? { descriptions: chooseTexts(subject.descriptions, languages, original, cut) } : {}),
  };
}

type Pending = Exclude<Fact, { kind: 'item' }> | { kind: 'item'; id: string };

/** The first distinct values of each requested property, in statement order. */
export function pendingFacts(
  subject: Pick<IndexedSubject, 'statements'>,
  properties: readonly string[],
): Map<string, Pending[]> {
  const kept = new Map<string, { values: Pending[]; seen: Set<string> }>(
    properties.map((property) => [property, { values: [], seen: new Set() }]),
  );
  for (const { property, value, facet } of subject.statements) {
    const entry = facet && kept.get(property);
    if (!facet || !entry || entry.values.length === FACTS_PER_PROPERTY) continue;
    const fact: Pending =
      facet.kind === 'item'
        ? { kind: 'item', id: value }
        : facet.kind === 'time'
          ? {
              kind: 'time',
              year: facet.year,
              ...(facet.month === undefined ? {} : { month: facet.month }),
              ...(facet.day === undefined ? {} : { day: facet.day }),
            }
          : facet.kind === 'quantity'
            ? { kind: 'quantity', amount: facet.amount, unit: facet.unit }
            : { kind: 'code', value };
    const key = JSON.stringify(fact);
    if (entry.seen.has(key)) continue;
    entry.seen.add(key);
    entry.values.push(fact);
  }
  return new Map([...kept].map(([property, { values }]) => [property, values]));
}

/**
 * Facts of every hit of a page, in the order of `subjects`. The item targets of the whole page are read once through
 * disclosure; a target that is not visible is dropped without taking a later value's place.
 */
export async function projectFacts(
  source: SubjectSource,
  subjects: readonly IndexedSubject[],
  properties: readonly string[],
  languages: readonly string[] | undefined,
): Promise<Record<string, Fact[]>[]> {
  const lists = subjects.map((subject) => pendingFacts(subject, properties));
  const targets = new Set<string>();
  for (const list of lists)
    for (const values of list.values()) for (const value of values) if (value.kind === 'item') targets.add(value.id);
  const visible = targets.size ? await discloseFacetValues(source, [...targets]) : new Map<string, IndexedSubject>();
  return lists.map((list) =>
    Object.fromEntries(
      [...list].map(([property, values]) => [
        property,
        values.flatMap((value): Fact[] => {
          if (value.kind !== 'item') return [value];
          const target = visible.get(value.id);
          return target
            ? [
                {
                  kind: 'item',
                  id: value.id,
                  labels: chooseTexts(target.labels, languages, originalLanguage(target)),
                },
              ]
            : [];
        }),
      ]),
    ),
  );
}
