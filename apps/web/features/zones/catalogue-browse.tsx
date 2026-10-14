import type { ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import { zoneWork } from '../realm/adapt.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import type { readZoneBrowse } from '../realm/read.ts';
import { browseHref, mainBrowseQuery, parseBrowseState } from './browse-state.ts';
import type { BrowseModel } from './browse-view.ts';
import type { readPublicationYears } from './catalogue-facts.ts';
import { catalogueYearCondition, catalogueYearParam } from './catalogue-year.ts';

// A selected year is a Condition on the Realm's browse read. The all-years
// directory retains its existing publication-year template and ordering source.
export function catalogueBrowseQuery(search: Record<string, string | string[] | undefined>):
  ReturnType<typeof mainBrowseQuery> & { publicationYear?: string } {
  const year = catalogueYearCondition(search.year);
  return { ...mainBrowseQuery(parseBrowseState(search)),
    ...year !== null ? { publicationYear: String(year) } : {} };
}

export const MEMBER_PAGES = 10;
/** Pages of `work-publication-years` one request may read. A cap on that request's cost, not a quota. */
export const YEAR_PAGES = 8;
/** Matches kept from the pages this request read. A further year-read page waits for the next cursor. */
const SCREEN = 20;

function withFlags(href: string, year: string | null, directory: boolean): string {
  const url = new URL(href, 'https://rezics.local');
  if (year === null) url.searchParams.delete('year');
  else url.searchParams.set('year', String(year));
  if (directory && year === null) url.searchParams.set('years', '1');
  else url.searchParams.delete('years');
  url.searchParams.delete('yearOffset');
  url.searchParams.delete('yearCursor');
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

function directoryParam(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === '1';
}

/** The publication-year cursor the year view resumes from, or null at the start of the read. */
function yearCursorOf(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length <= 2048 ? raw : null;
}

function yearHref(href: string, cursor: string | null): string {
  const url = new URL(href, 'https://rezics.local');
  if (cursor) url.searchParams.set('yearCursor', cursor);
  else url.searchParams.delete('yearCursor');
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

// The roster intersection stops after MEMBER_PAGES, so a year view covers only those Works
// and may miss the rest. Use work-publication-years with `concept` and drop the roster intersection.
async function members(view: Extract<RealmView, { kind: 'view' }>, state: ReturnType<typeof parseBrowseState>,
  browse: typeof readZoneBrowse): Promise<{
  works: Map<string, ZoneWork>; incomplete: boolean; failure: 'unavailable' | null;
}> {
  const works = new Map<string, ZoneWork>();
  let cursor: string | null = null;
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const read = await browse(view.context.realm, view.context.locale, mainBrowseQuery({ ...state, cursor }));
    if (!read.ok) return { works, incomplete: true, failure: 'unavailable' };
    for (const item of read.data.items) works.set(item.id, zoneWork(item, view.context, item.evidence));
    cursor = read.data.nextCursor;
    if (!cursor) return { works, incomplete: false, failure: null };
  }
  return { works, incomplete: cursor !== null, failure: null };
}

/**
 * Stamps the year onto the browse model the route already built, and fills the header slot's year
 * control. The route has already loaded the view and the first browse page.
 * A selected year keeps the route's API items, counts and continuation.
 * `reads` replaces the unchanged all-years directory's year and roster reads in tests.
 */
export async function applyCatalogueYear({ view, search, model }: {
  view: Extract<RealmView, { kind: 'view' }>;
  search: Record<string, string | string[] | undefined>;
  model: BrowseModel;
}, reads: { publicationYears?: typeof readPublicationYears; zoneBrowse?: typeof readZoneBrowse } = {}): Promise<{
  header: ReactNode; publicationYears: Map<string, number[]>; year: number | null;
  failure: 'unavailable' | null }> {
  const year = catalogueYearCondition(search.year);
  const directory = year === null && directoryParam(search.years);
  const base = view.zone.links.browse;
  const state = parseBrowseState(search);
  const listing = year !== null || directory;
  const stamp = (href: string) => withFlags(href, year, directory);
  model.action = stamp(model.action);
  model.clearHref = model.clearHref ? stamp(model.clearHref) : null;
  model.next = model.next ? stamp(model.next) : null;
  model.first = model.first ? stamp(model.first) : null;
  for (const group of model.groups) for (const value of group.values) {
    value.href = stamp(value.href);
    if (value.excludeHref) value.excludeHref = stamp(value.excludeHref);
  }
  for (const item of model.chosen) item.href = stamp(item.href);
  for (const item of model.sorts) item.href = stamp(item.href);
  for (const item of model.views) item.href = stamp(item.href);
  if (year !== null) model.kept = [...model.kept, { name: 'year', value: String(year) }];
  else if (directory) model.kept = [...model.kept, { name: 'years', value: '1' }];
  const kept = [...model.kept.filter(item => item.name !== 'year' && item.name !== 'years'),
    ...(state.text ? [{ name: 'q', value: state.text }] : []),
    ...(state.sort ? [{ name: 'sort', value: state.sort }] : [])];
  const plain = browseHref(base, { ...state, cursor: null });
  const yearControl = {
    action: base, value: year === null ? '' : String(year), kept,
    clearHref: listing ? withFlags(plain, null, false) : null,
    directoryHref: withFlags(plain, null, true),
    directory, window: 0, bounded: false,
  };
  const Header = view.pkg?.slots.browseHeader;
  const Link = Header ? (await import('../shell/localized-link.tsx')).default : null;
  const header = Header && Link ? <Header zone={view.zone} filter={null} filtered={false} fallback={null} Link={Link}
    year={yearControl} /> : null;
  const publicationYears = new Map<string, number[]>();
  // A range is a Condition, not evidence of each card's publication year.
  const exactYear = year === null ? null : catalogueYearParam(year);
  if (exactYear !== null) for (const work of model.items) publicationYears.set(work.id, [exactYear]);
  if (directory) {
    // Directory reads belong to the server. Selected-year presentation can also
    // render in Storybook without importing their request context.
    const years = reads.publicationYears ?? (await import('./catalogue-facts.ts')).readPublicationYears;
    const browse = reads.zoneBrowse ?? (await import('../realm/read.ts')).readZoneBrowse;
    const roster = await members(view, { ...state, cursor: null }, browse);
    if (roster.failure) return { header, publicationYears, year: exactYear, failure: 'unavailable' };
    const found: ZoneWork[] = [];
    let cursor = yearCursorOf(search.yearCursor) ?? undefined;
    let nextCursor: string | null = null;
    // YEAR_PAGES bounds one request. Works outside this Zone are filtered after the read;
    // the year template does not take a format or type yet.
    for (let step = 0; step < YEAR_PAGES; step++) {
      const listed = await years({}, cursor);
      if (!listed.ok) return { header, publicationYears, year: exactYear, failure: 'unavailable' };
      for (const row of listed.data.items) {
        const work = roster.works.get(row.id);
        if (!work) continue;
        const prior = publicationYears.get(work.id) ?? [];
        if (!prior.includes(row.year)) publicationYears.set(work.id, [...prior, row.year].sort((left, right) => right - left));
        if (!found.some(item => item.id === work.id)) found.push(work);
      }
      if (!listed.data.nextCursor) { nextCursor = null; break; }
      nextCursor = listed.data.nextCursor;
      cursor = listed.data.nextCursor;
      if (found.length >= SCREEN) break;
    }
    // Every match on a page this request read stays on the screen, so the read leaves nothing
    // unshown. Next carries the cursor where the read stopped when a further page remains.
    // The same cursor again would re-read this page. A screen with no match still links forward
    // when the read advanced, so this Zone's Works further on stay reachable.
    const started = yearCursorOf(search.yearCursor);
    const resume = nextCursor && nextCursor !== started ? nextCursor : null;
    const listedHref = withFlags(plain, year, directory);
    model.items = found;
    model.next = resume ? yearHref(listedHref, resume) : null;
    model.first = started ? listedHref : null;
    yearControl.window = roster.works.size;
    yearControl.bounded = roster.incomplete;
    const t = materializeData(view.zoneMessages, { locale: view.context.locale });
    const open = roster.incomplete || nextCursor !== null;
    model.results = open
      ? t.resultsAtLeast({ count: String(found.length) }) : t.results(found.length);
  }
  return { header, publicationYears, year: exactYear, failure: null };
}
