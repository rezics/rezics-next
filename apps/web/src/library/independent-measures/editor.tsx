import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { Exposure } from '../../kernel/exposure';
import { ProgressDecimalInput } from '../progress-decimal-input-field';
import { progressDecimalIssue } from '../progress-decimal-input';
import { scalarRecordingValue } from '../progress-view';
import { collectEdits, type IndependentMeasure, type MeasureDraft } from './contract';

function valueLabel(measure: IndependentMeasure): string {
  if (measure.kind === 'absent') return m.library_progress_measure_absent();
  if (measure.kind === 'zero') return m.library_progress_measure_zero();
  return (
    scalarRecordingValue(
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
    ) ??
    measure.amount ??
    m.library_progress_measure_absent()
  );
}

function recordingNotice(measure: IndependentMeasure): string | null {
  if (measure.recording === 'historical') return m.library_progress_measure_historical();
  if (measure.recording === 'unsupported') return m.library_progress_measure_recording_unsupported();
  if (measure.recording === 'unavailable') return m.library_progress_measure_recording_unavailable();
  return null;
}

function MeasureDetails({ measure }: { measure: IndependentMeasure }) {
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.library_progress_details()}
      </summary>
      <dl className="grid gap-3 pb-2 sm:grid-cols-2">
        <div>
          <dt>{m.library_progress_unit()}</dt>
          <dd className="whitespace-pre-wrap break-all">
            <code>{measure.unit}</code>
          </dd>
        </div>
        {measure.total !== null ? (
          <div>
            <dt>{m.library_progress_total()}</dt>
            <dd className="break-all tabular-nums">{measure.total}</dd>
          </div>
        ) : null}
        {measure.inputRules?.min !== undefined ? (
          <div>
            <dt>{m.library_progress_minimum()}</dt>
            <dd className="break-all tabular-nums">{measure.inputRules.min}</dd>
          </div>
        ) : null}
        {measure.inputRules?.max !== undefined ? (
          <div>
            <dt>{m.library_progress_maximum()}</dt>
            <dd className="break-all tabular-nums">{measure.inputRules.max}</dd>
          </div>
        ) : null}
      </dl>
      {measure.meaning !== 'known' ? <p>{m.library_progress_measure_label_unavailable()}</p> : null}
    </details>
  );
}

