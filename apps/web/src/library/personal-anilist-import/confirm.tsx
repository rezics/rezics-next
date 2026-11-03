import { m } from '../../paraglide/messages.js';
import { ImportSourceChecks, ImportSourceEvidence } from '../rich-private-entry/source-confirm';
import type { AniListRowMeta } from './contract';
import { AniListAction } from './controls';
import { aniListAppliedFields, aniListMatchLabel, aniListMediaLabel } from './meaning';

export function AniListConfirmPage({
  rows,
  busy,
  confirmPrivacy,
  confirmTimestamps,
  onBack,
  onConfirm,
  onConfirmSource,
}: {
  rows: AniListRowMeta[];
  busy: boolean;
  confirmPrivacy: boolean;
  confirmTimestamps: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onConfirmSource: (choice: { privacy?: boolean; timestamps?: boolean }) => void;
}) {
  const ready = rows.filter((row) => row.reviewId);
  const gated = busy || ready.length === 0 || !confirmPrivacy || !confirmTimestamps;
  return (
    <section className="space-y-4" data-anilist-stage="confirm">
      <p>{m.library_anilist_confirm_help({ count: ready.length })}</p>
      <ul className="space-y-3">
        {ready.map((row) => {
          const fields = aniListAppliedFields(row);
          return (
            <li key={row.ordinal} className="rounded-md border p-3" data-anilist-confirm={row.ordinal}>
              <p className="font-medium [overflow-wrap:anywhere]">{row.title}</p>
              <p className="text-sm">
                {aniListMediaLabel(row.mediaType)} · {aniListMatchLabel(row.match, row.skip)}
              </p>
              <p className="text-sm">
                {m.library_anilist_confirm_fields({
                  fields: fields.length ? fields.join(', ') : m.library_anilist_match_skipped(),
                })}
              </p>
              {row.replace ? <p className="text-sm">{m.library_anilist_confirm_replace()}</p> : null}
              {row.proposedState ? (
                <p className="text-sm">{m.library_anilist_proposed({ state: row.proposedState })}</p>
              ) : null}
              {row.target ? <p className="text-sm [overflow-wrap:anywhere]">{row.target}</p> : null}
              {row.current ? (
                <p className="text-sm">
                  {m.library_anilist_current({ state: row.current.state, revision: row.current.revision })}
                </p>
              ) : (
                <p className="text-sm">{m.library_anilist_absence()}</p>
              )}
              <ImportSourceEvidence preview={row.sourcePreview} />
            </li>
          );
        })}
      </ul>
      <ImportSourceChecks
        prefix="anilist"
        privacy={confirmPrivacy}
        timestamps={confirmTimestamps}
        disabled={busy}
        onPrivacy={(privacy) => onConfirmSource({ privacy })}
        onTimestamps={(timestamps) => onConfirmSource({ timestamps })}
      />
      <div className="flex flex-wrap gap-3">
        <AniListAction type="button" variant="outline" disabled={busy} onClick={onBack}>
          {m.library_anilist_return_review()}
        </AniListAction>
        <AniListAction type="button" disabled={gated} onClick={onConfirm} aria-busy={busy}>
          {busy ? m.library_anilist_confirming() : m.library_anilist_confirm()}
        </AniListAction>
      </div>
    </section>
  );
}
