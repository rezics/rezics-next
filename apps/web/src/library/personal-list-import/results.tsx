import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { subjectHref } from '../../subject/subject-href';
import type { VndbJourneySnapshot } from './controller';
import { VndbAction } from './controls';
import type { VndbOutcome } from './contract';

function outcomeId(outcome: VndbOutcome): string {
  return typeof outcome.scoreReviewId === 'string' ? outcome.scoreReviewId : outcome.reviewId!;
}

function outcomeKind(outcome: VndbOutcome): 'score' | 'entry-state' {
  return typeof outcome.scoreReviewId === 'string' ? 'score' : 'entry-state';
}

function resultLabel(status: string): string {
  if (status === 'applied') return m.library_bangumi_result_applied();
  if (status === 'skipped') return m.library_vndb_result_unchanged();
  if (status === 'stale') return m.library_bangumi_result_stale();
  if (status === 'unsupported') return m.library_bangumi_result_unsupported();
  if (status === 'failed') return m.library_vndb_result_rejected();
  if (status === 'unavailable') return m.library_vndb_score_result_unavailable();
  return m.library_vndb_result_uncertain();
}

export function VndbResultPage({
  snap,
  busy,
  onResume,
  onReview,
  onDiscard,
}: {
  snap: VndbJourneySnapshot;
  busy: boolean;
  onResume: () => void;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const title = new Map(snap.rows.map((row) => [row.ordinal, row.title]));
  const settled = new Map(
    snap.settledEffects.map((effect) => [`${effect.ordinal}:${effect.kind}:${effect.reviewId}`, effect]),
  );
  const pending = new Set(snap.pendingEffects.map((effect) => `${effect.ordinal}:${effect.kind}:${effect.reviewId}`));
  const renderTarget = (targetId: string | null, ordinal: number) => {
    if (!targetId) return null;
    return (
      <a className="underline underline-offset-2" href={subjectHref({ id: targetId, label: '' }, getLocale()).href}>
        {m.library_vndb_effect_target({ id: targetId })}
      </a>
    );
  };
  return (
    <section className="min-w-0 space-y-4" data-vndb-stage="results" tabIndex={-1}>
      <h2 className="text-xl font-semibold">{m.library_vndb_results_title()}</h2>
      <p role="status">
        {m.library_vndb_effect_progress({
          applied: snap.applied,
          total: snap.outcomes.length + snap.unattemptedEffects.length,
        })}
      </p>
      {snap.stopped === 'cancelled' ? <p>{m.library_vndb_stopped_cancelled()}</p> : null}
      {snap.stopped === 'deadline' ? <p>{m.library_vndb_stopped_deadline()}</p> : null}
      <p className="text-sm text-muted-foreground">{m.library_vndb_no_rollback()}</p>
      {!snap.reviewCurrent ? <p role="status">{m.library_vndb_review_withdrawn()}</p> : null}
      <ul className="space-y-3">
        {snap.outcomes.map((outcome) => (
          <li
            key={`${outcome.ordinal}:${outcomeId(outcome)}`}
            className="rounded-md border p-3"
            data-vndb-result={outcome.status}
            data-vndb-row={outcome.ordinal}
          >
            <p className="break-words font-medium">
              {title.get(outcome.ordinal) ?? `#${outcome.ordinal + 1}`} ·{' '}
              {outcomeKind(outcome) === 'score' ? m.library_vndb_score_effect() : m.library_vndb_entry_state_effect()}
            </p>
            <p>{resultLabel(outcome.status)}</p>
            <p className="break-words text-sm">{m.library_vndb_effect_review_id({ id: outcomeId(outcome) })}</p>
            {renderTarget(
              settled.get(`${outcome.ordinal}:${outcomeKind(outcome)}:${outcomeId(outcome)}`)?.targetId ?? null,
              outcome.ordinal,
            )}
          </li>
        ))}
        {snap.unattemptedEffects.map((effect) => {
          const key = `${effect.ordinal}:${effect.kind}:${effect.reviewId}`;
          const dispatched = pending.has(key) && snap.retryCommand === 'apply';
          const progress = dispatched
            ? snap.busy
              ? m.library_vndb_effect_applying()
              : snap.notice?.kind === 'unknown'
                ? m.library_vndb_result_uncertain()
                : m.library_vndb_apply_refused()
            : m.library_bangumi_result_unattempted();
          return (
            <li
              key={key}
              className="min-w-0 rounded-md border p-3"
              data-vndb-result={dispatched ? (snap.busy ? 'applying' : 'pending') : 'unattempted'}
              data-vndb-row={effect.ordinal}
              data-vndb-effect={effect.kind}
              data-vndb-review-id={effect.reviewId}
            >
              <p className="break-words font-medium">
                {title.get(effect.ordinal) ?? `#${effect.ordinal + 1}`} ·{' '}
                {effect.kind === 'score' ? m.library_vndb_score_effect() : m.library_vndb_entry_state_effect()}
              </p>
              <p>{progress}</p>
              <p className="break-words text-sm">{m.library_vndb_effect_review_id({ id: effect.reviewId })}</p>
              {renderTarget(effect.targetId, effect.ordinal)}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-3">
        {snap.stopped === 'deadline' ? (
          <VndbAction type="button" disabled={busy} onClick={onResume}>
            {m.library_vndb_resume()}
          </VndbAction>
        ) : null}
        <VndbAction
          type="button"
          variant="outline"
          disabled={busy || !snap.reviewCurrent || !!snap.retryCommand}
          onClick={onReview}
        >
          {m.library_bangumi_return_review()}
        </VndbAction>
        {snap.uploadId ? (
          <VndbAction type="button" variant="outline" disabled={busy || !!snap.retryCommand} onClick={onDiscard}>
            {m.library_bangumi_discard()}
          </VndbAction>
        ) : null}
      </div>
    </section>
  );
}
