import { m } from '../../paraglide/messages.js';
import { ImportSourceChecks, ImportSourceEvidence } from '../rich-private-entry/source-confirm';
import type { AniListRowMeta } from './contract';
import { AniListAction } from './controls';
import { AniListCheck } from './controls';
import { aniListAppliedFields, aniListMatchLabel, aniListMediaLabel, aniListValidityLabel } from './meaning';

export function AniListConfirmPage({
  rows,
  busy,
  confirmPrivacy,
  confirmTimestamps,
  onBack,
  onConfirm,
  onConfirmSource,
  onVoteConsent,
}: {
  rows: AniListRowMeta[];
  busy: boolean;
  confirmPrivacy: boolean;
  confirmTimestamps: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onConfirmSource: (choice: { privacy?: boolean; timestamps?: boolean }) => void;
  onVoteConsent: (ordinal: number, consent: boolean) => void;
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
              {row.replace && row.scoreReview?.currentVote === 'present' ? (
                <p className="text-sm">{m.library_anilist_confirm_replace_vote()}</p>
              ) : null}
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
              {row.scoreSource ? (
                <div className="space-y-2 rounded-md border p-3" data-anilist-confirm-score={row.ordinal}>
                  <p className="font-medium">
                    {m.library_anilist_score_source({
                      value:
                        row.scoreSource.lexeme ??
                        JSON.stringify(row.scoreSource.value) ??
                        String(row.scoreSource.value),
                      scale: row.scoreSource.scale ?? m.library_anilist_score_scale_unknown(),
                      validity: aniListValidityLabel(row.scoreSource.validity),
                    })}
                  </p>
                  <p className="text-sm text-muted-foreground">{row.scoreSource.reason}</p>
                  {row.scoreReview ? (
                    <>
                      <p>
                        {row.scoreReview.action === 'vote'
                          ? m.library_anilist_confirm_vote({ units: row.scoreReview.units ?? 0 })
                          : m.library_anilist_confirm_clear()}
                      </p>
                      {row.scoreReview.questionLabel ? <p>{row.scoreReview.questionLabel}</p> : null}
                      {row.scoreReview.questionMeaning ? <p>{row.scoreReview.questionMeaning}</p> : null}
                      {row.scoreReview.minimumUnits !== null &&
                      row.scoreReview.maximumUnits !== null &&
                      row.scoreReview.stepUnits !== null ? (
                        <p className="text-sm">
                          {m.library_anilist_question_scale({
                            min: row.scoreReview.minimumUnits,
                            max: row.scoreReview.maximumUnits,
                            step: row.scoreReview.stepUnits,
                          })}
                        </p>
                      ) : null}
                      {row.scoreReview.questionRevision !== null ? (
                        <p className="text-sm">
                          {m.library_anilist_question_revision({ revision: row.scoreReview.questionRevision })}
                        </p>
                      ) : null}
                      {row.scoreReview.targetId ? (
                        <p className="text-sm [overflow-wrap:anywhere]">
                          {m.library_anilist_score_target({ target: row.scoreReview.targetId })}
                        </p>
                      ) : null}
                      {row.scoreReview.currentVote === 'present' ? (
                        <p>{m.library_anilist_review_vote_present({ units: row.scoreReview.currentVoteUnits ?? 0 })}</p>
                      ) : row.scoreReview.currentVote === 'absent' ? (
                        <p>{m.library_anilist_review_vote_absent()}</p>
                      ) : (
                        <p>
                          {m.library_anilist_review_vote_unavailable({
                            reason: row.scoreReview.currentVoteReason ?? '',
                          })}
                        </p>
                      )}
                      {row.scoreReview.currentVote === 'present' &&
                      row.scoreReview.action === 'vote' &&
                      !row.replace ? (
                        <p>{m.library_anilist_existing_vote_preserved()}</p>
                      ) : null}
                      <p className="text-sm">
                        {row.scoreReview.availability === 'available'
                          ? m.library_anilist_review_observations_available()
                          : m.library_anilist_vote_write_unavailable({
                              reason: row.scoreReview.availabilityReason ?? '',
                            })}
                      </p>
                      <AniListCheck
                        id={`anilist-vote-consent-${row.ordinal}`}
                        checked={
                          row.nativeVoteConsent?.reviewId === row.scoreReview.reviewId &&
                          row.nativeVoteConsent.consentKey === row.scoreReview.consentKey
                        }
                        disabled={busy || !row.scoreReview.consentKey}
                        label={m.library_anilist_confirm_native_vote_effects()}
                        onToggle={(consent) => onVoteConsent(row.ordinal, consent)}
                      />
                    </>
                  ) : (
                    <p>{m.library_anilist_score_keep()}</p>
                  )}
                </div>
              ) : null}
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
