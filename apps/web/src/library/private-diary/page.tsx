import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import type { useSession } from '../../session/query';
import type { PrivateDiaryLoadResult } from './server';
import { cancelPrivateDiary } from './server';
import { PRIVATE_DIARY_PAGE_BYTES, PRIVATE_DIARY_PAGE_LIMIT } from './native';
import { consumptionStatistics, privateCount, reportedDate } from './presentation';

type ReaderSession = ReturnType<typeof useSession>;

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f]/.test(value)) return '/library';
  try {
    const parsed = new URL(value, 'https://rezics.invalid');
    return parsed.origin === 'https://rezics.invalid' && parsed.pathname !== '/library/history'
      ? parsed.pathname + parsed.search + parsed.hash
      : '/library';
  } catch {
    return '/library';
  }
}

export function PrivateDiaryPage({
  loaded,
  session,
  returnTo,
}: {
  loaded: PrivateDiaryLoadResult;
  session: ReaderSession;
  returnTo?: string;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [closeUnavailable, setCloseUnavailable] = useState(false);
  const currentReturn = safeReturnTo(returnTo);
  const load =
    loaded.kind === 'ready' &&
    session.state === 'signed-in' &&
    loaded.viewer === session.subject &&
    loaded.csrfToken === session.csrfToken;
  const authorizedLoad = load ? loaded : null;
  const authenticated = authorizedLoad !== null;
  const retired =
    authorizedLoad?.diary.kind === 'retired' || authorizedLoad?.summary.kind === 'retired';
  const page =
    !retired && authorizedLoad?.diary.kind === 'ready' ? authorizedLoad.diary.page : null;
  const statistics =
    !retired && authorizedLoad?.summary.kind === 'ready'
      ? consumptionStatistics(authorizedLoad.summary.value)
      : null;

  useEffect(() => {
    if (retired) window.location.assign(currentReturn);
  }, [currentReturn, retired]);

  async function closeDiary() {
    if (!authorizedLoad || retired || !page?.continuation || closing) {
      window.location.assign(currentReturn);
      return;
    }
    setClosing(true);
    const result = await cancelPrivateDiary({
      data: {
        viewer: authorizedLoad.viewer,
        csrfToken: authorizedLoad.csrfToken,
        continuation: page.continuation,
      },
    });
    setClosing(false);
    if (result === 'unavailable') {
      setCloseUnavailable(true);
      return;
    }
    setCloseUnavailable(false);
    window.location.assign(currentReturn);
  }

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{m.library_diary_heading()}</h1>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="min-h-11 rounded-md border px-3" disabled={closing} onClick={() => void closeDiary()}>
              {closing ? m.library_diary_closing() : m.library_diary_return()}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{m.library_diary_help()}</p>
        {closeUnavailable ? <p role="status">{m.library_diary_cancel_unavailable()}</p> : null}
      </header>

      {retired ? <p role="status" className="rounded-md border p-4">{m.library_diary_session_ended()}</p> : null}

      {statistics ? (
        <section aria-labelledby="library-diary-statistics" className="rounded-lg border p-4">
          <h2 id="library-diary-statistics" className="text-lg font-semibold">{m.library_diary_statistics()}</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div><dt className="text-sm">{m.library_diary_completed()}</dt><dd className="text-xl font-semibold">{privateCount(statistics.completedOccurrences)}</dd></div>
            <div><dt className="text-sm">{m.library_diary_distinct_subjects()}</dt><dd className="text-xl font-semibold">{privateCount(statistics.distinctCompletedSubjects)}</dd></div>
            <div><dt className="text-sm">{m.library_diary_repeats()}</dt><dd className="text-xl font-semibold">{privateCount(statistics.repeatOccurrences)}</dd></div>
          </dl>
          <p className="mt-3 text-sm">{m.library_diary_coverage({
            native: statistics.coverage.nativeSessions,
            other: statistics.coverage.otherHistory,
            meaning: statistics.coverage.unitMeaning,
            unknown: privateCount(statistics.completedOccurrencesWithUnknownProfile),
          })}</p>
          <p className="mt-1 text-sm">{m.library_diary_statistics_scope({ scope: statistics.scope })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{m.library_diary_currentness({ state: statistics.currentness.state })}</p>
        </section>
      ) : !retired && authenticated ? (
        <section aria-live="polite" className="rounded-lg border p-4">
          <h2 className="font-semibold">{m.library_diary_statistics()}</h2>
          <p>{m.library_diary_statistics_unavailable()}</p>
          <button type="button" className="mt-2 min-h-11 rounded-md border px-3" onClick={() => void router.invalidate()}>
            {m.library_selection_retry()}
          </button>
        </section>
      ) : null}

      {!authenticated ? (
        <p role="status" className="rounded-md border p-4">{m.library_diary_unavailable()}</p>
      ) : retired ? null : authorizedLoad?.diary.kind === 'stale' ? (
        <section className="rounded-md border p-4">
          <p>{m.library_diary_stale()}</p>
          <Link className="mt-2 inline-flex min-h-11 items-center rounded-md border px-3" to="/library/history" search={{ returnTo: currentReturn }}>
            {m.library_diary_restart()}
          </Link>
        </section>
      ) : authorizedLoad?.diary.kind === 'unavailable' ? (
        <section className="rounded-md border p-4">
          <p>{m.library_diary_read_unavailable()}</p>
          <button type="button" className="mt-2 min-h-11 rounded-md border px-3" onClick={() => void router.invalidate()}>
            {m.library_selection_retry()}
          </button>
        </section>
      ) : page ? (
        <section aria-labelledby="library-diary-occurrences" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="library-diary-occurrences" className="text-lg font-semibold">{m.library_diary_occurrences()}</h2>
            <p className="text-sm text-muted-foreground">{m.library_diary_page_bound({ count: Math.min(PRIVATE_DIARY_PAGE_LIMIT, page.occurrences.length), bytes: PRIVATE_DIARY_PAGE_BYTES })}</p>
          </div>
          {page.occurrences.length === 0 ? <p className="rounded-md border p-4">{m.library_diary_empty()}</p> : (
            <ol className="space-y-3">
              {page.occurrences.map((occurrence) => (
                <li key={occurrence.id} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{occurrence.subject?.label ?? m.library_diary_subject_unavailable()}</h3>
                      {occurrence.subject?.language ? <p className="text-sm text-muted-foreground">{occurrence.subject.language}</p> : null}
                    </div>
                    <span className="rounded-full border px-2 py-1 text-sm">{m.library_diary_state({ state: occurrence.state })}</span>
                  </div>
                  <dl className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2">
                    <div><dt className="text-sm font-medium">{m.library_diary_reported_start()}</dt><dd>{reportedDate(occurrence.reportedDates.startDate, m.library_diary_date_unknown())}</dd></div>
                    <div><dt className="text-sm font-medium">{m.library_diary_reported_finish()}</dt><dd>{reportedDate(occurrence.reportedDates.finishDate, m.library_diary_date_unknown())}</dd></div>
                    <div><dt className="text-sm font-medium">{m.library_diary_recorded_start()}</dt><dd>{occurrence.recordedStartedAt}</dd></div>
                    <div><dt className="text-sm font-medium">{m.library_diary_recorded_completion()}</dt><dd>{occurrence.recordedCompletedAt ?? m.library_diary_not_completed()}</dd></div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link className="inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-primary-foreground" to="/library/progress/$id" params={{ id: occurrence.id }}>
                      {m.library_diary_open_occurrence()}
                    </Link>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {page.next ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-md border px-4"
              to="/library/history"
              replace
              search={{ cursor: page.next, returnTo: currentReturn }}
            >
              {m.library_diary_next()}
            </Link>
          ) : <p className="text-sm text-muted-foreground">{m.library_diary_end()}</p>}
        </section>
      ) : null}
    </main>
  );
}
