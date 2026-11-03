import { Link } from '@tanstack/react-router';
import type { DiaryAddress } from './address';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { ReportedYearRead, ReportedYearSummary } from './native';
import { privateCount } from './presentation';

type Counts = ReportedYearSummary['monthUnallocated'];
function CountsView({ counts }: { counts: Counts }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      {[
        [m.library_diary_completed(), counts.completedOccurrences],
        [m.library_diary_distinct_subjects(), counts.distinctCompletedSubjects],
        [m.library_diary_repeats(), counts.repeatOccurrences],
      ].map(([label, count]) => (
        <div key={label}>
          <dt className="text-sm">{label}</dt>
          <dd className="text-xl font-semibold">{privateCount(count!)}</dd>
        </div>
      ))}
      <div className="sm:col-span-3 text-sm">
        <dt>{m.library_diary_year_precision()}</dt>
        <dd>
          {m.library_diary_year_precision_counts({
            year: privateCount(counts.finishPrecision.year),
            month: privateCount(counts.finishPrecision.month),
            day: privateCount(counts.finishPrecision.day),
          })}
        </dd>
      </div>
    </dl>
  );
}

/** Counts and bucket membership share the native reported finish-date contract. */
export function ReportedYearPanel({
  year,
  result,
  retry,
  address = { year },
}: {
  year: number;
  result: ReportedYearRead;
  retry: () => void;
  address?: DiaryAddress;
}) {
  const summary = result.kind === 'ready' && result.value.year === year ? result.value : null;
  const monthName = (month: number) =>
    new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2000, month - 1, 1)),
    );
  return (
    <section aria-labelledby="library-diary-year-summary" className="space-y-4 rounded-lg border p-4">
      <h2 id="library-diary-year-summary" className="text-lg font-semibold">
        {m.library_diary_year_heading({ year })}
      </h2>
      {summary ? (
        <>
          <CountsView counts={summary} />
          <p className="text-sm">{m.library_diary_year_help()}</p>
          <p className="text-sm">
            {m.library_diary_coverage({
              native: summary.coverage.nativeSessions,
              other: summary.coverage.otherHistory,
              meaning: summary.coverage.unitMeaning,
              unknown: privateCount(summary.completedOccurrencesWithUnknownProfile),
            })}
          </p>
          <p className="text-sm">
            {m.library_diary_year_coverage({
              initialized: privateCount(summary.coverage.initializedSessions),
              retained: privateCount(summary.coverage.retainedSessions),
              missing: privateCount(summary.coverage.completedOccurrencesWithMissingFinish),
              unsupported: privateCount(summary.coverage.completedOccurrencesWithUnsupportedFinish),
            })}
          </p>
          <p className="text-sm">{m.library_diary_currentness({ state: summary.currentness.state })}</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {summary.months.map((bucket) => (
              <li key={bucket.month} className="min-w-0 rounded-md border p-3">
                <Link
                  to="/library/history"
                  search={{ year, month: bucket.month, returnTo: address.returnTo }}
                  aria-current={address.month === bucket.month ? 'page' : undefined}
                  className="inline-flex min-h-11 items-center text-start font-medium underline"
                >
                  {monthName(bucket.month)}
                </Link>
                <CountsView counts={bucket} />
              </li>
            ))}
            <li className="min-w-0 rounded-md border p-3">
              <Link
                to="/library/history"
                search={{ year, month: 'unallocated', returnTo: address.returnTo }}
                aria-current={address.month === 'unallocated' ? 'page' : undefined}
                className="inline-flex min-h-11 items-center text-start font-medium underline"
              >
                {m.library_diary_year_unallocated()}
              </Link>
              <CountsView counts={summary.monthUnallocated} />
            </li>
          </ul>
        </>
      ) : (
        <>
          <p role="status">{m.library_diary_year_unavailable()}</p>
          <button type="button" className="min-h-11 rounded-md border px-3" onClick={retry}>
            {m.library_selection_retry()}
          </button>
        </>
      )}
    </section>
  );
}
