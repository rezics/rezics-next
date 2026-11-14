import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { IndependentMeasure, MeasureEdit } from './contract';

export function IndependentMeasuresReview({
  revision,
  measures,
  edits,
  busy,
  correction = false,
  onConfirm,
  onCancel,
}: {
  revision: number;
  measures: IndependentMeasure[];
  edits: MeasureEdit[];
  busy: boolean;
  correction?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-muted/30 p-4"
      aria-label={m.library_progress_measures_review()}
    >
      <h3 className="text-lg font-semibold">{m.library_progress_measures_review()}</h3>
      <p className="text-sm text-muted-foreground">{m.library_progress_measures_intro()}</p>
      {correction ? <p role="alert">{m.library_progress_measures_correction()}</p> : null}
      <dl className="divide-y divide-border">
        {measures.map((measure) => {
          const edit = edits.find((item) => item.unit === measure.unit);
          return (
            <div key={measure.unit} className="space-y-1 py-3">
              <dt className="text-sm font-medium [overflow-wrap:anywhere]">{measure.label}</dt>
              <dd
                className={`text-sm tabular-nums [overflow-wrap:anywhere] ${edit ? 'font-medium' : 'text-muted-foreground'}`}
              >
                {!edit
                  ? m.library_progress_measures_review_unchanged({ unit: measure.label })
                  : edit.kind === 'clear'
                    ? m.library_progress_measures_review_clear({ unit: measure.label })
                    : m.library_progress_measures_review_amount({ unit: measure.label, amount: edit.amount ?? '' })}
              </dd>
            </div>
          );
        })}
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {onConfirm ? (
          <Button
            type="button"
            className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
            disabled={busy}
            onClick={onConfirm}
          >
            {m.library_progress_confirm_correction()}
          </Button>
        ) : null}
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
            disabled={busy}
            onClick={onCancel}
          >
            {m.library_progress_cancel()}
          </Button>
        ) : null}
      </div>
      <details className="text-sm text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.library_progress_details()}
        </summary>
        <p>{m.library_progress_measures_shared_revision({ revision })}</p>
        <ul className="mt-2 space-y-1">
          {measures.map((measure) => (
            <li key={measure.unit}>
              <code className="break-all">{measure.unit}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
