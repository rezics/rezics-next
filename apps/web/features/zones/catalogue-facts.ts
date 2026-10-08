import type { ZoneCatalogueFacts, ZoneText } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { readEntityProjection, readStatements, sectionOf } from '../entity-page/read.ts';
import type { StatementItem, StatementPage } from '../entity-page/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { reader, readClassifications, settle } from '../work-page/read.ts';
import type { Loaded } from '../work-page/types.ts';

// Facts a catalogue card and the leading panel state. Every value is a Statement or a classification
// the Work page already reads, or a year the publication-year template returned. Nothing is inferred
// from a title, a season or a chapter count.

const DATE_PUBLISHED = 'https://schema.org/datePublished';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const INTEGER = `${XSD}integer`;
const DATE = /^(\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const DATE_TIME = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

const empty = (): ZoneCatalogueFacts => ({ format: null, years: [], count: null, unavailable: false });

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

function literalOf(item: StatementItem): { lexical: string; datatype: string } | null {
  if (!('kind' in item) || item.kind !== 'statement') return null;
  const value = item.value;
  if (!value || value.kind !== 'literal' || typeof value.lexical !== 'string' || typeof value.datatype !== 'string') return null;
  return { lexical: value.lexical, datatype: value.datatype };
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

async function countPredicate(notation: 'episode-count' | 'volume-count'): Promise<Loaded<string | null>> {
  const { main, actingSubject } = await reader();
  const read = await settle(() => main.v1.lexicon.definitions({ key: notation }).get({
    query: { ...(actingSubject ? { actingSubject } : {}) },
  }));
  if (!read.ok) return read.failure === 'missing' ? { ok: true, data: null } : read;
  return { ok: true, data: read.data.definition };
}

/**
 * Format, publication years and the declared count for one Work.
 * `formatNames` are the public names of this Zone's formats; any other classification stays off the panel.
 */
export async function readCatalogueFacts(id: string, locale: UiLocale, count: 'episodes' | 'volumes',
  formatNames: readonly string[]): Promise<ZoneCatalogueFacts> {
  const names = new Set(formatNames);
  const [classifications, pages, predicate] = await Promise.all([
    readClassifications(id, locale, { kind: 'global' }),
    statementPages(id),
    countPredicate(count === 'episodes' ? 'episode-count' : 'volume-count'),
  ]);
  if (!classifications.ok || !pages.ok || !predicate.ok) return { ...empty(), unavailable: true };
  const matched = classifications.data.items.find(item => names.has(item.name.value));
  const format: ZoneText | null = matched
    ? { value: matched.name.value, lang: matched.name.language, dir: matched.name.direction }
    : null;
  return {
    format,
    years: yearsFrom(pages.data),
    count: predicate.data ? countFrom(pages.data, predicate.data) : null,
    unavailable: false,
  };
}

export interface PublicationYearRow { id: string; year: number; statement: string }

/** One page of the publication-year template, newest first. A failed read is unavailable, never an empty year. */
export async function readPublicationYears(parameters: { fromYear?: number; toYear?: number },
  cursor?: string): Promise<Loaded<{ items: PublicationYearRow[]; nextCursor: string | null }>> {
  const { main } = await reader();
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
  const items = answer.data.items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { id?: unknown; year?: unknown; statement?: unknown };
    return typeof row.id === 'string' && typeof row.year === 'number' && typeof row.statement === 'string'
      ? [{ id: row.id, year: row.year, statement: row.statement }] : [];
  });
  return { ok: true, data: { items, nextCursor: answer.data.nextCursor } };
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
