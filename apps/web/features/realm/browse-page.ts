import type { ZonePackage } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import { browseFacets, type BrowseFacet, type BrowseState } from '../zones/browse-state.ts';
import { browseModel, type BrowseModel, type FacetCounts } from '../zones/browse-view.ts';
import type { ZoneMessages } from '../zones/messages.ts';
import { zoneText, zoneWork, type AdaptContext } from './adapt.ts';
import type { FacetList, Loaded, ZoneBrowsePage } from './types.ts';

/** Main's value counts per Facet, with Concept names as the SDK's text. */
export function browseFacetCounts(page: ZoneBrowsePage): FacetCounts {
  const counts = {} as Record<BrowseFacet, FacetCounts[BrowseFacet]>;
  for (const facet of browseFacets) {
    counts[facet] = page.facets[facet].map(item => ({ value: item.value, count: item.count,
      name: item.name ? zoneText(item.name) : null }));
  }
  return counts;
}

/** The two public answers become the model ZoneBrowse renders in both route and stories. */
export function buildBrowsePage({ page, facets, base, zoneName, state, context, locale, messages, catalogue }: {
  page: Loaded<ZoneBrowsePage>; facets: Loaded<FacetList>;
  base: string; zoneName: string; state: BrowseState; context: AdaptContext;
  locale: UiLocale; messages: ZoneMessages; catalogue?: ZonePackage['catalogue'];
}): Loaded<BrowseModel> {
  if (!page.ok) return page;
  const admitted = new Map((facets.ok ? facets.data.facets : []).filter(facet => facet.current)
    .map(facet => [facet.name, facet.labels[locale]] as const));
  const counts = browseFacetCounts(page.data);
  if (catalogue) {
    const formats = new Set(catalogue.formatNames);
    counts.concept = counts.concept.filter(item =>
      (item.name ? formats.has(item.name.value) : false) || state.filter.concept?.includes(item.value));
  }
  return { ok: true, data: browseModel({ base, zoneName, state, admitted, locale, messages,
    page: { ...page.data, facets: counts, sort: page.data.query.sort,
      items: page.data.items.map(item => zoneWork(item, context, item.evidence)) } }) };
}
