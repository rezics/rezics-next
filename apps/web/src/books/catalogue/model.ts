import { discoverySearchHref } from '../../search/search';

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

type DescriptorRead =
  | { ok: false; reason: 'missing' | 'unavailable' }
  | {
      ok: true;
      descriptor: {
        label: string;
        language: string | null;
        description: string | null;
        descriptionLanguage: string | null;
      };
    };

/** Finite released metadata only. The destination applications own their page requests. */
export async function readBookCatalogue<Locale extends string>(
  locale: Locale,
  readDescriptor: (type: BookCatalogueType, locale: string) => Promise<DescriptorRead>,
): Promise<{ locale: Locale; choices: BookCatalogueChoice[] }> {
  const choices = await Promise.all(
    bookCatalogueTypes.map(async (type): Promise<BookCatalogueChoice> => {
      const result = await readDescriptor(type, locale);
      if (!result.ok) return { type, state: result.reason };
      const { label, language, description, descriptionLanguage } = result.descriptor;
      return { type, state: 'ready', label, language, description, descriptionLanguage };
    }),
  );
  return { locale, choices };
}

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
