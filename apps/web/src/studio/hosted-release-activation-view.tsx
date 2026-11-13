import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { Locale } from '../paraglide/runtime.js';
import { activationCopy } from './hosted-release-activation-copy';
import { releaseCopy } from './hosted-release-preparation-copy';
import { HostedReleaseReaderLink } from './hosted-release-reader-link-action';
import type { HostedReleaseActivationVisit } from './hosted-release-activation';

const control =
  'min-h-11 max-w-full whitespace-normal text-start focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring';
const valueStyle = 'min-w-0 break-all text-sm';

/** Composes inside preparation's existing workspace; no nested page, modal or additional private locator. */
export function HostedReleaseActivationView({
  visit,
  locale,
}: {
  visit: HostedReleaseActivationVisit;
  locale: Locale;
}) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const copy = activationCopy[locale];
  const preparation = releaseCopy[locale];
  const feedback = useRef<HTMLHeadingElement>(null);
  const phase = state.kind === 'active' ? state.phase : 'ended';
  useEffect(() => {
    if (state.kind === 'active' && !state.busy && visit.isCurrent()) feedback.current?.focus();
  }, [visit, phase, state.kind === 'active' && state.paused, state.kind === 'active' && state.readback]);
  if (state.kind === 'ended')
    return <p role="alert">{state.reason === 'denied' ? preparation.denied : preparation.ended}</p>;
  const { review, progress, receipt } = state;
  const status = {
    review: copy.review,
    checking: state.paused ? copy.paused : copy.checking,
    ready: copy.ready,
    restart: copy.restart,
    unknown: copy.unknown,
    blocked: copy.blocked,
    activated: copy.activated,
  }[state.phase];
  const readback = {
    idle: null,
    reading: copy.reading,
    observed: copy.observed,
    unavailable: copy.unavailable,
    different: copy.different,
    'not-public': copy.notPublic,
    empty: copy.empty,
    verified: copy.verified,
  }[state.readback];
  const rows: [string, string][] = [
    [preparation.catalogue, review.catalogueId],
    [preparation.draft, review.sourceRevisionId],
    [copy.previous, review.expectedPublicationId ?? preparation.absent],
    [preparation.stage, review.stageId],
    [copy.candidateId, review.candidateId],
    [copy.generation, review.candidateGenerationId],
  ];
  if (progress) rows.push([copy.pass, progress.passId]);
  if (receipt) rows.push([copy.receipt, receipt.publicationId!]);
  if (state.observedPublicationId !== undefined)
    rows.push([copy.observation, state.observedPublicationId ?? preparation.absent]);
  const counts: [string, string][] = [
    [preparation.candidate, review.placementCount],
    [preparation.chapters, review.chapterCount],
    ...(progress
      ? ([
          [copy.checked, progress.checkedTargetCount],
          [copy.total, progress.totalTargetCount],
        ] as [string, string][])
      : []),
  ];
  return (
    <section
      className="min-w-0 space-y-6 selection:bg-primary selection:text-primary-foreground"
      aria-label={copy.heading}
    >
      <header className="space-y-3">
        <h2 className="max-w-prose break-words text-balance text-2xl font-semibold">{review.title}</h2>
      </header>
      <dl className="grid min-w-0 gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className={valueStyle}>{value}</dd>
          </div>
        ))}
        {counts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="min-w-0 break-all tabular-nums">{new Intl.NumberFormat(locale).format(BigInt(value))}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-4" aria-busy={state.busy}>
        <h3
          ref={feedback}
          tabIndex={-1}
          className="max-w-prose rounded-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {status}
        </h3>
        <p
          role={['unknown', 'blocked', 'restart'].includes(state.phase) ? 'alert' : 'status'}
          className="max-w-prose text-pretty"
        >
          {state.busy && state.readback !== 'reading' ? preparation.working : status}
        </p>
        {readback ? (
          <p
            role={['unavailable', 'different', 'not-public'].includes(state.readback) ? 'alert' : 'status'}
            className="max-w-prose text-pretty"
          >
            {readback}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start gap-3">
          {state.phase === 'review' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.start()}>
              {copy.start}
            </Button>
          ) : null}
          {state.phase === 'checking' && !state.paused ? (
            <>
              <Button className={control} disabled={state.busy} onClick={() => void visit.checkNext()}>
                {copy.next}
              </Button>
              <Button className={control} variant="outline" onClick={visit.pause}>
                {copy.pause}
              </Button>
            </>
          ) : null}
          {state.phase === 'checking' && state.paused ? (
            <Button className={control} disabled={state.busy} onClick={visit.resume}>
              {copy.resume}
            </Button>
          ) : null}
          {state.phase === 'ready' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.activate()}>
              {copy.activate}
            </Button>
          ) : null}
          {state.phase === 'restart' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.restartAuthority()}>
              {copy.restartAction}
            </Button>
          ) : null}
          {state.phase === 'unknown' ? (
            <Button className={control} disabled={state.busy} onClick={() => void visit.retry()}>
              {copy.retry}
            </Button>
          ) : null}
          {['unknown', 'activated'].includes(state.phase) ? (
            <Button
              className={control}
              variant="outline"
              disabled={state.busy}
              onClick={() => void visit.readPublication()}
            >
              {copy.read}
            </Button>
          ) : null}
        </div>
        <HostedReleaseReaderLink binding={visit.readerLink} locale={locale} />
      </div>
    </section>
  );
}
