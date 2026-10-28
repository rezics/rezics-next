import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { createFileRoute, Link, useLocation } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { startThread } from '../../threads/actions';
import { threadHref, threadTitle } from '../../threads/thread-href';
import { csrfHeaders, draftFetch, PostComposer, SignInPrompt } from '../../threads/composer';
import { ReviewFields } from '../../threads/review-fields';
import type { VoteCitation } from '../../threads/post-writes';
import { readNewThreadPage } from '../../threads/reads';
import { PageHeading } from '../../shell/page-heading';

type NewThreadSearch = { subject?: string; subjectTitle?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const Route = createFileRoute('/boards/$id_/new')({
  loader: ({ params }) => readNewThreadPage({ data: { id: params.id } }),
  validateSearch: (search: Record<string, unknown>): NewThreadSearch => {
    const subject = typeof search.subject === 'string' && uuid.test(search.subject) ? search.subject : undefined;
    const subjectTitle =
      subject && typeof search.subjectTitle === 'string' && search.subjectTitle.length <= 512
        ? search.subjectTitle
        : undefined;
    return { ...(subject ? { subject } : {}), ...(subjectTitle ? { subjectTitle } : {}) };
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.board.title ?? m.thread_new_heading() }] }),
  component: NewThreadPage,
});

function NewThreadPage() {
  const { board, idempotencyKey } = Route.useLoaderData();
  const { subject: presetSubject, subjectTitle: presetSubjectTitle } = Route.useSearch();
  const { state: session } = useSession();
  const location = useLocation();
  const review = board.purpose === 'reviews';
  const [subjectId, setSubjectId] = useState<string | null>(presetSubject ?? null);
  const [voteCitation, setVoteCitation] = useState<VoteCitation | undefined>();
  const handleSubjectChange = useCallback((next: string | null) => {
    setSubjectId(next);
    setVoteCitation(undefined);
  }, []);

  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">{board.title ?? m.threads_untitled()}</p>
        <PageHeading>{m.thread_new_heading()}</PageHeading>
      </header>
      {session === 'signed-in' ? (
        <div className="space-y-5">
          {review ? (
            <ReviewFields
              key={presetSubject ?? 'review-subject'}
              {...(presetSubject ? { initialSubjectId: presetSubject } : {})}
              {...(presetSubjectTitle ? { initialSubjectTitle: presetSubjectTitle } : {})}
              onSubjectChange={handleSubjectChange}
              onVoteCitationChange={setVoteCitation}
            />
          ) : null}
          <PostComposer
            initialKey={idempotencyKey}
            titleRequired
            canSubmit={!review || Boolean(subjectId)}
            boardId={board.id}
            onSubmit={async ({ title, body, idempotencyKey: key, mediaIds }) => {
              const result = await startThread({
                data: {
                  boardId: board.id,
                  title,
                  body,
                  idempotencyKey: key,
                  ...(review
                    ? {
                        kind: 'review' as const,
                        subjectId: subjectId!,
                        ...(voteCitation ? { voteCitation } : {}),
                      }
                    : {}),
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
        </div>
      ) : session === 'signed-out' ? (
        <SignInPrompt returnTo={location.publicHref.split(/[?#]/, 1)[0]!} label={m.board_sign_in_to_start()} />
      ) : null}
      <Link to="/boards/$id" params={{ id: board.id }} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
        {m.board_threads_heading()}
      </Link>
    </article>
  );
}
