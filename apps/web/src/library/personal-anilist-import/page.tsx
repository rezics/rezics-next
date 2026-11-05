import { useEffect, useRef, useState } from 'react';
import { useOperation } from '../../kernel/exposure';
import { getLocale } from '../../paraglide/runtime.js';
import { AniListLabelAdoption } from './labels';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { createAniListJourney, type AniListJourney, type AniListJourneySnapshot } from './controller';
import { AniListConfirmPage } from './confirm';
import { AniListAction } from './controls';
import { AniListDeparture } from './departure';
import { aniListFailureLabel } from './meaning';
import { useAniListImportPort } from './port';
import { AniListResultPage } from './results';
import { AniListReviewPage } from './review';
import type { RowDraft } from './row';
import { AniListApplying, AniListCancelledNotice, AniListRemovedNotice, AniListSignedOut } from './states';
import { AniListUploadForm } from './upload';
import { useAniListVisit, type AniListVisit } from './visit';

function noticeText(notice: AniListJourneySnapshot['notice']): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_anilist_uncertain();
  if (notice.kind === 'too-large') return m.library_anilist_too_large();
  if (notice.kind === 'empty') return m.library_anilist_invalid_empty();
  if (notice.kind === 'started-locked') return m.library_anilist_started_locked();
  return aniListFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

export function PersonalAniListImportPage({ visit }: { visit?: AniListVisit | null }) {
  const observed = useAniListVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.put');
  if (!current) return <AniListSignedOut />;
  return <AniListImportSession key={`${current.subject}:${current.csrfToken}:${getLocale()}`} visit={current} />;
}

