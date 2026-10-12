import type { ReactNode } from 'react';
import type { RealmView } from '../realm/realm-page.tsx';
import { browseHref, mainBrowseQuery, parseBrowseState } from './browse-state.ts';
import type { BrowseModel } from './browse-view.ts';
import { catalogueYearParam } from './catalogue-year.ts';

// Year, format and status belong to the same API read and its continuation.
export function catalogueBrowseQuery(search: Record<string, string | string[] | undefined>):
  ReturnType<typeof mainBrowseQuery> & { publicationYear?: string; publicationYearOrder?: 'descending' } {
  const year = catalogueYearParam(search.year);
  return { ...mainBrowseQuery(parseBrowseState(search)),
    ...year !== null ? { publicationYear: String(year) }
      : directoryParam(search.years) ? { publicationYear: '1-9999', publicationYearOrder: 'descending' as const } : {} };
}

function withFlags(href: string, year: number | null, directory: boolean): string {
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

/**
 * Stamps the year onto the browse model the route already built, and fills the header slot's year
 * control. The route has already loaded the view and the first browse page.
 * The route used catalogueBrowseQuery, so items, counts and Facets already describe the year.
 */
export async function applyCatalogueYear({ view, search, model }: {
  view: Extract<RealmView, { kind: 'view' }>;
  search: Record<string, string | string[] | undefined>;
  model: BrowseModel;
}): Promise<{
  header: ReactNode; publicationYears: Map<string, number[]>; year: number | null;
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
    directory, window: 0, bounded: false,
  };
  const Header = view.pkg?.slots.browseHeader;
  const Link = Header ? (await import('../shell/localized-link.tsx')).default : null;
  const header = Header && Link ? <Header zone={view.zone} filter={null} filtered={false} fallback={null} Link={Link}
    year={yearControl} /> : null;
  const publicationYears = new Map<string, number[]>();
  if (year !== null) for (const work of model.items) publicationYears.set(work.id, [year]);
  return { header, publicationYears, year, failure: null };
}
