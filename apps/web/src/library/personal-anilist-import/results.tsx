import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ImportSourceOutcome } from '../rich-private-entry/source-confirm';
import type { AniListOutcome, AniListRowMeta } from './contract';
import { AniListAction } from './controls';
import { aniListOutcomeLabel, aniListValidityLabel } from './meaning';

function Outcome({
  outcome,
  titles,
  admission,
  row,
}: {
  outcome: AniListOutcome;
  titles: Map<number, string>;
  admission: AniListRowMeta['sourceAdmission'];
  row: AniListRowMeta | undefined;
}) {
  const applied = outcome.status === 'applied' ? ['status'].filter((field) => !outcome.retained.includes(field)) : [];
  const score =
    outcome.score && typeof outcome.score === 'object' && !Array.isArray(outcome.score)
      ? (outcome.score as Record<string, unknown>)
      : null;
  const scoreStatus = score && typeof score.status === 'string' ? score.status : null;
  const scoreReason = score && typeof score.reason === 'string' ? score.reason : null;
  const readback = currentScoreReadback(row?.currentScore);
  return (
    <li className="rounded-md border p-3" data-anilist-outcome={outcome.status} data-anilist-row={outcome.ordinal}>
      <p className="font-medium [overflow-wrap:anywhere]">{titles.get(outcome.ordinal) ?? `#${outcome.ordinal + 1}`}</p>
      <section className="space-y-1" data-anilist-state-effect>
        <h4 className="font-medium">{m.library_anilist_state_effect()}</h4>
        <p>{aniListOutcomeLabel(outcome.status)}</p>
        {applied.length ? (
          <p className="text-sm">{m.library_anilist_applied_fields({ fields: applied.join(', ') })}</p>
        ) : (
          <p className="text-sm">{m.library_anilist_applied_summary()}</p>
        )}
      </section>
      <section className="space-y-1" data-anilist-source-retention>
        <h4 className="font-medium">{m.library_anilist_source_retention()}</h4>
        {row?.scoreSource ? (
          <>
            <p className="text-sm [overflow-wrap:anywhere]">
              {m.library_anilist_score_source({
                value: row.scoreSource.lexeme ?? JSON.stringify(row.scoreSource.value) ?? String(row.scoreSource.value),
                scale: row.scoreSource.scale ?? m.library_anilist_score_scale_unknown(),
                validity: aniListValidityLabel(row.scoreSource.validity),
              })}
            </p>
            <p className="text-sm">{m.library_anilist_source_score_retained()}</p>
          </>
        ) : (
          <p className="text-sm">{m.library_anilist_source_score_absent()}</p>
        )}
      </section>
      <section className="space-y-1" data-anilist-score-effect>
        <h4 className="font-medium">{m.library_anilist_score_effect()}</h4>
        {scoreStatus ? (
          <p>{scoreOutcomeLabel(scoreStatus)}</p>
        ) : row?.scoreAction === 'keep' ? (
          <p>{m.library_anilist_score_no_effect()}</p>
        ) : (
          <p>{m.library_anilist_score_effect_not_reported()}</p>
        )}
        {scoreReason ? <p className="text-sm text-muted-foreground">{scoreReason}</p> : null}
        {readback ? (
          <p role="status" data-anilist-current-score>
            {readback.status === 'unavailable'
              ? m.library_anilist_score_readback_unavailable({ reason: readback.reason ?? '' })
              : readback.units === null
                ? m.library_anilist_score_readback_absent()
                : m.library_anilist_score_readback_vote({ units: readback.units })}
            {readback.questionLabel ? ` · ${readback.questionLabel}` : ''}
            {readback.questionRevision !== undefined
              ? ` · ${m.library_anilist_question_revision({ revision: readback.questionRevision })}`
              : ''}
          </p>
        ) : row?.scoreReview ? (
          <p>{m.library_anilist_score_readback_pending()}</p>
        ) : null}
      </section>
      {outcome.retained.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2">{m.library_anilist_retained_summary()}</summary>
          <p className="text-sm [overflow-wrap:anywhere]">
            {m.library_anilist_retained_fields({ fields: outcome.retained.join(', ') })}
          </p>
        </details>
      ) : null}
      {outcome.status === 'stale' ? (
        <p className="text-sm text-muted-foreground">{m.library_anilist_stale_help()}</p>
      ) : null}
      <ImportSourceOutcome outcome={admission} />
    </li>
  );
}

function scoreOutcomeLabel(status: string): string {
  switch (status) {
    case 'applied':
      return m.library_anilist_score_outcome_applied();
    case 'skipped':
      return m.library_anilist_score_outcome_skipped();
    case 'stale':
      return m.library_anilist_score_outcome_stale();
    case 'unsupported':
      return m.library_anilist_score_outcome_unsupported();
    case 'failed':
      return m.library_anilist_score_outcome_failed();
    case 'unavailable':
      return m.library_anilist_score_outcome_unavailable();
    default:
      return m.library_anilist_score_effect_not_reported();
  }
}

