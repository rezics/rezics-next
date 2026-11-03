import { useId } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { Exposure } from '../../kernel/exposure';
import { ProgressDecimalInput } from '../progress-decimal-input-field';
import { progressDecimalIssue } from '../progress-decimal-input';
import { scalarRecordingValue } from '../progress-view';
import type { IndependentMeasure, MeasureDraft } from './contract';
import { independentActionClass, independentPrimaryActionClass } from './recovery';

function valueLabel(measure: IndependentMeasure): string {
  if (measure.kind === 'absent') return m.library_progress_measure_absent();
  if (measure.kind === 'zero') return m.library_progress_measure_zero();
  return scalarRecordingValue(
    {
      mode: 'scalar_amount',
      unit: measure.unit,
      amount: measure.amount,
      total: null,
      completedUnitCount: 0,
      locator: null,
      ...(measure.label !== measure.unit ? { unitLabel: measure.label } : {}),
    },
    measure.amount,
    getLocale(),
  ) ?? measure.amount ?? m.library_progress_measure_absent();
}

export function IndependentMeasuresReadout({ measures, revision }: { measures: IndependentMeasure[]; revision: number }) {
  return (
    <section className="space-y-3" aria-label={m.library_progress_measures_heading()}>
      <h3 className="text-lg font-semibold">{m.library_progress_measures_heading()}</h3>
      <p className="text-sm text-muted-foreground">{m.library_progress_measures_intro()}</p>
      <p className="text-sm">{m.library_progress_measures_shared_revision({ revision })}</p>
      <ul className="space-y-3">
        {measures.map((measure) => (
          <li key={measure.unit} className="min-w-0 space-y-1 rounded-lg border border-border p-3">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">
              {measure.primary ? m.library_progress_measure_primary() : m.library_progress_measure_additional()}:{' '}
              {measure.label}
            </p>
            <p className="text-sm">{valueLabel(measure)}</p>
            {measure.total ? (
              <p className="text-sm text-muted-foreground">{m.library_progress_measure_total({ value: measure.total })}</p>
            ) : null}
            {measure.recording === 'historical' ? (
              <p className="text-sm text-muted-foreground">{m.library_progress_measure_historical()}</p>
            ) : null}
            {measure.recording === 'unsupported' ? (
              <p className="text-sm text-muted-foreground">{m.library_progress_measure_recording_unsupported()}</p>
            ) : null}
            {measure.recording === 'unavailable' ? (
              <p className="text-sm text-muted-foreground">{m.library_progress_measure_recording_unavailable()}</p>
            ) : null}
            {measure.meaning !== 'known' ? (
              <p className="text-sm text-muted-foreground">{m.library_progress_measure_label_unavailable()}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function IndependentMeasuresEditor({
  measures,
  drafts,
  submitted,
  busy,
  onDraft,
  onClear,
  onReview,
}: {
  measures: IndependentMeasure[];
  drafts: MeasureDraft[];
  submitted: boolean;
  busy: boolean;
  onDraft: (unit: string, text: string) => void;
  onClear: (unit: string) => void;
  onReview: () => void;
}) {
  const headingId = useId();
  return (
    <section className="space-y-4" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-lg font-semibold">
        {m.library_progress_measures_heading()}
      </h3>
      <p className="text-sm text-muted-foreground">{m.library_progress_measures_intro()}</p>
      <div className="grid gap-4 md:grid-cols-2">
        {measures.map((measure) => {
          const draft = drafts.find((item) => item.unit === measure.unit) ?? { unit: measure.unit, text: '', clear: false };
          const writable = measure.recording === 'supported';
          const issue = submitted && writable && !draft.clear ? progressDecimalIssue(draft.text, measure.inputRules ?? {}, true) : null;
          const fieldId = `${headingId}-${measure.unit}`;
          return (
            <fieldset key={measure.unit} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium [overflow-wrap:anywhere]">
                {measure.primary ? m.library_progress_measure_primary() : m.library_progress_measure_additional()}: {measure.label}
              </legend>
              <p className="text-sm">
                {m.library_progress_current_total({ value: valueLabel(measure) })}
              </p>
              {writable ? (
                <>
                  <label htmlFor={fieldId} className="text-sm font-medium">
                    {m.library_progress_amount()}
                  </label>
                  <ProgressDecimalInput
                    id={fieldId}
                    rules={measure.inputRules}
                    issue={issue}
                    required={!draft.clear}
                    value={draft.clear ? '' : draft.text}
                    disabled={busy}
                    onChange={(event) => onDraft(measure.unit, event.target.value)}
                  />
                  <Exposure operation="progress_session.record">
                    <button
                      type="button"
                      className={independentActionClass}
                      disabled={busy || measure.amount === null}
                      onClick={() => onClear(measure.unit)}
                    >
                      {m.library_progress_measure_clear()}
                    </button>
                  </Exposure>
                </>
              ) : measure.recording === 'historical' ? (
                <p className="text-sm text-muted-foreground">{m.library_progress_measure_historical()}</p>
              ) : measure.recording === 'unsupported' ? (
                <p className="text-sm text-muted-foreground">{m.library_progress_measure_recording_unsupported()}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{m.library_progress_measure_recording_unavailable()}</p>
              )}
            </fieldset>
          );
        })}
      </div>
      <Exposure operation="progress_session.record">
        <button type="button" className={independentPrimaryActionClass} disabled={busy} onClick={onReview}>
          {m.library_progress_measure_save()}
        </button>
      </Exposure>
    </section>
  );
}
