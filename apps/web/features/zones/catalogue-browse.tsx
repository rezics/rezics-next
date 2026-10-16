import type { ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import { zoneWork } from '../realm/adapt.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import type { FilterCondition } from '../../../../model/definitions/filter-document-v1.ts';
import type { readPublicationYearWorks } from './catalogue-facts.ts';
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
  return raw ?? null;
}

function yearHref(href: string, cursor: string | null): string {
  const url = new URL(href, 'https://rezics.local');
  if (cursor) url.searchParams.set('yearCursor', cursor);
  else url.searchParams.delete('yearCursor');
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

/** The same admitted Facet state as Realm browse, passed to the year owner. */
export function catalogueYearScope(realm: string, state: ReturnType<typeof parseBrowseState>) {
  const all: FilterCondition[] = [];
  for (const facet of ['type', 'concept', 'status'] as const) {
    if (state.filter[facet]?.length) all.push({ facet, any: state.filter[facet] });
  }
  if (state.filter.length?.[0]) {
    const [min, max] = state.filter.length[0].split('-');
    all.push({ facet: 'length', range: { ...(min ? { min } : {}), ...(max ? { max } : {}) } });
  }
  if (state.excludedConcepts?.length) all.push({ facet: 'concept', none: state.excludedConcepts });
  return { realm: realm.startsWith('https://rezics.com/id/') ? realm : `https://rezics.com/id/${realm}`,
    filter: { all }, ...(state.text ? { text: state.text } : {}) };
}

/**
 * Fills the header slot's year control and preserves all-years directory links.
 * Selected-year Conditions belong to the shared browse model the route already built.
 * A selected year keeps the route's API items, counts and continuation.
 * The year query owns membership; hydration follows only its returned IDs.
 */
export async function applyCatalogueYear({ view, search, model }: {
  view: Extract<RealmView, { kind: 'view' }>;
  search: Record<string, string | string[] | undefined>;
  model: BrowseModel;
}, reads: { publicationYears?: typeof readPublicationYears; works?: typeof readPublicationYearWorks } = {}): Promise<{
  header: ReactNode; publicationYears: Map<string, number[]>; year: number | null;
  failure: 'unavailable' | null }> {
  const year = catalogueYearCondition(search.year);
  const directory = year === null && directoryParam(search.years);
  const base = view.zone.links.browse;
  const state = parseBrowseState(search);
  const listing = year !== null || directory;
  if (directory) {
    const stamp = (href: string) => withFlags(href, null, true);
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
    model.kept = [...model.kept, { name: 'years', value: '1' }];
  }
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
  if (exactYear !== null) {
    const page = { works: model.items, nextCursor: model.nextCursor };
    for (const work of page.works) publicationYears.set(work.id, [exactYear]);
  }
  if (directory) {
    // Directory reads belong to the server. Selected-year presentation can also
    // render in Storybook without importing their request context.
    const years = reads.publicationYears ?? (await import('./catalogue-facts.ts')).readPublicationYears;
    const hydrate = reads.works ?? (await import('./catalogue-facts.ts')).readPublicationYearWorks;
    const parameters = catalogueYearScope(view.context.realm, state);
    const listed = await years(parameters, yearCursorOf(search.yearCursor) ?? undefined);
    if (!listed.ok) return { header, publicationYears, year: exactYear, failure: 'unavailable' };
    const page = { rows: listed.data.items, nextCursor: listed.data.nextCursor };
    const resources = [...new Set(page.rows.map(row => row.id))];
    const cards = await hydrate(resources, parameters.realm);
    if (!cards.ok) return { header, publicationYears, year: exactYear, failure: 'unavailable' };
    const found: ZoneWork[] = [];
    for (const row of page.rows) {
      const summary = cards.data.get(row.id);
      if (!summary) return { header, publicationYears, year: exactYear, failure: 'unavailable' };
      const work = zoneWork(summary, view.context, null);
      const prior = publicationYears.get(work.id) ?? [];
      if (!prior.includes(row.year)) publicationYears.set(work.id, [...prior, row.year].sort((left, right) => right - left));
      if (!found.some(item => item.id === work.id)) found.push(work);
    }
    const listedHref = withFlags(plain, year, directory);
    const t = materializeData(view.zoneMessages, { locale: view.context.locale });
    const open = page.nextCursor !== null;
    Object.assign(model, {
      items: found, nextCursor: page.nextCursor,
      next: page.nextCursor ? yearHref(listedHref, page.nextCursor) : null,
      first: yearCursorOf(search.yearCursor) ? listedHref : null,
      complete: !open,
      results: open ? t.resultsAtLeast({ count: String(found.length) }) : t.results(found.length),
    });
  }
  return { header, publicationYears, year: exactYear, failure: null };
}
