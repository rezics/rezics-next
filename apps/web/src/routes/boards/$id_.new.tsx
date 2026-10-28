import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { createFileRoute, Link, useLocation } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { startThread } from '../../threads/actions';
import { threadHref, threadTitle } from '../../threads/thread-href';
import { csrfHeaders, draftFetch, PostComposer, SignInPrompt } from '../../threads/composer';
import { readNewThreadPage } from '../../threads/reads';
import { PageHeading } from '../../shell/page-heading';

export const Route = createFileRoute('/boards/$id_/new')({
  loader: ({ params }) => readNewThreadPage({ data: { id: params.id } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.board.title ?? m.thread_new_heading() }] }),
  component: NewThreadPage,
});

function NewThreadPage() {
  const { board, idempotencyKey } = Route.useLoaderData();
  const { state: session } = useSession();
  const location = useLocation();

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">{board.title ?? m.threads_untitled()}</p>
        <PageHeading>{m.thread_new_heading()}</PageHeading>
      </header>
      {session === 'signed-in' ? (
        <PostComposer
          initialKey={idempotencyKey}
          titleRequired
          boardId={board.id}
          onSubmit={async ({ title, body, idempotencyKey: key, mediaIds }) => {
            const result = await startThread({
              data: {
                boardId: board.id,
                title,
                body,
                idempotencyKey: key,
                ...(mediaIds.length > 0 ? { mediaIds } : {}),
              },
              headers: csrfHeaders(),
              fetch: draftFetch(body),
            });
            if (result.ok)
              document.cookie = `rezics_draft_key=${result.thread.id}.${key}; Path=/; Max-Age=120; SameSite=Lax`;
            return result.ok ? { ok: true as const, value: result.thread } : result;
          }}
          onSuccess={(thread) => {
            window.location.assign(`/${getLocale()}${threadHref({ id: thread.id, title: threadTitle(thread) })}`);
          }}
        />
      ) : session !== 'unavailable' ? (
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} label={m.board_sign_in_to_start()} />
      ) : null}
      <Link to="/boards/$id" params={{ id: board.id }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
        {m.board_threads_heading()}
      </Link>
    </article>
  );
}
