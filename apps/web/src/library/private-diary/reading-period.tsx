import { Link } from '@tanstack/react-router';
import type { DiaryAddress } from './address';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { ConsumptionSummary, ReportedYearRead, ReportedYearSummary } from './native';
import { privateCount } from './presentation';

type AllTimeRead = { kind: 'ready'; value: ConsumptionSummary } | { kind: 'unavailable' | 'retired' | 'not-selected' };
type BucketCounts = ReportedYearSummary['monthUnallocated'];

function CountValues({
  counts,
}: {
  counts: Pick<ConsumptionSummary, 'completedOccurrences' | 'distinctCompletedSubjects' | 'repeatOccurrences'>;
}) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      <div>
        <dt className="text-sm">{m.library_diary_completed()}</dt>
        <dd className="text-xl font-semibold">{privateCount(counts.completedOccurrences)}</dd>
      </div>
      <div>
        <dt className="text-sm">{m.library_diary_distinct_subjects()}</dt>
        <dd className="text-xl font-semibold">{privateCount(counts.distinctCompletedSubjects)}</dd>
      </div>
      <div>
        <dt className="text-sm">{m.library_diary_repeats()}</dt>
        <dd className="text-xl font-semibold">{privateCount(counts.repeatOccurrences)}</dd>
      </div>
    </dl>
  );
}

function BucketValues({ counts }: { counts: BucketCounts }) {
  return (
    <>
      <CountValues counts={counts} />
      <p className="mt-3 text-sm">
        {m.library_diary_year_precision_counts({
          year: privateCount(counts.finishPrecision.year),
          month: privateCount(counts.finishPrecision.month),
          day: privateCount(counts.finishPrecision.day),
        })}
      </p>
    </>
  );
}

function monthName(month: number) {
  return new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 1)),
  );
}

function YearBucket({ address, result }: { address: DiaryAddress; result: ReportedYearRead | null }) {
  if (!result || result.kind !== 'ready' || result.value.year !== address.year) {
    return <p role="status">{m.library_diary_year_unavailable()}</p>;
  }

  const summary = result.value;
  const counts =
    address.month === undefined
      ? summary
      : address.month === 'unallocated'
        ? summary.monthUnallocated
        : summary.months.find((bucket) => bucket.month === address.month);

  if (!counts) return <p role="status">{m.library_diary_year_unavailable()}</p>;

  return (
    <>
      <BucketValues counts={counts} />
      <p className="mt-3 text-sm">
        {m.library_diary_coverage({
          native: summary.coverage.nativeSessions,
          other: summary.coverage.otherHistory,
          meaning: summary.coverage.unitMeaning,
          unknown: privateCount(counts.completedOccurrencesWithUnknownProfile),
        })}
      </p>
      <p className="mt-1 text-sm">{m.library_diary_period_coverage_scope()}</p>
      <p className="mt-2 text-sm">{m.library_diary_period_owner_scope()}</p>
      <p className="mt-2 text-sm">{m.library_diary_period_unknown_history()}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {m.library_diary_currentness({ state: summary.currentness.state })}
      </p>
    </>
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
    <section aria-labelledby="library-diary-active-period" className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="library-diary-active-period" className="text-lg font-semibold">
            {title}
          </h2>
          <p className="mt-1 text-sm">{m.library_diary_period_membership()}</p>
          <p className="mt-1 text-sm">{m.library_diary_period_order()}</p>
        </div>
        <nav aria-label={m.library_diary_period_navigation()} className="flex flex-wrap gap-2">
          {!allTimeSelected && month !== undefined ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-md border px-3"
              to="/library/history"
              search={{ year: address.year, returnTo }}
            >
              {m.library_diary_period_return_year({ year: address.year! })}
            </Link>
          ) : null}
          {!allTimeSelected ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-md border px-3"
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
          <>
            <CountValues counts={allTime.value} />
            <p className="mt-2 text-sm">
              {m.library_diary_coverage({
                native: allTime.value.coverage.nativeSessions,
                other: allTime.value.coverage.otherHistory,
                meaning: allTime.value.coverage.unitMeaning,
                unknown: privateCount(allTime.value.completedOccurrencesWithUnknownProfile),
              })}
            </p>
            <p className="mt-1 text-sm">{m.library_diary_period_coverage_scope()}</p>
            <p className="mt-2 text-sm">{m.library_diary_statistics_scope({ scope: allTime.value.scope })}</p>
            <p className="mt-2 text-sm">{m.library_diary_period_precision_unavailable()}</p>
            <p className="mt-2 text-sm">{m.library_diary_period_unknown_history()}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {m.library_diary_currentness({ state: allTime.value.currentness.state })}
            </p>
          </>
        ) : (
          <div aria-live="polite">
            <p role="status">{m.library_diary_statistics_unavailable()}</p>
            <button type="button" className="mt-2 min-h-11 rounded-md border px-3" onClick={retry}>
              {m.library_selection_retry()}
            </button>
          </div>
        )
      ) : (
        <>
          <YearBucket address={address} result={reportedYear} />
          {reportedYear?.kind === 'ready' ? (
            <p className="text-sm">
              {m.library_diary_year_coverage({
                initialized: privateCount(reportedYear.value.coverage.initializedSessions),
                retained: privateCount(reportedYear.value.coverage.retainedSessions),
                missing: privateCount(reportedYear.value.coverage.completedOccurrencesWithMissingFinish),
                unsupported: privateCount(reportedYear.value.coverage.completedOccurrencesWithUnsupportedFinish),
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
