import * as v from 'valibot';
import { locales } from '../paraglide/runtime.js';
import { subjectHref, type SubjectHrefInput } from '../subject/subject-href';
import { isSearchResourceScope } from './advanced-scope';
import { RATING_POPULATION_FIELD } from './rating-population';
import { searchLoaderDeps, searchParams } from './search-params';
import { realmReadingSearch } from '../community/realm-reading-return';

const origin = 'https://rezics.invalid';
const returnFragment = '#search-results';
const returnLimit = 2048;
const searchPath = new RegExp(`^/(${locales.join('|')})/search$`);
const realmPath = new RegExp(
  `^/(${locales.join('|')})/realms/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`,
);
const searchIntentKeys = new Set([
  'q',
  'type',
  'cursor',
  'searchCursor',
  'kinds',
  'language',
  'condition',
  'filter',
  'sort',
  RATING_POPULATION_FIELD,
  'layout',
]);

/** Keep the same bounded, same-locale Realm Search visit available from a Subject's Connections view. */
export function realmCatalogueReturnHref(value: unknown, locale?: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length + (value.endsWith(returnFragment) ? 0 : returnFragment.length) > returnLimit ||
    !value.startsWith('/') ||
    value.startsWith('//')
  )
    return;
  try {
    const url = new URL(value, origin);
    const search = searchPath.exec(url.pathname);
    const realm = realmPath.exec(url.pathname);
    const path = search ?? realm;
    if (
      url.origin !== origin ||
      !path ||
      (locale !== undefined && path[1] !== locale) ||
      (url.hash !== '' && url.hash !== returnFragment)
    )
      return;
    const params: Record<string, unknown> = Object.create(null);
    for (const key of new Set(url.searchParams.keys())) {
      const shelfKey = realm && (key === 'node' || key === 'cursor');
      const realmSearchCursor = realm && key === 'searchCursor';
      if (
        !shelfKey &&
        !realmSearchCursor &&
        !searchIntentKeys.has(key) &&
        !key.startsWith('f.') &&
        !key.startsWith('r.')
      )
        return;
      const values = url.searchParams.getAll(key);
      params[key] = values.length === 1 ? values[0] : values;
    }
    if (search && ('searchCursor' in params || 'node' in params)) return;
    const shelf = realm ? realmReadingSearch(params) : undefined;
    if (
      realm &&
      ((params.node !== undefined && params.node !== shelf?.node) ||
        (params.cursor !== undefined && params.cursor !== shelf?.cursor))
    )
      return;
    const parsed = v.safeParse(searchParams, params);
    if (!parsed.success) return;
    const deps = searchLoaderDeps({
      ...(parsed.output as Record<string, unknown>),
      cursor: realm ? params.searchCursor : params.cursor,
    });
    if (deps.invalidInput || !isSearchResourceScope(deps.resourceScope) || deps.resourceScope.kind !== 'realm') return;
    if (realm && deps.resourceScope.id.toLowerCase() !== realm[2]!.toLowerCase()) return;
    return `${url.pathname}${url.search}${returnFragment}`;
  } catch {
    return;
  }
}

/** Add a bounded Search return to a canonical Subject destination without changing Search's query bytes. */
export function realmCatalogueSubjectHref(subject: SubjectHrefInput, locale: string, search: unknown): string {
  const href = subjectHref(subject, locale).href;
  const returnHref = realmCatalogueReturnHref(search, locale);
  if (!returnHref) return href;
  const url = new URL(href, origin);
  url.searchParams.set('via', returnHref);
  return `${url.pathname}${url.search}`;
}
