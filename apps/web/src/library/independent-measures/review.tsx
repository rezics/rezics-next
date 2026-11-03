import { m } from '../../paraglide/messages.js';
import type { IndependentMeasure, MeasureEdit } from './contract';
import { independentActionClass, independentPrimaryActionClass } from './recovery';

export function IndependentMeasuresReview({
  revision,
  measures,
  edits,
  busy,
  onConfirm,
  onCancel,
}: {
  revision: number;
  measures: IndependentMeasure[];
  edits: MeasureEdit[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-4" aria-label={m.library_progress_measures_review()}>
      <h3 className="text-lg font-semibold">{m.library_progress_measures_review()}</h3>
      <p className="text-sm">{m.library_progress_measures_shared_revision({ revision })}</p>
      <dl className="space-y-3">
        {measures.map((measure) => {
          const edit = edits.find((item) => item.unit === measure.unit);
          const label = measure.label || measure.unit;
          return (
            <div key={measure.unit}>
              <dt className="text-sm font-medium">
                {measure.primary ? m.library_progress_measure_primary() : m.library_progress_measure_additional()} ·{' '}
                {label}
              </dt>
              <dd className="break-all text-sm">
                {!edit
                  ? m.library_progress_measures_review_unchanged({ unit: measure.unit })
                  : edit.kind === 'clear'
                    ? m.library_progress_measures_review_clear({ unit: measure.unit })
                    : m.library_progress_measures_review_amount({ unit: measure.unit, amount: edit.amount ?? '' })}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={independentPrimaryActionClass} disabled={busy} onClick={onConfirm}>
          {m.library_progress_confirm_correction()}
        </button>
        <button type="button" className={independentActionClass} disabled={busy} onClick={onCancel}>
          {m.library_progress_cancel()}
        </button>
      </div>
    </section>
  );
}
