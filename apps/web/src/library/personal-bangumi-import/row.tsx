import { useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type {
  BangumiApplyState,
  BangumiImportPort,
  BangumiLabelPanelState,
  BangumiRow,
  BangumiRowMeta,
} from './contract';
import { BangumiAction, BangumiCheck } from './controls';
import { BangumiEvidencePanel } from './fields';
import { BangumiLabelAdoption } from './labels';
import {
  bangumiCanChooseTarget,
  bangumiHasUnsupportedProposal,
  bangumiMatchLabel,
  bangumiMediumLabel,
  bangumiNeedsReplace,
  bangumiTitle,
} from './meaning';
import { BangumiTargetSearch } from './target';
import { BangumiScoreReviewPanel, scoreDraftFrom, scoreSelectionFromDraft, type BangumiScoreDraft } from './score';
import type { BangumiVisit } from './visit';

export type RowDraft = {
  ordinal: number;
  target: string | null;
  state: BangumiApplyState;
  skip: boolean;
  score: BangumiScoreDraft;
};

export function draftFromMeta(row: BangumiRow, meta?: BangumiRowMeta): RowDraft {
  return {
    ordinal: row.ordinal,
    target: meta?.target ?? row.review?.target ?? null,
    state: meta?.choice.state ?? 'preserve',
    skip: meta?.choice.skip ?? false,
    score: scoreDraftFrom(row.review?.score ?? meta?.scoreReview),
  };
}

export function BangumiRowReview({
  row,
  meta,
  uploadId,
  port,
  visit,
  labelPanel,
  onLabelPanelChange,
  busy,
  onSave,
  onChoose,
}: {
  row: BangumiRow;
  meta?: BangumiRowMeta;
  uploadId: string | null;
  port: BangumiImportPort;
  visit: BangumiVisit;
  labelPanel: BangumiLabelPanelState | undefined;
  onLabelPanelChange: (update: (previous: BangumiLabelPanelState | undefined) => BangumiLabelPanelState) => void;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
}) {
  const base = useId();
  const reviewToken = row.review?.token ?? meta?.reviewToken ?? null;
  const [savedDraft, setSavedDraft] = useState(() => ({ reviewToken, value: draftFromMeta(row, meta) }));
  const draft = savedDraft.reviewToken === reviewToken ? savedDraft.value : draftFromMeta(row, meta);
  const reviewed = !!(row.review || meta?.reviewToken);
  const match = row.review?.match ?? meta?.match ?? null;
  const canTarget = (bangumiCanChooseTarget(match) || (reviewed && match === 'chosen')) && !draft.skip;
  const title = bangumiTitle(row.evidence.source, m.library_bangumi_untitled());
  const scoreReview = row.review?.score ?? meta?.scoreReview ?? null;
  const reviewedTarget = row.review?.target ?? meta?.target ?? null;
  const scoreTargetReady = !!draft.target && draft.target === reviewedTarget;
  const scoreSelection = scoreTargetReady
    ? scoreSelectionFromDraft(draft.score, scoreReview, true)
    : { action: 'preserve' as const };
  const replaceable = bangumiNeedsReplace(row) || meta?.match === 'already_matched' || meta?.conflict;
  function update(next: RowDraft) {
    setSavedDraft({ reviewToken, value: next });
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
      {scoreReview ? (
        <BangumiScoreReviewPanel
          review={scoreReview}
          hasTarget={scoreTargetReady}
          draft={draft.score}
          base={base}
          disabled={busy || !reviewed}
          onChange={(score) => update({ ...draft, score })}
        />
      ) : null}
      {uploadId ? (
        <BangumiLabelAdoption
          uploadId={uploadId}
          ordinal={row.ordinal}
          rowRevision={row.review?.token ?? null}
          port={port}
          visit={visit}
          panel={labelPanel}
          onChange={onLabelPanelChange}
          disabled={busy}
        />
      ) : null}
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
        <BangumiTargetSearch disabled={busy} value={draft.target} onChange={(target) => update({ ...draft, target })} />
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
      <BangumiAction type="button" disabled={busy || !scoreSelection} onClick={() => onSave(draft)}>
        {m.library_bangumi_save_review()}
      </BangumiAction>
    </article>
  );
}
