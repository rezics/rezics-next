import { subjectHref } from '../../subject/subject-href';
import { realmCatalogueReturnHref } from '../../search/realm-catalogue-handoff';
import { isView } from '@rezics/composition';
import { copiesSubjectId } from '../../library/copies-query';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const subjectDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/subjects/${uuid}/[^/?#]+(?:/([^/?#]+))?$`);
const realmDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/realms/${uuid}$`);
const copiesDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/library/copies$`);
const returnAddressCap = 32768;
const collectionDestination = new RegExp(`^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/collections/${uuid}$`);

export type ConnectionReturnWindow = {
  stream: string;
  cursor?: string;
  reading?: string;
  focus?: string;
  holder?: string;
};

/** An opaque public locator, not rows, credentials, a reveal grant or a recursive opener. */
export function connectionReturnWindow(hash: string): ConnectionReturnWindow | undefined {
  if (!hash.startsWith('#connections?') || hash.length > 28000) return;
  const params = new URLSearchParams(hash.slice('#connections?'.length));
  const keys = [...params.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['stream', 'cursor', 'reading', 'focus', 'holder'].includes(key))
  )
    return;
  const stream = params.get('stream');
  const reading = params.get('reading');
  const cursor = params.get('cursor');
  const focus = params.get('focus');
  const holder = params.get('holder');
  if (
    !stream ||
    !/^(in|out):[^\s\u0000-\u001f]{1,256}$/u.test(stream) ||
    (reading !== null && !/^[a-f0-9]{64}$/.test(reading)) ||
    (reading === null && (cursor !== null || focus !== null || holder !== null)) ||
    (cursor !== null && (!cursor || cursor.length > 8192 || /[\u0000-\u001f]/u.test(cursor))) ||
    (focus !== null && !new RegExp(`^${uuid}$`).test(focus)) ||
    (holder !== null && (!focus || !new RegExp(`^${uuid}$`).test(holder))) ||
    (focus !== null && !holder)
  )
    return;
  return {
    stream,
    ...(reading ? { reading } : {}),
    ...(cursor ? { cursor } : {}),
    ...(focus ? { focus, holder: holder! } : {}),
  };
}

export function connectionWindowFragment(window: ConnectionReturnWindow): string {
  const params = new URLSearchParams({ stream: window.stream });
  if (window.reading) params.set('reading', window.reading);
  if (window.cursor) params.set('cursor', window.cursor);
  if (window.focus && window.holder) {
    params.set('focus', window.focus);
    params.set('holder', window.holder);
  }
  const hash = `#connections?${params}`;
  return connectionReturnWindow(hash) ? hash : '#connections';
}

