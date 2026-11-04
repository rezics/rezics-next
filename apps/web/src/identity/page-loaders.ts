import type { BoardPageResponse, KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { receiveBoardOpeningPage, type ReceivedBoardOpeningPage } from '../threads/board-opening';
import { readThreadSubjects, type ThreadSubject } from '../threads/subjects';
import { loadThreadPage, type LoadedThreadPage, type ThreadSlugRedirect } from '../threads/thread-page';
import { BoardPageCursorError, isInvalidBoardCursor } from '../threads/board-reading';
import { readPageAuthors, type PageAuthors } from './read';

export type BoardPageAuthor = Extract<
  BoardPageResponse['threads'][number]['authors']['thread'],
  { state: 'available' }
>;
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
): Promise<ReceivedBoardOpeningPage> {
  const now = new Date().toISOString();
  const sort: 'new' | 'active' | 'hot' = data.sort ?? 'active';
  const query = {
    query: { ...(data.cursor === undefined ? {} : { cursor: data.cursor }), sort },
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
  return receiveBoardOpeningPage(response, now);
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
  const subjects = await readThreadSubjects(client, page.thread.subjectIds);
  return { ...page, subjects, now };
}
