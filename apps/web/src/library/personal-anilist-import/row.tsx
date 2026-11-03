import { useId, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { AniListRow, AniListRowMeta, AniListScoreFormat } from './contract';
import { AniListAction, AniListCheck } from './controls';
import { AniListEvidencePanel } from './fields';
import {
  aniListCanChooseTarget,
  aniListHasAdmittedStatus,
  aniListMatchLabel,
  aniListMediaLabel,
  aniListMediaType,
  aniListNeedsReplace,
  aniListTitle,
} from './meaning';
import { AniListTargetSearch } from './target';

export type RowDraft = {
  ordinal: number;
  target: string | null;
  skip: boolean;
  replace: boolean;
  applyStatus: boolean;
};

export function draftFromMeta(row: AniListRow, meta?: AniListRowMeta): RowDraft {
  return {
    ordinal: row.ordinal,
    target: meta?.target ?? row.review?.input.subjectId ?? null,
    skip: meta?.skip ?? false,
    replace: meta?.replace ?? false,
    applyStatus: meta?.applyStatus ?? true,
  };
}

export function AniListRowReview({
  row,
  meta,
  scoreFormat,
  busy,
  onSave,
  onChoose,
}: {
  row: AniListRow;
  meta?: AniListRowMeta;
  scoreFormat: AniListScoreFormat | null;
  busy: boolean;
  onSave: (draft: RowDraft) => void;
  onChoose: (draft: RowDraft) => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<RowDraft>(() => draftFromMeta(row, meta));
  const match = row.review?.match.state ?? row.match.state ?? meta?.match ?? null;
  const canTarget = aniListCanChooseTarget(match) && !draft.skip;
  const title = aniListTitle(row.source.evidence, m.library_anilist_untitled());
  const reviewed = !!(row.review || meta?.reviewId);
  const replaceable = aniListNeedsReplace(row) || !!meta?.current;
  const started = row.started || meta?.started === true;
  const mediaType = aniListMediaType(row.source.evidence);
  function update(next: RowDraft) {
    setDraft(next);
    onChoose(next);
  }
  return (
    <article
      className="space-y-4 rounded-lg border p-4"
      data-anilist-row={row.ordinal}
      data-anilist-match={match ?? 'pending'}
      data-anilist-started={started ? 'true' : 'false'}
    >
      <header className="space-y-1">
        <h3 className="text-lg font-medium [overflow-wrap:anywhere]">{title}</h3>
        <p className="text-sm text-muted-foreground">
          {aniListMediaLabel(mediaType)} · {aniListMatchLabel(match, draft.skip)}
        </p>
        {meta?.groupLabel ? (
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_anilist_group()}: {meta.groupLabel}
          </p>
        ) : null}
      </header>
      <AniListEvidencePanel row={row} scoreFormat={scoreFormat} />
      {row.proposal?.current || meta?.current ? (
        <p>
          {m.library_anilist_current({
            state: (row.proposal?.current ?? meta?.current)!.state,
            revision: (row.proposal?.current ?? meta?.current)!.revision,
          })}
        </p>
      ) : (
        <p>{m.library_anilist_absence()}</p>
      )}
      {(row.proposal?.proposedState ?? meta?.proposedState) ? (
        <p>{m.library_anilist_proposed({ state: (row.proposal?.proposedState ?? meta?.proposedState)! })}</p>
      ) : meta?.repeating ? (
        <p>{m.library_anilist_repeating_status()}</p>
      ) : (
        <p>{m.library_anilist_unsupported_status()}</p>
      )}
      {replaceable ? <p>{m.library_anilist_conflict_entry()}</p> : null}
      {!aniListHasAdmittedStatus(row) ? <p>{m.library_anilist_empty_fields()}</p> : null}
      {meta?.target && row.review?.input.subjectId && meta.target !== row.review.input.subjectId ? (
        <p>{m.library_anilist_changed_target()}</p>
      ) : null}
      {started ? <p>{m.library_anilist_started_locked()}</p> : null}
      {canTarget && !started ? (
        <AniListTargetSearch disabled={busy} value={draft.target} onChange={(target) => update({ ...draft, target })} />
      ) : null}
      <AniListCheck
        id={`${base}-skip`}
        checked={draft.skip}
        disabled={busy || started}
        label={m.library_anilist_skip_row()}
        onToggle={(skip) => update({ ...draft, skip, replace: skip ? false : draft.replace, applyStatus: !skip })}
      />
      {!draft.skip && !started ? (
        <AniListCheck
          id={`${base}-status`}
          checked={draft.applyStatus}
          disabled={busy}
          label={m.library_anilist_apply_status()}
          onToggle={(applyStatus) => update({ ...draft, applyStatus })}
        />
      ) : null}
      {replaceable && !draft.skip && !started ? (
        <AniListCheck
          id={`${base}-replace`}
          checked={draft.replace}
          disabled={busy || !reviewed}
          label={m.library_anilist_replace()}
          onToggle={(replace) => update({ ...draft, replace })}
        />
      ) : null}
      <AniListAction type="button" disabled={busy || started} onClick={() => onSave(draft)}>
        {m.library_anilist_save_review()}
      </AniListAction>
    </article>
  );
}
