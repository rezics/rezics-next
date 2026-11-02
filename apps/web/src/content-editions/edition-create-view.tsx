import {
  EditionIdentitySummary,
  EditionTechnicalDetails,
  editionSubjectName,
  editionRevisionDate,
} from './edition-identity';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { DocumentBody } from '../document-body';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { useSession } from '../session/query';
import { exactRevisionHref } from '../threads/exact-revision-href';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import {
  commandEditionPublication,
  readEditionCreateSource,
  readEditionResume,
  reviewEditionPublication,
} from './edition-create-actions';
import {
  EditionPublicationController,
  editionMatchesSource,
  editionSourceFromLink,
  type EditionCreateApi,
  type EditionSourceIdentity,
  type EditionResumeRead,
  type EditionPreviewImage,
} from './edition-create';

type NativeDocumentImageProps = { image: EditionPreviewImage | null; alt: string; locale: string };
// The sole document-media component owns derivative selection, credit and the authorized Worker URL.
const NativeDocumentImage =
  (() => {
    try {
      return import.meta.glob<ComponentType<NativeDocumentImageProps>>('../threads/document-media.ts', {
        eager: true,
        import: 'NativeDocumentImage',
      })['../threads/document-media.ts'];
    } catch {
      return undefined;
    }
  })() ??
  function UnavailableImage({ alt, locale }: NativeDocumentImageProps) {
    const label = m.content_edition_image_unavailable({}, { locale: locale as never });
    return (
      <span
        className="block rounded-xl bg-muted p-5 text-sm text-muted-foreground"
        role="img"
        aria-label={alt || label}
      >
        {label}
        {alt ? ` — ${alt}` : ''}
      </span>
    );
  };

