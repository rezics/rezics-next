import { m } from '../../paraglide/messages.js';
import { ImportSourceChecks, ImportSourceEvidence } from '../rich-private-entry/source-confirm';
import type { MalPreviewRow } from './contract';
import { MalAction } from './controls';
import { admittedFields, malKindLabel, malMatchLabel } from './meaning';
import { malSourcePreview } from './source';

export function MalConfirmPage({
  rows,
  busy,
  confirmPrivacy,
  confirmTimestamps,
  onBack,
  onConfirm,
  onConfirmSource,
}: {
  rows: MalPreviewRow[];
  busy: boolean;
  confirmPrivacy: boolean;
  confirmTimestamps: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onConfirmSource: (choice: { privacy?: boolean; timestamps?: boolean }) => void;
}) {
  const ready = rows.filter((row) => row.review);
  const gated = busy || ready.length === 0 || !confirmPrivacy || !confirmTimestamps;
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
              <ImportSourceEvidence preview={row.sourcePreview ?? malSourcePreview(row)} />
            </li>
          );
        })}
      </ul>
      <ImportSourceChecks
        prefix="mal"
        privacy={confirmPrivacy}
        timestamps={confirmTimestamps}
        disabled={busy}
        onPrivacy={(privacy) => onConfirmSource({ privacy })}
        onTimestamps={(timestamps) => onConfirmSource({ timestamps })}
      />
      <div className="flex flex-wrap gap-3">
        <MalAction type="button" variant="outline" disabled={busy} onClick={onBack}>
          {m.library_mal_return_review()}
        </MalAction>
        <MalAction type="button" disabled={gated} onClick={onConfirm} aria-busy={busy}>
          {busy ? m.library_mal_confirming() : m.library_mal_confirm()}
        </MalAction>
      </div>
    </section>
  );
}
