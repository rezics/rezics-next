import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { localizeHref, type Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { releaseSelectionCopy } from './hosted-release-selection-copy';
import { HostedReleaseSelectionView } from './hosted-release-selection-view';
import { releaseCopy } from './hosted-release-preparation-copy';
import type { HostedReleasePreparationVisit } from './hosted-release-preparation';
import { HostedReleaseActivationEntry, type HostedReleaseActivationBinding } from './hosted-release-activation-entry';
import { activationCopy } from './hosted-release-activation-copy';

const control = 'min-h-11 max-w-full whitespace-normal text-start';
const valueStyle = 'min-w-0 break-all font-mono text-sm';

export function HostedReleasePreparationView({
  visit,
  locale,
  activation,
}: {
  visit: HostedReleasePreparationVisit;
  locale: Locale;
  activation?: HostedReleaseActivationBinding;
}) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const feedback = useRef<HTMLHeadingElement>(null);
  const copy = releaseCopy[locale];
  const selectionCopy = releaseSelectionCopy[locale];
  const phase = state.kind === 'active' ? state.phase : 'ended';
  useEffect(() => {
    if (visit.isCurrent() && state.kind === 'active' && !state.busy && !state.running) feedback.current?.focus();
  }, [visit, phase]);
  if (state.kind === 'ended') return <p role="alert">{state.reason === 'denied' ? copy.denied : copy.ended}</p>;
  const { progress, review, owner } = state;
  if (activation && state.phase === 'prepared' && progress)
    return (
      <main className="studio-workspace mx-auto w-full max-w-4xl space-y-8 px-4 py-8">
        <header className="studio-header space-y-3">
          <h1>{activationCopy[locale].heading}</h1>
          <a
            className="studio-skip inline-flex min-h-11 items-center"
            href={localizeHref('/studio?books=1', { locale })}
          >
            {m.studio_root_append_return({}, { locale })}
          </a>
        </header>
        <HostedReleaseActivationEntry {...activation} owner={owner} prepared={progress} locale={locale} />
      </main>
    );
  const failure = ['unknown', 'invalid', 'stale', 'unavailable', 'expired', 'cancelled', 'failed'].includes(phase);
  const message = {
    review: copy.review,
    reviewed: copy.reviewed,
    paused: copy.paused,
    selecting: selectionCopy.selecting,
    invalid: selectionCopy.invalid,
    unknown: copy.unknown,
    ready: copy.ready,
    prepared: copy.prepared,
    stale: copy.stale,
    unavailable: copy.unavailable,
    expired: copy.expired,
    cancelled: copy.cancelled,
    failed:
      progress?.stage.failure === 'missing_ancestor'
        ? selectionCopy.missing
        : progress?.stage.failure === 'stale_source'
          ? selectionCopy.stale
          : state.mode === 'selection'
            ? selectionCopy.incomplete
            : copy.failed,
  }[state.phase];
  const version =
    review ??
    (state.phase === 'review'
      ? {
          catalogueId: owner.item.catalogueId,
          expectedRevisionId: owner.item.headRevisionId,
          expectedPublicationId: owner.item.publicationId,
        }
      : null);
  const counts = progress
    ? [
        [copy.selected, progress.stage.candidateCount],
        [copy.settled, progress.stage.settledInputCount],
        ...(progress.candidate
          ? [
              [copy.candidate, progress.candidate.placementCount],
              [copy.chapters, progress.candidate.chapterCount],
              [copy.roots, progress.candidate.rootCount],
            ]
          : []),
      ]
    : [];
  return (
    <main className="studio-workspace mx-auto w-full max-w-4xl space-y-8 px-4 py-8 selection:bg-primary selection:text-primary-foreground">
      <header className="studio-header space-y-3">
        <h1>{copy.heading}</h1>
        <a className="studio-skip inline-flex min-h-11 items-center" href={localizeHref('/studio?books=1', { locale })}>
          {m.studio_root_append_return({}, { locale })}
        </a>
        <p className="studio-help max-w-prose text-pretty">{copy.private}</p>
        <p className="text-xl font-semibold">{review?.title ?? owner.item.title}</p>
      </header>
      {version ? (
        <section className="space-y-3">
          <h2>{review ? copy.reviewed : copy.review}</h2>
          <dl className="grid min-w-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt>{copy.catalogue}</dt>
            <dd className={valueStyle}>{version.catalogueId}</dd>
            <dt>{copy.draft}</dt>
            <dd className={valueStyle}>{version.expectedRevisionId}</dd>
            <dt>{copy.publication}</dt>
            <dd className={valueStyle}>{version.expectedPublicationId ?? copy.absent}</dd>
          </dl>
        </section>
      ) : null}
      {!review && state.stageId ? <p className="max-w-prose">{copy.resumed}</p> : null}
      {state.stageId ? (
        <section className="space-y-2">
          <h2>{copy.stage}</h2>
          <p className={valueStyle}>{state.stageId}</p>
          {counts.length ? (
            <dl className="grid min-w-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
              {counts.map(([label, count]) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd className="break-all tabular-nums">{new Intl.NumberFormat(locale).format(BigInt(count!))}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>
      ) : null}
      <HostedReleaseSelectionView visit={visit} state={state} locale={locale} />
      <section className="space-y-4" aria-busy={state.busy}>
        <h2
          ref={feedback}
          tabIndex={-1}
          className="max-w-prose rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {state.busy || state.running ? copy.working : message}
        </h2>
        {failure ? (
          <p role="alert" className="max-w-prose text-pretty">
            {message}
          </p>
        ) : null}
        {state.phase === 'prepared' ? (
          <p role="status" className="max-w-prose">
            {copy.prepared}
          </p>
        ) : null}
        {state.error && !failure ? <p role="alert">{copy.unavailable}</p> : null}
        <div className="flex flex-wrap items-start gap-3">
          {state.phase === 'review' ? (
            <Button className={control} disabled={state.busy} onClick={visit.confirmReview}>
              {copy.confirm}
            </Button>
          ) : null}
          {state.phase === 'reviewed' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.start()}>
              {copy.start}
            </Button>
          ) : null}
          {state.phase === 'reviewed' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.start('selection')}>
              {selectionCopy.start}
            </Button>
          ) : null}
          {state.running ? (
            <Button className={control} variant="outline" onClick={visit.pause}>
              {copy.pause}
            </Button>
          ) : null}
          {!state.running && state.phase === 'paused' && progress ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.resume()}>
              {copy.resume}
            </Button>
          ) : null}
          {state.phase === 'unknown' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.retry()}>
              {copy.retry}
            </Button>
          ) : null}
          {state.phase === 'ready' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.seal()}>
              {copy.seal}
            </Button>
          ) : null}
          {state.stageId && state.phase !== 'unknown' && !state.running ? (
            <Button
              className={control}
              variant="outline"
              disabled={state.busy}
              onClick={() => void visit.readProgress()}
            >
              {copy.progress}
            </Button>
          ) : null}
          {progress &&
          !['unknown', 'prepared', 'expired', 'cancelled', 'failed'].includes(state.phase) &&
          !state.running ? (
            <Button className={control} variant="outline" disabled={state.busy} onClick={() => void visit.cancel()}>
              {copy.cancel}
            </Button>
          ) : null}
          {state.phase !== 'unknown' && !state.running ? (
            <Button
              className={control}
              variant="outline"
              disabled={state.busy}
              onClick={() => void visit.refreshReview()}
            >
              {copy.refresh}
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
