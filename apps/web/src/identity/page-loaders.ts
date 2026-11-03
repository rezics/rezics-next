import type { BoardPageResponse, KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { boardCommunitySource, type BoardCommunitySource } from '../threads/board-community-source';
import { readThreadSubjects, type ThreadSubject } from '../threads/subjects';
import { loadThreadPage, type LoadedThreadPage, type ThreadSlugRedirect } from '../threads/thread-page';
import { BoardPageCursorError, disclosedBoardAuthorIds, isInvalidBoardCursor } from '../threads/board-reading';
import { readPageAuthors, type PageAuthors } from './read';

type BoardResource = ReturnType<KernelClient['boards']>;
type ThreadPage = NonNullable<Awaited<ReturnType<BoardResource['threads']['get']>>['data']>;
export type BoardPageAuthor = Extract<BoardPageResponse['threads'][number]['authors']['thread'], { state: 'available' }>;
export type BoardPageAuthors = Record<string, BoardPageAuthor> | null;
export type PageInput = { id: string; cursor?: string; sort?: 'hot' | 'new' };

function checkRead<T>(
  result: { error?: unknown; status?: number; data?: T | null },
  resource: string,
  cursor?: { boardId: string; sort?: 'hot' | 'new' },
): NonNullable<T> {
  if (result.error) {
    if (result.status === 404) throw notFound();
    if (cursor && isInvalidBoardCursor(result.status ?? 0, result.error))
      throw new BoardPageCursorError(cursor.boardId, cursor.sort);
    throw new Error(`Kernel ${resource} read failed`);
  }
  return result.data as NonNullable<T>;
}

export async function loadBoardPageWithAuthors(
  client: KernelClient,
  data: PageInput,
  authorization?: string | null,
): Promise<{
  board: BoardPageResponse['board'];
  community: BoardCommunitySource;
  openingCards: Readonly<Record<string, BoardPageResponse['threads'][number]>>;
  viewer: BoardPageResponse['viewer'];
  actions: BoardPageResponse['actions'];
  threads: ThreadPage;
  authors: BoardPageAuthors;
  now: string;
}> {
  const now = new Date().toISOString();
  const sort = data.sort ?? 'active';
  const query = {
    query: { ...(data.cursor ? { cursor: data.cursor } : {}), sort },
    ...(authorization ? { headers: { authorization } } : {}),
  };
  const response = checkRead<BoardPageResponse>(
    await client.boards({ id: data.id }).page.get(query),
    'board opening page',
    {
      boardId: data.id,
      ...(data.sort === undefined ? {} : { sort: data.sort }),
    },
  );
  if (response.board.id !== data.id) throw notFound();
  const threads: ThreadPage = {
    pinnedThreads: response.pinnedThreads.map((card) => card.thread),
    threads: response.threads.map((card) => card.thread),
    next: response.next,
    rankRefreshedAt: response.rankRefreshedAt,
  };
  const openingCards: Record<string, BoardPageResponse['threads'][number]> = {};
  for (const card of [...response.pinnedThreads, ...response.threads])
    openingCards[card.thread.id] ??= card;
  const authors: Record<string, BoardPageAuthor> = {};
  for (const card of Object.values(openingCards)) {
    for (const author of [card.authors.thread, card.authors.openingPost]) {
      if (author.state === 'available') authors[author.id] ??= author;
    }
  }
  const board = response.board;
  const community = boardCommunitySource(board);
  return {
    board,
    community,
    openingCards,
    viewer: response.viewer,
    actions: response.actions,
    threads,
    authors,
    now,
  };
}

type ThreadPageInput = PageInput & { expectedSlug?: string; post?: string };
type ThreadPageWithAuthors = LoadedThreadPage & { authors: PageAuthors; subjects: ThreadSubject[]; now: string };

export function loadThreadPageWithAuthors(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput & { expectedSlug: string },
  verification: VerificationConfig,
  credentialMode?: ReadCredentialMode,
): Promise<ThreadPageWithAuthors | ThreadSlugRedirect>;
export function loadThreadPageWithAuthors(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: ThreadPageInput,
  verification: VerificationConfig,
  credentialMode?: ReadCredentialMode,
): Promise<ThreadPageWithAuthors | ThreadSlugRedirect>;
export function loadThreadPageWithAuthors(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput,
  verification: VerificationConfig,
  credentialMode?: ReadCredentialMode,
): Promise<ThreadPageWithAuthors>;
export async function loadThreadPageWithAuthors(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: ThreadPageInput,
  verification: VerificationConfig,
  credentialMode: ReadCredentialMode = 'session',
): Promise<ThreadPageWithAuthors | ThreadSlugRedirect> {
  const now = new Date().toISOString();
  const page =
    data.expectedSlug === undefined
      ? await loadThreadPage(client, request, sessionEnv, data, verification, credentialMode)
      : await loadThreadPage(
          client,
          request,
          sessionEnv,
          { ...data, expectedSlug: data.expectedSlug },
          verification,
          credentialMode,
        );
  if ('redirect' in page) return page;
  const [authors, subjects] = await Promise.all([
    readPageAuthors(client, [
      page.thread.authorId,
      ...page.posts.posts.flatMap((post) => ('authorId' in post ? [post.authorId] : [])),
    ]),
    readThreadSubjects(client, page.thread.subjectIds),
  ]);
  return { ...page, authors, subjects, now };
}
