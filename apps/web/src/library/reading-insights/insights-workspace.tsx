import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';

export function InsightsWorkspace({
  intro,
  year,
  actions,
  status,
  allTime,
  reportedYear,
  currentProgress,
  profiles,
  assessments,
}: {
  intro: ReactNode;
  year: number | undefined;
  actions: ReactNode;
  status: ReactNode;
  allTime: ReactNode;
  reportedYear: ReactNode;
  currentProgress: ReactNode;
  profiles: ReactNode;
  assessments: ReactNode;
}) {
  return (
    <article className="mx-auto min-w-0 max-w-7xl space-y-8 px-4 py-8 text-foreground [overflow-wrap:anywhere]">
      <header className="space-y-5">
        {intro}
        <section aria-label={m.library_insights_year()} className="rounded-xl border border-border bg-muted/20 p-4 sm:p-6">
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(9rem,0.8fr)_minmax(0,2fr)] lg:items-center">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">{m.library_insights_year()}</p>
              <p className="break-words text-2xl font-semibold tabular-nums">
                {year === undefined ? m.library_insights_invalid_year() : year}
              </p>
            </div>
            <div className="min-w-0 space-y-3">
              {actions}
              {status}
            </div>
          </div>
        </section>
      </header>
      <div className="min-w-0 space-y-6">
        {allTime}
        {reportedYear}
      </div>
      <div className="min-w-0 space-y-6">
        {currentProgress}
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          {profiles}
          {assessments}
        </div>
      </div>
    </article>
  );
}
