import { ThreadPageCursorError } from './thread-page-errors';
export { isThreadPageCursorError } from './thread-page-errors';
import type { KernelClient, ReadingPageResponse } from '@rezics/client';
import type { DocumentMentions } from '@rezics/ui/document-body';
import { boardProblemCode } from './board-reading';
import { readDocumentMentions } from '../kernel/mentions';
import { notFound } from '@tanstack/react-router';
import type { VerificationConfig } from '../report/turnstile';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { boardRealmId, readBoardRealm, type BoardRealm } from './board-context';
import { sameThreadSlug, threadTitle } from './thread-href';
import { readThreadDocumentMedia, type ThreadDocumentMedia } from './document-media-read';
import { readingConversationActivity, type ConversationActivityDisplay } from './activity';

type ThreadResource = ReturnType<KernelClient['threads']>;
type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];
type Thread = NonNullable<Awaited<ReturnType<ThreadResource['get']>>['data']>;
type PostPage = NonNullable<Awaited<ReturnType<ThreadResource['posts']['get']>>['data']>;
export type ReadingPage = ReadingPageResponse;
export type ThreadPost = ReadingPage['thread']['firstPost'] | ReadingPage['replies']['items'][number];
export type ThreadPageAuthor = ReadingPage['authors']['items'][number];
export type ThreadPageObservation = Pick<
  ReadingPage,
  'target' | 'viewer' | 'query' | 'actions' | 'watch' | 'slowMode' | 'currentness' | 'reactionsAsOf'
>;

type PageInput = { id: string; cursor?: string; post?: string };
type CanonicalPageInput = PageInput & { expectedSlug: string };

export type ThreadSlugRedirect = { redirect: { id: string; title: string | null } };

export type LoadedThreadPage = {
  thread: Thread['thread'];
  board?: Board;
  realm?: BoardRealm;
  posts: Omit<PostPage, 'posts'> & { posts: ThreadPost[] };
  /** Present only on the installed composed current-page read. */
  composed?: ThreadPageObservation;
  conversationActivity?: ConversationActivityDisplay;
  authors: import('../identity/read').PageAuthors;
  mentions: DocumentMentions;
  documentMedia?: ThreadDocumentMedia;
  viewerId?: string;
  verification: VerificationConfig;
  linkedPostUnavailable?: boolean;
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
  const signal = request.signal;
  signal.throwIfAborted();
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
  signal.throwIfAborted();
  let linkedPostUnavailable = false;
  const readReadingPage = async () => {
    let cursor = data.cursor;
    if (data.post !== undefined) {
      const result = await client
        .threads({ id: data.id })
        .posts({ postId: data.post })
        .location.get({
          ...(authorization ? { headers: { authorization } } : {}),
          fetch: { cache: 'no-store', signal },
        });
      signal.throwIfAborted();
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
    return client.threads({ id: data.id })['reading-page'].get({ ...options, fetch: { cache: 'no-store', signal } });
  };
  let readingPageRead = data.expectedSlug === undefined ? readReadingPage() : undefined;
  if (data.expectedSlug !== undefined) {
    const threadResult = await client.threads({ id: data.id }).get({
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: { cache: 'no-store', signal },
    });
    signal.throwIfAborted();
    const thread = checkRead<Thread>(threadResult, 'thread');
    if (thread.thread.id !== data.id) throw notFound();
    if (!sameThreadSlug(data.expectedSlug, thread.thread.title))
      return { redirect: { id: thread.thread.id, title: threadTitle(thread.thread) } };
  }
  readingPageRead ??= readReadingPage();
  const readingPageResult = await readingPageRead;
  signal.throwIfAborted();
  if (readingPageResult.status === 400 && boardProblemCode(readingPageResult.error) === 'invalid_cursor')
    throw new ThreadPageCursorError('invalid_cursor');
  const readingPage = checkRead<ReadingPage>(readingPageResult, 'thread reading page');
  const thread = readingPage.thread;
  if (thread.id !== data.id || readingPage.target.threadId !== data.id || readingPage.target.boardId !== thread.boardId)
    throw notFound();
  if (readingPage.viewer.kind === 'account' && (!authorization || readingPage.viewer.id !== viewerId))
    throw new Error('Kernel thread reading page viewer changed');
  if (data.expectedSlug !== undefined && !sameThreadSlug(data.expectedSlug, thread.title))
    return { redirect: { id: thread.id, title: threadTitle(thread) } };
  const posts: LoadedThreadPage['posts'] = {
    posts: [thread.firstPost, ...readingPage.replies.items],
    next: readingPage.replies.next,
  };
  const readContext = () =>
    thread.boardId
      ? client
          .boards({ id: thread.boardId })
          .get({
            ...(authorization ? { headers: { authorization } } : {}),
            fetch: { cache: 'no-store', signal },
          })
          .catch(() => null)
          .then(async (result) => {
            signal.throwIfAborted();
            const board = result?.data?.board;
            if (!board || board.id !== thread.boardId) return {};
            const realm = await readBoardRealm(client, boardRealmId(board), authorization);
            return { board, ...(realm ? { realm } : {}) };
          })
      : Promise.resolve({});
  const context = await readContext();
  signal.throwIfAborted();
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
    readThreadDocumentMedia(client, posts.posts, authorization, signal),
  ]);
  signal.throwIfAborted();
  // Only identities named by readable posts can enter this page's byline map.
  const disclosed = new Set(posts.posts.flatMap((post) => (post.availability === 'available' ? [post.authorId] : [])));
  const authors =
    readingPage.authors.state === 'current' && readingPage.currentness.authors === 'current'
      ? Object.fromEntries(
          readingPage.authors.items.filter((author) => disclosed.has(author.id)).map((author) => [author.id, author]),
        )
      : null;
  const { target, viewer, query, actions, watch, slowMode, currentness, reactionsAsOf } = readingPage;
  return {
    authors,
    composed: { target, viewer, query, actions, watch, slowMode, currentness, reactionsAsOf },
    conversationActivity: readingConversationActivity(readingPage),
    mentions,
    documentMedia,
    thread,
    ...context,
    posts,
    ...(readingPage.viewer.kind === 'account' && readingPage.viewer.id === viewerId ? { viewerId } : {}),
    verification,
    ...(data.post === undefined ? {} : { linkedPostUnavailable }),
  };
}
