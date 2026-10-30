import { DocumentBody } from '@rezics/ui/document-body';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { useSession } from '../session/query';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { commandEditionPublication, readEditionCreateSource, reviewEditionPublication } from './edition-create-actions';
import {
  EditionPublicationController,
  editionSourceFromLink,
  type EditionCreateApi,
  type EditionSourceIdentity,
} from './edition-create';

/** Route composition keeps token refresh independent of the mounted publication intent. */
export function EditionPublicationPanel({
  initialSource,
  api: override,
  controller: suppliedController,
}: {
  initialSource?: EditionSourceIdentity | undefined;
  api?: EditionCreateApi | undefined;
  controller?: EditionPublicationController | undefined;
}) {
  const session = useSession();
  const csrf = useRef(session.csrfToken);
  csrf.current = session.csrfToken;
  const api = useMemo<EditionCreateApi>(
    () =>
      override ?? {
        source: (data) => readEditionCreateSource({ data }),
        command: (data) =>
          csrf.current
            ? commandEditionPublication({ data, headers: { 'X-CSRF-Token': csrf.current } })
            : Promise.resolve({ kind: 'refused', status: 401 }),
        review: (source, editionId) => reviewEditionPublication({ data: { source, editionId } }),
      },
    [override],
  );
  const controller = useMemo(
    () => suppliedController ?? new EditionPublicationController(api),
    [api, suppliedController, session.subject],
  );
  if (!override && session.state !== 'signed-in')
    return (
      <article className="mx-auto w-full max-w-3xl space-y-4">
        <PageHeading>{m.edition_publication_heading()}</PageHeading>
        <p role="status">{m.edition_publication_sign_in()}</p>
        {session.state === 'signed-out' ? (
          <a
            className="inline-flex min-h-11 items-center underline"
            href={`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/editions/new${initialSource ? `?${new URLSearchParams(initialSource)}` : ''}`)}`}
          >
            {m.content_edition_sign_in()}
          </a>
        ) : null}
      </article>
    );
  return <EditionPublication controller={controller} initialSource={initialSource} />;
}

/** A fixed-edition creator has no shadcn equivalent. Shared document rendering owns canonical bytes. */
export function EditionPublication({
  controller,
  initialSource,
}: {
  controller: EditionPublicationController;
  initialSource?: EditionSourceIdentity | undefined;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [sourceLink, setSourceLink] = useState('');
  const [invalidLink, setInvalidLink] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const sourceId = useId();
  const subjectId = useId();
  const confirmId = useId();
  const locale = getLocale();
  const initialPostId = initialSource?.postId;
  const initialRevisionId = initialSource?.revisionId;
  useEffect(() => {
    if (!controller.snapshot().identity && initialPostId && initialRevisionId)
      void controller.select({ postId: initialPostId, revisionId: initialRevisionId });
  }, [controller, initialPostId, initialRevisionId]);
  useEffect(() => {
    setConfirmed(false);
  }, [state.review, state.edition?.editionRevision, state.targetSubjectId]);
  const { source, edition, failure } = state;
  const published = edition?.state === 'published' && !failure && source;
  return (
    <article
      className="mx-auto w-full max-w-3xl space-y-8 text-foreground [overflow-wrap:anywhere]"
      aria-busy={state.busy}
    >
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">{m.edition_publication_eyebrow()}</p>
        <PageHeading>{m.edition_publication_heading()}</PageHeading>
        <p className="max-w-prose text-sm text-muted-foreground">{m.edition_publication_intro()}</p>
      </header>
      {!edition && !state.intent ? (
        <section className="space-y-4" aria-label={m.edition_publication_source_heading()}>
          <h2 className="text-lg font-semibold">{m.edition_publication_source_heading()}</h2>
          <p className="text-sm text-muted-foreground">{m.edition_publication_selection_help()}</p>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const identity = editionSourceFromLink(sourceLink, window.location.origin);
              setInvalidLink(!identity);
              if (identity) void controller.select(identity);
            }}
          >
            <label className="block text-sm font-medium" htmlFor={sourceId}>
              {m.edition_publication_source_link()}
            </label>
            <Input
              id={sourceId}
              value={sourceLink}
              onChange={(event) => setSourceLink(event.target.value)}
              disabled={state.busy}
              aria-invalid={invalidLink}
              placeholder={`/${locale}/posts/…/revisions/…`}
            />
            {invalidLink ? (
              <p role="alert" className="text-sm">
                {m.edition_publication_invalid_link()}
              </p>
            ) : null}
            <Button type="submit" variant="outline" disabled={state.busy || !sourceLink.trim()}>
              {m.edition_publication_load()}
            </Button>
          </form>
        </section>
      ) : null}
      {state.busy ? <p role="status">{m.edition_publication_loading()}</p> : null}
      {failure ? (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
          aria-label={m.edition_publication_status_heading()}
        >
          <p role="alert">
            {failure.kind === 'uncertain'
              ? m.edition_publication_uncertain()
              : failure.kind === 'conflict'
                ? m.edition_publication_conflict()
                : failure.kind === 'refused'
                  ? m.edition_publication_refused()
                  : m.edition_publication_unavailable()}
          </p>
          <div className="flex flex-wrap gap-3">
            {state.uncertain && state.intent && source ? (
              <Button disabled={state.busy} onClick={() => void controller.retry()}>
                {m.edition_publication_retry()}
              </Button>
            ) : null}
            {state.identity ? (
              <Button variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>
                {m.edition_publication_refresh()}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {source ? (
        <section className="min-w-0 space-y-5" aria-label={m.edition_publication_preview()}>
          <div className="space-y-3 border-b border-border pb-5">
            <h2 className="text-lg font-semibold">{m.edition_publication_preview()}</h2>
            <a
              className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
              href={exactRevisionHref(source, locale)}
            >
              {m.edition_publication_open_revision()}
            </a>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-medium">{m.exact_revision_post()}</dt>
                <dd>{source.postId}</dd>
              </div>
              <div>
                <dt className="font-medium">{m.exact_revision_id()}</dt>
                <dd>{source.revisionId}</dd>
              </div>
              <div>
                <dt className="font-medium">{m.edition_publication_licence()}</dt>
                <dd>{source.licence}</dd>
              </div>
              <div>
                <dt className="font-medium">SHA-256</dt>
                <dd className="font-mono text-xs">{source.sha256}</dd>
              </div>
            </dl>
          </div>
          <DocumentBody
            document={source.body}
            locale={locale}
            renderImage={() => <p className="text-sm text-muted-foreground">{m.content_edition_image_unavailable()}</p>}
          />
          <div className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <label className="block text-sm font-medium" htmlFor={subjectId}>
              {m.edition_publication_subject()}
            </label>
            <p className="text-sm text-muted-foreground">{m.edition_publication_subject_help()}</p>
            <select
              id={subjectId}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={state.targetSubjectId}
              disabled={state.busy || !!state.intent || !!edition}
              onChange={(event) => controller.chooseSubject(event.target.value)}
            >
              <option value="">{m.edition_publication_choose_subject()}</option>
              {source.subjectIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        </section>
      ) : null}
      {state.review && (!state.uncertain || state.review.edition?.editionId === state.knownEditionId) && source ? (
        <section
          className="space-y-4 rounded-xl border border-border p-4 sm:p-5"
          aria-label={m.edition_publication_review_heading()}
        >
          <h2 className="text-lg font-semibold">{m.edition_publication_review_heading()}</h2>
          <p className="text-sm">{m.edition_publication_review_help()}</p>
          {state.review.edition ? (
            <p className="text-sm">
              {m.edition_publication_edition_version({ revision: state.review.edition.editionRevision })} ·{' '}
              {state.review.edition.state}
            </p>
          ) : null}
          <Button disabled={state.busy} onClick={() => controller.acceptReview()}>
            {m.edition_publication_accept_review()}
          </Button>
        </section>
      ) : null}
      {source && !failure && !edition ? (
        <Button disabled={state.busy || !state.targetSubjectId} onClick={() => void controller.create()}>
          {m.edition_publication_create()}
        </Button>
      ) : null}
      {source && edition?.state === 'draft' ? (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
          aria-label={m.edition_publication_draft_heading()}
        >
          <h2 className="text-lg font-semibold">{m.edition_publication_draft_heading()}</h2>
          <p className="text-sm">{m.edition_publication_draft_help()}</p>
          <p className="font-mono text-xs">{edition.editionId}</p>
          <p className="text-sm">{m.edition_publication_edition_version({ revision: edition.editionRevision })}</p>
          <label htmlFor={confirmId} className="flex min-h-11 items-start gap-3 text-sm">
            <input
              id={confirmId}
              type="checkbox"
              className="mt-1 size-4 shrink-0"
              checked={confirmed}
              disabled={state.busy || !!failure}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {m.edition_publication_confirm({
                revision: source.revisionId,
                licence: source.licence,
                subject: state.targetSubjectId,
              })}
            </span>
          </label>
          <Button disabled={!confirmed || state.busy || !!failure} onClick={() => void controller.publish()}>
            {m.edition_publication_publish()}
          </Button>
        </section>
      ) : null}
      {published ? (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
          aria-label={m.edition_publication_published_heading()}
        >
          <h2 className="text-lg font-semibold" role="status">
            {m.edition_publication_published_heading()}
          </h2>
          <p className="text-sm">{m.edition_publication_published_help()}</p>
          <p className="font-mono text-sm">{edition.editionId}</p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              className={buttonVariants({ className: 'min-h-11' })}
              href={localizeHref(`/creator/offers/new?editionId=${encodeURIComponent(edition.editionId)}`)}
            >
              {m.edition_publication_create_offer()}
            </a>
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-4"
              href={`/${locale}/editions/${encodeURIComponent(edition.editionId)}`}
            >
              {m.edition_publication_open()}
            </a>
          </div>
        </section>
      ) : null}
    </article>
  );
}
