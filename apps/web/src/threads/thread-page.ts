import type { KernelClient } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import { readDocumentMentions } from '../kernel/mentions';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { boardRealmId, readBoardRealm, type BoardRealm } from './board-context';
import { sameThreadSlug, threadTitle } from './thread-href';
import { readThreadDocumentMedia, type ThreadDocumentMedia } from './document-media-read';

type ThreadResource = ReturnType<KernelClient['threads']>;
type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];
type Thread = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['data']>;
type PostPage = NonNullable<Awaited<ReturnType<ThreadResource['posts']['get']>>['data']>;
/** Temporary narrow seam until the complete Kernel client declarations publish this mounted route. */
type ReadingPage = {
  thread: Thread['thread'];
  replies: { items: PostPage['posts']; next: PostPage['next'] };
};
type ReadingPageClient = ThreadResource & {
  'reading-page': {
    get(options: {
      query?: { cursor?: string };
      headers?: { authorization: string };
    }): Promise<{ error?: unknown; status?: number; data?: ReadingPage | null }>;
  };
};
export type ThreadPost = PostPage['posts'][number];

type PageInput = { id: string; cursor?: string; post?: string };
type CanonicalPageInput = PageInput & { expectedSlug: string };

export type ThreadSlugRedirect = { redirect: { id: string; title: string | null } };

export type LoadedThreadPage = {
  thread: Thread['thread'];
  board?: Board;
  realm?: BoardRealm;
  posts: PostPage;
  mentions: DocumentMentions;
  documentMedia?: ThreadDocumentMedia;
  viewerId?: string;
  verification: VerificationConfig;
  linkedPostUnavailable?: boolean;
};

/** Consumer seam for the native locator until the controller regenerates the client. */
type PostLocator = (params: { postId: string }) => {
  location: {
    get(options: { headers?: { authorization: string }; fetch: { cache: 'no-store' } }): Promise<{
      error?: unknown;
      status?: number;
      data?: { cursor: string | null } | null;
    }>;
  };
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
  credentialMode?: ReadCredentialMode,
): Promise<LoadedThreadPage | ThreadSlugRedirect>;
export function loadThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput,
  verification: VerificationConfig,
  credentialMode?: ReadCredentialMode,
): Promise<LoadedThreadPage>;
export async function loadThreadPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: PageInput & { expectedSlug?: string },
  verification: VerificationConfig,
  credentialMode: ReadCredentialMode = 'session',
): Promise<LoadedThreadPage | ThreadSlugRedirect> {
  let authorization: string | null = null;
  let viewerId: string | undefined;
  if (credentialMode === 'session') {
    try {
      await prepareSession(request, sessionEnv);
      authorization = viewerCredential(request);
      viewerId = sessionSubject(request);
    } catch {
      // A page remains usable when the session credential cannot be read.
      authorization = null;
      viewerId = undefined;
    }
  }
  let linkedPostUnavailable = false;
  const readReadingPage = async () => {
    let cursor = data.cursor;
    if (data.post !== undefined) {
      const posts = client.threads({ id: data.id }).posts as unknown as PostLocator;
      const result = await posts({ postId: data.post }).location.get({
        ...(authorization ? { headers: { authorization } } : {}),
        fetch: { cache: 'no-store' },
      });
      if (result.status === 404) {
        linkedPostUnavailable = true;
        cursor = undefined;
      } else {
        const location = checkRead<{ cursor: string | null }>(result, 'post location');
        if (!location || (location.cursor !== null && typeof location.cursor !== 'string'))
          throw new Error('Invalid kernel post location');
        cursor = location.cursor ?? undefined;
      }
    }
    const options = {
      ...(cursor === undefined ? {} : { query: { cursor } }),
      ...(authorization ? { headers: { authorization } } : {}),
    };
    const threadClient = client.threads({ id: data.id }) as ReadingPageClient;
    return threadClient['reading-page'].get(options);
  };
  let readingPageRead = data.expectedSlug === undefined ? readReadingPage() : undefined;
  if (data.expectedSlug !== undefined) {
    const threadResult = authorization
      ? await client.threads({ id: data.id }).get({ headers: { authorization } })
      : await client.threads({ id: data.id }).get();
    const thread = checkRead<Thread>(threadResult, 'thread');
    if (thread.thread.id !== data.id) throw notFound();
    if (!sameThreadSlug(data.expectedSlug, thread.thread.title))
      return { redirect: { id: thread.thread.id, title: threadTitle(thread.thread) } };
  }
  readingPageRead ??= readReadingPage();
  const readingPageResult = await readingPageRead;
  const readingPage = checkRead<ReadingPage>(readingPageResult, 'thread reading page');
  const thread = readingPage.thread;
  if (thread.id !== data.id) throw notFound();
  if (data.expectedSlug !== undefined && !sameThreadSlug(data.expectedSlug, thread.title))
    return { redirect: { id: thread.id, title: threadTitle(thread) } };
  const posts: PostPage = {
    posts: [thread.firstPost, ...readingPage.replies.items],
    next: readingPage.replies.next,
    rankRefreshedAt: null,
    status: 200,
  };
  const readContext = () =>
    thread.boardId
      ? (authorization
          ? client.boards({ id: thread.boardId }).get({ headers: { authorization } })
          : client.boards({ id: thread.boardId }).get()
        )
          .catch(() => null)
          .then(async (result) => {
            const board = result?.data?.board;
            if (!board || board.id !== thread.boardId) return {};
            const realm = await readBoardRealm(client, boardRealmId(board), authorization);
            return { board, ...(realm ? { realm } : {}) };
          })
      : Promise.resolve({});
  const context = await readContext();
  if (
    data.post !== undefined &&
    !posts.posts.some((post) => post.id === data.post && post.availability === 'available')
  )
    linkedPostUnavailable = true;
  const [mentions, documentMedia] = await Promise.all([
    readDocumentMentions(
      client,
      posts.posts.map((post) => post.body),
    ),
    readThreadDocumentMedia(client, posts.posts, authorization),
  ]);
  return {
    mentions,
    documentMedia,
    thread,
    ...context,
    posts,
    ...(viewerId ? { viewerId } : {}),
    verification,
    ...(data.post === undefined ? {} : { linkedPostUnavailable }),
  };
}
