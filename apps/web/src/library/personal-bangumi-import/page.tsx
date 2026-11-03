import { useEffect, useRef, useState } from 'react';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { createBangumiJourney, type BangumiJourney, type BangumiJourneySnapshot } from './controller';
import { BangumiConfirmPage } from './confirm';
import { BangumiAction } from './controls';
import { BangumiDeparture } from './departure';
import { bangumiFailureLabel } from './meaning';
import { useBangumiImportPort } from './port';
import { BangumiResultPage } from './results';
import { BangumiReviewPage } from './review';
import type { RowDraft } from './row';
import { BangumiApplying, BangumiCancelledNotice, BangumiRemovedNotice, BangumiSignedOut } from './states';
import { BangumiUploadForm } from './upload';
import { useBangumiVisit, type BangumiVisit } from './visit';

function noticeText(notice: BangumiJourneySnapshot['notice']): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_bangumi_uncertain();
  if (notice.kind === 'too-large') return m.library_bangumi_too_large();
  if (notice.kind === 'empty') return m.library_bangumi_invalid_empty();
  return bangumiFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

export function PersonalBangumiImportPage({ visit }: { visit?: BangumiVisit | null }) {
  const observed = useBangumiVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.put');
  if (!current) return <BangumiSignedOut />;
  return <BangumiImportSession key={`${current.subject}:${current.csrfToken}`} visit={current} />;
}

function BangumiImportSession({ visit }: { visit: BangumiVisit }) {
  const port = useBangumiImportPort();
  const journey = useRef<BangumiJourney | null>(null);
  if (!journey.current) journey.current = createBangumiJourney({ port, visit });
  const [snap, setSnap] = useState<BangumiJourneySnapshot>(() => journey.current!.snapshot());
  useEffect(() => () => visit.retire(), [visit]);

  async function act(run: (current: BangumiJourney) => Promise<BangumiJourneySnapshot> | BangumiJourneySnapshot) {
    if (!journey.current) return;
    setSnap(await run(journey.current));
  }

  async function saveReview(draft: RowDraft) {
    await act(async (current) => {
      current.choose(draft.ordinal, { state: draft.state, skip: draft.skip });
      return current.review(draft.ordinal, draft.target);
    });
  }

  const locked = snap.busy || snap.notice?.kind === 'unknown';
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_bangumi_title()}</PageHeading>
      {noticeText(snap.notice) ? (
        <p role="status" aria-live="polite">
          {noticeText(snap.notice)}
        </p>
      ) : null}
      {snap.notice?.kind === 'unknown' ? (
        <BangumiAction type="button" disabled={snap.busy} onClick={() => void act((current) => current.retryUnknown())}>
          {m.library_bangumi_retry_command()}
        </BangumiAction>
      ) : null}
      {snap.stage === 'upload' ? (
        <BangumiUploadForm busy={snap.busy} onUpload={(upload) => void act((current) => current.preview(upload))} />
      ) : null}
      {snap.stage === 'review' ? (
        <BangumiReviewPage
          snap={snap}
          busy={snap.busy}
          onSave={(draft) => void saveReview(draft)}
          onChoose={(draft) =>
            act((current) => current.choose(draft.ordinal, { state: draft.state, skip: draft.skip }))
          }
          onNext={() => void act((current) => current.nextPage())}
          onConfirm={() => act((current) => current.openConfirm())}
        />
      ) : null}
      {snap.stage === 'confirm' ? (
        <BangumiConfirmPage
          rows={snap.meta}
          busy={snap.busy}
          onBack={() => act((current) => current.backToReview())}
          onConfirm={() => void act((current) => current.confirm())}
        />
      ) : null}
      {snap.stage === 'applying' ? <BangumiApplying applied={snap.applied} applying={snap.applying} /> : null}
      {snap.stage === 'results' ? (
        <BangumiResultPage
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
        <BangumiCancelledNotice onReturn={() => act((current) => current.backToReview())} />
      ) : null}
      {snap.stage === 'removed' ? <BangumiRemovedNotice /> : null}
      {snap.uploadId && snap.stage !== 'removed' ? (
        <div className="flex flex-wrap gap-3">
          {snap.stage === 'applying' || snap.stage === 'review' || snap.stage === 'confirm' ? (
            <BangumiAction
              type="button"
              variant="outline"
              disabled={locked && snap.stage !== 'applying'}
              onClick={() => void act((current) => current.cancelAdmission())}
            >
              {snap.busy ? m.library_bangumi_cancelling() : m.library_bangumi_cancel()}
            </BangumiAction>
          ) : null}
          <BangumiAction
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => void act((current) => current.discard())}
          >
            {m.library_bangumi_discard()}
          </BangumiAction>
        </div>
      ) : null}
      <BangumiDeparture
        active={!!snap.uploadId && snap.stage !== 'removed'}
        locked={locked}
        onDiscard={() => void act((current) => current.discard())}
      />
    </main>
  );
}
