import { m } from '../../paraglide/messages.js';
import type { BangumiRowMeta } from './contract';
import { BangumiAction } from './controls';
import { bangumiMatchLabel, bangumiMediumLabel, bangumiStateLabel } from './meaning';

export function BangumiConfirmPage({
  rows,
  busy,
  onBack,
  onConfirm,
}: {
  rows: BangumiRowMeta[];
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = rows.filter((row) => row.reviewToken);
  return (
    <section className="space-y-4" data-bangumi-stage="confirm">
      <p>{m.library_bangumi_confirm_help({ count: ready.length })}</p>
      <ul className="space-y-3">
        {ready.map((row) => (
          <li key={row.ordinal} className="rounded-md border p-3" data-bangumi-confirm={row.ordinal}>
            <p className="font-medium [overflow-wrap:anywhere]">{row.title}</p>
            <p className="text-sm">
              {bangumiMediumLabel(row.medium)} · {bangumiMatchLabel(row.match, row.choice.skip)}
            </p>
            <p className="text-sm">
              {m.library_bangumi_confirm_state({
                state: row.choice.skip ? m.library_bangumi_match_skipped() : bangumiStateLabel(row.choice.state),
              })}
            </p>
            {row.proposedState ? <p className="text-sm">{m.library_bangumi_proposed({ state: row.proposedState })}</p> : null}
            {row.target ? <p className="text-sm [overflow-wrap:anywhere]">{row.target}</p> : null}
            {row.current ? (
              <p className="text-sm">
                {m.library_bangumi_current({ state: row.current.state, revision: row.current.revision })}
              </p>
            ) : (
              <p className="text-sm">{m.library_bangumi_absence()}</p>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <BangumiAction type="button" variant="outline" disabled={busy} onClick={onBack}>
          {m.library_bangumi_return_review()}
        </BangumiAction>
        <BangumiAction type="button" disabled={busy || ready.length === 0} onClick={onConfirm} aria-busy={busy}>
          {busy ? m.library_bangumi_confirming() : m.library_bangumi_confirm()}
        </BangumiAction>
      </div>
    </section>
  );
}
