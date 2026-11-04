import { subjectHref } from '../../../subject/subject-href';
import { subjectVisitReturn } from '../../pages/subject-visit-navigation';
import { seriesUuid } from '../screen-episode-membership';
import type { ScreenEpisodeEntry } from './read';

export const SCREEN_EPISODE_CURSOR = 'screenCursor';
export const SCREEN_EPISODE_SELECTION = 'screenSelection';
export const SCREEN_EPISODE_VISIT_LIMIT = 8;

export type ScreenEpisodeOrigin = { pathname: string; searchStr: string; hash?: string };
export type ScreenEpisodeCursorIntent = { kind: 'first' } | { kind: 'cursor'; cursor: string } | { kind: 'invalid' };

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
  const values = new URLSearchParams(searchStr).getAll(SCREEN_EPISODE_SELECTION);
  if (values.length !== 1) return undefined;
  const value = values[0];
  return value && seriesUuid.test(value) ? value : undefined;
}

export function screenEpisodeCursorIntent(searchStr: string): ScreenEpisodeCursorIntent {
  const values = new URLSearchParams(searchStr).getAll(SCREEN_EPISODE_CURSOR);
  if (!values.length) return { kind: 'first' };
  const value = values[0];
  if (
    values.length !== 1 ||
    !value ||
    value.length > 8192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return { kind: 'invalid' };
  return { kind: 'cursor', cursor: value };
}

export function screenEpisodeCursor(searchStr: string): string | undefined {
  const intent = screenEpisodeCursorIntent(searchStr);
  return intent.kind === 'cursor' ? intent.cursor : undefined;
}

function queryAddress(pathname: string, search: URLSearchParams, hash = '#screen-episode-list') {
  const query = search.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

/** Address of a window only; a selected membership is always re-admitted by the reader. */
export function screenEpisodeWindowAddress(origin: ScreenEpisodeOrigin): string {
  const search = new URLSearchParams(origin.searchStr);
  search.delete(SCREEN_EPISODE_SELECTION);
  return queryAddress(origin.pathname, search);
}

export function screenEpisodeReadingAddress(origin: ScreenEpisodeOrigin): string {
  const search = new URLSearchParams(origin.searchStr);
  search.delete(SCREEN_EPISODE_CURSOR);
  search.delete(SCREEN_EPISODE_SELECTION);
  return queryAddress(origin.pathname, search);
}

export function screenEpisodeContinuationHref(origin: ScreenEpisodeOrigin, cursor: string): string {
  const search = new URLSearchParams(origin.searchStr);
  search.set(SCREEN_EPISODE_CURSOR, cursor);
  search.delete(SCREEN_EPISODE_SELECTION);
  return queryAddress(origin.pathname, search);
}

export function screenEpisodeRestartHref(origin: ScreenEpisodeOrigin): string {
  const search = new URLSearchParams(origin.searchStr);
  search.delete(SCREEN_EPISODE_CURSOR);
  search.delete(SCREEN_EPISODE_SELECTION);
  return queryAddress(origin.pathname, search);
}

export function screenEpisodeReturn(searchStr: string, locale: string):
  | { href: string; membershipId: string }
  | undefined {
  const via = new URLSearchParams(searchStr).getAll('via');
  if (via.length !== 1) return;
  const href = subjectVisitReturn(via[0], locale);
  if (!href) return;
  const address = new URL(href, 'https://rezics.invalid');
  const membershipId = screenEpisodeSelection(address.search);
  if (!membershipId || screenEpisodeFocusMembership(address.hash) !== membershipId) return;
  return { href, membershipId };
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
  const target = new URL(href, 'https://rezics.invalid');
  const search = new URLSearchParams();
  if (realm && seriesUuid.test(realm)) search.set('realm', realm);
  if (pathIsSubjectOverview(origin.pathname, locale)) {
    // A subject return remains one hop. Carry every supported local context field and
    // the current native window, while the incoming via stays local to the current page.
    const parent = new URLSearchParams(origin.searchStr);
    parent.delete('via');
    parent.delete(SCREEN_EPISODE_SELECTION);
    const current = subjectVisitReturn(queryAddress(origin.pathname, parent, ''), locale);
    const returnUrl = current ? new URL(current, 'https://rezics.invalid') : undefined;
    if (returnUrl) {
      returnUrl.searchParams.set(SCREEN_EPISODE_SELECTION, entry.membershipId);
      const returnHash = screenEpisodeEntryElementId(entry.membershipId);
      returnUrl.hash = returnHash ? `#${returnHash}` : '#screen-episode-list';
      const returnAddress = subjectVisitReturn(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`, locale);
      if (returnAddress) search.set('via', returnAddress);
    }
  }
  target.search = search.toString();
  return `${target.pathname}${target.search}`;
}
