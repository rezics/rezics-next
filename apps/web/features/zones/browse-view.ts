import type { ZoneBrowseEntry, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import { workTypeLabel } from '../catalogue/work.ts';
import { type BrowseFacet, browseFacets, browseHref, type BrowseSort, type BrowseState, chipHref, cleared,
  facetParams, lengthBands, toggled, urlValue } from './browse-state.ts';
import type { ZoneMessages } from './messages.ts';

// Main's browse page as the page shows it: every Facet and value named in the
// reader's language, and every change a link. Pure, so tests and stories
// build it the way the route does.

/** Main's per-Facet value counts; Concept values carry their name. */
export type FacetCounts = Record<BrowseFacet, readonly { value: string; count: number; name?: ZoneText | null }[]>;

export interface BrowseValue { value: string; label: ZoneText; count: number; chosen: boolean; href: string }
export interface BrowseFacetGroup { facet: BrowseFacet; label: string; values: BrowseValue[] }

export interface BrowseModel {
  title: string;
  searchLabel: string;
  placeholder: string;
  /** The form's target and the Conditions it keeps while the text changes. */
  action: string;
  kept: { name: string; value: string }[];
  state: BrowseState;
  groups: BrowseFacetGroup[];
  chosen: { key: string; label: string; remove: string; href: string }[];
  /** "Filters", or "Filters (2)" with Conditions chosen. */
  filtersLabel: string;
  clearHref: string | null;
  sorts: { sort: BrowseSort; label: string; href: string; current: boolean }[];
  views: { view: 'list' | 'grid'; label: string; href: string; current: boolean }[];
  results: string;
  notes: string[];
  items: ZoneWork[];
  next: string | null;
  first: string | null;
}

const plain = (value: string): ZoneText => ({ value, lang: '', dir: 'ltr' });

/** Facet labels: an admitted Facet's own (`GET /v1/facets`), else the page's words for Main's other Conditions. */
export function facetLabel(facet: BrowseFacet, admitted: ReadonlyMap<string, string>, messages: ZoneMessages): string {
  return admitted.get(facet) ?? { modLoader: messages.facetLoader, modGameVersion: messages.facetGameVersion,
    modEnvironment: messages.facetEnvironment, status: messages.facetStatus, length: messages.facetLength,
    concept: messages.facetConcept, type: messages.facetType }[facet];
}

/** A value's label: Concepts by their name, types by the catalogue's word, loaders and versions as they are. */
export function valueLabel(facet: BrowseFacet, value: string, name: ZoneText | null | undefined, locale: UiLocale,
  messages: ZoneMessages): ZoneText | null {
  switch (facet) {
    case 'concept': return name ?? null;
    case 'type': {
      const key = workTypeLabel([value]);
      return key ? plain(catalogueMessages[locale][key]) : null;
    }
    case 'modEnvironment': return plain(value === 'client' ? messages.envClient : messages.envServer);
    case 'status': return plain({ ongoing: messages.statusOngoing, completed: messages.statusCompleted,
      hiatus: messages.statusHiatus }[value as 'ongoing'] ?? value);
    case 'length': {
      const index = lengthBands.indexOf(value as never);
      return index < 0 ? null : plain([messages.length0, messages.length1, messages.length2, messages.length3][index]!);
    }
    default: return plain(value);
  }
}

function groups(base: string, state: BrowseState, counts: FacetCounts, admitted: ReadonlyMap<string, string>,
  locale: UiLocale, messages: ZoneMessages): BrowseFacetGroup[] {
  return browseFacets.flatMap(facet => {
    const values = counts[facet].flatMap(item => {
      const label = valueLabel(facet, item.value, item.name, locale, messages);
      const chosen = state.filter[facet]?.includes(item.value) ?? false;
      return label && (item.count > 0 || chosen) ? [{ value: item.value, label, count: item.count, chosen,
        href: browseHref(base, toggled(state, facet, item.value)) }] : [];
    });
    // A Facet with a single value and nothing chosen cannot narrow anything.
    return values.length > 1 || values.some(value => value.chosen)
      ? [{ facet, label: facetLabel(facet, admitted, messages), values }] : [];
  });
}

export function browseModel({ base, zoneName, state, page, admitted, locale, messages }: {
  base: string; zoneName: string; state: BrowseState;
  page: { items: ZoneWork[]; facets: FacetCounts; matches: { value: number; kind: 'exact' | 'lower-bound' };
    window: { scanned: number; complete: boolean }; tags: 'current' | 'stale' | 'unavailable';
    nextCursor: string | null; sort: BrowseSort };
  admitted: ReadonlyMap<string, string>; locale: UiLocale; messages: ZoneMessages;
}): BrowseModel {
  const t = materializeData(messages, { locale });
  const facetGroups = groups(base, state, page.facets, admitted, locale, messages);
  const chosen = browseFacets.flatMap(facet => (state.filter[facet] ?? []).map(value => {
    const label = facetGroups.find(group => group.facet === facet)?.values.find(item => item.value === value)?.label.value
      ?? valueLabel(facet, value, null, locale, messages)?.value ?? value;
    return { key: `${facet}:${value}`, label, remove: t.removeFilter({ label }),
      href: browseHref(base, toggled(state, facet, value)) };
  }));
  const sorts = (state.text ? ['relevance', 'newest', 'updated'] as const : ['newest', 'updated'] as const)
    .map(sort => ({ sort, current: page.sort === sort,
      label: { relevance: messages.sortRelevance, newest: messages.sortNewest, updated: messages.sortUpdated }[sort],
      href: browseHref(base, { ...state, sort, cursor: null }) }));
  const views = (['list', 'grid'] as const).map(view => ({ view, current: state.view === view,
    label: view === 'list' ? messages.viewList : messages.viewGrid,
    href: browseHref(base, { ...state, view, cursor: state.cursor }) }));
  const notes = [
    page.window.complete ? null : t.windowNote({ count: String(page.window.scanned) }),
    page.tags === 'stale' && state.filter.concept ? messages.tagsStale : null,
    page.tags === 'unavailable' && state.filter.concept ? messages.tagsUnavailable : null,
    page.items.some(item => item.mod) || state.filter.modLoader || state.filter.modGameVersion ? messages.noDownloads
      : null,
  ].filter(note => note !== null);
  const kept = browseFacets.flatMap(facet => (state.filter[facet] ?? []).map(value =>
    ({ name: facetParams[facet], value: urlValue(facet, value) })));
  return { title: t.browseTitle({ zone: zoneName }), searchLabel: t.searchLabel({ zone: zoneName }),
    placeholder: t.searchPlaceholder({ zone: zoneName }), action: base,
    kept: [...kept, ...state.view === 'grid' ? [{ name: 'view', value: 'grid' }] : []],
    state, groups: facetGroups, chosen,
    filtersLabel: chosen.length ? t.filtersChosen({ count: String(chosen.length) }) : messages.filters, clearHref: chosen.length ? browseHref(base, cleared(state)) : null,
    sorts, views,
    results: page.matches.kind === 'exact' ? t.results(page.matches.value)
      : t.resultsAtLeast({ count: String(page.matches.value) }),
    notes, items: page.items,
    next: page.nextCursor ? browseHref(base, { ...state, cursor: page.nextCursor }) : null,
    first: state.cursor ? browseHref(base, { ...state, cursor: null }) : null };
}

/** The Facets the home's search bar offers, in this order, and how many values of each. */
const entryFacets: readonly (readonly [BrowseFacet, number])[] = [['modLoader', 3], ['modGameVersion', 4],
  ['modEnvironment', 2], ['status', 3], ['length', 4]];

/** What a Zone home leads with: its search, and the values of the Facets Main measures as one-filter links. */
export function browseEntry({ base, zoneName, counts, locale, messages }: {
  base: string; zoneName: string; counts: FacetCounts | null; locale: UiLocale; messages: ZoneMessages;
}): ZoneBrowseEntry {
  const t = materializeData(messages, { locale });
  const groups = counts ? entryFacets.flatMap(([facet, limit]) => {
    const chips = counts[facet].filter(item => item.count > 0).slice(0, limit).flatMap(item => {
      const label = valueLabel(facet, item.value, item.name, locale, messages);
      return label ? [{ facet, value: item.value, label, count: item.count, href: chipHref(base, facet, item.value) }] : [];
    });
    return chips.length > 1 ? [{ facet, label: facetLabel(facet, new Map(), messages), chips }] : [];
  }) : [];
  return { href: base, searchLabel: t.searchLabel({ zone: zoneName }),
    placeholder: t.searchPlaceholder({ zone: zoneName }), groups };
}
