import { DocumentBody } from '@rezics/ui/document-body';
import { ContentActions } from '@rezics/ui/content-actions';
import { createFileRoute, Link, useLoaderData, useLocation } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';
import { getLocale } from '../../paraglide/runtime.js';
import { readThreadPage, type ThreadPost } from '../../threads/reads';
import {
  erasePost,
  replyToThread,
  revisePost,
  type RevisedPost,
  type WriteFailure,
  type CreatedPost,
} from '../../threads/actions';
import { csrfHeaders, draftFetch, InlinePostEditor, PostComposer, SignInPrompt } from '../../threads/composer';

export const Route = createFileRoute('/threads/$id')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, deps }) => readThreadPage({ data: { id: params.id, cursor: deps.cursor } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.thread.title ?? m.threads_untitled() }] }),
  component: ThreadPage,
});

function ThreadPage() {
  const { thread, posts: loadedPosts, idempotencyKey, viewerId, verification } = Route.useLoaderData();
  const [posts, setPosts] = useState(loadedPosts);
  const { session } = useLoaderData({ from: '__root__' });
  const location = useLocation();
  const id = Route.useParams().id;

  useEffect(() => setPosts(loadedPosts), [loadedPosts]);

  function updatePost(post: ThreadPost) {
    setPosts((current) => ({
      ...current,
      posts: current.posts.map((item) => (item.id === post.id ? post : item)),
    }));
  }

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{thread.title ?? m.threads_untitled()}</h1>
      </header>
      <section className="space-y-6" aria-labelledby="thread-posts-heading">
        <h2 id="thread-posts-heading" className="text-xl font-semibold">
          {m.thread_posts_heading()}
        </h2>
        {posts.posts.length ? (
          <ol className="divide-y divide-border/60 border-y border-border/60">
            {posts.posts.map((post) => {
              const firstPost = post.id === thread.firstPost.id;
              return (
                <PostSlot
                  key={post.id}
                  anchorId={firstPost ? `thread-${thread.id}` : `post-${post.id}`}
                  onChange={updatePost}
                  post={post}
                  target={firstPost ? { kind: 'thread', id: thread.id } : { kind: 'post', id: post.id }}
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
            <Link
              to="/threads/$id"
              params={{ id }}
              search={{ cursor: posts.next }}
              className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
            >
              {m.threads_next_page()}
            </Link>
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
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />
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
  viewerId,
  onChange,
  anchorId,
  target,
  verification,
}: {
  post: ThreadPost;
  viewerId: string | undefined;
  onChange: (post: ThreadPost) => void;
  anchorId: string;
  target: { kind: 'thread' | 'post'; id: string };
  verification: VerificationConfig;
}) {
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState('');
  const menuButton = useRef<HTMLButtonElement>(null);
  const deleteKey = useRef<string | undefined>(undefined);
  const restoreMenuFocus = useRef(false);
  const ownsPost = viewerId !== undefined && post.authorId === viewerId;

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
      data: { postId: post.id, idempotencyKey: deleteKey.current },
      headers: csrfHeaders(),
    });
    if (!result.ok) throw new Error(postDeleteFailureText(result));
    onChange({ ...post, body: null, availability: 'erased', removed: true } as ThreadPost);
  }

  if (('removed' in post && post.removed) || post.availability === 'erased') {
    return (
      <li id={anchorId} className="py-6">
        <p className="text-muted-foreground" role="note">
          {m.thread_post_erased()}
        </p>
      </li>
    );
  }

  return (
    <li id={anchorId} className="py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex min-h-8 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <time dateTime={post.createdAt} title={fullDateTime(post.createdAt)}>
            {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
              new Date(post.createdAt),
            )}
          </time>
          {post.revisedAt ? (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={post.revisedAt} title={fullDateTime(post.revisedAt)}>
                {m.thread_post_edited()}
              </time>
            </>
          ) : null}
        </div>
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
            ownsContent={false}
            verification={verification}
          />
        )}
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
        <DocumentBody document={post.body} labels={{ revealSpoiler: m.thread_reveal_spoiler() }} />
      )}
    </li>
  );
}
