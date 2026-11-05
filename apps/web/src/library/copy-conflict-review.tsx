import { m } from '../paraglide/messages.js';
import type { CopyItem } from './copies-read';

export type ConflictReview =
  | { state: 'idle' | 'loading' | 'unavailable' | 'forbidden' }
  | { state: 'ready'; copy: CopyItem };

export function CopyConflictReview({
  review,
  disabled,
  onReview,
  onAccept,
}: {
  review: ConflictReview;
  disabled: boolean;
  onReview: () => void;
  onAccept: () => void;
}) {
  const control = 'min-h-11 rounded-lg border border-border px-4 py-2 text-primary disabled:opacity-60';
  const copy = review.state === 'ready' ? review.copy : null;
  return (
    <section
      aria-label={m.library_copy_conflict_review_title()}
      className="min-w-0 space-y-3 rounded-lg border border-border p-4"
    >
      <p>{m.library_copy_conflict_review_description()}</p>
      <button type="button" className={control} disabled={disabled || review.state === 'loading'} onClick={onReview}>
        {m.library_copy_conflict_review_open()}
      </button>
      {review.state === 'loading' ? <p role="status">{m.library_copy_detail_loading()}</p> : null}
      {review.state === 'unavailable' ? <p role="status">{m.library_copy_detail_unavailable()}</p> : null}
      {review.state === 'forbidden' ? <p role="alert">{m.library_copy_detail_forbidden()}</p> : null}
      {copy ? (
        <>
          <h3 className="font-medium">{m.library_copy_conflict_review_title()}</h3>
          <dl className="space-y-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
            <div>
              <dt>{m.library_copy_kind()}</dt>
              <dd lang={copy.kindLabelLanguage}>{copy.kindLabel ?? copy.kind ?? m.library_other()}</dd>
            </div>
            <div>
              <dt>{m.library_copy_status()}</dt>
              <dd lang={copy.statusLabelLanguage}>{copy.statusLabel ?? copy.status}</dd>
            </div>
            {[
              [m.library_copy_location(), copy.location],
              [m.library_copy_source(), copy.source],
              [m.library_copy_acquired(), copy.acquiredOn],
              [m.library_copy_disposed(), copy.disposedOn],
              [m.library_copy_note(), copy.note],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || '—'}</dd>
              </div>
            ))}
          </dl>
          {copy.meaning !== 'known' ? (
            <p>{copy.meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable()}</p>
          ) : null}
          <button type="button" className={control} disabled={disabled} onClick={onAccept}>
            {m.library_copy_conflict_review_accept()}
          </button>
        </>
      ) : null}
    </section>
  );
}
