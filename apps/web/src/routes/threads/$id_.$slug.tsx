import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { DocumentBody, type DocumentMentions } from '@rezics/ui/document-body';
import { ContentActions } from '@rezics/ui/content-actions';
import { undoToast } from '@rezics/ui/undo-toast';
import type { ReactionKind } from '@rezics/ui/reactions';
import { createFileRoute, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import { getLocale } from '../../paraglide/runtime.js';
import type { ThreadPost } from '../../threads/reads';
import { threadPageQuery, threadPersonalQuery } from '../../threads/thread-queries';
import { threadPageHead } from '../../threads/thread-head';
import {
  rememberThreadSlug,
  rememberedThreadSlug,
  sameThreadSlug,
  slugMatches,
  threadLocation,
  threadTitle,
} from '../../threads/thread-href';
import type { PageAuthors } from '../../identity/read';
import { Byline } from '../../threads/byline';
import { BoardContext } from '../../threads/thread-context';
import { ThreadSubjects } from '../../threads/thread-subjects';
import { ThreadReactions } from '../../threads/thread-reactions';
import {
  erasePost,
  restorePost as restorePostAction,
  replyToThread,
  revisePost,
  type RevisedPost,
  type WriteFailure,
  type CreatedPost,
} from '../../threads/actions';
import { csrfHeaders, draftFetch, InlinePostEditor, PostComposer, SignInPrompt } from '../../threads/composer';
import { PageHeading } from '../../shell/page-heading';
import { RemovedPost } from '../../threads/post-removed';

function threadSearch(search: Record<string, unknown>): { cursor?: string } {
  const cursor = v.parse(v.fallback(v.optional(v.string()), undefined), search.cursor);
  return typeof cursor === 'string' ? { cursor } : {};
}

export const Route = createFileRoute('/threads/$id_/$slug')({
  staticData: { publicCache: true },
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => ({ cursor: threadSearch(search).cursor }),
  loader: async ({ params, deps, context }) => {
    const mode = context.credentialMode;
    const known = rememberedThreadSlug(params.id);
    const expectedSlug = known !== undefined && slugMatches(params.slug, known) ? undefined : params.slug;
    const page = await context.queryClient.ensureQueryData(threadPageQuery(params.id, deps.cursor, mode, expectedSlug));
    if ('redirect' in page) {
      rememberThreadSlug(page.redirect.id, page.redirect.title);
      throw redirect({ href: threadLocation(getLocale(), page.redirect, deps.cursor), statusCode: 301 });
    }
    const title = threadTitle(page.thread);
    rememberThreadSlug(page.thread.id, title);
    if (!sameThreadSlug(params.slug, title))
      throw redirect({
        href: threadLocation(getLocale(), { id: page.thread.id, title }, deps.cursor),
        statusCode: 301,
      });
    return { ...page, indexable: deps.cursor === undefined };
  },
  head: ({ loaderData }) => (loaderData ? threadPageHead(loaderData) : { meta: [{ title: m.threads_untitled() }] }),
  component: ThreadPage,
});

function ThreadPage() {
  const {
    thread,
    board,
    realm,
    posts: loadedPosts,
    verification,
    authors,
    subjects,
    mentions,
    now,
  } = Route.useLoaderData();
  const [posts, setPosts] = useState(loadedPosts);
  const [currentMentions, setCurrentMentions] = useState(mentions);
  const [displayTitle, setDisplayTitle] = useState(thread.title);
  const { state: session } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const location = useLocation();
  const id = Route.useParams().id;
  const cursor = Route.useSearch().cursor;
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;
  const postIds = posts.posts.map((post) => post.id);
  const personalQuery = useQuery({
    ...threadPersonalQuery(id, cursor, postIds),
    enabled: session === 'signed-in',
  });
  const personal = session === 'signed-in' ? personalQuery.data : undefined;

  useEffect(() => setPosts(loadedPosts), [loadedPosts]);
  useEffect(() => setCurrentMentions(mentions), [mentions]);
  useEffect(() => setDisplayTitle(thread.title), [thread.id, thread.title]);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash.startsWith('post-')) document.getElementById(hash)?.scrollIntoView();
    else if (!hash) window.scrollTo(0, 0);
  }, [id, location.hash, loadedPosts]);

  function updatePost(post: ThreadPost) {
    setPosts((current) => ({
      ...current,
      posts: current.posts.map((item) => (item.id === post.id ? post : item)),
    }));
  }

  async function refreshThreadQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['thread-page', id] }),
      queryClient.invalidateQueries({ queryKey: ['thread-personal', id] }),
    ]);
  }

  async function refreshThreadPage() {
    const page = await queryClient.fetchQuery({
      ...threadPageQuery(id, cursor, session === 'signed-in' ? 'session' : 'anonymous'),
      staleTime: 0,
    });
    if ('redirect' in page) return;
    setPosts(page.posts);
    setCurrentMentions(page.mentions);
    setDisplayTitle(page.thread.title);
    rememberThreadSlug(page.thread.id, page.thread.title);
    const destination = threadLocation(getLocale(), { id: page.thread.id, title: page.thread.title }, cursor);
    if (new URL(destination, window.location.origin).pathname !== location.pathname)
      await router.navigate({ to: destination as never });
  }

  return (
    <article className="max-w-4xl space-y-6 text-foreground">
      <header className="space-y-3">
        <BoardContext realm={realm} board={board} />
        {displayTitle ? <PageHeading>{displayTitle}</PageHeading> : null}
        <ThreadSubjects subjects={subjects} />
      </header>
      <section className="space-y-6" aria-labelledby="thread-posts-heading">
        <h2 id="thread-posts-heading" className="text-xl font-semibold">
          {m.thread_posts_heading()}
        </h2>
        {posts.posts.length ? (
          <ol id={`thread-${thread.id}`} className="scroll-mt-24 divide-y divide-border/60 border-y border-border/60">
            {posts.posts.map((post) => {
              const firstPost = post.id === thread.firstPost.id;
              return (
                <PostSlot
                  key={post.id}
                  anchorId={`post-${post.id}`}
                  onChange={updatePost}
                  post={post}
                  authors={authors}
                  mentions={currentMentions}
                  now={now}
                  counts={firstPost ? (thread.reactions ?? {}) : (post.reactions ?? {})}
                  returnTo={returnTo}
                  signedIn={session === 'signed-in'}
                  personalReady={session !== 'signed-in' || personal !== undefined}
                  target={firstPost ? { kind: 'thread', id: thread.id } : { kind: 'post', id: post.id }}
                  value={(personal?.reactions[firstPost ? thread.id : post.id] as ReactionKind | null) ?? null}
                  verification={verification}
                  viewerId={personal?.viewerId ?? undefined}
                  onMutation={refreshThreadQueries}
                  onPageRefresh={refreshThreadPage}
                  onOpeningPostChange={(restored) => {
                    const title = restored ? thread.title : null;
                    setDisplayTitle(title);
                    rememberThreadSlug(thread.id, title);
                  }}
                />
              );
            })}
          </ol>
        ) : (
          <p className="text-muted-foreground">{m.thread_posts_empty()}</p>
        )}
        {posts.next && (
          <nav aria-label={m.thread_posts_heading()}>
            <a
              href={threadLocation(getLocale(), { id: thread.id, title: threadTitle(thread) }, posts.next)}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.threads_next_page()}
            </a>
          </nav>
        )}
      </section>
      <div className="min-h-[22rem]">
        {session === 'signed-in' && personal ? (
          <PostComposer<CreatedPost>
            initialKey={personal.idempotencyKey}
            containerId={id}
            onSubmit={async ({ body, idempotencyKey: key, mediaIds }) => {
              const result = await replyToThread({
                data: {
                  threadId: id,
                  body,
                  idempotencyKey: key,
                  ...(mediaIds.length > 0 ? { mediaIds } : {}),
                },
                headers: csrfHeaders(),
                fetch: draftFetch(body),
              });
              return result.ok ? { ok: true as const, value: result.post } : result;
            }}
            onSuccess={(post) => {
              setPosts((current) => ({ ...current, posts: [...current.posts, post] }));
              void refreshThreadQueries();
            }}
          />
        ) : session === 'signed-out' ? (
          <SignInPrompt returnTo={returnTo} label={m.threads_sign_in_to_reply()} />
        ) : null}
      </div>
    </article>
  );
}

function fullDateTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(date);
}

function postDeleteFailureText(failure: WriteFailure): string {
  return failure.reason === 'closed' ? m.thread_write_closed() : m.thread_delete_failure();
}

function PostSlot({
  post,
  authors,
  mentions,
  now,
  viewerId,
  personalReady,
  onChange,
  anchorId,
  target,
  counts,
  value,
  signedIn,
  returnTo,
  verification,
  onMutation,
  onPageRefresh,
  onOpeningPostChange,
}: {
  post: ThreadPost;
  authors: PageAuthors;
  mentions: DocumentMentions;
  now: string;
  viewerId: string | undefined;
  personalReady: boolean;
  onChange: (post: ThreadPost) => void;
  anchorId: string;
  target: { kind: 'thread' | 'post'; id: string };
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  signedIn: boolean;
  returnTo: string;
  verification: VerificationConfig;
  onMutation: () => Promise<void>;
  onPageRefresh: () => Promise<void>;
  onOpeningPostChange: (restored: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [removedMinHeight, setRemovedMinHeight] = useState<number>();
  const menuButton = useRef<HTMLButtonElement>(null);
  const itemElement = useRef<HTMLLIElement>(null);
  const deleteKey = useRef<string | undefined>(undefined);
  const restoreKey = useRef<string | undefined>(undefined);
  const restoreSnapshot = useRef<ThreadPost | undefined>(undefined);
  const restorePending = useRef(false);
  const restoreMenuFocus = useRef(false);
  const restorePostFocus = useRef(false);
  const ownsPost = viewerId !== undefined && post.availability === 'available' && post.authorId === viewerId;

  useEffect(() => {
    if (restoreMenuFocus.current && !editing) {
      restoreMenuFocus.current = false;
      menuButton.current?.focus();
    }
    if (restorePostFocus.current && !editing && post.availability === 'available') {
      restorePostFocus.current = false;
      itemElement.current?.focus();
    }
  }, [editing, post.availability]);

  const labels = {
    moreActions: m.thread_content_more_actions(),
    copyLink: m.thread_content_copy_link(),
    edit: m.thread_content_edit(),
    delete: m.thread_content_delete(),
    deleteTitle: m.thread_delete_title(),
    deleteDescription: m.thread_delete_description(),
    confirmDelete: m.thread_delete_confirm(),
    cancel: m.thread_delete_cancel(),
    deleteFailure: m.thread_delete_failure(),
  };

  async function copyLink() {
    await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${anchorId}`);
  }

  function cancelEdit() {
    restoreMenuFocus.current = true;
    setEditing(false);
  }

  async function restoreRemovedPost(snapshot?: ThreadPost) {
    if (restorePending.current) return;
    restorePending.current = true;
    setRestoreError('');
    restoreKey.current ??= crypto.randomUUID();
    try {
      const result = await restorePostAction({
        data: { postId: post.id, idempotencyKey: restoreKey.current },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        if (result.reason === 'conflict') {
          restoreKey.current = undefined;
          setRestoreError(m.thread_post_restore_conflict());
        } else {
          setRestoreError(m.thread_post_restore_failure());
        }
        return;
      }

      restoreKey.current = undefined;
      restorePostFocus.current = true;
      if (snapshot) {
        onChange(snapshot);
        if (target.kind === 'thread') onOpeningPostChange(true);
      } else {
        // A fresh tombstone has no body by contract. Once restored, reload its readable page entry.
        await onPageRefresh();
      }
    } catch {
      setRestoreError(m.thread_post_restore_failure());
    } finally {
      restorePending.current = false;
    }
  }

  async function deletePost() {
    deleteKey.current ??= crypto.randomUUID();
    const result = await erasePost({
      data: {
        postId: post.id,
        idempotencyKey: deleteKey.current,
        ...(target.kind === 'thread' ? { openingThreadId: target.id } : {}),
      },
      headers: csrfHeaders(),
    });
    if (!result.ok) throw new Error(postDeleteFailureText(result));
    if (removedMinHeight === undefined) setRemovedMinHeight(itemElement.current?.getBoundingClientRect().height);
    restoreSnapshot.current = post;
    restoreMenuFocus.current = true;
    setRestoreError('');
    const deleted: ThreadPost = {
      ...post,
      body: null,
      sha256: null,
      availability: 'erased',
      removed: true,
      restorableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    onChange(deleted);
    if (target.kind === 'thread') onOpeningPostChange(false);
    undoToast(m.thread_post_deleted_toast(), () => void restoreRemovedPost(post), { undo: m.thread_post_undo() });
  }

  if (post.availability !== 'available') {
    return (
      <RemovedPost
        post={post}
        authors={authors}
        now={now}
        {...(viewerId !== undefined ? { viewerId } : {})}
        anchorId={anchorId}
        itemRef={itemElement}
        menuButton={menuButton}
        {...(removedMinHeight !== undefined ? { minHeight: removedMinHeight } : {})}
        restoreError={restoreError}
        onCopyLink={copyLink}
        {...(post.availability === 'erased' && 'restorableUntil' in post && post.restorableUntil
          ? { onRestore: () => void restoreRemovedPost(restoreSnapshot.current) }
          : {})}
      />
    );
  }

  return (
    <li id={anchorId} ref={itemElement} tabIndex={-1} className="scroll-mt-24 py-5 target:bg-muted/50">
      <div className="mb-3 flex items-start justify-between gap-3">
        <Byline
          author={authors?.[post.authorId]}
          createdAt={post.createdAt}
          now={now}
          showAuthor={authors !== null}
          className="min-h-8 flex-1"
        >
          {post.revisedAt && new Date(post.revisedAt).getTime() > new Date(post.createdAt).getTime() ? (
            <time dateTime={post.revisedAt} title={fullDateTime(post.revisedAt)}>
              {m.thread_post_edited()}
            </time>
          ) : null}
        </Byline>
        <div className="flex shrink-0 items-center gap-1">
          <ThreadReactions
            counts={counts}
            returnTo={returnTo}
            signedIn={signedIn}
            target={target}
            value={value}
            onMutation={onMutation}
            personalReady={personalReady}
          />
          {editing ? null : ownsPost ? (
            <ContentActions
              labels={labels}
              onCopyLink={copyLink}
              onDelete={deletePost}
              onEdit={() => {
                setEditKey(crypto.randomUUID());
                setEditing(true);
              }}
              ownsContent
              triggerRef={menuButton}
            />
          ) : (
            <PostActions
              target={target}
              {...(post.revisionId ? { revisionId: post.revisionId } : {})}
              verification={verification}
            />
          )}
        </div>
      </div>
      {editing ? (
        <InlinePostEditor
          initialBody={post.body}
          initialMediaIds={post.mediaIds}
          revisionId={post.revisionId}
          idempotencyKey={editKey}
          containerId={post.threadId}
          onCancel={cancelEdit}
          onSubmit={async ({ body, revisionId, idempotencyKey, mediaIds }) => {
            const result = await revisePost({
              data: { postId: post.id, body, revisionId, idempotencyKey, mediaIds },
              headers: csrfHeaders(),
              fetch: draftFetch(body),
            });
            return result;
          }}
          onSuccess={(updated: RevisedPost) => {
            onChange(updated as ThreadPost);
            setEditing(false);
            void onMutation();
          }}
        />
      ) : (
        <DocumentBody
          className="mx-0!"
          document={post.body}
          mentions={mentions}
          locale={getLocale()}
          labels={{ revealSpoiler: m.thread_reveal_spoiler() }}
        />
      )}
    </li>
  );
}
