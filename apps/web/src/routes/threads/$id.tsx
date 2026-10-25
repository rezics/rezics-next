import { DocumentBody } from '@rezics/ui/document-body';
import { createFileRoute, Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { readThreadPage } from '../../threads/reads';

export const Route = createFileRoute('/threads/$id')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, deps }) => readThreadPage({ data: { id: params.id, cursor: deps.cursor } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.thread.title ?? m.threads_untitled() }] }),
  component: ThreadPage,
});

function ThreadPage() {
  const { thread, posts } = Route.useLoaderData();
  const id = Route.useParams().id;
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
              <li key={post.id} className="py-6">
                {post.availability === 'erased' ? (
                  <p className="text-muted-foreground" role="note">
                    {m.thread_post_erased()}
                  </p>
                ) : (
                  <DocumentBody document={post.body} />
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
    </article>
  );
}
