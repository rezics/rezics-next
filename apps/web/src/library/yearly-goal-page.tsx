import { useEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { ReportedYearSummary } from './private-diary/native';

const control =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-4 py-2 text-sm underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type GoalAction = { allowed: boolean; reason?: string };
export type YearlyGoalSnapshot = {
  year: number;
  viewer: {
    state: 'owner';
    actions: { editTarget: GoalAction; clearTarget: GoalAction; navigateYear: GoalAction };
  };
  target:
    | { state: 'none'; revision: string | null }
    | { state: 'set'; target: number; revision: string }
    | { state: 'unavailable'; reason: 'not_installed' };
  progress:
    | { state: 'available'; summary: ReportedYearSummary }
    | { state: 'unavailable'; reason: 'summary_unavailable' };
};

export type YearlyGoalReadResult =
  | { state: 'ready'; value: YearlyGoalSnapshot }
  | { state: 'denied' | 'retired' | 'unavailable' };

/** The UI hands this exact command to its server adapter; the key is sent as the native header. */
export type YearlyGoalCommand = {
  year: number;
  metric: 'completed_consumption_occurrences';
  target: number | null;
  expectedRevision: string | null;
  idempotencyKey: string;
};

export type YearlyGoalWriteResult =
  | { state: 'applied' }
  | { state: 'stale' }
  | { state: 'uncertain' }
  | { state: 'denied' }
  | { state: 'unavailable' };

/** A narrow seam for the mounted Kernel reader and command; the owning route supplies the published client binding. */
export type YearlyGoalPageApi = {
  read(year: number): Promise<YearlyGoalReadResult>;
  write(command: YearlyGoalCommand): Promise<YearlyGoalWriteResult>;
};

type Loaded = { state: 'loading' } | Exclude<YearlyGoalReadResult, { state: 'ready' }> | YearlyGoalReadResult;
type Operation =
  | null
  | 'sending'
  | 'refreshing'
  | 'saved'
  | 'review'
  | 'stale'
  | 'uncertain'
  | 'denied'
  | 'unavailable';

function monthName(month: number): string {
  return new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, month - 1, 1)),
  );
}

