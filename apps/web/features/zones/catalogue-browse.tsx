import type { ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import { zoneWork } from '../realm/adapt.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import { readZoneBrowse } from '../realm/read.ts';
import { browseHref, mainBrowseQuery, parseBrowseState } from './browse-state.ts';
import type { BrowseModel } from './browse-view.ts';
import { catalogueYearParam, readPublicationYears } from './catalogue-facts.ts';

// A publication year is a query parameter on the one browse route. Format and status stay the realm
// browse Facets. The year comes from the publication-year template and is intersected with those
// results. A Work the template does not list is left out; the page does not invent a year.

const MEMBER_PAGES = 10;
const YEAR_PAGES = 8;

function withFlags(href: string, year: number | null, directory: boolean): string {
  const url = new URL(href, 'https://rezics.local');
  if (year === null) url.searchParams.delete('year');
  else url.searchParams.set('year', String(year));
  if (directory && year === null) url.searchParams.set('years', '1');
  else url.searchParams.delete('years');
  url.searchParams.delete('yearOffset');
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

function directoryParam(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === '1';
}

function offsetOf(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^[0-9]+$/.test(raw)) return 0;
  const offset = Number(raw);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 10_000 ? offset : 0;
}

async function members(view: Extract<RealmView, { kind: 'view' }>, state: ReturnType<typeof parseBrowseState>): Promise<{
  works: Map<string, ZoneWork>; incomplete: boolean; failure: 'unavailable' | null;
}> {
  const works = new Map<string, ZoneWork>();
  let cursor: string | null = null;
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const read = await readZoneBrowse(view.context.realm, view.context.locale, mainBrowseQuery({ ...state, cursor }));
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
 */
export async function applyCatalogueYear({ view, search, model }: {
  view: Extract<RealmView, { kind: 'view' }>;
  search: Record<string, string | string[] | undefined>;
  model: BrowseModel;
}): Promise<{ header: ReactNode; publicationYears: Map<string, number[]>; year: number | null;
  failure: 'unavailable' | null }> {
  const year = catalogueYearParam(search.year);
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
  const kept = model.kept.filter(item => item.name !== 'year' && item.name !== 'years');
  const plain = browseHref(base, { ...state, cursor: null });
  const yearControl = {
    action: base, value: year === null ? '' : String(year), kept,
    clearHref: listing ? withFlags(plain, null, false) : null,
    directoryHref: withFlags(plain, null, true),
    directory, bounded: false,
  };
  const Header = view.pkg?.slots.browseHeader;
  const Link = (await import('../shell/localized-link.tsx')).default;
  const header = Header ? <Header zone={view.zone} filter={null} filtered={false} fallback={null} Link={Link}
    year={yearControl} /> : null;
  const publicationYears = new Map<string, number[]>();
  if (listing) {
    const roster = await members(view, { ...state, cursor: null });
    if (roster.failure) return { header, publicationYears, year, failure: 'unavailable' };
    const found: ZoneWork[] = [];
    let cursor: string | undefined;
    let stopped = false;
    for (let step = 0; step < YEAR_PAGES; step++) {
      const listed = await readPublicationYears(year === null ? {} : { fromYear: year, toYear: year }, cursor);
      if (!listed.ok) return { header, publicationYears, year, failure: 'unavailable' };
      for (const row of listed.data.items) {
        const work = roster.works.get(row.id);
        if (!work) continue;
        const prior = publicationYears.get(work.id) ?? [];
        if (!prior.includes(row.year)) publicationYears.set(work.id, [...prior, row.year].sort((left, right) => right - left));
        if (!found.some(item => item.id === work.id)) found.push(work);
      }
      if (!listed.data.nextCursor) { cursor = undefined; break; }
      cursor = listed.data.nextCursor;
      if (step === YEAR_PAGES - 1) stopped = true;
    }
    const offset = offsetOf(search.yearOffset);
    const slice = found.slice(offset, offset + 20);
    const nextOffset = offset + slice.length;
    const listedHref = withFlags(plain, year, directory);
    const join = listedHref.includes('?') ? '&' : '?';
    model.items = slice;
    model.next = nextOffset < found.length || (stopped && cursor)
      ? `${listedHref}${join}yearOffset=${nextOffset}` : null;
    model.first = offset > 0 ? listedHref : null;
    yearControl.bounded = roster.incomplete || stopped;
    const t = materializeData(view.zoneMessages, { locale: view.context.locale });
    model.results = yearControl.bounded
      ? t.resultsAtLeast({ count: String(found.length) }) : t.results(found.length);
  }
  return { header, publicationYears, year, failure: null };
}
