import { Link } from '@tanstack/react-router';
import type { DiaryAddress } from './address';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { ReportedYearRead } from './native';
import { reportPresentation, type ReportPresentation } from './presentation';
import { Button } from '@rezics/ui/shadcn/button';

function CountsView({ presentation }: { presentation: ReportPresentation }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      {[
        presentation.counts.completed,
        presentation.counts.distinct,
        presentation.counts.repeats,
        presentation.unknownProfile,
      ].map(({ label, value }) => (
        <div key={label} className="h-auto min-w-0 [overflow-wrap:anywhere]">
          <dt className="text-sm">{label}</dt>
          <dd className="text-xl font-semibold">{value}</dd>
        </div>
      ))}
      {presentation.finishPrecision ? (
        <div className="h-auto sm:col-span-3 min-w-0 text-sm [overflow-wrap:anywhere]">
          <dt>{presentation.finishPrecision.label}</dt>
          <dd>{presentation.finishPrecision.value}</dd>
        </div>
      ) : null}
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
  const locale = getLocale();
  const presentation = summary ? reportPresentation(summary, summary, locale) : null;
  const monthName = (month: number) =>
    new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2000, month - 1, 1)),
    );
  return (
    <section aria-labelledby="library-diary-year-summary" className="space-y-4 rounded-lg border p-4">
      <h2 id="library-diary-year-summary" className="text-lg font-semibold">
        {m.library_diary_year_heading({ year })}
      </h2>
      {summary && presentation ? (
        <>
          <CountsView presentation={presentation} />
          <p className="text-sm">{presentation.yearHelp}</p>
          <p className="text-sm">{presentation.coverageMeaning}</p>
          {address.month === undefined ? <p className="text-sm">{presentation.coverageScope}</p> : null}
          <p className="text-sm">{presentation.ownerScope}</p>
          <p className="text-sm">{presentation.unknownHistory}</p>
          {presentation.ownerCoverage ? <p className="text-sm">{presentation.ownerCoverage}</p> : null}
          <p className="min-w-0 break-all text-sm">
            {presentation.snapshot.label}:{' '}
            <bdi dir="ltr">{presentation.snapshot.revision}</bdi>
          </p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {summary.months.map((bucket) => (
              <li key={bucket.month} className="min-w-0 rounded-md border p-3">
                <Link
                  to="/library/history"
                  search={{ year, month: bucket.month, returnTo: address.returnTo }}
                  aria-current={address.month === bucket.month ? 'page' : undefined}
                  className="inline-flex items-center text-start font-medium underline"
                >
                  {monthName(bucket.month)}
                </Link>
                <CountsView presentation={reportPresentation(summary, bucket, locale)} />
              </li>
            ))}
            <li className="min-w-0 rounded-md border p-3">
              <Link
                to="/library/history"
                search={{ year, month: 'unallocated', returnTo: address.returnTo }}
                aria-current={address.month === 'unallocated' ? 'page' : undefined}
                className="inline-flex items-center text-start font-medium underline"
              >
                {m.library_diary_year_unallocated()}
              </Link>
              <CountsView presentation={reportPresentation(summary, summary.monthUnallocated, locale)} />
            </li>
          </ul>
        </>
      ) : result.kind === 'denied' || result.kind === 'closed' ? (
        <p role="status">{result.kind === 'closed' ? m.platform_closed_message() : m.ctxw_denied()}</p>
      ) : (
        <>
          <p role="status">{m.library_diary_year_unavailable()}</p>
          <Button type="button" variant="outline" onClick={retry}>
            {m.library_selection_retry()}
          </Button>
        </>
      )}
    </section>
  );
}
