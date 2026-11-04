import type { BoardPageAuthor, loadBoardPageWithAuthors } from '../identity/page-loaders';
import {
  BOARD_PINNED_SECTION_LIMIT,
  pinnedIdentitySet,
  validBoardPinId,
  validBoardPinRevision,
} from './board-pins/contract';
import type { BoardPinAdviceSelection, BoardPinAdviceReference } from './board-pins/advice';
import type { PageAuthors } from '../identity/read';

type LoadedCommunityBoardPage = Awaited<ReturnType<typeof loadBoardPageWithAuthors>>;
export type CommunityBoardPage = Omit<LoadedCommunityBoardPage, 'openingCards' | 'openingRows' | 'authors'> & {
  openingCards?: LoadedCommunityBoardPage['openingCards'];
  openingRows?: LoadedCommunityBoardPage['openingRows'];
  authors: BoardFeedAuthors;
};
export type BoardFeedThread = CommunityBoardPage['threads']['threads'][number];
export type BoardThreadPage = CommunityBoardPage['threads'];
export type BoardOpeningCard = LoadedCommunityBoardPage['openingCards'][string];
export type BoardFeedAuthor = BoardPageAuthor | NonNullable<PageAuthors>[string];
export type BoardFeedAuthors = Record<string, BoardFeedAuthor> | null;

export type BoardPinnedSection =
  | Readonly<{ state: 'empty' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'ready'; threads: readonly BoardFeedThread[] }>;

function isFeedThread(value: unknown): value is BoardFeedThread {
  return !!value && typeof value === 'object' && 'id' in value && typeof value.id === 'string';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the already-disclosed document's text nodes, never attributes, links, media ids or hidden bodies. */
export function boardThreadPreview(thread: BoardFeedThread, revealSpoilers = false): string | null {
  if (thread.availability !== 'available' || thread.firstPost.availability !== 'available') return null;
  const body: unknown = thread.firstPost.body;
  if (!record(body) || !record(body.doc)) return null;
  const pending: unknown[] = [body.doc];
  const words: string[] = [];
  let length = 0;
  // The native document is bounded; this smaller window also bounds work for a preview.
  for (let visited = 0; pending.length && visited < 128 && length < 280; visited += 1) {
    const node = pending.pop();
    if (!record(node)) continue;
    if (
      !revealSpoilers &&
      Array.isArray(node.marks) &&
      node.marks.some((mark) => record(mark) && mark.type === 'spoiler')
    )
      continue;
    if (node.type === 'text' && typeof node.text === 'string') {
      const text = node.text
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 280 - length);
      if (text) {
        words.push(text);
        length += text.length + 1;
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content.slice(0, Math.max(0, 127 - visited - pending.length)).reverse())
        pending.push(child);
    }
  }
  return words.length ? words.join(' ').slice(0, 280) : null;
}

/** An omitted aggregate makes no zero claim. Do not substitute opening-post counts for thread counts. */
export function boardThreadReactionCount(thread: BoardFeedThread): number | null {
  if (thread.availability !== 'available' || thread.reactions === undefined) return null;
  const values = Object.values(thread.reactions);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** Native pinnedThreads order, newest first. Concealed rows leave no title, placeholder or count. */
export function nativePinnedSection(pinned: unknown): BoardPinnedSection {
  if (pinned === undefined || pinned === null) return { state: 'empty' };
  if (!Array.isArray(pinned)) return { state: 'unavailable' };
  const seen = new Set<string>();
  const threads: BoardFeedThread[] = [];
  for (const item of pinned) {
    if (!isFeedThread(item) || seen.has(item.id)) return { state: 'unavailable' };
    seen.add(item.id);
    if (item.availability === 'available' && threads.length < BOARD_PINNED_SECTION_LIMIT) threads.push(item);
  }
  return threads.length === 0 ? { state: 'empty' } : { state: 'ready', threads };
}

/**
 * Drop the native initial cohort from ordinary rows, including concealed identities.
 * Continuation pages supply an empty pinned array and are not scanned for pins.
 */
export function ordinaryBoardThreads(page: BoardThreadPage): BoardThreadPage {
  const pinned = pinnedIdentitySet(page.pinnedThreads);
  if (pinned.size === 0) return page;
  return { ...page, threads: page.threads.filter((thread) => !pinned.has(thread.id)) };
}

/** Current disclosed authors only. A replacement page never keeps leftover private metadata. */
export function authorsForCurrentReading(
  previous: BoardFeedAuthors,
  next: PageAuthors | undefined,
  authorIds: readonly string[],
): BoardFeedAuthors {
  if (next === null) return null;
  const source = next ?? previous ?? {};
  const current: NonNullable<BoardFeedAuthors> = {};
  for (const id of authorIds) {
    const author = source[id];
    if (author) current[id] = author;
  }
  return current;
}

export function boardPinThreadIds(page: BoardThreadPage): string[] {
  const section = nativePinnedSection(page.pinnedThreads);
  const ordinary = ordinaryBoardThreads(page);
  const ids = section.state === 'ready' ? section.threads.map((thread) => thread.id) : [];
  for (const thread of ordinary.threads) ids.push(thread.id);
  return ids;
}

/** Build advice only from the exact disclosed rows and generation supplied with this page. */
export function boardPinAdviceSelection(boardId: string, page: BoardThreadPage): BoardPinAdviceSelection | undefined {
  if (!validBoardPinId(boardId) || !validBoardPinRevision(page.pinRevision)) return undefined;
  const section = nativePinnedSection(page.pinnedThreads);
  if (section.state === 'unavailable') return undefined;
  const ordinary = ordinaryBoardThreads(page);
  const rows = [
    ...(section.state === 'ready' ? section.threads : []),
    ...ordinary.threads.filter((thread) => thread.availability === 'available'),
  ];
  if (rows.length === 0 || rows.length > 25) return undefined;
  const selected: BoardPinAdviceReference[] = [];
  for (const thread of rows) {
    const opening = record(thread) ? thread.firstPost : undefined;
    if (
      !validBoardPinId(thread.id) ||
      !record(opening) ||
      opening.availability !== 'available' ||
      !validBoardPinId(opening.revisionId)
    )
      return undefined;
    selected.push({ threadId: thread.id, placeId: boardId, sourceRevisionId: opening.revisionId });
  }
  return Object.freeze({ selected: Object.freeze(selected), pinRevision: page.pinRevision });
}
