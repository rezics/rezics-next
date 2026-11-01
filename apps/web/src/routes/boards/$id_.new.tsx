import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import type { QueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { startThread } from '../../threads/actions';
import { threadHref, threadTitle } from '../../threads/thread-href';
import { draftFetch, PostComposer } from '../../threads/composer';
import { ReviewFields } from '../../threads/review-fields';
import type { VoteCitation } from '../../threads/post-writes';
import { readNewThreadPage } from '../../threads/reads';
import { PageHeading } from '../../shell/page-heading';
import { canSubmitThread } from '../../threads/review-policy';
import { DiscussionSubjects } from '../../threads/discussion-subjects';
import { contentSubjectPreset } from '../../threads/content-subject-search';
import { AuthoringDepartureProvider } from '../../threads/authoring-departure';
import {
  observeThreadCreationReader,
  threadCreationReaderObservationMatches,
  ThreadCreationLifetimeProvider,
  useThreadCreationLifetime,
  type ThreadCreationReaderAdmission,
} from '../../threads/thread-creation-lifetime';

type NewThreadSearch = { subject?: string; subjectTitle?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const Route = createFileRoute('/boards/$id_/new')({
  beforeLoad: requireSignedIn,
  loader: ({ params, context }) =>
    loadAdmittedNewThreadPage(context.queryClient, params.id, (expectedReaderSubject) =>
      readNewThreadPage({ data: { id: params.id, expectedReaderSubject } }),
    ),
  validateSearch: (search: Record<string, unknown>): NewThreadSearch => {
    const subject = typeof search.subject === 'string' && uuid.test(search.subject) ? search.subject : undefined;
    const subjectTitle =
      subject && typeof search.subjectTitle === 'string' && search.subjectTitle.length <= 512
        ? search.subjectTitle
        : undefined;
    return { ...(subject ? { subject } : {}), ...(subjectTitle ? { subjectTitle } : {}) };
  },
  head: ({ loaderData, match }) =>
    pageHead(
      { title: loaderData?.board.title ?? m.thread_new_heading(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: NewThreadPage,
});

export async function loadAdmittedNewThreadPage(
  client: QueryClient,
  id: string,
  read: (expectedReaderSubject: string) => Promise<Awaited<ReturnType<typeof readNewThreadPage>>>,
): Promise<Awaited<ReturnType<typeof readNewThreadPage>> & { readerAdmission: ThreadCreationReaderAdmission }> {
  const observation = observeThreadCreationReader(client);
  if (!observation) throw notFound();
  const page = await read(observation.subject);
  if (
    page.board.id !== id ||
    page.readerSubject !== observation.subject ||
    !threadCreationReaderObservationMatches(client, observation, page.readerSubject)
  )
    throw notFound();
  return { ...page, readerAdmission: { observation, actualSubject: page.readerSubject } };
}

function NewThreadPage() {
  const { board, idempotencyKey, readerAdmission } = Route.useLoaderData();
  const { subject: presetSubject, subjectTitle: presetSubjectTitle } = Route.useSearch();
  return (
    <NewThreadComposition
      board={board}
      idempotencyKey={idempotencyKey}
      readerAdmission={readerAdmission}
      {...(presetSubject ? { presetSubject } : {})}
      {...(presetSubjectTitle ? { presetSubjectTitle } : {})}
    />
  );
}

export function NewThreadComposition({
  board,
  idempotencyKey,
  readerAdmission,
  presetSubject,
  presetSubjectTitle,
}: {
  board: Awaited<ReturnType<typeof readNewThreadPage>>['board'];
  idempotencyKey: string;
  readerAdmission: ThreadCreationReaderAdmission;
  presetSubject?: string;
  presetSubjectTitle?: string;
}) {
  const visit = useThreadCreationLifetime(
    {
      boardId: board.id,
      purpose: board.purpose,
      initialKey: idempotencyKey,
      ...(presetSubject ? { initialSubject: presetSubject } : {}),
      ...(presetSubjectTitle ? { initialSubjectTitle: presetSubjectTitle } : {}),
    },
    readerAdmission,
  );
  const { lifetime, ticket, current, bound } = visit;
  const [origin] = useState(() => ({
    board,
    boardId: board.id,
    purpose: board.purpose,
    idempotencyKey,
    presetSubject: presetSubject ?? null,
    presetSubjectTitle: presetSubjectTitle ?? null,
  }));
  const [initiallyAdmitted] = useState(() => bound);
  const review = origin.purpose === 'reviews';
  const [subjectId, setSubjectId] = useState<string | null>(origin.presetSubject);
  const [discussionSubjects, setDiscussionSubjects] = useState(() =>
    origin.presetSubject
      ? [contentSubjectPreset(origin.presetSubject, origin.presetSubjectTitle ?? m.thread_discussion_subject())]
      : [],
  );
  const [voteCitation, setVoteCitation] = useState<VoteCitation | undefined>();
  const lockedSubmissionContext = useRef({
    active: false,
    value: undefined as ThreadSubmissionContext | undefined,
  });
  const renderedSubmissionContext = useRef<ThreadSubmissionContext | undefined>(undefined);
  const editable = lifetime.isEditable(ticket);
  const searchScope = JSON.stringify([visit.scopeKey, lifetime.accountId, lifetime.csrfToken, visit.sessionRevision]);

  const handleIntentLockChange = useCallback(
    (locked: boolean) => {
      if (!lifetime.isCurrent(ticket)) return;
      lockedSubmissionContext.current = locked
        ? { active: true, value: cloneSubmissionContext(renderedSubmissionContext.current) }
        : { active: false, value: undefined };
      lifetime.setIntentLocked(ticket, locked);
    },
    [lifetime, ticket],
  );
  const handleSubjectChange = useCallback(
    (next: string | null) => {
      if (!lifetime.isEditable(ticket)) return;
      setSubjectId(next);
      setVoteCitation(undefined);
    },
    [lifetime, ticket],
  );
  const handleVoteCitationChange = useCallback(
    (next: VoteCitation | undefined) => {
      if (lifetime.isEditable(ticket)) setVoteCitation(next);
    },
    [lifetime, ticket],
  );
  const liveSubmissionContext: ThreadSubmissionContext | undefined = bound
    ? review
      ? { kind: 'review', subjectId: subjectId ?? '', ...(voteCitation ? { voteCitation } : {}) }
      : { subjectIds: discussionSubjects.map((subject) => subject.id) }
    : undefined;
  renderedSubmissionContext.current = liveSubmissionContext;
  const submissionContext = lockedSubmissionContext.current.active
    ? lockedSubmissionContext.current.value
    : liveSubmissionContext;

  useLayoutEffect(() => {
    const title = `${(bound ? origin.board.title : null) ?? m.thread_new_heading()} – REZICS`;
    document.title = title;
    document.head
      .querySelectorAll<HTMLMetaElement>('meta[property="og:title"], meta[name="twitter:title"]')
      .forEach((meta) => meta.setAttribute('content', title));
  }, [bound, origin.board.title]);

  if (!initiallyAdmitted) return <p role="status">{m.thread_authoring_session_changed()}</p>;

  return (
    <ThreadCreationLifetimeProvider lifetime={lifetime}>
      <AuthoringDepartureProvider>
        <article className="max-w-4xl space-y-8 text-foreground">
          <header className="space-y-3">
            {bound ? (
              <p className="text-sm font-medium text-muted-foreground">
                {origin.board.title ?? m.threads_untitled()}
              </p>
            ) : null}
            <PageHeading>{m.thread_new_heading()}</PageHeading>
          </header>
          <div className="space-y-5" inert={!editable}>
            {bound ? (
              review ? (
                <ReviewFields
                  key={searchScope}
                  {...(origin.presetSubject ? { initialSubjectId: origin.presetSubject } : {})}
                  {...(origin.presetSubjectTitle ? { initialSubjectTitle: origin.presetSubjectTitle } : {})}
                  onSubjectChange={handleSubjectChange}
                  onVoteCitationChange={handleVoteCitationChange}
                  disabled={!editable}
                  searchScope={searchScope}
                />
              ) : (
                <DiscussionSubjects
                  key={searchScope}
                  value={discussionSubjects}
                  onValueChange={(items) => {
                    if (lifetime.isEditable(ticket)) setDiscussionSubjects(items);
                  }}
                  disabled={!editable}
                  searchScope={searchScope}
                />
              )
            ) : (
              <p role="status">{m.thread_authoring_session_changed()}</p>
            )}
            <PostComposer
              initialKey={origin.idempotencyKey}
              titleRequired
              canSubmit={current && canSubmitThread(origin.purpose, subjectId)}
              boardId={origin.boardId}
              submissionContext={submissionContext}
              onIntentLockChange={handleIntentLockChange}
              onSubmit={async ({ title, body, idempotencyKey: key, mediaIds, submissionContext: originalContext }) => {
                if (!lifetime.isCurrent(ticket)) return { ok: false as const, reason: 'unavailable' as const };
                const result = await startThread({
                  data: {
                    boardId: origin.boardId,
                    title,
                    body,
                    idempotencyKey: key,
                    ...originalContext!,
                    ...(mediaIds.length > 0 ? { mediaIds } : {}),
                  },
                  headers: { 'X-CSRF-Token': lifetime.csrfToken },
                  fetch: draftFetch(body),
                });
                if (!lifetime.isCurrent(ticket)) return { ok: false as const, reason: 'unavailable' as const };
                if (result.ok)
                  document.cookie = `rezics_draft_key=${result.thread.id}.${key}; Path=/; Max-Age=120; SameSite=Lax`;
                return result.ok ? { ok: true as const, value: result.thread } : result;
              }}
              onSuccess={(thread) => {
                if (!lifetime.isCurrent(ticket)) return;
                window.location.assign(`/${getLocale()}${threadHref({ id: thread.id, title: threadTitle(thread) })}`);
              }}
            />
          </div>
          {bound ? (
            <Link
              to="/boards/$id"
              params={{ id: origin.boardId }}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.board_threads_heading()}
            </Link>
          ) : null}
        </article>
      </AuthoringDepartureProvider>
    </ThreadCreationLifetimeProvider>
  );
}

type ThreadSubmissionContext =
  | { kind: 'review'; subjectId: string; voteCitation?: VoteCitation }
  | { subjectIds: string[] };

function cloneSubmissionContext(context: ThreadSubmissionContext | undefined): ThreadSubmissionContext | undefined {
  if (!context) return undefined;
  if ('subjectIds' in context) return { subjectIds: [...context.subjectIds] };
  return {
    kind: 'review',
    subjectId: context.subjectId,
    ...(context.voteCitation ? { voteCitation: { ...context.voteCitation } } : {}),
  };
}