function currentScoreReadback(value: unknown): {
  status: 'current' | 'unavailable';
  units: number | null;
  reason?: string;
  questionLabel?: string;
  questionRevision?: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const readback = value as Record<string, unknown>;
  if (readback.status === 'unavailable') {
    return { status: 'unavailable', units: null, reason: typeof readback.reason === 'string' ? readback.reason : '' };
  }
  if (readback.status !== 'current' || !readback.question || typeof readback.question !== 'object') return null;
  const question = readback.question as Record<string, unknown>;
  const questionLabel = typeof question.label === 'string' ? question.label : undefined;
  const questionRevision = typeof question.revision === 'number' ? question.revision : undefined;
  if (readback.vote === null)
    return {
      status: 'current',
      units: null,
      ...(questionLabel === undefined ? {} : { questionLabel }),
      ...(questionRevision === undefined ? {} : { questionRevision }),
    };
  if (readback.vote && typeof readback.vote === 'object') {
    const vote = readback.vote as Record<string, unknown>;
    if (typeof vote.units === 'number')
      return {
        status: 'current',
        units: vote.units,
        ...(questionLabel === undefined ? {} : { questionLabel }),
        ...(questionRevision === undefined ? {} : { questionRevision }),
      };
  }
  return null;
}

export function AniListResultPage({
  outcomes,
  remaining,
  meta,
  busy,
  cancelled,
  canRetry,
  onRetry,
  onReview,
  onRefresh,
}: {
  outcomes: AniListOutcome[];
  remaining: number[];
  meta: AniListRowMeta[];
  busy: boolean;
  cancelled: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onReview: () => void;
  onRefresh: () => void;
}) {
  const titles = new Map(meta.map((row) => [row.ordinal, row.title]));
  const admissions = new Map(meta.map((row) => [row.ordinal, row.sourceAdmission]));
  const rows = new Map(meta.map((row) => [row.ordinal, row]));
  const locale = getLocale();
  return (
    <section className="space-y-4" data-anilist-stage="results">
      {cancelled ? (
        <p role="status">{m.library_anilist_stopped()}</p>
      ) : (
        <p role="status">{m.library_anilist_partial()}</p>
      )}
      <p className="text-sm text-muted-foreground">{m.library_anilist_erasure_limit()}</p>
      <ul className="space-y-3">
        {outcomes.map((outcome) => (
          <Outcome
            key={outcome.ordinal}
            outcome={outcome}
            titles={titles}
            admission={admissions.get(outcome.ordinal) ?? null}
            row={rows.get(outcome.ordinal)}
          />
        ))}
        {remaining.map((ordinal) => (
          <li
            key={`remaining-${ordinal}`}
            className="rounded-md border p-3"
            data-anilist-outcome="unattempted"
            data-anilist-row={ordinal}
          >
            <p className="font-medium [overflow-wrap:anywhere]">{titles.get(ordinal) ?? `#${ordinal + 1}`}</p>
            <p>{m.library_anilist_result_unattempted()}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <AniListAction type="button" variant="outline" disabled={busy} onClick={onReview}>
          {m.library_anilist_return_review()}
        </AniListAction>
        <AniListAction type="button" variant="outline" disabled={busy} onClick={onRefresh}>
          {m.library_anilist_fresh_read()}
        </AniListAction>
        {canRetry ? (
          <AniListAction type="button" disabled={busy} onClick={onRetry}>
            {m.library_anilist_retry_command()}
          </AniListAction>
        ) : null}
        <a href={`/${locale}/library`} className="inline-flex min-h-11 items-center px-3 py-2 underline">
          {m.library_anilist_return_library()}
        </a>
      </div>
    </section>
  );
}

/** Receipts and current assignments are separate facts, including a created label awaiting assignment. */
export function AniListLabelResult({
  row,
  labels,
}: {
  row: import('./contract').AniListRow;
  labels: NonNullable<AniListRowMeta['labels']>;
}) {
  const outcomes =
    labels.outcomes?.items ??
    Object.values(row.labelWork ?? {}).flatMap((work) => (work.outcome ? [work.outcome] : []));
  return (
    <section className="space-y-3" data-anilist-label-results>
      <ul className="space-y-2">
        {outcomes.map((item) => (
          <li key={item.key} data-anilist-label-outcome={item.status}>
            <p>
              {item.key} · {m.library_anilist_labels_outcome({ status: item.status })}
            </p>
            {item.label ? (
              <p>
                {m.library_anilist_labels_native_label()} · {item.label.id} · {item.label.revision}
              </p>
            ) : null}
            {item.assignment ? (
              <p>
                {m.library_anilist_labels_assignment()} · {item.assignment.id} · {item.assignment.revision}
              </p>
            ) : null}
            {item.reason ? <p>{item.reason}</p> : null}
          </li>
        ))}
      </ul>
      {Object.entries(row.labelWork ?? {})
        .filter(([, work]) => work.label && !work.outcome)
        .map(([index, work]) => (
          <div key={index}>
            <p>
              {labels.review?.items[Number(index)]?.key} · {m.library_anilist_labels_native_label()} · {work.label!.id}{' '}
              · {work.label!.revision}
            </p>
            <p role="status">{m.library_anilist_labels_incomplete()}</p>
          </div>
        ))}
      <h4 className="font-medium">{m.library_anilist_labels_current()}</h4>
      {row.currentLabels ? (
        <ul>
          {row.currentLabels.map((item) => (
            <li key={item.id}>
              {item.name} · {item.labelId} · {item.id} · {item.revision}
            </li>
          ))}
        </ul>
      ) : (
        <p>{m.library_anilist_labels_read_pending()}</p>
      )}
      {labels.outcomes?.complete === false || outcomes.some((item) => item.status === 'pending') ? (
        <p role="status">{m.library_anilist_labels_incomplete()}</p>
      ) : null}
    </section>
  );
}
