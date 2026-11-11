import { discoverySearchHref } from '../../search/search-params';

/** Exact released identities. An Edition is never silently replaced by its work. */
export const bookCatalogueTypes = ['schema:Book', 'schema:BookSeries', 'bf:Instance'] as const;
export type BookCatalogueType = (typeof bookCatalogueTypes)[number];

export type BookCatalogueChoice = {
  type: BookCatalogueType;
  state: 'ready' | 'missing' | 'unavailable';
  label?: string;
  language?: string | null;
  description?: string | null;
  descriptionLanguage?: string | null;
};

/** Search owns query admission, filtering, native pagination and result rendering. */
export function bookDiscoveryHref(locale: string, type: BookCatalogueType): string {
  return discoverySearchHref(locale, {
    query: '',
    type,
    facets: {},
    cursor: undefined,
    sort: undefined,
  });
}
