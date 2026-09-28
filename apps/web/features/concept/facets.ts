import type { UiLocale } from '../../i18n/define.ts';
import type { Facet, FacetList } from './types.ts';

// Facets name every kind of value a reader filters by (`GET /v1/facets`), so the
// web keeps no table of its own: "Tags" is the free Concept Facet's label.

/** The Facet's label in the interface locale; Main supplies one for each. */
export const facetLabel = (facet: Pick<Facet, 'labels'>, locale: UiLocale): string =>
  facet.labels[locale] ?? facet.labels.en;

export const facetByRef = (facets: FacetList | null, ref: string): Facet | null =>
  facets?.facets.find(facet => facet.id === ref) ?? null;

/**
 * The Facet a Work's accepted Concepts are read through: the current free
 * Concept Facet ("Tags"). A Concept Facet limited to a scheme, such as a
 * genre Facet, would claim only its scheme's Concepts; classification items
 * do not carry schemes yet, so every Concept is read through the free one.
 */
export const classificationFacet = (facets: FacetList | null): Facet | null =>
  facets?.facets.find(facet => facet.current
    && facet.values.some(domain => domain.kind === 'concept' && !('scheme' in domain && domain.scheme))) ?? null;
