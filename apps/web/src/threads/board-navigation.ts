import { subjectCommunityVisitReturn } from '../features/pages/subject-visit-navigation';
import { getLocale, locales } from '../paraglide/runtime.js';
import { returnTarget } from '../session/return-target';
import { boardSortFromSearch, type BoardSort } from './board-sort';
import { validBoardPinId } from './board-pins/contract';
import { boardReadingHref, type BoardReadingReturn } from './board-reading';

const navigationOrigin = 'https://rezics.invalid';
const addressLimit = 131_072;

export type BoardSearch = { cursor?: string; sort?: 'hot' | 'new'; returnTo?: string };
/** Prepared by the existing route, without a reader, credential or command capability. */
export type BoardPreparedNavigation = Readonly<{ href: string }>;
export type BoardRowOccurrence = Readonly<{ section: 'pinned' | 'ordinary'; index: number }>;

/** The Board route and return consumer use the same search admission. */
export function boardSearch(search: Record<string, unknown>, locale: string = getLocale()): BoardSearch {
  const cursor = typeof search.cursor === 'string' ? search.cursor : undefined;
  const sort = boardSortFromSearch(search.sort);
  const returnTo = subjectCommunityVisitReturn(search.returnTo, locale);
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(sort ? { sort } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

export function boardRequestHref(locale: string, boardId: string, search: BoardSearch): string {
  const query = new URLSearchParams();
  if (search.cursor !== undefined) query.set('cursor', search.cursor);
  if (search.sort !== undefined) query.set('sort', search.sort);
  if (search.returnTo !== undefined) query.set('returnTo', search.returnTo);
  return `/${locale}/boards/${encodeURIComponent(boardId)}${query.size ? `?${query}` : ''}`;
}

export function boardRowAnchor(threadId: string, occurrence: BoardRowOccurrence): string {
  return `board-thread-${threadId}--${occurrence.section}-${occurrence.index}`;
}

/** A focus locator within one bounded page, including repeated identities in that page. */
export function boardReturnAnchor(hash: string): string | undefined {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const match = /^board-thread-([0-9a-f-]+)(?:--(pinned|ordinary)-(\d{1,3}))?$/i.exec(value);
  return match && validBoardPinId(match[1]) ? value : undefined;
}

/**
 * Local URL admission belongs to sign-in. This closed Board address schema only identifies
 * the mounted reader and its operands; it cannot vouch for cursor validity or write permission.
 */
export function admittedBoardReturn(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > addressLimit) return;
  const admitted = returnTarget(value, navigationOrigin);
  const url = new URL(admitted, navigationOrigin);
  const match = /^\/([^/]+)\/boards\/([^/]+)$/.exec(url.pathname);
  if (!match || !locales.some((locale) => locale === match[1]) || !validBoardPinId(match[2])) return;
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['cursor', 'sort', 'returnTo'].includes(key)) ||
    (url.hash && !boardReturnAnchor(url.hash))
  )
    return;
  const search = boardSearch(Object.fromEntries(url.searchParams), match[1]);
  return `${boardRequestHref(match[1]!, match[2]!, search)}${url.hash}`;
}

/** Bind a supplied route address to this exact request before preparing any row link. */
export function boardRowReturn(
  reading: BoardReadingReturn,
  threadId: string,
  occurrence: BoardRowOccurrence,
  navigation?: BoardPreparedNavigation,
): string | undefined {
  const href = admittedBoardReturn(navigation?.href ?? boardReadingHref(reading));
  if (!href || !validBoardPinId(threadId)) return;
  const url = new URL(href, navigationOrigin);
  const search = boardSearch(Object.fromEntries(url.searchParams), reading.locale);
  if (
    url.pathname !== `/${reading.locale}/boards/${reading.boardId}` ||
    (search.sort ?? 'active') !== reading.sort ||
    search.cursor !== reading.cursor
  )
    return;
  return `${url.pathname}${url.search}#${boardRowAnchor(threadId, occurrence)}`;
}

export function boardReturnMatches(href: string, boardId: string | undefined, locale: string): boolean {
  const admitted = admittedBoardReturn(href);
  return !!admitted && new URL(admitted, navigationOrigin).pathname === `/${locale}/boards/${boardId}`;
}

export function boardPreparedSearch(navigation: BoardPreparedNavigation | undefined, locale: string): BoardSearch {
  const href = admittedBoardReturn(navigation?.href);
  return href ? boardSearch(Object.fromEntries(new URL(href, navigationOrigin).searchParams), locale) : {};
}

/** Restart preserves the original Subject/place return and sort, and deliberately drops the frontier. */
export function boardReturnRestart(href: string): string | undefined {
  const admitted = admittedBoardReturn(href);
  if (!admitted) return;
  const url = new URL(admitted, navigationOrigin);
  url.searchParams.delete('cursor');
  return `${url.pathname}${url.search}`;
}

/** Next moves only the native frontier. Sort changes and restart deliberately discard it. */
export function boardContinuationSearch(search: BoardSearch, cursor: string): BoardSearch {
  return { ...search, cursor };
}

export function boardOrderSearch(search: BoardSearch, sort: BoardSort): BoardSearch {
  return { ...(sort === 'active' ? {} : { sort }), ...(search.returnTo ? { returnTo: search.returnTo } : {}) };
}
