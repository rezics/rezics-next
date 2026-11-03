import { subjectHref } from '../../subject/subject-href';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const destination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/(?:subjects/${uuid}/[^/?#]+|realms/${uuid})$`);

/** A single public return address. Never carry a nested return chain, private rows, credentials or cursors. */
export function subjectVisitReturn(value: unknown, locale?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    const match = destination.exec(url.pathname);
    if (url.origin !== 'https://rezics.invalid' || !match || (locale !== undefined && match[1] !== locale)) return;
    if ([...url.searchParams.keys()].some((key) => key !== 'realm') || url.searchParams.getAll('realm').length > 1)
      return;
    const realm = url.searchParams.get('realm');
    if (realm !== null && !new RegExp(`^${uuid}$`).test(realm)) return;
    return `${url.pathname}${url.search}#connections`;
  } catch {
    return;
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
