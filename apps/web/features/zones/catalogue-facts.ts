import type { ZoneCatalogueFacts, ZoneText } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken } from '../api/main.ts';
import { readEntityProjection, readStatements, sectionOf } from '../entity-page/read.ts';
import type { StatementItem, StatementPage } from '../entity-page/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { reader, readClassifications, settle } from '../work-page/read.ts';
import { idOf } from '../work-page/route.ts';
import type { Loaded } from '../work-page/types.ts';
import { catalogueCountProperty, type CatalogueCountProperty } from './catalogue-count.ts';

// Facts a catalogue card and the leading panel state. Every value is a Statement or a classification
// the Work page already reads, or a year the publication-year template returned. A count's predicate
// is the public property of that name; its reviewed presentation names it. Nothing is inferred
// from a title, a season or a chapter count.

const DATE_PUBLISHED = 'https://schema.org/datePublished';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const INTEGER = `${XSD}integer`;
const DATE = /^(\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DATE_TIME = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

const empty = (): ZoneCatalogueFacts => ({ format: null, years: [], count: null, countName: null, unavailable: false });

/** Catalogue facts plus the statement pages' rights reads, one per page, in page order. */
export interface CatalogueFacts extends ZoneCatalogueFacts {
  factObligations: StatementPage['factObligations'][];
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function digits(value: string): number {
  if (value.length > 9) return -1;
  const year = Number(value);
  return Number.isInteger(year) ? year : -1;
}

/** Calendar year of a date lexical form. A timezone does not move the year, and an invalid day is not a year. */
export function cataloguePublicationYear(datatype: string, lexical: string): number | null {
  const kind = datatype.startsWith(XSD) ? datatype.slice(XSD.length) : datatype;
  let year = -1;
  let month = 1;
  let day = 1;
  if (kind === 'gYear') {
    if (!/^\d{4,}$/.test(lexical)) return null;
    year = digits(lexical);
  } else if (kind === 'date') {
    const match = DATE.exec(lexical);
    if (!match) return null;
    year = digits(match[1]!);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (kind === 'dateTime') {
    const match = DATE_TIME.exec(lexical);
    if (!match) return null;
    year = digits(match[1]!);
    month = Number(match[2]);
    day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return null;
  } else return null;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return year;
}

/** The form a literal was recorded in. A date the API client parsed is written back as that form. */
function recordedLexical(lexical: unknown, datatype: string): string | null {
  if (typeof lexical === 'string') return lexical;
  if (!(lexical instanceof Date) || Number.isNaN(lexical.getTime())) return null;
  const iso = lexical.toISOString();
  const kind = datatype.startsWith(XSD) ? datatype.slice(XSD.length) : datatype;
  if (kind === 'gYear') return iso.slice(0, 4);
  if (kind === 'date' || kind === 'gYearMonth') return iso.slice(0, kind === 'gYearMonth' ? 7 : 10);
  return iso.replace(/\.\d+(?=Z$)/, '');
}

function literalOf(item: StatementItem): { lexical: string; datatype: string } | null {
  if (!('kind' in item) || item.kind !== 'statement') return null;
  const value = item.value;
  if (!value || value.kind !== 'literal' || typeof value.datatype !== 'string') return null;
  const lexical = recordedLexical(value.lexical, value.datatype);
  return lexical === null ? null : { lexical, datatype: value.datatype };
}

async function statementPages(id: string): Promise<Loaded<StatementPage[]>> {
  const projection = await readEntityProjection(id);
  if (!projection.ok) return projection;
  const section = sectionOf(projection.data, 'statements');
  if (!section) return { ok: true, data: [] };
  const pages: StatementPage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const read = await readStatements(section, cursor);
    if (!read.ok) return read;
    pages.push(read.data);
    if (!read.data.nextCursor) break;
    cursor = read.data.nextCursor;
  }
  return { ok: true, data: pages };
}

function countFrom(pages: readonly StatementPage[], predicate: string): number | null {
  for (const page of pages) {
    const group = page.groups.find(item => item.predicate === predicate);
    for (const item of group?.items ?? []) {
      const literal = literalOf(item);
      if (!literal || (literal.datatype !== INTEGER && literal.datatype !== 'integer')) continue;
      if (!/^[1-9][0-9]*$/.test(literal.lexical)) continue;
      const value = Number(literal.lexical);
      if (Number.isSafeInteger(value)) return value;
    }
  }
  return null;
}

function yearsFrom(pages: readonly StatementPage[]): number[] {
  const years = new Set<number>();
  for (const page of pages) {
    const group = page.groups.find(item => item.predicate === DATE_PUBLISHED);
    for (const item of group?.items ?? []) {
      const literal = literalOf(item);
      if (!literal) continue;
      const year = cataloguePublicationYear(literal.datatype, literal.lexical);
      if (year !== null) years.add(year);
    }
  }
  return [...years].sort((left, right) => right - left);
}

async function countPredicate(notation: 'episode-count' | 'volume-count',
  locale: UiLocale): Promise<Loaded<CatalogueCountProperty | null>> {
  const { main, actingSubject } = await reader();
  const read = await settle(() => main.v1.lexicon.definitions({ key: notation }).get({
    query: { languages: locale, ...(actingSubject ? { actingSubject } : {}) },
  }));
  if (!read.ok) return read.failure === 'missing' ? { ok: true, data: null } : read;
  // Kind and the subject → value rendering decide that this key is a count. The predicate is that property.
  return { ok: true, data: catalogueCountProperty(read.data, locale) };
}

/**
 * Format, publication years and the declared count for one Work.
 * `formatNames` are the public names of this Zone's formats; any other classification stays off the panel.
 */
export async function readCatalogueFacts(id: string, locale: UiLocale, count: 'episodes' | 'volumes',
  formatNames: readonly string[]): Promise<CatalogueFacts> {
  // A browse card names the Work by its IRI. Statement and classification paths take the UUID.
  const resource = idOf(id) ?? id;
  const names = new Set(formatNames);
  const [classifications, pages, predicate] = await Promise.all([
    readClassifications(resource, locale, { kind: 'global' }),
    statementPages(resource),
    countPredicate(count === 'episodes' ? 'episode-count' : 'volume-count', locale),
  ]);
  if (!classifications.ok || !pages.ok || !predicate.ok) return { ...empty(), unavailable: true, factObligations: [] };
  const matched = classifications.data.items.find(item => names.has(item.name.value));
  const format: ZoneText | null = matched
    ? { value: matched.name.value, lang: matched.name.language, dir: matched.name.direction }
    : null;
  return {
    format,
    years: yearsFrom(pages.data),
    count: predicate.data ? countFrom(pages.data, predicate.data.predicate) : null,
    countName: predicate.data?.name ?? null,
    unavailable: false,
    factObligations: pages.data.map(page => page.factObligations),
  };
}

export interface PublicationYearRow { id: string; year: number; statement: string }

/** One page of the publication-year template, newest first. A failed read is unavailable, never an empty year. */
export async function readPublicationYears(parameters: { fromYear?: number; toYear?: number },
  cursor?: string): Promise<Loaded<{ items: PublicationYearRow[]; nextCursor: string | null }>> {
  // The year facet is intersected with an anonymous Realm roster, including continuations.
  const main = mainApiWithToken(undefined);
  const answer = await settle(async () => {
    const result = await main.v1.query.post({
      profile: 'template-query-v1', query: 'https://rezics.com/query/work-publication-years', revision: 1,
      parameters, limit: 20, ...(cursor ? { cursor } : {}),
    });
    const page = result.data?.result;
    const data = page && page.profile === 'template-result-v1'
      && page.query === 'https://rezics.com/query/work-publication-years' ? page : null;
    return { error: result.error, data };
  }, cursor);
  if (!answer.ok) return answer;
  const rows = Array.isArray(answer.data.items) ? answer.data.items : [];
  const items = rows.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { id?: unknown; year?: unknown; statement?: unknown };
    return typeof row.id === 'string' && typeof row.year === 'number' && typeof row.statement === 'string'
      ? [{ id: row.id, year: row.year, statement: row.statement }] : [];
  });
  return { ok: true, data: { items, nextCursor: answer.data.nextCursor } };
}

/**
 * Statement years win. Otherwise the years are the ones the publication-year
 * template already returned for this Work. An empty list is unrecorded.
 */
export function catalogueYears(stated: readonly number[], listed?: readonly number[]): number[] {
  if (stated.length || !listed?.length) return [...stated];
  return [...new Set(listed.filter(year => Number.isInteger(year) && year >= 1 && year <= 9999))]
    .sort((left, right) => right - left);
}

/** A year the address names, or null when it names none. A value outside 1..9999 is dropped, not guessed. */
export function catalogueYearParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^[1-9][0-9]{0,3}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1 && year <= 9999 ? year : null;
}

export function catalogueText(value: string, locale: string): ZoneText {
  return zoneContentText(value, locale);
}
