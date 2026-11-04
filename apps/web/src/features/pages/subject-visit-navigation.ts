import { subjectHref } from '../../subject/subject-href';
import { realmCatalogueReturnHref } from '../../search/realm-catalogue-handoff';
import { isView } from '@rezics/composition';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const subjectDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/subjects/${uuid}/[^/?#]+(?:/([^/?#]+))?$`);
const realmDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/realms/${uuid}$`);
const returnAddressCap = 32768;

/** A public return address may restore one admitted Subject view window without chaining history. */
export function subjectVisitReturn(value: unknown, locale?: string): string | undefined {
  if (typeof value !== 'string' || value.length > returnAddressCap) return;
  const catalogueReturn = realmCatalogueReturnHref(value, locale);
  if (catalogueReturn) return catalogueReturn;
  if (!value.startsWith('/') || value.startsWith('//')) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    const subject = subjectDestination.exec(url.pathname);
    const realmPath = realmDestination.exec(url.pathname);
    const match = subject ?? realmPath;
    if (
      url.origin !== 'https://rezics.invalid' ||
      !match ||
      (locale !== undefined && match[1] !== locale) ||
      (subject?.[2] !== undefined && !isView(subject[2]))
    )
      return;
    const allowed = new Set(['realm', 'node', 'cursor', 'property']);
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return;
    const selectedRealm = url.searchParams.get('realm');
    const node = url.searchParams.get('node');
    const cursor = url.searchParams.get('cursor');
    const property = url.searchParams.get('property');
    if (
      (selectedRealm !== null && !new RegExp(`^${uuid}$`).test(selectedRealm)) ||
      (node !== null && (!subject?.[2] || !/^[A-Za-z0-9_-]{1,64}$/.test(node))) ||
      (cursor !== null && (!subject?.[2] || !cursor || cursor.length > 8192 || /[\u0000-\u001f]/u.test(cursor))) ||
      (property !== null &&
        (!subject?.[2] || !property.trim() || property.length > 256 || /[\u0000-\u001f]/u.test(property)))
    )
      return;
    const fragment = url.hash === '' ? '#connections' : url.hash;
    if (fragment !== '#connections' && fragment !== '#manga-reader') return;
    return `${url.pathname}${url.search}${fragment}`;
  } catch {
    return;
  }
}

/** Bound route search by its fixed fields plus one validated opaque return address and current cursor. */
export function subjectRouteSearchLimit(search: string, cursor?: string): number {
  const parameters = new URLSearchParams(search);
  const via = parameters.get('via');
  const acceptedVia = via && via.length <= returnAddressCap ? subjectVisitReturn(via) : undefined;
  try {
    const currentCursor = cursor && cursor.length <= 8192 ? encodeURIComponent(cursor).length : 0;
    return 2048 + (acceptedVia ? encodeURIComponent(acceptedVia).length : 0) + currentCursor;
  } catch {
    return 2048;
  }
}

export function connectionReturnHref(id: string, label: string, locale: string, realm?: string): string {
  const url = new URL(subjectHref({ id, label }, locale).href, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  return `${url.pathname}${url.search}#connections`;
}

export function withSubjectVisitReturn(href: string, value: string, locale: string): string {
  const via = subjectVisitReturn(value, locale);
  if (!via || !/^\/[^/]+\/subjects\//.test(href)) return href;
  const url = new URL(href, 'https://rezics.invalid');
  url.searchParams.set('via', via);
  return `${url.pathname}${url.search}${url.hash}`;
}