/** Route composition keeps token refresh independent of the mounted publication intent. */
export function EditionPublicationPanel({
  initialSource,
  initialEditionId,
  initialResume,
  api: override,
  controller: suppliedController,
}: {
  initialSource?: EditionSourceIdentity | undefined;
  initialEditionId?: string | undefined;
  initialResume?: EditionResumeRead | undefined;
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
        resume: (editionId) => readEditionResume({ data: { editionId } }),
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
  // Loader metadata belongs to the initial session; a replacement session must read it again.
  const initialController = useRef(controller);
  if (!override && session.state !== 'signed-in')
    return (
      <article className="mx-auto w-full max-w-3xl space-y-4">
        <PageHeading>{m.edition_publication_heading()}</PageHeading>
        <p role="status">{m.edition_publication_sign_in()}</p>
        {session.state === 'signed-out' ? (
          <a
            className="inline-flex min-h-11 items-center underline"
            href={`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/editions/new${initialEditionId !== undefined ? `?${new URLSearchParams({ editionId: initialEditionId })}` : initialSource ? `?${new URLSearchParams(initialSource)}` : ''}`)}`}
          >
            {m.content_edition_sign_in()}
          </a>
        ) : null}
      </article>
    );
  return (
    <EditionPublication
      controller={controller}
      initialSource={initialSource}
      initialEditionId={initialEditionId}
      initialResume={controller === initialController.current ? initialResume : undefined}
    />
  );
}

/** A fixed-edition creator has no shadcn equivalent. Shared document rendering owns canonical bytes. */
export function EditionPublication({
  controller,
  initialSource,
  initialEditionId,
  initialResume,
}: {
  controller: EditionPublicationController;
  initialSource?: EditionSourceIdentity | undefined;
  initialEditionId?: string | undefined;
  initialResume?: EditionResumeRead | undefined;
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
  const unresolvedCommand = !!state.intent && (state.busy || state.uncertain);
  const localSelection = state.resumeEditionId === null && !state.edition && (!!sourceLink.trim() || !!state.identity);
  const needsDeparture = localSelection || (confirmed && state.edition?.state === 'draft') || unresolvedCommand;
  useAuthoringDeparture(
    needsDeparture,
    unresolvedCommand,
    JSON.stringify([
      sourceLink,
      state.identity,
      state.targetSubjectId,
      state.edition?.editionId,
      state.edition?.editionRevision,
      state.intent,
      confirmed,
    ]),
    undefined,
    controller.retire,
  );
  useEffect(() => {
    if (initialEditionId !== undefined) {
      void controller.resume(initialEditionId, initialResume);
      return;
    }
    if (!controller.snapshot().identity && initialPostId && initialRevisionId)
      void controller.select({ postId: initialPostId, revisionId: initialRevisionId });
  }, [controller, initialPostId, initialRevisionId, initialEditionId, initialResume]);
  useEffect(() => {
    if (state.intent && (state.busy || state.uncertain)) return;
    setConfirmed(false);
  }, [state.review, state.failure, state.busy, state.edition?.editionRevision, state.targetSubjectId]);
  const { source, failure } = state;
  const concealed =
    state.busy ||
    failure?.concealSource ||
    failure?.kind === 'refused' ||
    failure?.kind === 'unavailable' ||
    failure?.kind === 'missing' ||
    (state.uncertain && !!failure?.receipt);
  const edition = concealed ? null : (state.review?.edition ?? state.edition);
  const previewSource = concealed ? null : source;
  const target = edition
    ? edition.identity?.subject
    : previewSource?.recognition?.subjects.find((subject) => subject.id === state.targetSubjectId);
  const recognized = target?.kind === 'available';
  // Media is part of the exact delivered source, never a separately retained image query.
  const images = useMemo(
    () =>
      new Map(
        previewSource?.media.kind === 'ready' ? previewSource.media.images.map((image) => [image.id, image]) : [],
      ),
    [previewSource],
  );
  const published =
    edition?.state === 'published' &&
    (state.resumeEditionId !== null || source !== null) &&
    !state.busy &&
    !state.uncertain &&
    !failure &&
    (source
      ? editionMatchesSource(edition, source, state.targetSubjectId)
      : edition.editionId === state.resumeEditionId);
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
      {!edition && !state.intent && state.resumeEditionId === null && initialEditionId === undefined ? (
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
            {failure.receipt
              ? m.edition_identity_recorded()
              : failure.kind === 'uncertain'
                ? m.edition_publication_uncertain()
                : failure.kind === 'conflict'
                  ? m.edition_publication_conflict()
                  : failure.kind === 'refused'
                    ? m.edition_publication_refused()
                    : failure.kind === 'missing'
                      ? m.edition_publication_missing()
                      : m.edition_publication_unavailable()}
          </p>
          <div className="flex flex-wrap gap-3">
            {state.uncertain &&
            state.intent &&
            failure.kind === 'uncertain' &&
            !failure.concealSource &&
            !failure.receipt &&
            (source || state.resumeEditionId !== null) ? (
              <Button disabled={state.busy} onClick={() => void controller.retry()}>
                {m.edition_publication_retry()}
              </Button>
            ) : null}
            {(state.identity || state.resumeEditionId !== null) && failure.status !== 400 ? (
              <Button variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>
                {m.edition_publication_refresh()}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
      {edition && state.resumeEditionId !== null && edition.state !== 'draft' ? (
        <section className="space-y-4 border-b border-border pb-5" aria-label={m.edition_publication_resume_heading()}>
          <h2 className="text-lg font-semibold">{m.edition_publication_resume_heading()}</h2>
          <p className="max-w-prose text-sm text-muted-foreground">{m.edition_publication_resume_help()}</p>
          <EditionIdentitySummary edition={edition} />
          <EditionTechnicalDetails edition={edition} />
          <p className="text-sm">
            {m.edition_publication_licence()}: {edition.licence}
          </p>
          <Button variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>
            {m.edition_publication_refresh()}
          </Button>
        </section>
      ) : null}
      {edition?.state === 'withdrawn' ? (
        <section className="space-y-3 rounded-xl border border-border p-4 sm:p-5">
          <h2 className="text-lg font-semibold">{m.edition_publication_withdrawn_heading()}</h2>
          <p role="status" className="text-sm">
            {m.edition_publication_withdrawn_help()}
          </p>
          <EditionIdentitySummary edition={edition} />
          <EditionTechnicalDetails edition={edition} />
        </section>
      ) : null}
      {previewSource ? (
        <section className="min-w-0 space-y-5" aria-label={m.edition_publication_preview()}>
          <div className="space-y-3 border-b border-border pb-5">
            <h2 className="text-lg font-semibold">{m.edition_publication_preview()}</h2>
            <a
              className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
              href={exactRevisionHref(previewSource, locale)}
            >
              {m.edition_publication_open_revision()}
            </a>
            <p className="text-sm">
              {m.edition_publication_licence()}: {previewSource.licence}
            </p>
            <details className="text-xs">
              <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground">
                {m.edition_identity_details()}
              </summary>
              <dl className="space-y-3">
                <div>
                  <dt>{m.exact_revision_post()}</dt>
                  <dd className="select-all font-mono">{previewSource.postId}</dd>
                </div>
                <div>
                  <dt>{m.exact_revision_id()}</dt>
                  <dd className="select-all font-mono">{previewSource.revisionId}</dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd className="select-all font-mono">{previewSource.sha256}</dd>
                </div>
                {state.targetSubjectId && (
                  <div>
                    <dt>{m.edition_publication_subject()}</dt>
                    <dd className="select-all font-mono">{state.targetSubjectId}</dd>
                  </div>
                )}
              </dl>
            </details>
          </div>
          <DocumentBody
            document={previewSource.body}
            locale={locale}
            renderImage={({ mediaId, alt }) => (
              <NativeDocumentImage image={images.get(mediaId) ?? null} alt={alt} locale={locale} />
            )}
          />
          <div className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <Field>
              <FieldLabel htmlFor={subjectId}>{m.edition_publication_subject()}</FieldLabel>
              <p className="text-sm text-muted-foreground">{m.edition_publication_subject_help()}</p>
              <NativeSelect
                id={subjectId}
                className="w-full [&_select]:min-h-11"
                value={state.targetSubjectId}
                disabled={state.busy || !!state.intent || !!edition}
                onChange={(event) => controller.chooseSubject(event.target.value)}
              >
                <NativeSelectOption value="">{m.edition_publication_choose_subject()}</NativeSelectOption>
                {previewSource.subjectIds.map((id, index) => {
                  const subject = previewSource.recognition?.subjects.find((subject) => subject.id === id);
                  return (
                    <NativeSelectOption
                      key={id}
                      value={id}
                      disabled={subject?.kind !== 'available'}
                      lang={subject?.label?.language}
                    >
                      {editionSubjectName(subject)}
                      {subject?.kind !== 'available' ? ` (${index + 1})` : ''}
                    </NativeSelectOption>
                  );
                })}
              </NativeSelect>
            </Field>
            <p className="text-sm text-muted-foreground">
              {m.edition_identity_revision_date({
                date: editionRevisionDate(previewSource.recognition?.revisionCreatedAt),
              })}
            </p>
            {previewSource.recognition?.subjects.some((subject) => subject.kind !== 'available') ||
            !previewSource.recognition ? (
              <p role="status" className="text-sm text-muted-foreground">
                {m.edition_identity_recovery()}
              </p>
            ) : null}
            <Button variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>
              {m.edition_publication_refresh()}
            </Button>
          </div>
        </section>
      ) : null}
      {state.review && !state.uncertain && (source || edition) ? (
        <section
          className="space-y-4 rounded-xl border border-border p-4 sm:p-5"
          aria-label={m.edition_publication_review_heading()}
        >
          <h2 className="text-lg font-semibold">{m.edition_publication_review_heading()}</h2>
          <p className="text-sm">{m.edition_publication_review_help()}</p>
          {state.review.edition ? (
            <p className="text-sm">
              {m.edition_publication_edition_version({ revision: state.review.edition.editionRevision })} ·{' '}
              {state.review.edition.state === 'draft'
                ? m.creator_editions_draft()
                : state.review.edition.state === 'published'
                  ? m.creator_editions_published()
                  : m.creator_editions_withdrawn()}
            </p>
          ) : null}
          {state.review.edition && <EditionIdentitySummary edition={state.review.edition} />}
          <Button disabled={state.busy} onClick={() => controller.acceptReview()}>
            {m.edition_publication_accept_review()}
          </Button>
        </section>
      ) : null}
      {source && !failure && !edition && state.resumeEditionId === null ? (
        <Button disabled={state.busy || !state.targetSubjectId || !recognized} onClick={() => void controller.create()}>
          {m.edition_publication_create()}
        </Button>
      ) : null}
      {edition?.state === 'draft' ? (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
          aria-label={m.edition_publication_draft_heading()}
        >
          <h2 className="text-lg font-semibold">{m.edition_publication_draft_heading()}</h2>
          <p className="text-sm">{m.edition_publication_draft_help()}</p>
          <EditionIdentitySummary edition={edition} />
          <EditionTechnicalDetails edition={edition} />
          {state.resumeEditionId !== null && (
            <Button variant="outline" disabled={state.busy} onClick={() => void controller.refresh()}>
              {m.edition_publication_refresh()}
            </Button>
          )}
          <p className="text-sm">{m.edition_publication_edition_version({ revision: edition.editionRevision })}</p>
          <label htmlFor={confirmId} className="flex min-h-11 items-start gap-3 text-sm">
            <input
              id={confirmId}
              type="checkbox"
              className="mt-1 size-4 shrink-0"
              checked={confirmed}
              disabled={state.busy || !!failure || !recognized}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {recognized
                ? m.edition_publication_confirm({
                    revision: editionRevisionDate(edition.identity?.revisionCreatedAt),
                    licence: edition.licence,
                    subject: editionSubjectName(target),
                  })
                : m.edition_identity_recovery()}
            </span>
          </label>
          <Button
            disabled={!confirmed || state.busy || !!failure || !recognized}
            onClick={() => void controller.publish()}
          >
            {m.edition_publication_publish()}
          </Button>
        </section>
      ) : null}
      {published ? (
        <section
          className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
          aria-label={m.edition_publication_published_heading()}
          role="status"
        >
          <h2 className="text-lg font-semibold">{m.edition_publication_published_heading()}</h2>
          <p className="text-sm">{m.edition_publication_published_help()}</p>
          <EditionIdentitySummary edition={edition} />
          <EditionTechnicalDetails edition={edition} />
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
