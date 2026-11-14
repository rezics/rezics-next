import { useEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { ReportedYearSummary } from './private-diary/native';
import type { NativeYearlyGoal } from './yearly-goal-native';

const control =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-4 py-2 text-sm underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type YearlyGoalSnapshot = NativeYearlyGoal;

export type YearlyGoalReadResult =
  | { state: 'ready'; value: YearlyGoalSnapshot }
  | { state: 'denied' | 'retired' | 'unavailable' };

/** The UI hands this exact command to its server adapter; the key is sent as the native header. */
export type YearlyGoalCommand = Readonly<{
  year: number;
  metric: 'completed_consumption_occurrences';
  target: number | null;
  expectedRevision: string | null;
  idempotencyKey: string;
}>;

export type YearlyGoalWriteResult = {
  state:
    | 'applied'
    | 'stale'
    | 'uncertain'
    | 'denied'
    | 'retired'
    | 'unavailable'
    | 'key-conflict'
    | 'erased'
    | 'invalid';
};

/** Rejected transport promises are normalized at this boundary; a current read cannot confirm an uncertain write. */
export type YearlyGoalPageApi = {
  current?: () => boolean;
  read(year: number): Promise<YearlyGoalReadResult>;
  write(command: YearlyGoalCommand): Promise<YearlyGoalWriteResult>;
};

type Loaded = { state: 'loading' } | YearlyGoalReadResult;
type Operation =
  | null
  | 'sending'
  | 'refreshing'
  | 'review'
  | Exclude<YearlyGoalWriteResult['state'], 'applied' | 'retired'>;
type PendingIntent = { command: YearlyGoalCommand; sender: YearlyGoalPageApi['write'] };

async function readCurrent(api: YearlyGoalPageApi, year: number): Promise<YearlyGoalReadResult> {
  try {
    return await api.read(year);
  } catch {
    return { state: 'unavailable' };
  }
}

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
  const [pending, setPending] = useState<PendingIntent>();
  const [operation, setOperation] = useState<Operation>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const unresolved = useRef<PendingIntent | undefined>(undefined);
  const live = () => api !== undefined && (api.current?.() ?? true);

  useEffect(() => {
    const current = ++generation.current;
    if (year === undefined || sessionState !== 'signed-in' || !viewerSubject || !api || !live()) {
      setLoaded({ state: 'unavailable' });
    } else {
      inFlight.current = true;
      void readCurrent(api, year).then((result) => {
        if (generation.current !== current || !live()) return;
        inFlight.current = false;
        setLoaded(result);
      });
    }
    return () => {
      if (generation.current === current) generation.current += 1;
      unresolved.current = undefined;
    };
  }, [api, sessionState, viewerSubject, year]);

  const snapshot = loaded.state === 'ready' ? loaded.value : undefined;
  const busy = operation === 'sending' || operation === 'refreshing';

  async function refreshCurrent(purpose: 'conflict' | 'manual' | 'readback') {
    if (!api || year === undefined || !live() || inFlight.current || unresolved.current) return;
    inFlight.current = true;
    const current = generation.current;
    setOperation('refreshing');
    setLoaded({ state: 'loading' });
    const result = await readCurrent(api, year);
    if (generation.current !== current || !live()) return;
    inFlight.current = false;
    setLoaded(result);
    setOperation(
      result.state === 'ready'
        ? purpose === 'conflict' || mode !== 'view'
          ? 'review'
          : null
        : purpose === 'conflict'
          ? 'stale'
          : 'unavailable',
    );
  }

  async function send(intent: PendingIntent) {
    if (!api || !live() || inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setOperation('sending');
    let result: YearlyGoalWriteResult;
    try {
      result = await intent.sender(intent.command);
    } catch {
      result = { state: 'uncertain' };
    }
    if (generation.current !== current || !live()) return;
    if (result.state === 'applied') {
      unresolved.current = undefined;
      setPending(undefined);
      setMode('view');
      setAcknowledged(true);
      setLoaded({ state: 'loading' });
      setOperation('refreshing');
      if (year === undefined) return;
      const readback = await readCurrent(api, year);
      if (generation.current !== current || !live()) return;
      inFlight.current = false;
      setLoaded(readback);
      setOperation(readback.state === 'ready' ? null : 'unavailable');
      return;
    }
    inFlight.current = false;
    setLoaded({ state: result.state === 'denied' ? 'denied' : result.state === 'retired' ? 'retired' : 'unavailable' });
    if (result.state === 'uncertain') {
      unresolved.current = intent;
      setPending(intent);
      setOperation('uncertain');
      return;
    }
    unresolved.current = undefined;
    setPending(undefined);
    setOperation(result.state === 'retired' ? null : result.state);
  }

  function commandFor(target: number | null) {
    if (
      !api ||
      !live() ||
      inFlight.current ||
      unresolved.current ||
      !snapshot ||
      year === undefined ||
      snapshot.target.state === 'unavailable' ||
      (target !== null && !snapshot.viewer.actions.editTarget.allowed)
    )
      return;
    if (target === null && (snapshot.target.state !== 'set' || !snapshot.viewer.actions.clearTarget.allowed)) return;
    const command: YearlyGoalCommand = Object.freeze({
      year,
      metric: 'completed_consumption_occurrences',
      target,
      expectedRevision: snapshot.target.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    const intent = { command, sender: api.write.bind(api) };
    unresolved.current = intent;
    setAcknowledged(false);
    void send(intent);
  }

  function submitTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!live() || inFlight.current || unresolved.current) return;
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
    if (!snapshot || !live() || inFlight.current || unresolved.current) return;
    setDraft(snapshot.target.state === 'set' ? String(snapshot.target.target) : '');
    setOperation(null);
    setInvalidTarget(false);
    setMode('edit');
  }

  function cancel() {
    if (live() && !inFlight.current && !unresolved.current) setMode('view');
  }

  const retryExact = () => {
    if (pending && unresolved.current === pending) void send(pending);
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
                  <button
                    type="button"
                    className={control}
                    disabled={busy}
                    onClick={() => void refreshCurrent('manual')}
                  >
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
                {(snapshot.viewer.actions.editTarget.allowed || snapshot.viewer.actions.clearTarget.allowed) &&
                snapshot.target.state !== 'unavailable' ? (
                  mode === 'edit' && snapshot.viewer.actions.editTarget.allowed ? (
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
                        <button type="submit" className={control} disabled={busy}>
                          {m.library_yearly_goal_save()}
                        </button>
                        <button type="button" className={control} disabled={busy} onClick={cancel}>
                          {m.library_yearly_goal_cancel()}
                        </button>
                      </div>
                    </form>
                  ) : mode === 'clear' ? (
                    <div className="flex flex-wrap items-center gap-3">
                      {snapshot.target.state === 'set' && snapshot.viewer.actions.clearTarget.allowed ? (
                        <button type="button" className={control} disabled={busy} onClick={() => commandFor(null)}>
                          {m.library_yearly_goal_clear()}
                        </button>
                      ) : (
                        <p role="status">{m.library_yearly_goal_target_none()}</p>
                      )}
                      <button type="button" className={control} disabled={busy} onClick={cancel}>
                        {m.library_yearly_goal_cancel()}
                      </button>
                      {operation === 'review' ? <p role="status">{m.library_yearly_goal_review()}</p> : null}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-3">
                      {snapshot.viewer.actions.editTarget.allowed ? (
                        <button type="button" className={control} disabled={busy} onClick={beginEdit}>
                          {m.library_yearly_goal_edit()}
                        </button>
                      ) : null}
                      {snapshot.target.state === 'set' && snapshot.viewer.actions.clearTarget.allowed ? (
                        <button
                          type="button"
                          className={control}
                          disabled={busy}
                          onClick={() => {
                            if (live() && !inFlight.current && !unresolved.current) setMode('clear');
                          }}
                        >
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
            {acknowledged ? <p role="status">{m.library_yearly_goal_saved()}</p> : null}
            {operation === 'key-conflict' ? <p role="alert">{m.library_yearly_goal_key_conflict()}</p> : null}
            {operation === 'erased' ? <p role="status">{m.library_yearly_goal_receipt_erased()}</p> : null}
            {operation === 'invalid' ? <p role="alert">{m.library_yearly_goal_invalid_target()}</p> : null}
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
            {['unavailable', 'key-conflict', 'erased', 'invalid'].includes(operation ?? '') ? (
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
            {snapshot && !pending ? (
              <button type="button" className={control} disabled={busy} onClick={() => void refreshCurrent('manual')}>
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
          className="inline-flex min-h-11 min-w-11 items-center text-start font-medium underline"
        >
          {month === 'unallocated' ? m.library_diary_year_unallocated() : monthName(month)}
        </a>
      )}
      <dl className="mt-2 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm">{m.library_diary_completed()}</dt>
          <dd className="break-all text-xl font-semibold tabular-nums">{counts.completedOccurrences}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_distinct_subjects()}</dt>
          <dd className="break-all text-xl font-semibold tabular-nums">{counts.distinctCompletedSubjects}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_repeats()}</dt>
          <dd className="break-all text-xl font-semibold tabular-nums">{counts.repeatOccurrences}</dd>
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
          <dd className="break-all text-2xl font-semibold tabular-nums">{summary.completedOccurrences}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_distinct_subjects()}</dt>
          <dd className="break-all text-xl font-semibold tabular-nums">{summary.distinctCompletedSubjects}</dd>
        </div>
        <div>
          <dt className="text-sm">{m.library_diary_repeats()}</dt>
          <dd className="break-all text-xl font-semibold tabular-nums">{summary.repeatOccurrences}</dd>
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
  const source = useRef({ api, version: 0 });
  if (source.current.api !== api) source.current = { api, version: source.current.version + 1 };
  const key = `${getLocale()}:${year ?? 'invalid'}:${viewerSubject ?? 'no-viewer'}:${sessionState}:${source.current.version}`;
  return <YearlyGoalScreen key={key} year={year} sessionState={sessionState} viewerSubject={viewerSubject} api={api} />;
}