function YearlyGoalScreen({
  year,
  sessionState,
  viewerSubject,
  api,
}: {
  year?: number | undefined;
  sessionState: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  viewerSubject: string | null;
  api?: YearlyGoalPageApi | undefined;
}) {
  const locale = getLocale();
  const path = `/${locale}/library/goals`;
  const returnTo = `${path}${year === undefined ? '' : `?year=${year}`}`;
  const [loaded, setLoaded] = useState<Loaded>(() =>
    api && sessionState === 'signed-in' && viewerSubject ? { state: 'loading' } : { state: 'unavailable' },
  );
  const [mode, setMode] = useState<'view' | 'edit' | 'clear'>('view');
  const [draft, setDraft] = useState('');
  const [invalidTarget, setInvalidTarget] = useState(false);
  const [pending, setPending] = useState<YearlyGoalCommand>();
  const [operation, setOperation] = useState<Operation>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setMode('view');
    setDraft('');
    setInvalidTarget(false);
    setPending(undefined);
    setOperation(null);
    if (year === undefined || sessionState !== 'signed-in' || !viewerSubject || !api) {
      setLoaded({ state: 'unavailable' });
    } else {
      setLoaded({ state: 'loading' });
      void api.read(year).then((result) => {
        if (generation.current === current) setLoaded(result);
      });
    }
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [api, sessionState, viewerSubject, year]);

  const snapshot = loaded.state === 'ready' ? loaded.value : undefined;

  async function refreshCurrent(purpose: 'conflict' | 'manual' | 'readback') {
    if (!api || year === undefined) return;
    const current = generation.current;
    setOperation('refreshing');
    setLoaded({ state: 'loading' });
    const result = await api.read(year);
    if (generation.current !== current) return;
    setLoaded(result);
    setOperation(
      result.state === 'ready'
        ? purpose === 'conflict' || mode !== 'view'
          ? 'review'
          : purpose === 'readback'
            ? 'saved'
            : null
        : purpose === 'conflict'
          ? 'stale'
          : purpose === 'readback'
            ? 'unavailable'
            : null,
    );
  }

  async function send(command: YearlyGoalCommand) {
    if (!api) return;
    const current = generation.current;
    setOperation('sending');
    const result = await api.write(command);
    if (generation.current !== current) return;
    if (result.state === 'applied') {
      setPending(undefined);
      setMode('view');
      setLoaded({ state: 'loading' });
      setOperation('saved');
      if (year === undefined) return;
      const readback = await api.read(year);
      if (generation.current !== current) return;
      setLoaded(readback);
      return;
    }
    if (result.state === 'stale') {
      setPending(undefined);
      setLoaded({ state: 'unavailable' });
      setOperation('stale');
      return;
    }
    if (result.state === 'uncertain') {
      setPending(command);
      setLoaded({ state: 'unavailable' });
      setOperation('uncertain');
      return;
    }
    setPending(undefined);
    setLoaded(result.state === 'denied' ? { state: 'denied' } : { state: 'unavailable' });
    setOperation(result.state);
  }

  function commandFor(target: number | null) {
    if (
      !snapshot ||
      year === undefined ||
      snapshot.target.state === 'unavailable' ||
      !snapshot.viewer.actions.editTarget.allowed
    )
      return;
    if (target === null && (snapshot.target.state !== 'set' || !snapshot.viewer.actions.clearTarget.allowed)) return;
    const expectedRevision = snapshot.target.revision;
    void send({
      year,
      metric: 'completed_consumption_occurrences',
      target,
      expectedRevision,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  function submitTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[0-9]+$/.test(draft)) {
      setInvalidTarget(true);
      return;
    }
    const target = Number(draft);
    if (!Number.isSafeInteger(target) || target < 1 || target > 1000) {
      setInvalidTarget(true);
      return;
    }
    setInvalidTarget(false);
    commandFor(target);
  }

  function beginEdit() {
    if (!snapshot) return;
    setDraft(snapshot.target.state === 'set' ? String(snapshot.target.target) : '');
    setOperation(null);
    setInvalidTarget(false);
    setMode('edit');
  }

  const retryExact = () => {
    if (pending) void send(pending);
  };

  return (
    <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 px-4 py-6">
      <nav aria-label={m.library_nav_sidebar_label()} className="flex flex-wrap gap-3">
        <a href={`/${locale}/library`} className={`${control} underline`}>
          {m.library_nav_tracked_entries()}
        </a>
        {year !== undefined ? (
          <a href={`/${locale}/library/history?year=${year}`} className={`${control} underline`}>
            {m.library_diary_nav()}
          </a>
        ) : null}
      </nav>
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">{m.library_yearly_goal_title()}</h1>
        <p className="text-sm text-muted-foreground">{m.library_yearly_goal_metric()}</p>
      </header>
      <form action={path} method="get" className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <label htmlFor="yearly-goal-year">{m.library_diary_year_select()}</label>
          <input
            key={year ?? 'invalid'}
            id="yearly-goal-year"
            name="year"
            type="number"
            inputMode="numeric"
            min="1"
            max="9999"
            step="1"
            required
            defaultValue={year}
            aria-invalid={year === undefined || undefined}
            aria-describedby={year === undefined ? 'yearly-goal-year-error' : undefined}
            className="min-h-11 w-32 rounded-lg border bg-background px-3"
          />
        </div>
        <button type="submit" className={control}>
          {m.library_diary_year_show()}
        </button>
      </form>
      {year === undefined ? (
        <p id="yearly-goal-year-error" role="alert">
          {m.library_yearly_goal_invalid_year()}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">{m.library_diary_year_heading({ year })}</h2>
            <nav aria-label={m.library_diary_period_navigation()} className="flex flex-wrap gap-3">
              {year > 1 ? (
                <a href={`${path}?year=${year - 1}`} className={`${control} underline`}>
                  {m.library_yearly_goal_previous()}
                </a>
              ) : null}
              {year < 9999 ? (
                <a href={`${path}?year=${year + 1}`} className={`${control} underline`}>
                  {m.library_yearly_goal_next()}
                </a>
              ) : null}
            </nav>
          </div>
          {sessionState === 'signed-out' ? (
            <p role="status">{m.library_yearly_goal_signed_out()}</p>
          ) : sessionState === 'unknown' ? (
            <p role="status">{m.library_yearly_goal_checking_session()}</p>
          ) : sessionState === 'unavailable' ? (
            <p role="status">{m.shell_account_unavailable()}</p>
          ) : null}
          {sessionState === 'signed-out' ? (
            <a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} className={`${control} underline`}>
              {m.account_sign_in()}
            </a>
          ) : null}
          <section aria-labelledby="yearly-goal-target" className="space-y-4 rounded-lg border p-4">
            <h2 id="yearly-goal-target" className="text-lg font-semibold">
              {m.library_yearly_goal_target()}
            </h2>
            {sessionState === 'signed-in' && loaded.state === 'loading' ? (
              <p role="status">{m.library_yearly_goal_loading()}</p>
            ) : null}
            {sessionState === 'signed-in' && loaded.state === 'denied' ? <p role="status">{m.ctxw_denied()}</p> : null}
            {sessionState === 'signed-in' && loaded.state === 'retired' ? (
              <p role="status">{m.library_yearly_goal_signed_out()}</p>
            ) : null}
            {sessionState === 'signed-in' && loaded.state === 'unavailable' ? (
              <>
                <p role="status">{m.library_yearly_goal_unavailable()}</p>
                {api && operation === null ? (
                  <button type="button" className={control} onClick={() => void refreshCurrent('manual')}>
                    {m.library_selection_retry()}
                  </button>
                ) : null}
              </>
            ) : null}
            {snapshot ? (
              <>
                {snapshot.target.state === 'unavailable' ? (
                  <p role="status">{m.library_yearly_goal_target_unavailable()}</p>
                ) : snapshot.target.state === 'none' ? (
                  <div>
                    <p>{m.library_yearly_goal_target_none()}</p>
                    <p className="text-sm text-muted-foreground">
                      {snapshot.target.revision === null
                        ? m.library_yearly_goal_never_set()
                        : m.library_yearly_goal_target_revision({ revision: snapshot.target.revision })}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-2xl font-semibold">{snapshot.target.target}</p>
                    <p className="text-sm text-muted-foreground">
                      {m.library_yearly_goal_target_revision({ revision: snapshot.target.revision })}
                    </p>
                  </div>
                )}
                {snapshot.viewer.actions.editTarget.allowed && snapshot.target.state !== 'unavailable' ? (
                  mode === 'edit' ? (
                    <form className="grid max-w-sm gap-3" onSubmit={submitTarget}>
                      <label htmlFor="yearly-goal-target-value">{m.library_yearly_goal_target()}</label>
                      <input
                        id="yearly-goal-target-value"
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        minLength={1}
                        maxLength={4}
                        value={draft}
                        onChange={(event) => setDraft(event.currentTarget.value)}
                        aria-invalid={invalidTarget || undefined}
                        aria-describedby={invalidTarget ? 'yearly-goal-target-error' : undefined}
                        className="min-h-11 rounded-lg border bg-background px-3"
                      />
                      {invalidTarget ? (
                        <p id="yearly-goal-target-error" role="alert">
                          {m.library_yearly_goal_invalid_target()}
                        </p>
                      ) : null}
                      {operation === 'stale' ? <p role="alert">{m.library_yearly_goal_stale()}</p> : null}
                      {operation === 'review' ? <p role="status">{m.library_yearly_goal_review()}</p> : null}
                      <div className="flex flex-wrap gap-3">
                        <button
                          type="submit"
                          className={control}
                          disabled={operation === 'sending' || operation === 'refreshing'}
                        >
                          {m.library_yearly_goal_save()}
                        </button>
                        <button type="button" className={control} onClick={() => setMode('view')}>
                          {m.library_yearly_goal_cancel()}
                        </button>
                      </div>
                    </form>
                  ) : mode === 'clear' ? (
                    <div className="flex flex-wrap items-center gap-3">
                      {snapshot.target.state === 'set' && snapshot.viewer.actions.clearTarget.allowed ? (
                        <button
                          type="button"
                          className={control}
                          disabled={operation === 'sending' || operation === 'refreshing'}
                          onClick={() => commandFor(null)}
                        >
                          {m.library_yearly_goal_clear()}
                        </button>
                      ) : (
                        <p role="status">{m.library_yearly_goal_target_none()}</p>
                      )}
                      <button type="button" className={control} onClick={() => setMode('view')}>
                        {m.library_yearly_goal_cancel()}
                      </button>
                      {operation === 'review' ? <p role="status">{m.library_yearly_goal_review()}</p> : null}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      <button type="button" className={control} onClick={beginEdit}>
                        {m.library_yearly_goal_edit()}
                      </button>
                      {snapshot.target.state === 'set' && snapshot.viewer.actions.clearTarget.allowed ? (
                        <button type="button" className={control} onClick={() => setMode('clear')}>
                          {m.library_yearly_goal_clear()}
                        </button>
                      ) : null}
                    </div>
                  )
                ) : null}
              </>
            ) : null}
            {operation === 'sending' || operation === 'refreshing' ? (
              <p role="status">{m.library_yearly_goal_loading()}</p>
            ) : null}
            {operation === 'saved' ? <p role="status">{m.library_yearly_goal_saved()}</p> : null}
            {operation === 'stale' ? (
              <div className="space-y-3" role="alert">
                <p>{m.library_yearly_goal_stale()}</p>
                <button type="button" className={control} onClick={() => void refreshCurrent('conflict')}>
                  {m.library_yearly_goal_refresh()}
                </button>
              </div>
            ) : null}
            {operation === 'review' ? (
              <button type="button" className={control} onClick={() => void refreshCurrent('conflict')}>
                {m.library_yearly_goal_refresh()}
              </button>
            ) : null}
            {operation === 'uncertain' ? (
              <div className="space-y-3" role="alert">
                <p>{m.library_yearly_goal_uncertain()}</p>
                <button type="button" className={control} onClick={retryExact}>
                  {m.library_yearly_goal_retry_exact()}
                </button>
              </div>
            ) : null}
            {operation === 'denied' ? <p role="alert">{m.ctxw_denied()}</p> : null}
            {operation === 'unavailable' || (operation === 'saved' && loaded.state !== 'ready') ? (
              <button type="button" className={control} onClick={() => void refreshCurrent('readback')}>
                {m.library_selection_retry()}
              </button>
            ) : null}
          </section>
          <section aria-labelledby="yearly-goal-progress" className="space-y-4 rounded-lg border p-4">
            <h2 id="yearly-goal-progress" className="text-lg font-semibold">
              {m.library_yearly_goal_progress()}
            </h2>
            {snapshot?.progress.state === 'available' ? (
              <SummaryView year={year} summary={snapshot.progress.summary} />
            ) : snapshot?.progress.state === 'unavailable' ? (
              <p role="status">{m.library_diary_year_unavailable()}</p>
            ) : loaded.state === 'loading' ? (
              <p role="status">{m.library_yearly_goal_loading()}</p>
            ) : (
              <p role="status">{m.library_yearly_goal_unavailable()}</p>
            )}
            <p className="text-sm text-muted-foreground">{m.library_yearly_goal_coverage()}</p>
            {snapshot ? (
              <button type="button" className={control} onClick={() => void refreshCurrent('manual')}>
                {m.library_yearly_goal_refresh()}
              </button>
            ) : null}
          </section>
        </>
      )}
    </main>
  );
}

