import { buttonVariants } from '@rezics/ui/shadcn/button';
import { reactionKinds } from '@rezics/ui/reactions';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { ThreadReadingPost } from '../routes/threads/$id_.$slug';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthors } from '../identity/read';
import type { SessionState } from '../session/state';
import { rememberThreadSlug, threadLocation } from './thread-href';
import type { ThreadSubject } from './subjects';
import type { LoadedThreadPage, ThreadPost } from './thread-page';
import type { readThreadPersonal } from './reads';
import { replyToThread } from './actions';
import { csrfHeaders, draftFetch } from './composer';
import { ThreadReplyComposer } from './reply-context-composer';
import { AuthorErasureEntry } from './author-erasure-entry';

export type ThreadReadingPage = LoadedThreadPage & {
  authors: PageAuthors;
  subjects: ThreadSubject[];
  provenanceSubjects: ThreadSubject[];
  now: string;
};
export type ThreadReadingPersonal = Awaited<ReturnType<typeof readThreadPersonal>> & { idempotencyKey: string };

/** The real reading region; native commands, one composer and immutable revision views stay together. */
export function ThreadReading({
  page: sourcePage,
  readAuthority,
  personal,
  session,
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
  readAuthority?: object;
  Post: typeof ThreadReadingPost;
  signedOut: ReactNode;
  personal: ThreadReadingPersonal | undefined;
  session: SessionState | 'unknown';
  returnTo: string;
  renderHeader: (title: string | null) => ReactNode;
  onMutation: () => Promise<void>;
  onPageRefresh: () => Promise<ThreadReadingPage | undefined>;
  onPostIdsChange?: (ids: string[]) => void;
  authorErasure?: Omit<ComponentProps<typeof AuthorErasureEntry>, 'threadId'>;
}) {
  const [reading, setReading] = useState({ source: sourcePage, page: sourcePage });
  // Replace the complete disclosure together, including bylines, media, placement and title.
  const page = reading.source === sourcePage ? reading.page : sourcePage;
  if (reading.source !== sourcePage) setReading({ source: sourcePage, page: sourcePage });
  const { thread, realm, posts, authors, provenanceSubjects, verification, mentions: currentMentions, now, documentMedia } = page;
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
  const currentPersonal = session === 'signed-in' ? personal : undefined;
  const refreshScope = useMemo(() => ({}), [readAuthority, thread.id, thread.boardId, realm?.id, session, currentPersonal?.viewerId]);
  const currentRefresh = useRef(refreshScope);
  currentRefresh.current = refreshScope;
  useEffect(() => () => { currentRefresh.current = {}; }, []);
  // A private query can temporarily have no data when its post IDs change. Keep the local draft and intent mounted,
  // but expose no participation controls until current personal data is available again.
  const composer = useRef<{ viewerId: string | null; initialKey: string } | null>(null);
  if (currentPersonal && (!composer.current || composer.current.viewerId !== currentPersonal.viewerId)) {
    composer.current = { viewerId: currentPersonal.viewerId, initialKey: currentPersonal.idempotencyKey };
  }
  const summary = realm?.summary?.trim();
  useEffect(() => onPostIdsChange?.(posts.posts.map((post) => post.id)), [posts.posts, onPostIdsChange]);

  function selectReplyParent(parentId: string | null) {
    if (replyPending) return;
    setReplyTarget((current) => ({ parentId, focusRequest: current.focusRequest + 1 }));
  }
  function updatePost(post: ThreadPost) {
    setPosts((current) => ({ ...current, posts: current.posts.map((item) => (item.id === post.id ? post : item)) }));
  }
  async function refreshPage() {
    const scope = currentRefresh.current;
    const updated = await onPageRefresh();
    if (currentRefresh.current !== scope) throw new Error('Thread reader changed');
    if (!updated) throw new Error('Current thread page unavailable');
    setReading({ source: sourcePage, page: updated });
    return updated;
  }

  return (
    <article data-slot="thread-reading" className="mx-auto w-full min-w-0 space-y-5 text-foreground">
      {renderHeader(displayTitle)}
      {composer.current?.viewerId ? (
        <div hidden={!currentPersonal?.viewerId} inert={!currentPersonal?.viewerId}>
          <AuthorErasureEntry
            key={`${thread.id}:${composer.current.viewerId}`}
            threadId={thread.id}
            {...authorErasure}
          />
        </div>
      ) : null}
      <div
        className={
          summary ? 'grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]' : 'mx-auto w-full max-w-3xl'
        }
      >
        <div className="min-w-0 space-y-5">
          <section aria-labelledby="thread-posts-heading" className="min-w-0 space-y-3">
            <h2 id="thread-posts-heading" className="px-1 text-sm font-semibold text-muted-foreground">
              {m.thread_posts_heading()}
            </h2>
            {posts.posts.length ? (
              <ol
                id={`thread-${thread.id}`}
                className="space-y-3 scroll-mt-24 [&>li]:rounded-xl [&>li]:bg-card [&>li]:px-4 sm:[&>li]:px-6"
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
                      viewerId={currentPersonal?.viewerId ?? undefined}
                      personalReady={session !== 'signed-in' || currentPersonal !== undefined}
                      onChange={updatePost}
                      target={firstPost ? { kind: 'thread', id: thread.id } : { kind: 'post', id: post.id }}
                      counts={firstPost ? (thread.reactions ?? {}) : (post.reactions ?? {})}
                      value={
                        reactionKinds.find(
                          (kind) => kind === currentPersonal?.reactions[firstPost ? thread.id : post.id],
                        ) ?? null
                      }
                      signedIn={session === 'signed-in'}
                      returnTo={returnTo}
                      verification={verification}
                      onMutation={onMutation}
                      onPageRefresh={refreshPage}
                      onOpeningPostChange={(restored) => {
                        const title = restored ? thread.title : null;
                        setReading((current) => ({
                          ...current, page: { ...current.page, thread: { ...current.page.thread, title } },
                        }));
                        rememberThreadSlug(thread.id, title);
                      }}
                      replyParents={replyParents}
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
            {posts.next ? (
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
              hidden={!currentPersonal}
              inert={!currentPersonal}
            >
              <ThreadReplyComposer
                key={`${thread.id}:${composer.current.viewerId}`}
                initialKey={composer.current.initialKey}
                canSubmit={currentPersonal !== undefined}
                containerId={thread.id}
                parentId={replyTarget.parentId}
                parents={replyParents}
                focusRequest={replyTarget.focusRequest}
                pending={replyPending}
                onPendingChange={setReplyPending}
                onCancel={() => selectReplyParent(null)}
                onSubmit={async ({ body, idempotencyKey, mediaIds, parentId }) => {
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
                  setPosts((current) => ({
                    ...current,
                    posts: current.posts.some((item) => item.id === post.id)
                      ? current.posts.map((item) => (item.id === post.id ? post : item))
                      : [...current.posts, post],
                  }));
                  setReplyTarget((current) => ({ ...current, parentId: null }));
                  void onMutation();
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
