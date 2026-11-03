import { m } from '../../paraglide/messages.js';
import type { VndbJourneySnapshot } from './controller';
import { VndbAction } from './controls';

function selectionLabel(status: string, state: string | null, replace: boolean): string {
  if (status === 'skipped') return m.library_vndb_action_skip();
  if (status === 'unsupported') return m.library_vndb_action_retain();
  if (!state) return m.library_vndb_action_state();
  return replace ? m.library_vndb_confirm_replace({ state }) : m.library_vndb_confirm_state({ state });
}

export function VndbConfirmPage({
  snap,
  busy,
  onBack,
  onConfirm,
}: {
  snap: VndbJourneySnapshot;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <section className="min-w-0 space-y-4" data-vndb-stage="confirm" tabIndex={-1}>
      <h2 className="text-xl font-semibold">{m.library_vndb_confirm_title()}</h2>
      <p>{m.library_vndb_confirm_help({ count: snap.selection.length })}</p>
      <ul className="space-y-3">
        {snap.selection.map((row) => (
          <li key={row.ordinal} className="min-w-0 rounded-md border p-3" data-vndb-confirm={row.ordinal}>
            <p className="break-words font-medium">{row.title}</p>
            {row.identifier ? <p className="break-words text-sm">{m.library_vndb_identifier({ value: row.identifier.value })}</p> : null}
            <p className="break-words text-sm">{selectionLabel(row.decision!.status, row.decision!.state, row.decision!.replace)}</p>
            {row.decision?.targetId ? <p className="break-words text-sm">{m.library_vndb_target_id({ id: row.decision.targetId })}</p> : null}
            {row.decision?.baseline ? <p className="text-sm">{m.library_bangumi_current({ state: row.decision.baseline.state, revision: row.decision.baseline.revision })}</p> : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <VndbAction type="button" variant="outline" disabled={busy} onClick={onBack}>{m.library_bangumi_return_review()}</VndbAction>
        <VndbAction type="button" disabled={busy || snap.selection.length === 0} onClick={onConfirm} aria-busy={busy}>
          {m.library_vndb_apply_selection({ count: snap.selection.length })}
        </VndbAction>
      </div>
    </section>
  );
}
