import { createFileRoute, Link, useLoaderData, useLocation } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { startThread } from '../../threads/actions';
import { csrfHeaders, draftFetch, PostComposer, SignInPrompt } from '../../threads/composer';
import { readNewThreadPage } from '../../threads/reads';

export const Route = createFileRoute('/boards/$id_/new')({
  loader: ({ params }) => readNewThreadPage({ data: { id: params.id } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.board.title ?? m.thread_new_heading() }] }),
  component: NewThreadPage,
});

function NewThreadPage() {
  const { board, idempotencyKey } = Route.useLoaderData();
  const { session } = useLoaderData({ from: '__root__' });
  const location = useLocation();

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">{board.title ?? m.threads_untitled()}</p>
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{m.thread_new_heading()}</h1>
      </header>
      {session === 'signed-in' ? (
        <PostComposer
          initialKey={idempotencyKey}
          titleRequired
          onSubmit={async ({ title, body, idempotencyKey: key }) => {
            const result = await startThread({
              data: { boardId: board.id, title, body, idempotencyKey: key },
              headers: csrfHeaders(),
              fetch: draftFetch(body),
            });
            return result.ok ? { ok: true as const, value: result.thread } : result;
          }}
          onSuccess={(thread) => {
            window.location.assign(`/${getLocale()}/threads/${thread.id}`);
          }}
        />
      ) : session === 'signed-out' ? (
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} />
      ) : null}
      <Link
        to="/boards/$id"
        params={{ id: board.id }}
        className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary underline-offset-4 hover:bg-muted hover:underline"
      >
        {m.board_threads_heading()}
      </Link>
    </article>
  );
}
