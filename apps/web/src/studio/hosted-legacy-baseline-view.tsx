import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { localizeHref, type Locale } from '../paraglide/runtime.js';
import { baselineNextBody } from './hosted-legacy-baseline-contract';
import { baselineCopy } from './hosted-legacy-baseline-copy';
import type { BaselineReview, HostedLegacyBaselineVisit } from './hosted-legacy-baseline';
import './studio.css';

const control = 'min-h-11 h-auto max-w-full whitespace-normal break-words px-4 py-3 text-start';
const link =
  'inline-flex min-h-11 max-w-full items-center rounded-md px-3 py-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Version({ version, locale }: { version: BaselineReview; locale: Locale }) {
  const copy = baselineCopy[locale];
  return (
    <dl className="grid min-w-0 gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
      <dt>{copy.catalogue}</dt>
      <dd className="break-all">{version.catalogueId}</dd>
      <dt>{copy.revision}</dt>
      <dd className="break-all">{version.expectedRevisionId}</dd>
      <dt>{copy.publication}</dt>
      <dd className="break-all">{version.expectedPublicationId}</dd>
    </dl>
  );
}

export function HostedLegacyBaselineView({ visit, locale }: { visit: HostedLegacyBaselineVisit; locale: Locale }) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const feedback = useRef<HTMLHeadingElement>(null);
  const copy = baselineCopy[locale];
  const phase = state.kind === 'active' ? state.phase : 'ended';
  useEffect(() => {
    if (visit.isCurrent() && phase !== 'preparing') feedback.current?.focus();
  }, [visit, phase]);
  if (state.kind === 'ended') return <p role="alert">{copy.ended}</p>;
  const { original, candidate, progress } = state;
  const next = original ? baselineNextBody(original, progress) : null;
  const review =
    state.phase === 'review' && candidate?.item.publicationId
      ? {
          catalogueId: candidate.item.catalogueId,
          title: candidate.item.title ?? '',
          expectedRevisionId: candidate.item.headRevisionId,
          expectedPublicationId: candidate.item.publicationId,
        }
      : null;
  const message = {
    review: copy.review,
    preparing: copy.preparing,
    'step-ready': copy.ready,
    unknown: copy.unknown,
    stale: copy.stale,
    unavailable: candidate?.item.publicationId === null ? copy.noPublication : copy.unavailable,
    done: copy.done,
  }[state.phase];
  const book = original?.catalogueId ?? candidate?.item.catalogueId;
  const pointHref = book ? `/studio?catalogueId=${book}&points=1` : null;
  return (
    <main className="studio-workspace mx-auto w-full max-w-4xl space-y-8 px-4 py-8 selection:bg-primary selection:text-primary-foreground">
      <header className="studio-header">
        <h1>{copy.heading}</h1>
        <a className={link} href={localizeHref('/studio?books=1', { locale })}>
          {m.studio_root_append_return({}, { locale })}
        </a>
        <p className="studio-help max-w-prose text-pretty">{copy.private}</p>
      </header>
      {original?.title || candidate?.item.title ? (
        <p className="text-xl font-semibold">{original?.title ?? candidate?.item.title}</p>
      ) : null}
      {original ? (
        <section className="space-y-3">
          <h2>{copy.original}</h2>
          <Version version={original} locale={locale} />
        </section>
      ) : null}
      <section className="space-y-4" aria-busy={state.phase === 'preparing' || state.refreshing}>
        <h2
          ref={feedback}
          tabIndex={-1}
          className="max-w-prose rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {state.phase === 'unknown' || state.phase === 'stale' || state.phase === 'unavailable'
            ? copy.heading
            : message}
        </h2>
        {['unknown', 'stale', 'unavailable', 'done'].includes(state.phase) ? (
          <p
            role={state.phase === 'stale' || state.phase === 'unavailable' ? 'alert' : 'status'}
            className="max-w-prose text-pretty"
          >
            {message}
          </p>
        ) : null}
        {state.phase === 'preparing' ? <p role="status">{copy.preparing}</p> : null}
        {review ? (
          <div className="space-y-4">
            {original ? <h3>{copy.current}</h3> : null}
            <Version version={review} locale={locale} />
            <Button className={control} disabled={state.refreshing} onClick={visit.confirmReview}>
              {copy.confirm}
            </Button>
          </div>
        ) : null}
        {progress ? (
          <p className="max-w-prose">
            {copy.sourceSize}:{' '}
            <span className="tabular-nums">
              {new Intl.NumberFormat(locale).format(progress.expectedPlacementCount)}
            </span>
          </p>
        ) : null}
        {next && (state.phase === 'step-ready' || state.phase === 'unknown' || state.phase === 'preparing') ? (
          <p>
            {copy.next}: {copy.steps[state.intent?.request.body.step ?? next.step]}
          </p>
        ) : null}
        {state.readFailed ? (
          <p role="alert" className="max-w-prose">
            {copy.readFailed}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start gap-3">
          {state.phase === 'step-ready' || state.phase === 'unknown' ? (
            <Button className={control} disabled={state.refreshing} onClick={() => void visit.continue()}>
              {state.phase === 'unknown' ? copy.retry : copy.continue}
            </Button>
          ) : null}
          {state.phase !== 'preparing' && state.phase !== 'done' ? (
            <Button
              className={control}
              variant="outline"
              disabled={state.refreshing}
              onClick={() => void visit.refreshReview()}
            >
              {state.refreshing ? m.studio_draft_point_loading({}, { locale }) : copy.refresh}
            </Button>
          ) : null}
          {pointHref && (state.phase === 'done' || candidate?.item.publicationId === null) ? (
            <a className={link} href={localizeHref(pointHref, { locale })}>
              {copy.point}
            </a>
          ) : null}
        </div>
      </section>
    </main>
  );
}
