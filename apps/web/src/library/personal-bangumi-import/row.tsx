import { useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { BangumiApplyState, BangumiRow, BangumiRowMeta } from './contract';
import { BangumiAction, BangumiCheck } from './controls';
import { BangumiEvidencePanel } from './fields';
import {
  bangumiCanChooseTarget,
  bangumiHasUnsupportedProposal,
  bangumiMatchLabel,
  bangumiMediumLabel,
  bangumiNeedsReplace,
  bangumiTitle,
} from './meaning';
import { BangumiTargetSearch } from './target';

export type RowDraft = { ordinal: number; target: string | null; state: BangumiApplyState; skip: boolean };

export function draftFromMeta(row: BangumiRow, meta?: BangumiRowMeta): RowDraft {
  return {
    ordinal: row.ordinal,
    target: meta?.target ?? row.review?.target ?? null,
    state: meta?.choice.state ?? 'preserve',
    skip: meta?.choice.skip ?? false,
  };
}

export function BangumiRowReview({
  row,
  meta,
  busy,
  onSave,
  onChoose,
}: {
  row: BangumiRow;
  meta?: BangumiRowMeta;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<RowDraft>(() => draftFromMeta(row, meta));
  const match = row.review?.match ?? meta?.match ?? null;
  const canTarget = bangumiCanChooseTarget(match) && !draft.skip;
  const title = bangumiTitle(row.evidence.source, m.library_bangumi_untitled());
  const reviewed = !!(row.review || meta?.reviewToken);
  const replaceable = bangumiNeedsReplace(row) || meta?.match === 'already_matched' || meta?.conflict;
  function update(next: RowDraft) {
    setDraft(next);
    onChoose(next);
  }
  return (
    <article
      className="space-y-4 rounded-lg border p-4"
      data-bangumi-row={row.ordinal}
      data-bangumi-medium={row.evidence.medium}
      data-bangumi-match={match ?? 'pending'}
    >
      <header className="space-y-1">
        <h3 className="text-lg font-medium [overflow-wrap:anywhere]">{title}</h3>
        <p className="text-sm text-muted-foreground">
          {bangumiMediumLabel(row.evidence.medium)} · {bangumiMatchLabel(match, draft.skip)}
        </p>
        {typeof row.evidence.source.subject_id === 'number' ? (
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_bangumi_identifier({ value: String(row.evidence.source.subject_id) })}
          </p>
        ) : null}
      </header>
      <BangumiEvidencePanel row={row} />
      {row.review?.current || meta?.current ? (
        <p>
          {m.library_bangumi_current({
            state: (row.review?.current ?? meta?.current)!.state,
            revision: (row.review?.current ?? meta?.current)!.revision,
          })}
        </p>
      ) : (
        <p>{m.library_bangumi_absence()}</p>
      )}
      {(row.review?.proposedState ?? meta?.proposedState) ? (
        <p>{m.library_bangumi_proposed({ state: (row.review?.proposedState ?? meta?.proposedState)! })}</p>
      ) : (
        <p>{m.library_bangumi_unsupported_status()}</p>
      )}
      {row.review?.conflict || meta?.conflict ? <p>{m.library_bangumi_conflict_entry()}</p> : null}
      {bangumiHasUnsupportedProposal(row) ? <p>{m.library_bangumi_empty_fields()}</p> : null}
      {meta?.target && row.review?.target && meta.target !== row.review.target ? (
        <p>{m.library_bangumi_changed_target()}</p>
      ) : null}
      {canTarget ? (
        <BangumiTargetSearch
          disabled={busy}
          value={draft.target}
          onChange={(target) => update({ ...draft, target })}
        />
      ) : null}
      <BangumiCheck
        id={`${base}-skip`}
        checked={draft.skip}
        disabled={busy || !reviewed}
        label={m.library_bangumi_skip_row()}
        onToggle={(skip) => update({ ...draft, skip, state: skip ? 'preserve' : draft.state })}
      />
      {replaceable && !draft.skip ? (
        <BangumiCheck
          id={`${base}-replace`}
          checked={draft.state === 'replace'}
          disabled={busy || !reviewed}
          label={m.library_bangumi_replace()}
          onToggle={(on) => update({ ...draft, state: on ? 'replace' : 'preserve' })}
        />
      ) : null}
      {reviewed && !draft.skip && !replaceable ? (
        <BangumiCheck
          id={`${base}-omit`}
          checked={draft.state === 'omit'}
          disabled={busy}
          label={m.library_bangumi_omit()}
          onToggle={(on) => update({ ...draft, state: on ? 'omit' : 'preserve' })}
        />
      ) : null}
      <BangumiAction type="button" disabled={busy} onClick={() => onSave(draft)}>
        {m.library_bangumi_save_review()}
      </BangumiAction>
    </article>
  );
}
