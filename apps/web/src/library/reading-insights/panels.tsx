import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import type { PanelValue, ReadingInsightsOverview } from './native';
import { insightsDiaryHref } from './address';

export const insightLink = 'inline-flex min-h-11 items-center py-2 text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const cell = 'border-b border-border px-3 py-3 text-start align-top tabular-nums';
export function Facts({ values }: { values: readonly (readonly [string, ReactNode])[] }) {
  return <dl className="grid min-w-0 gap-3 sm:grid-cols-2">{values.map(([name, value]) =>
    <div key={name} className="min-w-0"><dt className="text-sm text-muted-foreground">{name}</dt><dd className="break-words font-medium tabular-nums">{value}</dd></div>)}</dl>;
}
function exact(value: string | number | null) { return value === null ? m.library_insights_not_supplied() : String(value); }
function Coverage({ value }: { value: { initializedSessions: string | null; retainedSessions: string | null } }) {
  return <p className="text-sm text-muted-foreground">{m.library_insights_coverage({
    initialized: value.initializedSessions ?? m.library_insights_unknown(), retained: value.retainedSessions ?? m.library_insights_unknown(),
  })}</p>;
}
function Snapshot({ value }: { value: { revision: string; source?: string; retainedSourceRevision?: string } }) {
  return <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">{m.library_insights_exact_details()}</summary>
    <Facts values={[
      [m.library_insights_snapshot(), value.revision],
      ...(value.source === undefined ? [] : [[m.library_insights_source(), value.source] as const]),
      ...(value.retainedSourceRevision === undefined ? [] : [[m.library_insights_retained_revision(), value.retainedSourceRevision] as const]),
    ]} />
  </details>;
}
function Unavailable({ value }: { value: { reason: 'not_installed' | 'initializing' | 'maintenance_unavailable'; coverage: { initializedSessions: string | null; retainedSessions: string | null } } }) {
  const message = value.reason === 'not_installed' ? m.library_insights_not_installed()
    : value.reason === 'initializing' ? m.library_insights_initializing() : m.library_insights_maintenance_unavailable();
  return <div role="status" className="space-y-3"><p>{message}</p><Coverage value={value.coverage} /></div>;
}
export function InsightsPanel<T>({ id, title, value, children }: {
  id: string; title: string; value: { status: 'received'; value: T } | { status: 'failed'; reason: string }; children: (value: T) => ReactNode;
}) {
  return <section aria-labelledby={id} className="min-w-0 space-y-4 rounded-xl border border-border p-4 sm:p-6">
    <h2 id={id} className="text-xl font-semibold">{title}</h2>
    {value.status === 'failed' ? <div role="status"><p>{m.library_insights_failed()}</p>
      <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">{m.library_insights_exact_details()}</summary><code>{value.reason}</code></details>
    </div> : children(value.value)}
  </section>;
}
type CompletionCounts = Pick<PanelValue<'allTime'>, 'completedOccurrences' | 'distinctCompletedSubjects' | 'repeatOccurrences' | 'completedOccurrencesWithUnknownProfile'>;
function completionFacts(value: CompletionCounts) {
  return [
    [m.library_insights_completed(), value.completedOccurrences], [m.library_insights_distinct(), value.distinctCompletedSubjects],
    [m.library_insights_repeats(), value.repeatOccurrences], [m.library_insights_unknown_profile(), value.completedOccurrencesWithUnknownProfile],
  ] as const;
}
export function AllTimePanel({ value }: { value: PanelValue<'allTime'> }) {
  return <><Facts values={completionFacts(value)} /><p className="text-sm text-muted-foreground">{m.library_insights_native_only()}</p><Snapshot value={value.currentness} /></>;
}
export function monthName(month: number) {
  return new Intl.DateTimeFormat(getLocale(), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, 1)));
}
export function YearPanel({ value, actions, current }: { value: PanelValue<'reportedYear'>; actions: ReadingInsightsOverview['actions']; current: () => boolean }) {
  const locale = getLocale();
  const monthRows = [...value.months.map((row) => ({ row, label: monthName(row.month), action: actions.months.find((action) => action.month === row.month)! })),
    { row: value.monthUnallocated, label: m.library_insights_unallocated(), action: actions.unallocatedMonth }];
  return <>
    <p className="text-sm text-muted-foreground">{m.library_insights_year_help()}</p>
    <Facts values={completionFacts(value)} />
    <div className="overflow-x-auto" role="region" aria-label={m.library_insights_reported_year({ year: value.year })} tabIndex={0}>
      <table className="w-full text-sm"><caption className="pb-3 text-start font-medium">{m.library_insights_reported_year({ year: value.year })}</caption>
        <thead><tr>{[m.library_insights_month(), m.library_insights_completed(), m.library_insights_distinct(), m.library_insights_repeats(), m.library_insights_unknown_profile()].map((name) => <th key={name} scope="col" className={cell}>{name}</th>)}</tr></thead>
        <tbody>{monthRows.map(({ row, label, action }) => <tr key={label}>
          <th scope="row" className={cell}><a className={insightLink} href={insightsDiaryHref(action, locale)} onClick={(event) => { if (!current()) event.preventDefault(); }}>{label}</a></th>
          <td className={cell}>{row.completedOccurrences}</td><td className={cell}>{row.distinctCompletedSubjects}</td><td className={cell}>{row.repeatOccurrences}</td><td className={cell}>{row.completedOccurrencesWithUnknownProfile}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <Facts values={[[m.library_insights_missing_finish(), value.coverage.completedOccurrencesWithMissingFinish], [m.library_insights_unsupported_finish(), value.coverage.completedOccurrencesWithUnsupportedFinish]]} />
    <p className="text-sm text-muted-foreground">{m.library_insights_native_only()}</p>
    <Coverage value={value.coverage} />
    <details><summary className="min-h-11 cursor-pointer py-3">{m.library_insights_precision()}</summary>
      <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">{m.library_insights_precision()}</caption>
        <thead><tr>{[m.library_insights_month(), m.library_insights_precision_year(), m.library_insights_precision_month(), m.library_insights_precision_day()].map((label) => <th key={label} scope="col" className={cell}>{label}</th>)}</tr></thead>
        <tbody>{[{ row: value, label: m.library_insights_reported_year({ year: value.year }) }, ...monthRows].map(({ row, label }) => <tr key={label}>
          <th scope="row" className={cell}>{label}</th><td className={cell}>{row.finishPrecision.year}</td><td className={cell}>{row.finishPrecision.month}</td><td className={cell}>{row.finishPrecision.day}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
    <Snapshot value={value.currentness} />
  </>;
}
type Profile = Extract<PanelValue<'profiles'>, { state: 'available' }>['profiles'][number]['profile'];
function ProfilePin({ value }: { value: Profile }) {
  return <Facts values={[[m.library_insights_profile_id(), value.profileId], [m.library_insights_release(), value.releaseDigest],
    [m.library_insights_accepting_type(), value.acceptingType ?? m.library_insights_unknown()], [m.library_insights_provenance(), value.provenance]]} />;
}
export function ProfilesPanel({ value }: { value: PanelValue<'profiles'> }) {
  if (value.state === 'unavailable') return <Unavailable value={value} />;
  const rows = [
    ...value.profiles.map((row) => ({ key: JSON.stringify(row.profile), label: row.profile.profileId, ...row })),
    { key: 'unknown', label: m.library_insights_unknown_profile(), ...value.unknown, profile: null },
    { key: 'remainder', label: m.library_insights_remaining_profiles({ count: value.remainder.profileGroups }), ...value.remainder, profile: null },
  ];
  return <>
    <p className="text-sm text-muted-foreground">{m.library_insights_profile_help()}</p>
    <Facts values={[[m.library_insights_completed(), value.totals.completedOccurrences], [m.library_insights_within_profile(), value.totals.repeatOccurrencesWithinProfile]]} />
    <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">{m.library_insights_profiles()}</caption>
      <thead><tr>{[m.library_insights_profile_id(), m.library_insights_completed(), m.library_insights_within_profile()].map((label) => <th key={label} scope="col" className={cell}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}><th scope="row" className={cell}>
        {row.label}{row.profile ? <details className="mt-2 font-normal"><summary className="min-h-11 cursor-pointer py-2">{m.library_insights_exact_details()}</summary><ProfilePin value={row.profile} /></details> : null}
      </th><td className={cell}>{row.completedOccurrences}</td><td className={cell}>{row.repeatOccurrencesWithinProfile}</td></tr>)}</tbody>
    </table></div><p className="text-sm text-muted-foreground">{m.library_insights_native_only()}</p><Coverage value={value.coverage} /><Snapshot value={value.currentness} />
  </>;
}
type Progress = Extract<PanelValue<'currentProgress'>, { state: 'available' }>;
function GroupCounts({ value }: { value: Progress['active']['remainder'] }) {
  return <p className="text-sm text-muted-foreground">{m.library_insights_group_counts({ occurrences: value.occurrences,
    current: value.currentValueCount, missingCurrent: value.missingCurrentValueCount, total: value.totalValueCount, missingTotal: value.missingTotalValueCount })}</p>;
}
function ProgressScope({ value, title }: { value: Progress['active']; title: string }) {
  return <section className="space-y-4"><h3 className="text-lg font-medium">{title}</h3>
    <p>{m.library_insights_scope_counts({ sessions: value.sessionCount, covered: value.coveredSessions })}</p>
    {value.sessionCount === '0' ? <p>{m.library_insights_none()}</p> : null}
    <ul className="space-y-4">{value.groups.map((group) => {
      const meaning = group.meaning;
      const currentLabel = meaning.mode === 'cursor_position' ? m.library_insights_current_cursor()
        : meaning.mode === 'completed_units' ? m.library_insights_current_units() : m.library_insights_current_amount();
      return <li key={JSON.stringify(meaning)} className="min-w-0 space-y-3 rounded-lg bg-muted/40 p-4">
        <h4 className="font-medium">{meaning.unit} · {m.library_insights_revision({ revision: meaning.meaningRevision })}</h4>
        <Facts values={[[currentLabel, exact(group.currentValue)], [m.library_insights_total_value(), exact(group.totalValue)]]} />
        {meaning.mode === 'cursor_position' ? <p className="text-sm text-muted-foreground">{m.library_insights_cursor_help()}</p> : null}
        <GroupCounts value={{ ...group, groupCount: '1' }} />
        <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3">{m.library_insights_exact_details()}</summary>
          <div className="space-y-4"><ProfilePin value={meaning.profilePin} /><Facts values={[
            [m.library_insights_unit_id(), meaning.unitId], [m.library_insights_unit(), meaning.unit], [m.library_insights_mode(), meaning.mode],
            [m.library_insights_dimension(), exact(meaning.dimension)], [m.library_insights_decimal_places(), exact(meaning.precision)],
            [m.library_insights_minimum(), exact(meaning.minimum)], [m.library_insights_maximum(), exact(meaning.maximum)],
            [m.library_insights_total_policy(), exact(meaning.totalPolicy)], [m.library_insights_identity(), meaning.identityKind],
            [m.library_insights_structure(), meaning.structureKind], [m.library_insights_locator(), exact(meaning.locator)],
          ]} /></div>
        </details>
      </li>;
    })}</ul>
    <div className="space-y-2 border-t border-border pt-3"><p>{m.library_insights_remaining_groups({ count: value.remainder.groupCount })}</p><GroupCounts value={value.remainder} /></div>
  </section>;
}
export function ProgressPanel({ value }: { value: PanelValue<'currentProgress'> }) {
  if (value.state === 'unavailable') return <Unavailable value={value} />;
  return <>
    <p className="text-sm text-muted-foreground">{m.library_insights_current_help()}</p>
    <Facts values={[[m.library_insights_covered(), value.coverage.coveredSessions], [m.library_insights_unsupported(), value.coverage.unsupportedSessions]]} />
    <p className="text-sm text-muted-foreground">{m.library_insights_group_help()}</p>
    <div className="grid min-w-0 gap-6 xl:grid-cols-2"><ProgressScope title={m.library_insights_active()} value={value.active} /><ProgressScope title={m.library_insights_backlog()} value={value.backlog} /></div>
    <Coverage value={value.coverage} /><Snapshot value={value.currentness} />
  </>;
}
export function AssessmentsPanel({ value }: { value: PanelValue<'assessments'> }) {
  if (value.state === 'unavailable') return <Unavailable value={value} />;
  return <>
    <p className="text-sm text-muted-foreground">{m.library_insights_assessments_help()}</p>
    <p>{m.library_insights_scope_counts({ sessions: value.coverage.retainedSessions ?? m.library_insights_unknown(), covered: value.coverage.includedSessions })}</p>
    {value.coverage.includedSessions === '0' ? <p>{m.library_insights_none()}</p> : null}
    <ul className="space-y-5">{value.revisions.map((row) => <li key={row.meaningRevision} className="min-w-0 space-y-3 border-t border-border pt-4">
      <h3 className="font-medium">{m.library_insights_revision({ revision: row.meaningRevision })}</h3>
      <Facts values={[[m.library_insights_absent(), row.counts.absent], [m.library_insights_explicit_null(), row.counts.explicitNull],
        [m.library_insights_value(), row.counts.value], [m.library_insights_historical_unknown(), row.counts.historicalUnknown]]} />
      <table className="w-full text-sm"><caption className="sr-only">{m.library_insights_revision({ revision: row.meaningRevision })}</caption>
        <thead><tr><th scope="col" className={cell}>{m.library_insights_assessment_value()}</th><th scope="col" className={cell}>{m.library_insights_occurrences()}</th></tr></thead>
        <tbody>{row.values.map((bucket) => <tr key={bucket.units}><th scope="row" className={cell}>{bucket.units / 2}</th><td className={cell}>{bucket.occurrences}</td></tr>)}</tbody>
      </table>
    </li>)}</ul><Coverage value={value.coverage} /><Snapshot value={value.currentness} />
  </>;
}
