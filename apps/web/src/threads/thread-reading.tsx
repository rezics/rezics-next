import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemHeading } from '@rezics/ui/content-item';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { reactionKinds } from '@rezics/ui/reactions';
import { fromPlainText } from '@rezics/document';
import { QueryClientContext } from '@tanstack/react-query';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { useLocation } from '@tanstack/react-router';
import type { ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthors } from '../identity/read';
import type { SessionState } from '../session/state';
import { readReplyParent } from './reads';
import { rememberThreadSlug, threadLocation } from './thread-href';
import type { ThreadSubject } from './subjects';
import type { LoadedThreadPage, ThreadPost } from './thread-page';
import type { readThreadPersonal } from './reads';
import { ReplyParentReader } from './reply-context';
import { replyToThread } from './actions';
import { csrfHeaders, draftFetch } from './composer';
import { ThreadReplyComposer } from './reply-context-composer';
import { AuthorErasureEntry } from './author-erasure-entry';
import { authorErasureSessionSource } from './author-erasure-lifetime';

export type ThreadReadingPage = LoadedThreadPage & {
  authors: PageAuthors;
  subjects: ThreadSubject[];
  provenanceSubjects: ThreadSubject[];
  now: string;
};
export type ThreadReadingPersonal = Awaited<ReturnType<typeof readThreadPersonal>> & { idempotencyKey: string };

