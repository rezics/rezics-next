import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { boardRealmId, readBoardRealm, type BoardRealm } from '../threads/board-context';
import { readThreadSubjects, type ThreadSubject } from '../threads/subjects';
import { loadThreadPage, type LoadedThreadPage, type ThreadSlugRedirect } from '../threads/thread-page';
import { readPageAuthors, type PageAuthors } from './read';

type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>;
type ThreadPage = NonNullable<Awaited<ReturnType<BoardResource['threads']['get']>>['data']>;
export type PageInput = { id: string; cursor?: string; sort?: 'hot' | 'new' };

function checkRead<T>(result: { error?: unknown; status?: number; data?: T | null }, resource: string): NonNullable<T> {
  if (result.error) {
    if (result.status === 404) throw notFound();
    throw new Error(`Kernel ${resource} read failed`);
  }
  return result.data as NonNullable<T>;
}

export async function loadBoardPageWithAuthors(
  client: KernelClient,
  data: PageInput,
  authorization?: string | null,
): Promise<{ board: Board['board']; realm?: BoardRealm; threads: ThreadPage; authors: PageAuthors; now: string }> {
  const now = new Date().toISOString();
  // Active is the default; New is the kernel's own order and sends no sort.
  const sort: 'active' | 'hot' | undefined = data.sort === 'new' ? undefined : (data.sort ?? 'active');
  const query = {
    query: { ...(data.cursor ? { cursor: data.cursor } : {}), ...(sort ? { sort } : {}) },
  };
  // The Realm read follows the board read, beside the thread list.
  const boardRead = client
    .boards({ id: data.id })
    .get(authorization ? { headers: { authorization } } : {})
    .then(async (result) => ({
      result,
      realm:
        result.data?.board.id === data.id
          ? await readBoardRealm(client, boardRealmId(result.data.board), authorization)
          : undefined,
    }));
  const [{ result: boardResult, realm }, threadsResult] = await Promise.all([
    boardRead,
    client.boards({ id: data.id }).threads.get({
      ...query,
      ...(authorization ? { headers: { authorization } } : {}),
    }),
  ]);
  const board = checkRead<Board>(boardResult, 'board');
  const threads = checkRead<ThreadPage>(threadsResult, 'board threads');
  if (board.board.id !== data.id) throw notFound();
  const authors = await readPageAuthors(
    client,
    threads.threads.map((thread) => thread.authorId),
  );
  return { board: board.board, ...(realm ? { realm } : {}), threads, authors, now };
}

type ThreadPageInput = PageInput & { expectedSlug?: string };
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