function AniListImportSession({ visit }: { visit: AniListVisit }) {
  const port = useAniListImportPort();
  const journey = useRef<AniListJourney | null>(null);
  if (!journey.current) journey.current = createAniListJourney({ port, visit });
  const [snap, setSnap] = useState<AniListJourneySnapshot>(() => journey.current!.snapshot());
  const questionReadStarted = useRef(false);
  useEffect(() => {
    if (!questionReadStarted.current) {
      questionReadStarted.current = true;
      void journey.current!.readQuestion().then(setSnap);
    }
    return () => visit.retire();
  }, [visit]);

  async function act(run: (current: AniListJourney) => Promise<AniListJourneySnapshot> | AniListJourneySnapshot) {
    if (!journey.current) return;
    const result = run(journey.current);
    // Publish in-flight custody before departure controls can allow the visit to leave.
    setSnap(journey.current.snapshot());
    const next = await result;
    if (journey.current.live()) setSnap(next);
  }

  async function saveReview(draft: RowDraft) {
    await act(async (current) => {
      current.choose(draft.ordinal, {
        skip: draft.skip,
        replace: draft.replace,
        applyStatus: draft.applyStatus,
        scoreAction: draft.scoreAction,
        scoreUnits: draft.scoreUnits,
      });
      return current.review(draft.ordinal, draft.target);
    });
  }

  const locked = snap.busy || snap.notice?.kind === 'unknown';
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_anilist_title()}</PageHeading>
      {noticeText(snap.notice) ? (
        <p role="status" aria-live="polite">
          {noticeText(snap.notice)}
        </p>
      ) : null}
      {snap.notice?.kind === 'unknown' ? (
        <AniListAction type="button" disabled={snap.busy} onClick={() => void act((current) => current.retryUnknown())}>
          {m.library_anilist_retry_command()}
        </AniListAction>
      ) : null}
      {snap.stage === 'upload' ? (
        <AniListUploadForm
          busy={snap.busy}
          onUpload={(upload, scoreFormat) => void act((current) => current.preview(upload, scoreFormat))}
          onReopen={(importId) => void act((current) => current.loadPage(importId, -1))}
        />
      ) : null}
      {snap.importId ? (
        <p className="break-all text-sm">
          {m.library_anilist_retained_id()}: {snap.importId}
        </p>
      ) : null}
      {snap.stage === 'review' ? (
        <AniListReviewPage
          snap={snap}
          busy={locked}
          onSave={(draft) => void saveReview(draft)}
          onChoose={(draft) =>
            act((current) =>
              current.choose(draft.ordinal, {
                skip: draft.skip,
                replace: draft.replace,
                applyStatus: draft.applyStatus,
                scoreAction: draft.scoreAction,
                scoreUnits: draft.scoreUnits,
              }),
            )
          }
          onRefreshQuestion={() => void act((current) => current.readQuestion())}
          onNext={() => void act((current) => current.nextPage())}
          onConfirm={() => act((current) => current.openConfirm())}
        />
      ) : null}
      {snap.stage === 'review' || snap.stage === 'results' || snap.stage === 'cancelled'
        ? snap.page
            .filter((row) => row.labelEvidence)
            .map((row) => (
              <AniListLabelAdoption
                key={`${snap.importId}:${row.ordinal}`}
                row={row}
                meta={snap.meta.find((item) => item.ordinal === row.ordinal)!}
                busy={locked}
                cancelled={snap.cancelled}
                current={() => journey.current!.live()}
                onChoose={(subjectId, selections) =>
                  void act((current) => current.chooseLabels(row.ordinal, subjectId, selections))
                }
                onReview={() => void act((current) => current.reviewLabels(row.ordinal))}
                onConfirm={() => void act((current) => current.confirmLabels(row.ordinal))}
                onRead={() => void act((current) => current.readLabels(row.ordinal))}
                onSearch={(query, cursor) => journey.current!.labelTargets(query, cursor)}
              />
            ))
        : null}
      {snap.stage === 'confirm' ? (
        <AniListConfirmPage
          rows={snap.meta}
          busy={snap.busy}
          confirmPrivacy={snap.confirmPrivacy}
          confirmTimestamps={snap.confirmTimestamps}
          onBack={() => act((current) => current.backToReview())}
          onConfirm={() => void act((current) => current.confirm())}
          onConfirmSource={(choice) => act((current) => current.confirmSource(choice))}
          onVoteConsent={(ordinal, consent) => act((current) => current.confirmVoteEffect(ordinal, consent))}
        />
      ) : null}
      {snap.stage === 'applying' ? <AniListApplying applied={snap.applied} applying={snap.applying} /> : null}
      {snap.stage === 'results' ? (
        <AniListResultPage
          outcomes={snap.outcomes}
          remaining={snap.remaining}
          meta={snap.meta}
          busy={snap.busy}
          cancelled={snap.cancelled}
          canRetry={snap.outcomes.some((item) => item.status === 'failed')}
          onRetry={() => void act((current) => current.retryFailed())}
          onReview={() => act((current) => current.backToReview())}
          onRefresh={() => void act((current) => current.refresh())}
        />
      ) : null}
      {snap.stage === 'cancelled' ? (
        <AniListCancelledNotice onReturn={() => act((current) => current.backToReview())} />
      ) : null}
      {snap.stage === 'removed' ? <AniListRemovedNotice /> : null}
      {snap.importId && snap.stage !== 'removed' ? (
        <div className="flex flex-wrap gap-3">
          {snap.stage === 'applying' || snap.stage === 'review' || snap.stage === 'confirm' ? (
            <AniListAction
              type="button"
              variant="outline"
              disabled={locked && snap.stage !== 'applying'}
              onClick={() => void act((current) => current.cancelAdmission())}
            >
              {snap.busy ? m.library_anilist_cancelling() : m.library_anilist_cancel()}
            </AniListAction>
          ) : null}
          <AniListAction
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => void act((current) => current.discard())}
          >
            {m.library_anilist_discard()}
          </AniListAction>
        </div>
      ) : null}
      <AniListDeparture
        active={!!snap.importId && snap.stage !== 'removed'}
        locked={locked}
        onDiscard={() => void act((current) => current.discard())}
      />
    </main>
  );
}