export function focusThreadPostLocation(
  hash: string,
  threadId: string,
  posts: ThreadPost[],
  list: HTMLOListElement | null,
  pageCurrent: boolean,
  isPageCallbackCurrent?: () => boolean,
) {
  if (!pageCurrent || isPageCallbackCurrent?.() === false) return;
  const fragment = hash.replace(/^#/, '');
  if (!fragment.startsWith('post-')) return;
  const id = fragment.slice('post-'.length);
  if (!posts.some((post) => post.id === id && post.availability === 'available')) return;
  if (
    !list ||
    list.id !== `thread-${threadId}` ||
    list.hasAttribute('inert') ||
    list.getAttribute('aria-hidden') === 'true'
  )
    return;
  const HTMLElementConstructor = list.ownerDocument.defaultView?.HTMLElement;
  const target = Array.from(list.children).find((item) => item.id === fragment);
  if (!HTMLElementConstructor || !(target instanceof HTMLElementConstructor)) return;
  target.scrollIntoView({ block: 'start' });
  target.focus({ preventScroll: true });
}

/** Remove obsolete page disclosure while keeping each keyed post component mounted for local drafts. */
function redactThreadReadingPage(page: ThreadReadingPage): ThreadReadingPage {
  const empty = fromPlainText('', 'blocks');
  const threadRecord = page.thread as typeof page.thread & { authorId?: string };
  const { authorId: _threadAuthor, firstPost, subjectIds: _subjectIds, ...threadFields } = threadRecord;
  const {
    authorId: _openingAuthor,
    revisedAt: _openingRevisedAt,
    revisionId: _openingRevisionId,
    sha256: _openingSha256,
    mediaIds: _openingMediaIds,
    subjectIds: _openingSubjectIds,
    subjectId: _openingSubjectId,
    body: _openingBody,
    ...openingFields
  } = firstPost as typeof firstPost & {
    authorId?: string;
    revisedAt?: string;
    revisionId?: string;
    sha256?: string | null;
    mediaIds?: string[];
    subjectIds?: string[];
    subjectId?: string;
    body?: unknown;
  };
  void [
    _threadAuthor,
    _subjectIds,
    _openingAuthor,
    _openingRevisedAt,
    _openingRevisionId,
    _openingSha256,
    _openingMediaIds,
    _openingSubjectIds,
    _openingSubjectId,
    _openingBody,
  ];
  const safeThread = {
    ...threadFields,
    title: null,
    firstPost: { ...openingFields, body: empty },
  } as typeof page.thread;
  const safePosts = page.posts.posts.map((post) => {
    if (post.availability !== 'available') return post;
    const value = post as typeof post & {
      authorId?: string;
      revisedAt?: string;
      revisionId?: string;
      sha256?: string | null;
      mediaIds?: string[];
      body?: unknown;
    };
    const {
      authorId: _postAuthor,
      revisedAt: _revisedAt,
      revisionId: _revisionId,
      body: _body,
      mediaIds: _mediaIds,
      ...safePost
    } = value;
    void [_postAuthor, _revisedAt, _revisionId, _body, _mediaIds];
    return { ...safePost, body: empty, mediaIds: [], sha256: null } as unknown as typeof post;
  });
  const { board: _board, realm: _realm, documentMedia: _documentMedia, ...safePage } = page;
  void [_board, _realm, _documentMedia];
  return {
    ...safePage,
    thread: safeThread,
    posts: { ...page.posts, posts: safePosts },
    mentions: {},
    authors: {},
    subjects: [],
    provenanceSubjects: [],
  };
}

/** The real reading region; native commands, one composer and immutable revision views stay together. */
export function ThreadReading({
  page: sourcePage,
  pageCurrent = true,
  pageCallbackRevision = '0:0',
  isPageCallbackCurrent = () => true,
  readAuthority,
  personal,
  session,
  readerSubject,
  returnTo,
  renderHeader,
  onMutation,
  onPageRefresh,
  onPostIdsChange,
  Post,
  signedOut,
  authorErasure,
}: {
  page: ThreadReadingPage;
  pageCurrent?: boolean;
  pageCallbackRevision?: string;
  isPageCallbackCurrent?: () => boolean;
  readAuthority?: object;
  Post: typeof ThreadReadingPost;
  signedOut: ReactNode;
  personal: ThreadReadingPersonal | undefined;
  session: SessionState | 'unknown';
  readerSubject?: string | null | undefined;
  returnTo: string;
  renderHeader: (title: string | null, page: ThreadReadingPage) => ReactNode;
  onMutation: () => Promise<void>;
  onPageRefresh: () => Promise<ThreadReadingPage | undefined>;
  onPostIdsChange?: (ids: string[]) => void;
  authorErasure?: Omit<ComponentProps<typeof AuthorErasureEntry>, 'threadId'>;
}) {
  const location = useLocation();
  const [reading, setReading] = useState({ source: sourcePage, page: sourcePage, redacted: false });
  // Replace the complete disclosure together, including bylines, media, placement and title.
  let page: ThreadReadingPage;
  if (!pageCurrent) {
    const current = reading.source === sourcePage ? reading.page : sourcePage;
    if (reading.source !== sourcePage || !reading.redacted)
      setReading({ source: sourcePage, page: redactThreadReadingPage(current), redacted: true });
    page = reading.source === sourcePage && reading.redacted ? reading.page : redactThreadReadingPage(current);
  } else {
    page = reading.source === sourcePage && !reading.redacted ? reading.page : sourcePage;
    if (reading.source !== sourcePage || reading.redacted)
      setReading({ source: sourcePage, page: sourcePage, redacted: false });
  }
  const {
    thread,
    realm,
    posts,
    authors,
    provenanceSubjects,
    verification,
    mentions: currentMentions,
    now,
    documentMedia,
  } = page;
  const postList = useRef<HTMLOListElement>(null);
  const permalinkPage = useRef({ posts: posts.posts, threadId: thread.id, pageCurrent, isPageCallbackCurrent });
  permalinkPage.current = { posts: posts.posts, threadId: thread.id, pageCurrent, isPageCallbackCurrent };
  useEffect(() => {
    const current = permalinkPage.current;
    focusThreadPostLocation(
      location.hash,
      current.threadId,
      current.posts,
      postList.current,
      current.pageCurrent,
      current.isPageCallbackCurrent,
    );
  }, [location]);
  const displayTitle = thread.title;
  function setPosts(update: (posts: ThreadReadingPage['posts']) => ThreadReadingPage['posts']) {
    setReading((current) => ({ ...current, page: { ...current.page, posts: update(current.page.posts) } }));
  }
  const [replyTarget, setReplyTarget] = useState<{ parentId: string | null; focusRequest: number }>({
    parentId: null,
    focusRequest: 0,
  });
  const [replyPending, setReplyPending] = useState(false);
  const replyParents = useMemo(() => new Map(posts.posts.map((post) => [post.id, post])), [posts.posts]);
  // Private data is consumed only while the session still says signed in.
  const currentPersonal = pageCurrent && session === 'signed-in' ? personal : undefined;
  const retainedCommandAuthority = useRef<{
    session: SessionState | 'unknown';
    viewerId?: string | null;
    personalReady: boolean;
  }>(undefined);
  if (pageCurrent && session === 'signed-in' && currentPersonal && !retainedCommandAuthority.current)
    retainedCommandAuthority.current = {
      session,
      viewerId: currentPersonal.viewerId,
      personalReady: true,
    };
  const commandAuthority = retainedCommandAuthority.current;
  const commandSession = pageCurrent ? session : (commandAuthority?.session ?? session);
  const commandViewerId = pageCurrent ? currentPersonal?.viewerId : commandAuthority?.viewerId;
  const commandPersonalReady = pageCurrent
    ? session !== 'signed-in' || currentPersonal !== undefined
    : (commandAuthority?.personalReady ?? false);
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => authorErasureSessionSource(client), [client]);
  const sessionRevision = observation.snapshot();
  const parentScope = useMemo(
    () => ({}),
    [
      readAuthority,
      thread.id,
      posts.posts,
      authors,
      session,
      readerSubject,
      currentPersonal?.viewerId,
      page.viewerId,
      observation,
    ],
  );
  const currentParentScope = useRef(parentScope);
  currentParentScope.current = parentScope;
  const parentReader = useMemo(() => {
    if (session !== 'signed-in' && session !== 'signed-out') return undefined;
    const browserSession = observation.read();
    // Prepared standalone/server views retain explicit admission. A real browser client must be known and ready.
    if (client && typeof window !== 'undefined') {
      if (browserSession?.state !== session) return undefined;
      if (
        session === 'signed-in' &&
        (!browserSession.subject ||
          !browserSession.csrfToken ||
          (readerSubject != null && readerSubject !== browserSession.subject) ||
          (currentPersonal?.viewerId != null && currentPersonal.viewerId !== browserSession.subject) ||
          (page.viewerId !== undefined && page.viewerId !== browserSession.subject))
      )
        return undefined;
    }
    const credentialMode = session === 'signed-in' ? 'session' : 'anonymous';
    return new ReplyParentReader(
      thread.id,
      (parentId) => readReplyParent({ data: { threadId: thread.id, parentId, credentialMode } }),
      () => currentParentScope.current === parentScope && observation.snapshot() === sessionRevision,
    );
  }, [
    parentScope,
    observation,
    sessionRevision,
    client,
    session,
    thread.id,
    readerSubject,
    currentPersonal?.viewerId,
    page.viewerId,
  ]);
  const subscribeParentSession = useCallback(
    (notify: () => void) =>
      observation.subscribe(() => {
        parentReader?.current();
        notify();
      }),
    [observation, parentReader],
  );
  useSyncExternalStore(subscribeParentSession, observation.snapshot, observation.serverSnapshot);
  useLayoutEffect(() => {
    return parentReader?.connect();
  }, [parentReader]);
  const refreshScope = useMemo(
    () => ({}),
    [readAuthority, thread.id, thread.boardId, realm?.id, session, currentPersonal?.viewerId, pageCallbackRevision],
  );
  const currentRefresh = useRef(refreshScope);
  currentRefresh.current = refreshScope;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A private query can temporarily have no data when its post IDs change. Keep the local draft and intent mounted,
  // but expose no participation controls until current personal data is available again.
  const composer = useRef<{ viewerId: string | null; initialKey: string } | null>(null);
  if (currentPersonal && (!composer.current || composer.current.viewerId !== currentPersonal.viewerId)) {
    composer.current = { viewerId: currentPersonal.viewerId, initialKey: currentPersonal.idempotencyKey };
  }
  const summary = realm?.summary?.trim();
  useEffect(() => {
    if (isPageCallbackCurrent()) onPostIdsChange?.(posts.posts.map((post) => post.id));
  }, [posts.posts, onPostIdsChange, pageCallbackRevision]);

  function selectReplyParent(parentId: string | null) {
    if (replyPending) return;
    setReplyTarget((current) => ({ parentId, focusRequest: current.focusRequest + 1 }));
  }
  function updatePost(post: ThreadPost) {
    if (!isPageCallbackCurrent()) return;
    setPosts((current) => ({ ...current, posts: current.posts.map((item) => (item.id === post.id ? post : item)) }));
  }
  async function refreshPage() {
    if (!isPageCallbackCurrent()) throw new Error('Thread reader changed');
    const scope = currentRefresh.current;
    const updated = await onPageRefresh();
    if (!mounted.current || currentRefresh.current !== scope || !isPageCallbackCurrent())
      throw new Error('Thread reader changed');
    if (!updated) throw new Error('Current thread page unavailable');
    setReading({ source: sourcePage, page: updated, redacted: false });
    return updated;
  }

  return (
    <article data-slot="thread-reading" className="mx-auto w-full min-w-0 text-foreground [overflow-wrap:anywhere]">
      <div
        className={
          summary
            ? 'mx-auto grid w-full min-w-0 max-w-[64.5rem] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]'
            : 'mx-auto w-full max-w-3xl'
        }
      >
        <div data-slot="thread-reading-column" className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
          {renderHeader(displayTitle, page)}
          <section aria-labelledby="thread-posts-heading" className="min-w-0 space-y-3">
            <ContentItemHeading
              level={2}
              id="thread-posts-heading"
              className="px-1 text-sm font-semibold text-muted-foreground"
            >
              {m.thread_posts_heading()}
            </ContentItemHeading>
            {posts.posts.length ? (
              <ol
                id={`thread-${thread.id}`}
                ref={postList}
                aria-hidden={!pageCurrent}
                inert={!pageCurrent}
                className={pageCurrent ? 'space-y-3 scroll-mt-24' : 'invisible space-y-3 scroll-mt-24'}
              >
                {posts.posts.map((post) => {
                  const firstPost = post.id === thread.firstPost.id;
                  return (
                    <Post
                      key={post.id}
                      anchorId={`post-${post.id}`}
                      post={post}
                      readAuthority={readAuthority}
                      authors={authors}
                      mentions={currentMentions}
                      documentMedia={documentMedia}
                      now={now}
                      viewerId={commandViewerId ?? undefined}
                      personalReady={commandPersonalReady}
                      onChange={updatePost}
                      target={firstPost ? { kind: 'thread', id: thread.id } : { kind: 'post', id: post.id }}
                      counts={firstPost ? (thread.reactions ?? {}) : (post.reactions ?? {})}
                      value={
                        reactionKinds.find(
                          (kind) => kind === currentPersonal?.reactions[firstPost ? thread.id : post.id],
                        ) ?? null
                      }
                      signedIn={commandSession === 'signed-in'}
                      returnTo={returnTo}
                      verification={verification}
                      onMutation={onMutation}
                      onPageRefresh={refreshPage}
                      onOpeningPostChange={(restored) => {
                        if (!isPageCallbackCurrent()) return;
                        const title = restored ? thread.title : null;
                        setReading((current) => ({
                          ...current,
                          page: { ...current.page, thread: { ...current.page.thread, title } },
                        }));
                        rememberThreadSlug(thread.id, title);
                        if (!isPageCallbackCurrent()) return;
                      }}
                      replyParents={replyParents}
                      replyParentReader={parentReader}
                      replyPending={replyPending}
                      onReply={() => selectReplyParent(post.id)}
                      subjects={provenanceSubjects}
                      currentVote={currentPersonal?.reviewVotes[post.id]}
                      review={firstPost && thread.kind === 'review'}
                    />
                  );
                })}
              </ol>
            ) : (
              <p className="rounded-xl bg-card p-4 text-muted-foreground">
                {posts.next ? m.thread_reading_empty_page() : m.thread_posts_empty()}
              </p>
            )}
            {pageCurrent && posts.next ? (
              <nav aria-label={m.thread_posts_heading()}>
                <a
                  href={threadLocation(getLocale(), { id: thread.id, title: displayTitle }, posts.next)}
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                >
                  {m.threads_next_page()}
                </a>
              </nav>
            ) : null}
          </section>
          {composer.current ? (
            <section
              aria-label={m.thread_reply_label()}
              className="min-w-0"
              hidden={!currentPersonal || !pageCurrent}
              inert={!currentPersonal || !pageCurrent}
            >
              <ThreadReplyComposer
                key={`${thread.id}:${composer.current.viewerId}`}
                initialKey={composer.current.initialKey}
                canSubmit={currentPersonal !== undefined}
                containerId={thread.id}
                boardId={thread.boardId}
                parentId={replyTarget.parentId}
                parents={replyParents}
                focusRequest={replyTarget.focusRequest}
                pending={replyPending}
                onPendingChange={setReplyPending}
                onCancel={() => selectReplyParent(null)}
                onSubmit={async ({ body, idempotencyKey, mediaIds, parentId }) => {
                  if (!isPageCallbackCurrent()) throw new Error('Thread reader changed');
                  const result = await replyToThread({
                    data: {
                      threadId: thread.id,
                      body,
                      idempotencyKey,
                      ...(parentId === undefined ? {} : { parentId }),
                      ...(mediaIds.length > 0 ? { mediaIds } : {}),
                    },
                    headers: csrfHeaders(),
                    fetch: draftFetch(body),
                  });
                  return result.ok ? { ok: true as const, value: result.post } : result;
                }}
                onSuccess={(post) => {
                  if (!isPageCallbackCurrent()) return;
                  setPosts((current) => ({
                    ...current,
                    posts: current.posts.some((item) => item.id === post.id)
                      ? current.posts.map((item) => (item.id === post.id ? post : item))
                      : [...current.posts, post],
                  }));
                  setReplyTarget((current) => ({ ...current, parentId: null }));
                  if (isPageCallbackCurrent()) void onMutation();
                }}
              />
            </section>
          ) : null}
          {currentPersonal ? null : session === 'signed-out' ? (
            <div className="rounded-xl bg-card p-4 sm:p-6">{signedOut}</div>
          ) : (
            <p role="status" className="px-1 text-sm text-muted-foreground">
              {session === 'unavailable' ? m.thread_reading_participation_unavailable() : m.thread_reading_preparing()}
            </p>
          )}
          {composer.current?.viewerId ? (
            <div hidden={!currentPersonal?.viewerId} inert={!currentPersonal?.viewerId}>
              <Collapsible data-slot="thread-actions" className="min-w-0">
                <CollapsibleTrigger
                  aria-controls={`thread-actions-${thread.id}`}
                  render={<Button variant="ghost" size="sm" />}
                >
                  {m.thread_content_more_actions()}
                </CollapsibleTrigger>
                {/* Closing secondary actions must retain the actor's confirmation and uncertain command intent. */}
                <CollapsibleContent id={`thread-actions-${thread.id}`} keepMounted className="pt-2">
                  <AuthorErasureEntry
                    key={`${thread.id}:${composer.current.viewerId}`}
                    threadId={thread.id}
                    viewerId={currentPersonal?.viewerId ?? composer.current.viewerId}
                    {...authorErasure}
                  />
                </CollapsibleContent>
              </Collapsible>
            </div>
          ) : null}
        </div>
        {summary && realm ? (
          <aside aria-labelledby="thread-community-heading" className="hidden rounded-xl bg-card p-5 lg:block">
            <h2 id="thread-community-heading" className="mb-3 text-sm font-semibold">
              {m.thread_reading_about()}
            </h2>
            <a
              href={`/${getLocale()}/realms/${encodeURIComponent(realm.id)}`}
              className="font-semibold underline-offset-4 hover:underline"
            >
              {realm.title}
            </a>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{summary}</p>
          </aside>
        ) : null}
      </div>
    </article>
  );
}
