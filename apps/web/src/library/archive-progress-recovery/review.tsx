import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { actionClass } from '../private-export/controls';
import type { Application, Result, Review, ReviewInput } from './native';

export function Evidence({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm [overflow-wrap:anywhere]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
export function EvidenceDetails({ value, title = m.library_archive_entry_evidence() }: { value: unknown; title?: string }) {
  return (
    <details className="min-w-0">
      <summary className={`${actionClass} cursor-pointer`}>{title}</summary>
      <Evidence value={value} />
    </details>
  );
}
function Fact({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 rounded-md border p-3">
      <dt className="font-medium">{title}</dt>
      <dd className="space-y-2">{children}</dd>
    </div>
  );
}
export function progressModeLabel(mode: string) {
  switch (mode) {
    case 'scalar_amount': return m.library_progress_mode_amount();
    case 'cursor_position': return m.library_progress_mode_cursor();
    case 'completed_units': return m.library_progress_mode_units();
    default: return m.library_archive_recovery_effect_unsupported();
  }
}
export function progressStateLabel(state: string) {
  switch (state) {
    case 'active': return m.library_progress_state_active();
    case 'completed': return m.library_progress_state_completed();
    case 'abandoned': return m.library_progress_state_abandoned();
    default: return m.library_archive_recovery_effect_unsupported();
  }
}
function admissionLabel(admission: Review['completedUnits'][number]['admission']) {
  switch (admission) {
    case 'member': return m.library_archive_present_member();
    case 'detached': return m.library_archive_present_detached();
    case 'unavailable': return m.library_archive_present_unavailable();
  }
}
function unsupportedLabel(reason: string) {
  const kind = reason.split(':')[0];
  switch (kind) {
    case 'mode-mapping-not-supported':
    case 'current-profile-unavailable':
    case 'primary-unit-not-admitted':
    case 'cursor-unit-not-admitted':
    case 'completed-unit-mode-not-admitted': return m.library_archive_present_profile_unsupported();
    case 'historical-state-not-expressible': return m.library_archive_present_state_unsupported();
    case 'version-subject-mapping-not-supported': return m.library_archive_present_version_unsupported();
    case 'source-count-not-fully-identified':
    case 'source-count-without-supported-unit-identities':
    case 'units-not-admitted': return m.library_archive_present_units_unsupported();
    case 'cursor-value-not-admitted':
    case 'incomplete-cursor-value': return m.library_archive_present_cursor_unsupported();
    case 'amount':
    case 'total':
    case 'primary-total':
    case 'additional-total':
    case 'additional-unit':
    case 'unknown-source-measure':
    case 'unmapped-additional-measure':
    case 'additional-measures-not-in-source-record': return m.library_archive_present_measure_unsupported();
    default: return m.library_archive_recovery_reason_other();
  }
}
export function unitLabel(measure: Pick<Review['measures'][number], 'currentMeaning'>) {
  const labels = measure.currentMeaning?.labels;
  return labels?.[getLocale()] || labels?.en || m.library_progress_unit_unspecified();
}
function amountEffect(value: Review['measures'][number]['amount']) {
  return value === 'supported'
    ? m.library_archive_present_will_apply()
    : value === 'absent'
      ? m.library_archive_present_stays_absent()
      : m.library_archive_entry_retained();
}

export function RecoveryReview({ review, operands }: { review: Review; operands: ReviewInput }) {
  return (
    <section className="space-y-4" aria-label={m.library_archive_progress_review()}>
      <h2 className="text-xl font-semibold">{m.library_archive_progress_review()}</h2>
      <p className="font-medium" role="status">
        {review.recovery === 'complete'
          ? m.library_archive_present_review_complete()
          : review.recovery === 'partial'
            ? m.library_archive_present_review_partial()
            : m.library_archive_present_review_unsupported()}
      </p>
      <p>{m.library_archive_progress_review_help()}</p>
      <p>{m.library_archive_present_new_session()}</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact title={m.library_archive_progress_pair()}>
          <p>{progressModeLabel(review.current.mode)}</p>
          <p>{review.current.profile.kind === 'supported'
            ? m.library_archive_present_profile_supported()
            : m.library_archive_present_profile_unsupported()}</p>
        </Fact>
        <Fact title={m.library_archive_present_session_state()}>
          <p>{progressStateLabel(review.historical.state)}</p>
          <p className="text-sm text-muted-foreground">{m.library_archive_present_state_help()}</p>
        </Fact>
      </dl>
      {review.measures.length ? (
        <section className="space-y-3" aria-label={m.library_progress_mode_amount()}>
          <h3 className="font-semibold">{m.library_progress_mode_amount()}</h3>
          <p>{m.library_progress_independent_meaning()}</p>
          {review.measures.map((measure, index) => (
            <article key={index} className="space-y-3 rounded-md border p-4">
              <h4 className="font-semibold">{unitLabel(measure)}</h4>
              <dl className="grid gap-3 sm:grid-cols-2">
                <Fact title={m.library_progress_amount()}>
                  <p>{measure.sourceAmount ?? m.library_progress_measure_absent()}</p>
                  <p>{amountEffect(measure.amount)}</p>
                </Fact>
                <Fact title={m.library_progress_total()}>
                  <p>{measure.sourceTotal ?? m.library_progress_measure_absent()}</p>
                  <p>{measure.total === 'supported'
                    ? measure.sourceTotal === null ? m.library_archive_present_stays_absent() : m.library_archive_present_will_apply()
                    : m.library_archive_entry_retained()}</p>
                </Fact>
              </dl>
              <EvidenceDetails value={measure} />
            </article>
          ))}
        </section>
      ) : null}
      {review.current.mode === 'completed_units' || review.completedUnits.length ? (
        <section className="space-y-3" aria-label={m.library_archive_progress_units()}>
          <h3 className="font-semibold">{m.library_archive_progress_units()}</h3>
          <p>{m.library_archive_progress_unit_help({ count: review.historical.completedUnitCount })}</p>
          <ol className="space-y-2">
            {review.completedUnits.map((unit, index) => (
              <li key={unit.unitId} className="rounded-md border p-3">
                <p>{m.library_archive_present_item({ number: index + 1 })} · {admissionLabel(unit.admission)}</p>
                <p className="text-sm text-muted-foreground">{m.library_archive_present_title_unavailable()}</p>
                <EvidenceDetails value={unit} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <section className="space-y-3 rounded-md border p-4" aria-label={m.library_archive_progress_unsupported()}>
        <h3 className="font-semibold">{m.library_archive_progress_unsupported()}</h3>
        <ul className="list-disc space-y-2 pl-5">
          {review.unsupported.map((reason, index) => <li key={index}>{unsupportedLabel(reason)}</li>)}
        </ul>
        <p>{m.library_archive_present_history_unsupported()}</p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact title={m.library_archive_personal_start_date()}>{review.historical.sourceTimes.startedAt}</Fact>
          <Fact title={m.library_archive_personal_finish_date()}>
            {review.historical.sourceTimes.completedAt ?? m.library_progress_measure_absent()}
          </Fact>
        </dl>
      </section>
      {!review.applicable ? <p role="alert">{m.library_archive_present_review_unsupported()}</p> : null}
      <EvidenceDetails title={m.library_archive_progress_exact()} value={{ review, operands }} />
    </section>
  );
}
function applicationLabel(state: Application['state'] | undefined) {
  switch (state) {
    case 'applied': return m.library_archive_recovery_complete_title();
    case 'partial': return m.library_archive_recovery_partial_title();
    case 'stale': return m.library_archive_recovery_conflict_help();
    case 'failed': return m.library_archive_recovery_effect_failed();
    case 'recoverable':
    case 'applying': return m.library_archive_progress_recoverable();
    default: return m.library_archive_progress_no_result();
  }
}
export function RecoveryResult({ application, result, pending }: {
  application: Application | null;
  result: Result | null;
  pending: boolean;
}) {
  if (!application && !result) return null;
  const outcome = result?.application ?? application;
  const unreconciled = pending || outcome?.state === 'recoverable' || outcome?.state === 'applying';
  const session = unreconciled ? null : result?.progressSession;
  const meaning = session && result?.review.measures.find((measure) => measure.currentUnit === session.unit);
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={m.library_archive_progress_result()}>
      <h2 className="text-xl font-semibold">{m.library_archive_progress_result()}</h2>
      <p role="status" className="font-medium">{unreconciled ? m.library_archive_progress_recoverable() : applicationLabel(outcome?.state)}</p>
      {outcome ? <p>{m.library_archive_present_steps({ count: outcome.acceptedSteps })}</p> : null}
      {unreconciled ? null : (
        <>
          <p>{m.library_archive_progress_accepted()}</p>
          {session ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-2">
                <Fact title={m.library_archive_present_session_state()}>{progressStateLabel(session.state)}</Fact>
                <Fact title={m.library_archive_progress_pair()}>{progressModeLabel(session.mode)}</Fact>
                {session.mode === 'scalar_amount' ? <>
                  <Fact title={m.library_progress_amount()}>{session.amount ?? m.library_progress_measure_absent()}</Fact>
                  <Fact title={m.library_progress_total()}>{session.total ?? m.library_progress_measure_absent()}</Fact>
                </> : session.mode === 'cursor_position' ? <>
                  <Fact title={m.library_progress_locator()}>{session.locator ?? m.library_progress_measure_absent()}</Fact>
                  <Fact title={m.library_progress_position()}>{session.position ?? m.library_progress_measure_absent()}</Fact>
                </> : <Fact title={m.library_progress_units()}>{session.completedUnitCount}</Fact>}
              </dl>
              <p className="text-sm">{meaning ? unitLabel(meaning) : m.library_progress_unit_unspecified()}</p>
              {session.measures?.map((measure, index) => (
                <div key={index} className="rounded border p-3">
                  <p>{unitLabel(result!.review.measures.find((item) => item.currentUnit === measure.unit) ?? { currentMeaning: null })}</p>
                  <p>{m.library_progress_amount()}: {measure.amount ?? m.library_progress_measure_absent()}</p>
                  <p>{m.library_progress_total()}: {measure.total ?? m.library_progress_measure_absent()}</p>
                </div>
              ))}
              {result?.completedEpisodes ? (
                <div className="space-y-2">
                  <h3 className="font-semibold">{m.library_progress_units()}</h3>
                  <ol className="space-y-2">
                    {result.completedEpisodes.episodes.map((episode, index) => (
                      <li key={index}>
                        {m.library_archive_present_item({ number: index + 1 })} · {admissionLabel(episode.membership)} ·{' '}
                        {episode.completed === true ? m.library_archive_recovery_effect_applied() : episode.completed === false
                          ? m.library_archive_recovery_effect_not_applicable() : m.library_archive_present_unavailable()}
                      </li>
                    ))}
                  </ol>
                  {result.completedEpisodes.next ? <p>{m.library_archive_present_more_evidence()}</p> : null}
                </div>
              ) : null}
            </>
          ) : <p>{m.library_archive_progress_no_result()}</p>}
        </>
      )}
      <EvidenceDetails value={unreconciled ? { application: outcome } : { application, result }} />
    </section>
  );
}
