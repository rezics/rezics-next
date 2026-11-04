import { subjectHref } from '../../../subject/subject-href';
import { seriesUuid } from '../screen-episode-membership';
import type { ScreenEpisodeEntry } from './read';

export const SCREEN_EPISODE_CURSOR = 'screenCursor';

export type ScreenEpisodeOrigin = { pathname: string; searchStr: string };

function pathIsSubjectOverview(path: string, locale: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#') || path.length > 512)
    return false;
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[1] !== 'subjects' || !seriesUuid.test(parts[2] ?? '') || !parts[3]) return false;
  try {
    return decodeURIComponent(parts[0] ?? '') === locale && decodeURIComponent(parts[3] ?? '').length <= 256;
  } catch {
    return false;
  }
}

export function screenEpisodeCursor(searchStr: string): string | undefined {
  return new URLSearchParams(searchStr).get(SCREEN_EPISODE_CURSOR) ?? undefined;
}

export function screenEpisodeContinuationHref(origin: ScreenEpisodeOrigin, cursor: string): string {
  const search = new URLSearchParams(origin.searchStr);
  search.set(SCREEN_EPISODE_CURSOR, cursor);
  return `${origin.pathname}?${search.toString()}#screen-episode-list`;
}

export function screenEpisodeSubjectHref(
  entry: ScreenEpisodeEntry,
  label: string,
  locale: string,
  origin: ScreenEpisodeOrigin,
): string {
  const href = subjectHref({ id: entry.id, label }, locale).href;
  const source = new URLSearchParams(origin.searchStr);
  const realm = source.get('realm');
  const cursor = screenEpisodeCursor(origin.searchStr);
  const target = new URL(href, 'https://rezics.invalid');
  const search = new URLSearchParams();
  if (realm && seriesUuid.test(realm)) {
    search.set('realm', realm);
    search.set('screenReturnRealm', realm);
  }
  if (pathIsSubjectOverview(origin.pathname, locale)) {
    search.set('screenReturnPath', origin.pathname);
    if (cursor && cursor.length <= 8192) search.set('screenReturnCursor', cursor);
  }
  target.search = search.toString();
  return `${target.pathname}${target.search}`;
}

export function screenEpisodeReturnHref(locale: string, searchStr: string): string | undefined {
  const search = new URLSearchParams(searchStr);
  const path = search.get('screenReturnPath');
  if (!path || !pathIsSubjectOverview(path, locale)) return;
  const cursor = search.get('screenReturnCursor');
  const realm = search.get('screenReturnRealm');
  if ((cursor !== null && (!cursor || cursor.length > 8192)) || (realm !== null && !seriesUuid.test(realm))) return;
  const target = new URL(path, 'https://rezics.invalid');
  const returned = new URLSearchParams();
  if (cursor) returned.set(SCREEN_EPISODE_CURSOR, cursor);
  if (realm) returned.set('realm', realm);
  target.search = returned.toString();
  target.hash = 'screen-episode-list';
  return `${target.pathname}${target.search}${target.hash}`;
}