export function IndependentMeasuresReadout({
  measures,
  revision,
}: {
  measures: IndependentMeasure[];
  revision: number;
}) {
  return (
    <section className="space-y-3" aria-label={m.library_progress_measures_heading()}>
      <h3 className="text-sm font-medium text-muted-foreground">{m.library_progress_measures_heading()}</h3>
      <dl className="divide-y divide-border">
        {measures.map((measure) => (
          <div
            key={measure.unit}
            className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:gap-4"
          >
            <dt className="space-y-1 text-sm">
              <span className="block font-medium [overflow-wrap:anywhere]">{measure.label}</span>
              <span className="block text-xs text-muted-foreground">
                {measure.primary ? m.library_progress_measure_primary() : m.library_progress_measure_additional()}
              </span>
            </dt>
            <dd className="min-w-0 space-y-1">
              <p className="font-medium tabular-nums [overflow-wrap:anywhere]">{valueLabel(measure)}</p>
              {measure.total !== null ? (
                <p className="text-sm text-muted-foreground">
                  {m.library_progress_measure_total({ value: measure.total })}
                </p>
              ) : null}
              {recordingNotice(measure) ? (
                <p className="text-sm text-muted-foreground">{recordingNotice(measure)}</p>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <details className="text-sm text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.library_progress_details()}
        </summary>
        <p>{m.library_progress_measures_shared_revision({ revision })}</p>
        <p className="mt-2">{m.library_progress_measures_intro()}</p>
      </details>
    </section>
  );
}

export function IndependentMeasuresEditor({
  measures,
  drafts,
  submitted,
  correctionUnits,
  busy,
  refreshing,
  onRefresh,
  onDraft,
  onClear,
  onReview,
}: {
  measures: IndependentMeasure[];
  drafts: MeasureDraft[];
  submitted: boolean;
  correctionUnits: string[];
  busy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onDraft: (unit: string, text: string) => void;
  onClear: (unit: string) => void;
  onReview: () => void;
}) {
  const headingId = useId();
  const introId = useId();
  const edits = collectEdits(measures, drafts);
  return (
    <section className="space-y-5" aria-labelledby={headingId} aria-describedby={introId}>
      <div className="space-y-2">
        <h3 id={headingId} className="text-lg font-semibold">
          {m.library_progress_measures_heading()}
        </h3>
        <p id={introId} className="text-sm text-muted-foreground">
          {m.library_progress_measures_intro()}
        </p>
      </div>
      {correctionUnits.length ? <p role="alert">{m.library_progress_measures_correction()}</p> : null}
      <div className="space-y-4">
        {measures.map((measure) => {
          const draft = drafts.find((item) => item.unit === measure.unit) ?? {
            unit: measure.unit,
            text: '',
            clear: false,
          };
          const writable = measure.recording === 'supported';
          const changed = edits.some((edit) => edit.unit === measure.unit);
          const issue =
            (submitted || correctionUnits.includes(measure.unit)) && writable && !draft.clear
              ? progressDecimalIssue(draft.text, measure.inputRules ?? {}, true)
              : null;
          const fieldId = `${headingId}-${measure.unit}`;
          const savedId = `${fieldId}-saved`;
          const intentId = `${fieldId}-intent`;
          return (
            <fieldset key={measure.unit} className="min-w-0 space-y-3 rounded-xl border border-border p-4">
              <legend className="max-w-full px-1 text-sm font-medium [overflow-wrap:anywhere]">
                {measure.primary ? m.library_progress_measure_primary() : m.library_progress_measure_additional()}:{' '}
                <span>{measure.label}</span>
              </legend>
              <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-2">
                  <p id={savedId} className="text-sm tabular-nums [overflow-wrap:anywhere]">
                    {m.library_progress_current_total({ value: valueLabel(measure) })}
                  </p>
                  {measure.total !== null ? (
                    <p className="text-sm text-muted-foreground">
                      {m.library_progress_measure_total({ value: measure.total })}
                    </p>
                  ) : null}
                  {recordingNotice(measure) ? (
                    <p className="text-sm text-muted-foreground">{recordingNotice(measure)}</p>
                  ) : null}
                </div>
                <div className="min-w-0 space-y-3">
                  {writable ? (
                    <Field className="gap-2">
                      <FieldLabel htmlFor={fieldId}>{m.library_progress_amount()}</FieldLabel>
                      <ProgressDecimalInput
                        id={fieldId}
                        rules={measure.inputRules}
                        issue={issue}
                        required={!draft.clear}
                        value={draft.clear ? '' : draft.text}
                        disabled={busy || draft.clear}
                        aria-describedby={`${savedId} ${intentId}`}
                        onChange={(event) => onDraft(measure.unit, event.target.value)}
                      />
                    </Field>
                  ) : null}
                  <Exposure operation="progress_session.record">
                    {draft.clear ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                        disabled={busy}
                        onClick={() => onDraft(measure.unit, measure.amount ?? '')}
                      >
                        {m.library_progress_cancel()}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                        disabled={busy || measure.amount === null}
                        onClick={() => onClear(measure.unit)}
                      >
                        {m.library_progress_measure_clear()}
                      </Button>
                    )}
                  </Exposure>
                </div>
              </div>
              <p
                id={intentId}
                role={changed ? 'status' : undefined}
                className={`text-sm [overflow-wrap:anywhere] ${changed ? 'font-medium' : 'text-muted-foreground'}`}
              >
                {draft.clear
                  ? m.library_progress_measures_review_clear({ unit: measure.label })
                  : changed
                    ? m.library_progress_measures_review_amount({ unit: measure.label, amount: draft.text })
                    : m.library_progress_measures_review_unchanged({ unit: measure.label })}
              </p>
              <MeasureDetails measure={measure} />
            </fieldset>
          );
        })}
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">{m.library_progress_scalar_meaning()}</p>
        <div className="flex flex-wrap gap-2">
          <Exposure operation="progress_session.record">
            <Button
              type="button"
              className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
              disabled={busy || !edits.length}
              onClick={onReview}
            >
              {m.library_progress_measure_save()}
            </Button>
          </Exposure>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
            disabled={busy || refreshing}
            onClick={onRefresh}
          >
            {m.library_progress_measures_refresh()}
          </Button>
        </div>
      </div>
    </section>
  );
}
