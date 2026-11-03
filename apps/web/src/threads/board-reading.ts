import { BOARD_PINNED_SECTION_LIMIT, pinnedIdentitySet, validBoardPinId } from './board-pins/contract';
import type { BoardSort } from './board-sort';

/** Content `listBoardThreads` default when Web omits `limit`. */
export const BOARD_ORDINARY_PAGE_LIMIT = 20;
/** `GET /v1/accounts?ids=` admits at most 100 identities. */
export const BOARD_AUTHOR_BATCH_LIMIT = 100;
/** Same bound as Home frontiers; larger cursors become an explicit restart. */
export const BOARD_READING_CURSOR_LIMIT = 32_768;
export const BOARD_READING_RETURN_VERSION = 1;

export { BOARD_PINNED_SECTION_LIMIT };

export type BoardReadingReturn = {
  version: 1;
  boardId: string;
  sort: BoardSort;
  locale: string;
  cursor?: string;
};

export class BoardPageCursorError extends Error {
  readonly code = 'invalid_cursor';
  readonly name = 'BoardPageCursorError';
  constructor(
    readonly boardId: string,
    readonly sort: 'hot' | 'new' | undefined,
  ) {
    super('invalid_cursor');
  }
}

export function isBoardPageCursorError(error: unknown): error is BoardPageCursorError {
  return (
    error instanceof BoardPageCursorError ||
    (!!error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'BoardPageCursorError' &&
      'code' in error &&
      error.code === 'invalid_cursor')
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Native problem code from a kernel-client error envelope or body. */
export function boardProblemCode(body: unknown): string | undefined {
  if (!record(body)) return undefined;
  if (typeof body.code === 'string') return body.code;
  if (record(body.value) && typeof body.value.code === 'string') return body.value.code;
  if (record(body.error)) return boardProblemCode(body.error);
  return undefined;
}

export function isInvalidBoardCursor(status: number, body: unknown): boolean {
  return status === 400 && boardProblemCode(body) === 'invalid_cursor';
}

export function isMalformedBoardQuery(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 422) return false;
  const code = boardProblemCode(body);
  return code !== 'invalid_cursor' && code !== 'stale_cursor';
}

export function captureBoardReadingReturn(input: {
  boardId: string;
  sort: BoardSort;
  locale: string;
  cursor?: string;
}): BoardReadingReturn | null {
  if (!validBoardPinId(input.boardId) || !input.locale || input.locale.length > 64) return null;
  if (input.sort !== 'active' && input.sort !== 'hot' && input.sort !== 'new') return null;
  const cursor = input.cursor;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > BOARD_READING_CURSOR_LIMIT)) {
    return { version: 1, boardId: input.boardId, sort: input.sort, locale: input.locale };
  }
  return {
    version: 1,
    boardId: input.boardId,
    sort: input.sort,
    locale: input.locale,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function parseBoardReadingReturn(value: unknown): BoardReadingReturn | null {
  if (!record(value) || value.version !== BOARD_READING_RETURN_VERSION) return null;
  if (typeof value.boardId !== 'string' || !validBoardPinId(value.boardId)) return null;
  if (value.sort !== 'active' && value.sort !== 'hot' && value.sort !== 'new') return null;
  if (typeof value.locale !== 'string' || !value.locale || value.locale.length > 64) return null;
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== 'string' || value.cursor.length > BOARD_READING_CURSOR_LIMIT)
  )
    return null;
  return captureBoardReadingReturn({
    boardId: value.boardId,
    sort: value.sort,
    locale: value.locale,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  });
}

export function boardReadingHref(reading: BoardReadingReturn): string {
  const path = `/${reading.locale}/boards/${encodeURIComponent(reading.boardId)}`;
  const params = new URLSearchParams();
  if (reading.sort !== 'active') params.set('sort', reading.sort);
  if (reading.cursor !== undefined) params.set('cursor', reading.cursor);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function boardReadingRestartHref(input: { boardId: string; sort: BoardSort; locale: string }): string {
  return boardReadingHref({ version: 1, boardId: input.boardId, sort: input.sort, locale: input.locale });
}

type AuthorSource = { id?: unknown; authorId?: unknown; availability?: unknown };

/** Disclosed rows only. Concealed identities and the native initial cohort never enter the author batch. */
export function disclosedBoardAuthorIds(
  pinned: readonly AuthorSource[] | undefined,
  ordinary: readonly AuthorSource[],
): string[] {
  const cohort = new Set<string>();
  for (const row of pinned ?? []) {
    if (typeof row.id === 'string') cohort.add(row.id);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of [
    ...(pinned ?? []),
    ...ordinary.filter((row) => typeof row.id !== 'string' || !cohort.has(row.id)),
  ]) {
    if (row.availability !== 'available' || typeof row.authorId !== 'string' || seen.has(row.authorId)) continue;
    seen.add(row.authorId);
    ids.push(row.authorId);
  }
  return ids;
}

export function authorBatchCount(authorIds: readonly string[]): number {
  if (authorIds.length === 0) return 0;
  return Math.ceil(authorIds.length / BOARD_AUTHOR_BATCH_LIMIT);
}

export function chunkAuthorIds(authorIds: readonly string[]): string[][] {
  const unique = [...new Set(authorIds)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += BOARD_AUTHOR_BATCH_LIMIT)
    batches.push(unique.slice(index, index + BOARD_AUTHOR_BATCH_LIMIT));
  return batches;
}

export type BoardReadingProjection = {
  pinnedIds: readonly string[];
  displayedPinnedIds: readonly string[];
  ordinaryIds: readonly string[];
  authorIds: readonly string[];
  authorBatches: number;
  next: string | null;
  bytes: number;
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Active page only: native cohort plus one ordinary page, never historical pages. */
export function projectBoardReading(page: {
  pinnedThreads?: readonly { id: string; availability?: string; authorId?: string }[];
  threads: readonly { id: string; availability?: string; authorId?: string }[];
  next: string | null;
}): BoardReadingProjection {
  const pinnedIds = [...pinnedIdentitySet(page.pinnedThreads)];
  const displayedPinnedIds: string[] = [];
  const seenDisplayed = new Set<string>();
  for (const row of page.pinnedThreads ?? []) {
    if (
      row.availability !== 'available' ||
      seenDisplayed.has(row.id) ||
      displayedPinnedIds.length >= BOARD_PINNED_SECTION_LIMIT
    )
      continue;
    seenDisplayed.add(row.id);
    displayedPinnedIds.push(row.id);
  }
  const cohort = new Set(pinnedIds);
  const ordinaryIds = page.threads.filter((thread) => !cohort.has(thread.id)).map((thread) => thread.id);
  const authorIds = disclosedBoardAuthorIds(
    page.pinnedThreads,
    page.threads.filter((thread) => !cohort.has(thread.id)),
  );
  const retained = {
    pinnedIds,
    displayedPinnedIds,
    ordinaryIds: ordinaryIds.slice(0, BOARD_ORDINARY_PAGE_LIMIT),
    authorIds,
    next: page.next,
  };
  return {
    ...retained,
    authorBatches: authorBatchCount(authorIds),
    bytes: utf8Bytes(JSON.stringify(retained)),
  };
}
