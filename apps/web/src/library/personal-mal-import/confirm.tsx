import { m } from '../../paraglide/messages.js';
import type { MalPreviewRow } from './contract';
import { MalAction } from './controls';
import { admittedFields, malKindLabel, malMatchLabel } from './meaning';

export function MalConfirmPage({
  rows,
  busy,
  onBack,
  onConfirm,
}: {
  rows: MalPreviewRow[];
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = rows.filter((row) => row.review);
  return (
    <section className="space-y-4" data-mal-stage="confirm">
      <p>{m.library_mal_confirm_help({ count: ready.length })}</p>
      <ul className="space-y-3">
        {ready.map((row) => {
          const review = row.review!;
          const fields = review.skip ? [] : admittedFields(row);
          return (
            <li key={row.index} className="rounded-md border p-3">
              <p className="font-medium [overflow-wrap:anywhere]">{row.title}</p>
              <p className="text-sm">
                {malKindLabel(row.kind)} · {malMatchLabel(row.match, review.skip)}
              </p>
              <p className="text-sm">
                {m.library_mal_confirm_fields({
                  fields: review.skip
                    ? m.library_mal_match_skipped()
                    : fields.join(', ') || m.library_mal_result_unsupported(),
                })}
              </p>
              {review.target ? <p className="text-sm [overflow-wrap:anywhere]">{review.target}</p> : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-3">
        <MalAction type="button" variant="outline" disabled={busy} onClick={onBack}>
          {m.library_mal_return_review()}
        </MalAction>
        <MalAction type="button" disabled={busy || ready.length === 0} onClick={onConfirm} aria-busy={busy}>
          {busy ? m.library_mal_confirming() : m.library_mal_confirm()}
        </MalAction>
      </div>
    </section>
  );
}
