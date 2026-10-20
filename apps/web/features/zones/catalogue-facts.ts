import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import type { zoneWork } from '../realm/adapt.ts';
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
export { catalogueYearParam } from './catalogue-year.ts';

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
  const projection = await readEntityProjection(id, undefined);
  if (!projection.ok) return projection;
  const section = sectionOf(projection.data, 'statements');
  if (!section) return { ok: true, data: [] };
  return readCatalogueStatementPages(cursor => readStatements(section, cursor));
}

/** A bounded facts read succeeds only after Main has ended its continuation. */
export async function readCatalogueStatementPages(
  readPage: (cursor?: string) => Promise<Loaded<StatementPage>>,
): Promise<Loaded<StatementPage[]>> {
  const pages: StatementPage[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const read = await readPage(cursor);
    if (!read.ok) return read;
    pages.push(read.data);
    if (!read.data.nextCursor) return { ok: true, data: pages };
    if (seen.has(read.data.nextCursor)) return { ok: false, failure: 'unavailable' };
    seen.add(read.data.nextCursor);
    cursor = read.data.nextCursor;
  }
  return { ok: false, failure: 'unavailable' };
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
  formatNames: readonly string[],
  read = { classifications: readClassifications, statements: statementPages, predicate: countPredicate },
): Promise<CatalogueFacts> {
  // A browse card names the Work by its IRI. Statement and classification paths take the UUID.
  const resource = idOf(id) ?? id;
  const names = new Set(formatNames);
  const [classifications, pages, predicate] = await Promise.all([
    read.classifications(resource, locale, { kind: 'global' }),
    read.statements(resource),
    read.predicate(count === 'episodes' ? 'episode-count' : 'volume-count', locale),
  ]);
  if (!classifications.ok || classifications.data.nextCursor || !pages.ok || !predicate.ok) {
    return { ...empty(), unavailable: true, factObligations: [] };
  }
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
export async function readPublicationYears(parameters: { fromYear?: number; toYear?: number; realm?: string; filter?: FilterDocument; text?: string },
  cursor?: string): Promise<Loaded<{ items: PublicationYearRow[]; nextCursor: string | null }>> {
  // Realm membership and Conditions belong to the query owner on every continuation.
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

export function catalogueText(value: string, locale: string): ZoneText {
  return zoneContentText(value, locale);
}

/** Public cards retain the header, canonical address and truthful author credits. */
export type PublicationYearWork = Parameters<typeof zoneWork>[0];

/** At most one year page (20 IDs), hydrated by the existing public readers. */
export async function readPublicationYearWorks(resources: readonly string[], realm: string):
  Promise<Loaded<ReadonlyMap<string, PublicationYearWork>>> {
  if (!resources.length) return { ok: true, data: new Map() };
  if (resources.length > 20) return { ok: false, failure: 'unavailable' };
  const main = mainApiWithToken(undefined);
  const summaries = await settle(() => main.v1.resources.summaries.post({
    profile: 'resource-summary-batch-v1', resources: [...resources], context: realm,
  }));
  if (!summaries.ok) return summaries;
  const cards = new Map<string, PublicationYearWork>();
  // Small batches bound concurrent work even when a directory page is full.
  for (let offset = 0; offset < resources.length; offset += 4) {
    const batch = await Promise.all(resources.slice(offset, offset + 4).map(async resource => {
      const summary = summaries.data.summaries.find(item => item.reference === resource);
      if (!summary || summary.status !== 'available' || summary.type !== 'work') return true;
      const id = idOf(resource);
      if (!id) return false;
      const [header, credits] = await Promise.all([
        settle(() => main.v1.works({ id }).get({ query: {} })),
        settle(() => main.v1.query.post({ profile: 'template-query-v1',
          query: 'https://rezics.com/query/work-credits', revision: 1,
          parameters: { roots: [resource], role: 'author' }, limit: 64 })),
      ]);
      if (!header.ok || !credits.ok) return false;
      const credit = credits.data.result;
      if (credit.profile !== 'template-result-v1' || credit.query !== 'https://rezics.com/query/work-credits'
        || credit.nextCursor) return false;
      cards.set(resource, { ...header.data, address: summary.address as CanonicalAddress,
        primaryCredits: credit.items, inZone: true });
      return true;
    }));
    if (batch.some(ok => !ok)) return { ok: false, failure: 'unavailable' };
  }
  return { ok: true, data: cards };
}
