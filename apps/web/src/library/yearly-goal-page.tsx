import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const control =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-4 py-2 text-sm underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The published client does not yet include this API. Do not present an absent target or a zero summary. */
export function YearlyGoalPage({
  year,
  sessionState,
}: {
  year?: number | undefined;
  sessionState: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
}) {
  const locale = getLocale();
  const path = `/${locale}/library/goals`;
  const returnTo = `${path}${year === undefined ? '' : `?year=${year}`}`;
  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-6">
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
          <h2 className="text-lg font-medium">{m.library_diary_year_heading({ year })}</h2>
          <div className="flex flex-wrap gap-3">
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
          </div>
        </>
      )}
      <section aria-label={m.library_yearly_goal_title()} className="space-y-3 rounded-lg border p-4">
        <p role="status">
          {sessionState === 'signed-out'
            ? m.library_yearly_goal_signed_out()
            : sessionState === 'unknown'
              ? m.library_yearly_goal_checking_session()
              : sessionState === 'unavailable'
                ? m.shell_account_unavailable()
                : m.library_yearly_goal_unavailable()}
        </p>
        {sessionState === 'signed-out' ? (
          <a href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`} className={`${control} underline`}>
            {m.account_sign_in()}
          </a>
        ) : null}
        <p className="text-sm text-muted-foreground">{m.library_yearly_goal_coverage()}</p>
      </section>
    </main>
  );
}