function collectionReturn(url: URL, locale?: string): string | undefined {
  const match = collectionDestination.exec(url.pathname);
  if (!match || (locale !== undefined && match[1] !== locale)) return undefined;
  const params = new URLSearchParams();
  const seen = new Set<string>();
  let filters = 0;
  for (const [key, value] of url.searchParams) {
    if (key === 'cursor' || key === 'layout' || key === 'type') {
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (key === 'cursor' && value.length > 4096) return undefined;
      if (key === 'layout' && value !== 'grid' && value !== 'list') return undefined;
      if (key === 'type' && value.length > 128) return undefined;
      params.append(key, value);
    } else if (/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) && value.length <= 256 && filters < 100) {
      params.append(key, value);
      filters += 1;
    }
  }
  const hash = /^#collection-member-[0-9a-f-]{36}$/i.test(url.hash) ? url.hash : '';
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ''}${hash}`;
}

/** A public return address may restore one admitted Subject or Collection view window. */
export function subjectVisitReturn(value: unknown, locale?: string): string | undefined {
  if (typeof value !== 'string' || value.length > returnAddressCap) return;
  const catalogueReturn = realmCatalogueReturnHref(value, locale);
  if (catalogueReturn) return catalogueReturn;
  if (!value.startsWith('/') || value.startsWith('//')) return;
  try {
    const url = new URL(value, 'https://rezics.invalid');
    const collection = collectionReturn(url, locale);
    if (collection) return collection;
    const subject = subjectDestination.exec(url.pathname);
    const realmPath = realmDestination.exec(url.pathname);
    const copiesPath = copiesDestination.exec(url.pathname);
    const match = subject ?? realmPath ?? copiesPath;
    if (
      url.origin !== 'https://rezics.invalid' ||
      !match ||
      (locale !== undefined && match[1] !== locale) ||
      (subject?.[2] !== undefined && !isView(subject[2]) && subject[2] !== 'sources')
    )
      return;
    if (copiesPath) {
      const keys = [...url.searchParams.keys()];
      if (
        url.hash ||
        new Set(keys).size !== keys.length ||
        keys.some((key) => key !== 'subjectId' && key !== 'cursor') ||
        (url.searchParams.has('subjectId') && !copiesSubjectId(url.searchParams.get('subjectId'))) ||
        (url.searchParams.get('cursor')?.length ?? 0) > 2048
      )
        return;
      return `${url.pathname}${url.search}`;
    }
    const allowed = new Set(['realm', 'node', 'cursor', 'property', 'screenCursor', 'screenSelection']);
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !allowed.has(key)) || new Set(keys).size !== keys.length) return;
    const selectedRealm = url.searchParams.get('realm');
    const node = url.searchParams.get('node');
    const cursor = url.searchParams.get('cursor');
    const property = url.searchParams.get('property');
    const screenCursor = url.searchParams.get('screenCursor');
    const screenSelection = url.searchParams.get('screenSelection');
    const screenEntry = /^#screen-episode-entry-([0-9a-f-]{36})$/i.exec(url.hash);
    const screenReturn = screenCursor !== null || screenSelection !== null || screenEntry !== null;
    if (
      (selectedRealm !== null && !new RegExp(`^${uuid}$`).test(selectedRealm)) ||
      (node !== null && (!subject?.[2] || !/^[A-Za-z0-9_-]{1,64}$/.test(node))) ||
      (cursor !== null && (!subject?.[2] || !cursor || cursor.length > 8192 || /[\u0000-\u001f]/u.test(cursor))) ||
      (property !== null &&
        (!subject?.[2] || !property.trim() || property.length > 256 || /[\u0000-\u001f]/u.test(property))) ||
      (screenReturn &&
        (subject?.[2] !== undefined ||
          (screenCursor !== null &&
            (!screenCursor || screenCursor.length > 8192 || /[\u0000-\u001f]/u.test(screenCursor))) ||
          (screenSelection !== null && !new RegExp(`^${uuid}$`, 'i').test(screenSelection)) ||
          (screenEntry !== null && !new RegExp(`^${uuid}$`, 'i').test(screenEntry[1]!)) ||
          (screenSelection !== null && screenEntry?.[1]?.toLowerCase() !== screenSelection.toLowerCase()) ||
          (screenSelection === null && screenEntry !== null)))
    )
      return;
    const fragment = url.hash === '' ? '#connections' : url.hash;
    if (
      fragment !== '#literary-reader' &&
      fragment !== '#connections' &&
      !(subject && connectionReturnWindow(fragment)) &&
      fragment !== '#manga-reader' &&
      fragment !== '#screen-episode-list' &&
      screenEntry === null &&
      !(subject?.[2] === 'sources' && fragment === '#subject-sources-heading')
    )
      return;
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

export function connectionReturnHref(
  id: string,
  label: string,
  locale: string,
  realm?: string,
  window?: ConnectionReturnWindow,
): string {
  const url = new URL(subjectHref({ id, label }, locale).href, 'https://rezics.invalid');
  if (realm) url.searchParams.set('realm', realm);
  return `${url.pathname}${url.search}${window ? connectionWindowFragment(window) : '#connections'}`;
}

export function withSubjectVisitReturn(href: string, value: string, locale: string): string {
  const via = subjectVisitReturn(value, locale);
  if (!via || !/^\/[^/]+\/subjects\//.test(href)) return href;
  const url = new URL(href, 'https://rezics.invalid');
  const existing = url.searchParams.getAll('via');
  if (existing.length === 1 && subjectVisitReturn(existing[0], locale)) return href;
  url.searchParams.set('via', via);
  return `${url.pathname}${url.search}${url.hash}`;
}
