import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import { boardRealmId, readBoardRealm, type BoardRealm } from '../threads/board-context';
import { readThreadSubjects } from '../threads/subjects';
import { loadThreadPage } from '../threads/thread-page';
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
    .get()
    .then(async (result) => ({
      result,
      realm:
        result.data?.board.id === data.id ? await readBoardRealm(client, boardRealmId(result.data.board)) : undefined,
    }));
  const [{ result: boardResult, realm }, threadsResult] = await Promise.all([
    boardRead,
    client.boards({ id: data.id }).threads.get(query),
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

export async function loadThreadPageWithAuthors(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput,
  verification: VerificationConfig,
) {
  const now = new Date().toISOString();
  const page = await loadThreadPage(client, request, sessionEnv, data, verification);
  const [authors, subjects] = await Promise.all([
    readPageAuthors(client, [
      page.thread.authorId,
      ...page.posts.posts.flatMap((post) => ('authorId' in post ? [post.authorId] : [])),
    ]),
    readThreadSubjects(client, page.thread.subjectIds),
  ]);
  return { ...page, authors, subjects, now };
}
