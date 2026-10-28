import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '@rezics/ui/document-body';
import { ContentActions } from '@rezics/ui/content-actions';
import type { ReactionKind } from '@rezics/ui/reactions';
import { createFileRoute, redirect, useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import { getLocale } from '../../paraglide/runtime.js';
import type { ThreadPost } from '../../threads/reads';
import { credentialMode, threadPageQuery } from '../../threads/thread-queries';
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
  replyToThread,
  revisePost,
  type RevisedPost,
  type WriteFailure,
  type CreatedPost,
} from '../../threads/actions';
import { csrfHeaders, draftFetch, InlinePostEditor, PostComposer, SignInPrompt } from '../../threads/composer';
import { PageHeading } from '../../shell/page-heading';

function threadSearch(search: Record<string, unknown>): { cursor?: string } {
  const cursor = v.parse(v.fallback(v.optional(v.string()), undefined), search.cursor);
  return typeof cursor === 'string' ? { cursor } : {};
}

export const Route = createFileRoute('/threads/$id_/$slug')({
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => ({ cursor: threadSearch(search).cursor }),
  loader: async ({ params, deps, context }) => {
    const mode = credentialMode();
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
    idempotencyKey,
    viewerId,
    verification,
    authors,
    subjects,
    now,
  } = Route.useLoaderData();
  const [posts, setPosts] = useState(loadedPosts);
  const { state: session } = useSession();
  const location = useLocation();
  const id = Route.useParams().id;
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;

  useEffect(() => setPosts(loadedPosts), [loadedPosts]);

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

  return (
    <article className="max-w-4xl space-y-6 text-foreground">
      <header className="space-y-3">
        <BoardContext realm={realm} board={board} />
        <PageHeading>{thread.title ?? m.threads_untitled()}</PageHeading>
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
                  now={now}
                  counts={firstPost ? (thread.reactions ?? {}) : (post.reactions ?? {})}
                  returnTo={returnTo}
                  signedIn={session === 'signed-in'}
                  target={firstPost ? { kind: 'thread', id: thread.id } : { kind: 'post', id: post.id }}
                  value={(firstPost ? thread.viewerReaction : post.viewerReaction) ?? null}
                  verification={verification}
                  viewerId={viewerId}
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
      {session === 'signed-in' ? (
        <PostComposer<CreatedPost>
          initialKey={idempotencyKey}
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
          onSuccess={(post) => setPosts((current) => ({ ...current, posts: [...current.posts, post] }))}
        />
      ) : session === 'signed-out' ? (
        <SignInPrompt returnTo={returnTo} label={m.threads_sign_in_to_reply()} />
      ) : null}
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
  now,
  viewerId,
  onChange,
  anchorId,
  target,
  counts,
  value,
  signedIn,
  returnTo,
  verification,
}: {
  post: ThreadPost;
  authors: PageAuthors;
  now: string;
  viewerId: string | undefined;
  onChange: (post: ThreadPost) => void;
  anchorId: string;
  target: { kind: 'thread' | 'post'; id: string };
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  signedIn: boolean;
  returnTo: string;
  verification: VerificationConfig;
}) {
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const deleteKey = useRef<string | undefined>(undefined);
  const restoreMenuFocus = useRef(false);
  const ownsPost = viewerId !== undefined && post.availability === 'available' && post.authorId === viewerId;

  useEffect(() => {
    if (restoreMenuFocus.current && !editing) {
      restoreMenuFocus.current = false;
      menuButton.current?.focus();
    }
  }, [editing]);

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
    onChange({ ...post, body: null, availability: 'erased', removed: true } as ThreadPost);
  }

  if (('removed' in post && post.removed) || post.availability === 'erased') {
    return (
      <li id={anchorId} className="scroll-mt-24 py-6 target:bg-muted/50">
        <p className="text-muted-foreground" role="note">
          {m.thread_post_erased()}
        </p>
      </li>
    );
  }

  return (
    <li id={anchorId} className="scroll-mt-24 py-5 target:bg-muted/50">
      <div className="mb-3 flex items-start justify-between gap-3">
        <Byline
          author={authors?.[post.authorId]}
          createdAt={post.createdAt}
          now={now}
          showAuthor={authors !== null}
          className="min-h-8 flex-1"
        >
          {post.revisedAt ? (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={post.revisedAt} title={fullDateTime(post.revisedAt)}>
                {m.thread_post_edited()}
              </time>
            </>
          ) : null}
        </Byline>
        <div className="flex shrink-0 items-center gap-1">
          <ThreadReactions counts={counts} returnTo={returnTo} signedIn={signedIn} target={target} value={value} />
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
          }}
        />
      ) : (
        <DocumentBody className="mx-0!" document={post.body} labels={{ revealSpoiler: m.thread_reveal_spoiler() }} />
      )}
    </li>
  );
}