function SummaryView({ year, summary }: { year: number; summary: ReportedYearSummary }) {
  const bucketView = (counts: ReportedYearSummary['monthUnallocated'], month?: number | 'unallocated') => (
    <li key={month ?? 'year'} className="min-w-0 rounded-md border p-3">
      {month === undefined ? null : (
        <a
          href={`/${getLocale()}/library/history?year=${year}&month=${month}`}
          className="inline-flex min-h-11 items-center text-start font-medium underline"
        >
          {month === 'unallocated' ? m.library_diary_year_unallocated() : monthName(month)}
        </a>
      )}
      <dl className="mt-2 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm">{m.library_diary_completed()}</dt>
          <dd className="text-xl font-semibold">{counts.completedOccurrences}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_distinct_subjects()}</dt>
          <dd className="text-xl font-semibold">{counts.distinctCompletedSubjects}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_repeats()}</dt>
          <dd className="text-xl font-semibold">{counts.repeatOccurrences}</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm">
        {m.library_diary_year_precision_counts({
          year: counts.finishPrecision.year,
          month: counts.finishPrecision.month,
          day: counts.finishPrecision.day,
        })}
      </p>
    </li>
  );

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm">{m.library_diary_completed()}</dt>
          <dd className="text-2xl font-semibold">{summary.completedOccurrences}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_distinct_subjects()}</dt>
          <dd className="text-xl font-semibold">{summary.distinctCompletedSubjects}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_repeats()}</dt>
          <dd className="text-xl font-semibold">{summary.repeatOccurrences}</dd>
        </div>
      </dl>
      <p className="text-sm">
        {m.library_diary_coverage({
          native: summary.coverage.nativeSessions,
          other: summary.coverage.otherHistory,
          meaning: summary.coverage.unitMeaning,
          unknown: summary.completedOccurrencesWithUnknownProfile,
        })}
      </p>
      <p className="text-sm">
        {m.library_diary_year_coverage({
          initialized: summary.coverage.initializedSessions,
          retained: summary.coverage.retainedSessions,
          missing: summary.coverage.completedOccurrencesWithMissingFinish,
          unsupported: summary.coverage.completedOccurrencesWithUnsupportedFinish,
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {m.library_diary_currentness({ state: summary.currentness.state })} · {summary.currentness.revision}
      </p>
      <h3 className="font-medium">{m.library_diary_year_precision()}</h3>
      <ul className="grid gap-3 sm:grid-cols-2">
        {summary.months.map((bucket) => bucketView(bucket, bucket.month))}
        {bucketView(summary.monthUnallocated, 'unallocated')}
      </ul>
    </div>
  );
}

/** A year/viewer keyed lifetime prevents retained private data and late async completions crossing owners. */
export function YearlyGoalPage({
  year,
  sessionState,
  viewerSubject = null,
  api,
}: {
  year?: number | undefined;
  sessionState: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  viewerSubject?: string | null;
  api?: YearlyGoalPageApi | undefined;
}) {
  const key = `${year ?? 'invalid'}:${viewerSubject ?? 'no-viewer'}:${sessionState}`;
  return <YearlyGoalScreen key={key} year={year} sessionState={sessionState} viewerSubject={viewerSubject} api={api} />;
}
