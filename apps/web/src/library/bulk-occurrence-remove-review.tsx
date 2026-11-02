import { m } from '../paraglide/messages.js';
import type { BulkOccurrenceRemoveCapture } from './bulk-occurrence-remove';

/** Selection presentation only; the native operation journey owns preview and confirmation controls. */
export function BulkOccurrenceRemoveReview({ capture }: { capture: BulkOccurrenceRemoveCapture }) {
  return (
    <section aria-label={m.library_bulk_occurrence_remove_review()} className="space-y-3 rounded-xl border p-3">
      <h2 className="font-semibold">{m.library_bulk_occurrence_remove_review()}</h2>
      <p>{m.library_bulk_occurrence_remove_source({ title: capture.source.title })}</p>
      <p className="break-all text-sm text-muted-foreground">{capture.source.id}</p>
      <p>{m.library_bulk_occurrence_remove_selection({ count: capture.targets.length })}</p>
      <ol className="space-y-2">
        {capture.targets.map((target) => (
          <li key={target.memberId} className="break-all text-sm">
            {m.library_bulk_occurrence_remove_target({ memberId: target.memberId, subjectId: target.subjectId })}
          </li>
        ))}
      </ol>
    </section>
  );
}
