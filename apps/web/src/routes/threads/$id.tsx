import { DocumentBody } from '@rezics/ui/document-body';
import { createFileRoute, Link, useLoaderData, useLocation } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { PostActions } from '../../report/content-actions';
import { readThreadPage } from '../../threads/reads';
import { replyToThread, type CreatedPost } from '../../threads/actions';
import { csrfHeaders, draftFetch, PostComposer, SignInPrompt } from '../../threads/composer';

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
            {posts.posts.map((post) => (
              <li
                key={post.id}
                id={post.id === thread.firstPost.id ? `thread-${thread.id}` : `post-${post.id}`}
                className="py-6"
              >
                <div className="mb-2 flex justify-end">
                  <PostActions
                    target={
                      post.id === thread.firstPost.id
                        ? { kind: 'thread', id: thread.id }
                        : { kind: 'post', id: post.id }
                    }
                    {...(post.revisionId ? { revisionId: post.revisionId } : {})}
                    ownsContent={Boolean(viewerId && viewerId === post.authorId)}
                    verification={verification}
                  />
                </div>
                {post.availability === 'erased' ? (
                  <p className="text-muted-foreground" role="note">
                    {m.thread_post_erased()}
                  </p>
                ) : (
                  <DocumentBody document={post.body} labels={{ revealSpoiler: m.thread_reveal_spoiler() }} />
                )}
              </li>
            ))}
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
