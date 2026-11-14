import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { DiaryAddress } from './address';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { ConsumptionSummary, DiaryReadFailure, ReportedYearRead, ReportedYearSummary } from './native';
import { reportPresentation, type ReportPresentation } from './presentation';

type AllTimeRead = { kind: 'ready'; value: ConsumptionSummary } | DiaryReadFailure | { kind: 'not-selected' };
type BucketCounts = ReportedYearSummary['monthUnallocated'];
type SummaryCounts = Pick<
  ConsumptionSummary,
  'completedOccurrences' | 'distinctCompletedSubjects' | 'repeatOccurrences' | 'completedOccurrencesWithUnknownProfile'
> &
  Partial<Pick<BucketCounts, 'finishPrecision'>>;

function SummaryReading({
  summary,
  counts,
  children,
}: {
  summary: ConsumptionSummary | ReportedYearSummary;
  counts: SummaryCounts;
  children: (presentation: ReportPresentation) => ReactNode;
}) {
  const presentation = reportPresentation(summary, counts, getLocale());

  return (
    <details className="min-w-0 border-t pt-2">
      <summary className="min-h-11 cursor-pointer rounded px-1 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]">
        <span className="mr-2 inline-block max-w-full [overflow-wrap:anywhere]">
          {presentation.counts.completed.label}: {presentation.counts.completed.value}
        </span>
        <span className="mr-2 inline-block max-w-full [overflow-wrap:anywhere]">
          {presentation.counts.distinct.label}: {presentation.counts.distinct.value}
        </span>
        <span className="inline-block max-w-full [overflow-wrap:anywhere]">
          {presentation.counts.repeats.label}: {presentation.counts.repeats.value}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {presentation.snapshot.label}:{' '}
          <bdi dir="ltr" className="[overflow-wrap:anywhere]">
            {presentation.snapshot.revision}
          </bdi>
        </span>
      </summary>
      <div className="min-w-0 space-y-2 pb-2 pt-1">{children(presentation)}</div>
    </details>
  );
}

function monthName(month: number) {
  return new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 1)),
  );
}

function YearBucket({ address, result }: { address: DiaryAddress; result: ReportedYearRead | null }) {
  if (result?.kind === 'denied' || result?.kind === 'closed') {
    return (
      <p role="status" className="min-w-0 [overflow-wrap:anywhere]">
        {result.kind === 'closed' ? m.platform_closed_message() : m.ctxw_denied()}
      </p>
    );
  }
  if (!result || result.kind !== 'ready' || result.value.year !== address.year) {
    return (
      <p role="status" className="min-w-0 [overflow-wrap:anywhere]">
        {m.library_diary_year_unavailable()}
      </p>
    );
  }

  const summary = result.value;
  const counts =
    address.month === undefined
      ? summary
      : address.month === 'unallocated'
        ? summary.monthUnallocated
        : summary.months.find((bucket) => bucket.month === address.month);

  if (!counts)
    return (
      <p role="status" className="min-w-0 [overflow-wrap:anywhere]">
        {m.library_diary_year_unavailable()}
      </p>
    );

  return (
    <SummaryReading summary={summary} counts={counts}>
      {(presentation) => (
        <>
          <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
            {presentation.finishPrecision
              ? `${presentation.finishPrecision.label}: ${presentation.finishPrecision.value}`
              : presentation.precisionUnavailable}
          </p>
          <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.coverageMeaning}</p>
          <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
            {presentation.unknownProfile.label}: {presentation.unknownProfile.value}
          </p>
          <p className="mt-1 min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.coverageScope}</p>
          <p className="mt-2 min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.ownerScope}</p>
          <p className="mt-2 min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.unknownHistory}</p>
          {presentation.ownerCoverage ? (
            <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.ownerCoverage}</p>
          ) : null}
        </>
      )}
    </SummaryReading>
  );
}

export function ReadingPeriod({
  address,
  returnTo,
  allTime,
  reportedYear,
  retry,
}: {
  address: DiaryAddress;
  returnTo: string;
  allTime: AllTimeRead;
  reportedYear: ReportedYearRead | null;
  retry: () => void;
}) {
  const allTimeSelected = address.year === undefined;
  const month = address.month;
  const title = allTimeSelected
    ? m.library_diary_period_all_time()
    : month === undefined
      ? m.library_diary_period_year({ year: address.year! })
      : month === 'unallocated'
        ? m.library_diary_period_unallocated({ year: address.year! })
        : m.library_diary_period_month({ month: monthName(month), year: address.year! });

  return (
    <section aria-labelledby="library-diary-active-period" className="min-w-0 space-y-4 rounded-lg border p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="library-diary-active-period" className="text-lg font-semibold [overflow-wrap:anywhere]">
            {title}
          </h2>
          <p className="mt-1 min-w-0 text-sm [overflow-wrap:anywhere]">{m.library_diary_period_membership()}</p>
          <p className="mt-1 min-w-0 text-sm [overflow-wrap:anywhere]">{m.library_diary_period_order()}</p>
        </div>
        <nav aria-label={m.library_diary_period_navigation()} className="flex min-w-0 flex-wrap gap-2">
          {!allTimeSelected && month !== undefined ? (
            <Link
              className="inline-flex min-h-11 min-w-0 max-w-full items-center rounded-md border px-3 text-start [overflow-wrap:anywhere]"
              to="/library/history"
              search={{ year: address.year, returnTo }}
            >
              {m.library_diary_period_return_year({ year: address.year! })}
            </Link>
          ) : null}
          {!allTimeSelected ? (
            <Link
              className="inline-flex min-h-11 min-w-0 max-w-full items-center rounded-md border px-3 text-start [overflow-wrap:anywhere]"
              to="/library/history"
              search={{ returnTo }}
            >
              {m.library_diary_all_time()}
            </Link>
          ) : null}
        </nav>
      </div>

      {allTimeSelected ? (
        allTime.kind === 'ready' ? (
          <SummaryReading summary={allTime.value} counts={allTime.value}>
            {(presentation) => (
              <>
                <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.coverageMeaning}</p>
                <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  {presentation.unknownProfile.label}: {presentation.unknownProfile.value}
                </p>
                <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.coverageScope}</p>
                <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.precisionUnavailable}</p>
                <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{presentation.unknownHistory}</p>
              </>
            )}
          </SummaryReading>
        ) : allTime.kind === 'denied' || allTime.kind === 'closed' ? (
          <p role="status" className="min-w-0 [overflow-wrap:anywhere]">
            {allTime.kind === 'closed' ? m.platform_closed_message() : m.ctxw_denied()}
          </p>
        ) : (
          <div aria-live="polite" className="min-w-0">
            <p role="status" className="[overflow-wrap:anywhere]">
              {m.library_diary_statistics_unavailable()}
            </p>
            <button
              type="button"
              className="mt-2 min-h-11 max-w-full rounded-md border px-3 [overflow-wrap:anywhere]"
              onClick={retry}
            >
              {m.library_selection_retry()}
            </button>
          </div>
        )
      ) : (
        <YearBucket address={address} result={reportedYear} />
      )}
    </section>
  );
}
