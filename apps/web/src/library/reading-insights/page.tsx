import { useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { insightsDiaryHref, insightsHref, insightsSearch } from './address';
import { useInsightsReading, type InsightsReader, type InsightsState } from './current';
import { AllTimePanel, AssessmentsPanel, InsightsPanel, ProfilesPanel, ProgressPanel, YearPanel, insightLink } from './panels';

const control = 'min-h-11 rounded-lg border border-border bg-background px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50';

export function ReadingInsightsView({ year, state, onRefresh, canRefresh = true, current = () => true, onYear }: {
  year: number | undefined; state: InsightsState; onRefresh: () => void; canRefresh?: boolean;
  current?: () => boolean; onYear: (year: number) => void;
}) {
  const locale = getLocale();
  const [draft, setDraft] = useState(year === undefined ? '' : String(year));
  const [invalid, setInvalid] = useState(false);
  const value = state.kind === 'ready' && current() ? state.value : null;
  function selectYear(event: FormEvent) {
    event.preventDefault();
    const selected = insightsSearch({ year: draft }).year;
    setInvalid(typeof selected !== 'number');
    if (typeof selected === 'number') onYear(selected);
  }
  const notice = state.kind === 'invalid' ? m.library_insights_invalid_year()
    : state.kind === 'signed-out' || state.kind === 'retired' ? m.library_insights_signed_out()
    : state.kind === 'denied' ? m.library_insights_denied()
    : state.kind === 'closed' ? m.platform_closed_heading()
    : state.kind === 'unavailable' ? m.library_insights_unavailable()
    : state.kind === 'loading' ? m.library_insights_loading() : m.library_insights_changed();
  return <article className="mx-auto min-w-0 max-w-6xl space-y-6 px-4 py-8 text-foreground [overflow-wrap:anywhere]">
    <header className="space-y-3">
      <a href={`/${locale}/library`} className={insightLink}>{m.nav_library()}</a>
      <PageHeading>{m.library_insights_title()}</PageHeading>
      <p className="max-w-prose text-muted-foreground">{m.library_insights_intro()}</p>
      <form onSubmit={selectYear} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><label htmlFor="insights-year" className="block text-sm font-medium">{m.library_insights_year()}</label>
          <input id="insights-year" name="year" inputMode="numeric" value={draft} onChange={(event) => setDraft(event.target.value)}
            aria-invalid={invalid || state.kind === 'invalid'} aria-describedby={invalid || state.kind === 'invalid' ? 'insights-year-error' : undefined} className={`${control} w-28`} />
        </div>
        <button type="submit" className={control}>{m.library_insights_open_year()}</button>
        <button type="button" className={control} onClick={onRefresh} disabled={!canRefresh || state.kind === 'loading' || year === undefined}>{m.library_insights_refresh()}</button>
      </form>
      {invalid || state.kind === 'invalid' ? <p id="insights-year-error" role="alert">{m.library_insights_invalid_year()}</p> : null}
    </header>
    {!value ? <div role="status" className="space-y-3 rounded-xl border border-border p-5"><p>{notice}</p>
      {state.kind === 'signed-out' || state.kind === 'retired' ? <a className={insightLink} href={`/auth/sign-in?return_to=${encodeURIComponent(year === undefined ? `/${locale}/library/insights` : insightsHref(year, locale))}`}>{m.account_sign_in()}</a> : null}
    </div> : <>
      <p className="text-sm text-muted-foreground">{m.library_insights_independent()}</p>
      <nav aria-label={m.library_insights_diary()}><a href={insightsDiaryHref(value.actions.diary, locale)} className={insightLink} onClick={(event) => { if (!current()) event.preventDefault(); }}>{m.library_insights_diary()}</a></nav>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <InsightsPanel id="insights-all-time" title={m.library_insights_all_time()} value={value.panels.allTime}>{(panel) => <AllTimePanel value={panel} />}</InsightsPanel>
        <InsightsPanel id="insights-profiles" title={m.library_insights_profiles()} value={value.panels.profiles}>{(panel) => <ProfilesPanel value={panel} />}</InsightsPanel>
      </div>
      <InsightsPanel id="insights-year-panel" title={m.library_insights_reported_year({ year: value.year })} value={value.panels.reportedYear}>{(panel) => <YearPanel value={panel} actions={value.actions} current={current} />}</InsightsPanel>
      <InsightsPanel id="insights-progress" title={m.library_insights_current_progress()} value={value.panels.currentProgress}>{(panel) => <ProgressPanel value={panel} />}</InsightsPanel>
      <InsightsPanel id="insights-assessments" title={m.library_insights_assessments()} value={value.panels.assessments}>{(panel) => <AssessmentsPanel value={panel} />}</InsightsPanel>
    </>}
  </article>;
}

export function ReadingInsightsPage({ year, onYear, reader }: { year: number | undefined; onYear: (year: number) => void; reader?: InsightsReader }) {
  const reading = useInsightsReading(year, reader);
  return <ReadingInsightsView key={year} year={year} state={reading.result} canRefresh={reading.canRefresh} current={reading.current} onRefresh={reading.refresh} onYear={onYear} />;
}
