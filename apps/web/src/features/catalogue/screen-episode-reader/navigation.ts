import { subjectHref } from '../../../subject/subject-href';
import { subjectVisitReturn } from '../../pages/subject-visit-navigation';
import { seriesUuid } from '../screen-episode-membership';
import type { ScreenEpisodeEntry } from './read';

export const SCREEN_EPISODE_CURSOR = 'screenCursor';
export const SCREEN_EPISODE_SELECTION = 'screenSelection';

export type ScreenEpisodeOrigin = { pathname: string; searchStr: string; hash?: string };

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

export function screenEpisodeEntryElementId(membershipId: string): string | undefined {
  return seriesUuid.test(membershipId) ? `screen-episode-entry-${membershipId}` : undefined;
}

export function screenEpisodeFocusMembership(hash: string): string | undefined {
  const match = /^#screen-episode-entry-([0-9a-f-]{36})$/i.exec(hash);
  return match && seriesUuid.test(match[1]!) ? match[1] : undefined;
}

export function screenEpisodeSelection(searchStr: string): string | undefined {
  const value = new URLSearchParams(searchStr).get(SCREEN_EPISODE_SELECTION);
  return value && seriesUuid.test(value) ? value : undefined;
}

export function screenEpisodeCursor(searchStr: string): string | undefined {
  const value = new URLSearchParams(searchStr).get(SCREEN_EPISODE_CURSOR);
  return value && value.length <= 8192 ? value : undefined;
}

export function screenEpisodeContinuationHref(origin: ScreenEpisodeOrigin, cursor: string): string {
  const search = new URLSearchParams(origin.searchStr);
  search.set(SCREEN_EPISODE_CURSOR, cursor);
  search.delete(SCREEN_EPISODE_SELECTION);
  return `${origin.pathname}?${search.toString()}#screen-episode-list`;
}

export function screenEpisodeRestartHref(origin: ScreenEpisodeOrigin): string {
  const search = new URLSearchParams(origin.searchStr);
  search.delete(SCREEN_EPISODE_CURSOR);
  search.delete(SCREEN_EPISODE_SELECTION);
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
  if (realm && seriesUuid.test(realm)) search.set('realm', realm);
  if (pathIsSubjectOverview(origin.pathname, locale)) {
    const returnSearch = new URLSearchParams();
    if (realm && seriesUuid.test(realm)) returnSearch.set('realm', realm);
    if (cursor) returnSearch.set(SCREEN_EPISODE_CURSOR, cursor);
    returnSearch.set(SCREEN_EPISODE_SELECTION, entry.membershipId);
    const returnHash = screenEpisodeEntryElementId(entry.membershipId);
    const returnAddress = subjectVisitReturn(
      `${origin.pathname}?${returnSearch.toString()}${returnHash ? `#${returnHash}` : '#screen-episode-list'}`,
      locale,
    );
    if (returnAddress) search.set('via', returnAddress);
  }
  target.search = search.toString();
  return `${target.pathname}${target.search}`;
}
