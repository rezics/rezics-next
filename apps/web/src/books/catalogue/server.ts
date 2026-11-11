import { createServerFn } from '@tanstack/react-start';
import { getLocale } from '../../paraglide/runtime.js';
import { readTypeDescriptor } from '../../features/catalogue/type-directory';
import { bookCatalogueTypes, type BookCatalogueChoice } from './model';

/** Three finite metadata reads; no Subject, Search or private Library reads on this entry. */
export const loadBookCatalogue = createServerFn({ method: 'GET' }).handler(async () => {
  const locale = getLocale();
  const choices = await Promise.all(
    bookCatalogueTypes.map(async (type): Promise<BookCatalogueChoice> => {
      const result = await readTypeDescriptor(type, locale);
      if (!result.ok) return { type, state: result.reason };
      const { descriptor } = result;
      return {
        type,
        state: 'ready',
        label: descriptor.label,
        language: descriptor.language,
        description: descriptor.description,
        descriptionLanguage: descriptor.descriptionLanguage,
      };
    }),
  );
  return { locale, choices };
});
