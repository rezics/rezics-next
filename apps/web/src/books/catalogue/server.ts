import { createServerFn } from '@tanstack/react-start';
import { getLocale } from '../../paraglide/runtime.js';
import { readTypeDescriptor } from '../../features/catalogue/type-directory';
import { readBookCatalogue } from './model';

/** Three finite metadata reads; no Subject, Search or private Library reads on this entry. */
export const loadBookCatalogue = createServerFn({ method: 'GET' }).handler(() =>
  readBookCatalogue(getLocale(), readTypeDescriptor),
);
