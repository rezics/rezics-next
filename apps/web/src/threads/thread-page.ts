import type { KernelClient } from '@rezics/client';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { boardRealmId, readBoardRealm, type BoardRealm } from './board-context';
import { sameThreadSlug, threadTitle } from './thread-href';

type ThreadResource = ReturnType<KernelClient['threads']>;
type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];
type Thread = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['data']>;
type PostPage = NonNullable<Awaited<ReturnType<ThreadResource['posts']['get']>>['data']>;
export type ThreadPost = PostPage['posts'][number];

type PageInput = { id: string; cursor?: string };
type CanonicalPageInput = PageInput & { expectedSlug: string };

export type ThreadSlugRedirect = { redirect: { id: string; title: string | null } };

export type LoadedThreadPage = {
  thread: Thread['thread'];
  board?: Board;
  realm?: BoardRealm;
  posts: PostPage;
  viewerId?: string;
  verification: VerificationConfig;
};

function checkRead<T>(result: { error?: unknown; status?: number; data?: T | null }, resource: string): NonNullable<T> {
  if (result.error) {
    if (result.status === 404) throw notFound();
    throw new Error(`Kernel ${resource} read failed`);
  }
  return result.data as NonNullable<T>;
}

export function loadThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: CanonicalPageInput,
  verification: VerificationConfig,
): Promise<LoadedThreadPage | ThreadSlugRedirect>;
export function loadThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput,
  verification: VerificationConfig,
): Promise<LoadedThreadPage>;
export async function loadThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput & { expectedSlug?: string },
  verification: VerificationConfig,
): Promise<LoadedThreadPage | ThreadSlugRedirect> {
  let authorization: string | null = null;
  let viewerId: string | undefined;
  try {
    await prepareSession(request, sessionEnv);
    authorization = viewerCredential(request);
    viewerId = sessionSubject(request);
  } catch {
    // A page remains usable when the session credential cannot be read.
    authorization = null;
    viewerId = undefined;
  }
  const threadRead = authorization
    ? client.threads({ id: data.id }).get({ headers: { authorization } })
    : client.threads({ id: data.id }).get();
  const readPosts = () =>
    authorization
      ? client
          .threads({ id: data.id })
          .posts.get(
            data.cursor
              ? { query: { cursor: data.cursor }, headers: { authorization } }
              : { headers: { authorization } },
          )
      : client.threads({ id: data.id }).posts.get(data.cursor ? { query: { cursor: data.cursor } } : {});
  let postsRead = data.expectedSlug === undefined ? readPosts() : undefined;
  const threadResult = await threadRead;
  const thread = checkRead<Thread>(threadResult, 'thread');
  if (thread.thread.id !== data.id) throw notFound();
  if (data.expectedSlug !== undefined && !sameThreadSlug(data.expectedSlug, thread.thread.title))
    return { redirect: { id: thread.thread.id, title: threadTitle(thread.thread) } };
  postsRead ??= readPosts();
  // The Realm read follows the board read, beside the posts read.
  const boardRead = thread.thread.boardId
    ? (authorization
        ? client.boards({ id: thread.thread.boardId }).get({ headers: { authorization } })
        : client.boards({ id: thread.thread.boardId }).get()
      )
        .catch(() => null)
        .then(async (result) => {
          const board = result?.data?.board;
          if (!board || board.id !== thread.thread.boardId) return {};
          const realm = await readBoardRealm(client, boardRealmId(board), authorization);
          return { board, ...(realm ? { realm } : {}) };
        })
    : Promise.resolve({});
  const [context, postsResult] = await Promise.all([boardRead, postsRead]);
  const posts = checkRead<PostPage>(postsResult, 'thread posts');
  return {
    thread: thread.thread,
    ...context,
    posts,
    ...(viewerId ? { viewerId } : {}),
    verification,
  };
}
