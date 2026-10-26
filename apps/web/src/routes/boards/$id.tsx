import { createFileRoute, Link, useLoaderData, useLocation } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { readBoardPage } from '../../threads/reads';
import { SignInPrompt } from '../../threads/composer';
import { ClosedErrorPage } from '../../shell/closed';
import { PageHeading } from '../../shell/page-heading';

export const Route = createFileRoute('/boards/$id')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, deps }) => readBoardPage({ data: { id: params.id, cursor: deps.cursor } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.board.title ?? m.threads_untitled() }] }),
  errorComponent: ClosedErrorPage,
  component: BoardPage,
});

function BoardPage() {
  const { board, threads } = Route.useLoaderData();
  const { session } = useLoaderData({ from: '__root__' });
  const location = useLocation();
  const id = Route.useParams().id;
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <PageHeading>{board.title ?? m.threads_untitled()}</PageHeading>
        {session === 'signed-in' ? (
          <a
            href={`/${getLocale()}/boards/${id}/new`}
            className="inline-flex min-h-10 items-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:opacity-90"
          >
            {m.board_start_thread()}
          </a>
        ) : session === 'signed-out' ? (
          <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />
        ) : null}
      </header>
      <section className="space-y-4" aria-labelledby="board-threads-heading">
        <h2 id="board-threads-heading" className="text-xl font-semibold">
          {m.board_threads_heading()}
        </h2>
        {threads.threads.length ? (
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {threads.threads.map((thread) => (
              <li key={thread.id} className="py-4">
                <Link
                  to="/threads/$id"
                  params={{ id: thread.id }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {thread.title ?? m.threads_untitled()}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.board_threads_empty()}</p>
        )}
        {threads.next && (
          <nav aria-label={m.board_threads_heading()}>
            <Link
              to="/boards/$id"
              params={{ id }}
              search={{ cursor: threads.next }}
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
