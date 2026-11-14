import { ImportCleanupRecovery, ImportCleanupReceipts } from '../personal-list-import/cleanup';
import { ImportPageReadRecovery } from '../personal-list-import/page-navigation';
import { ImportDetails, ImportJourney, ImportReturn } from '../personal-list-import/presentation';
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
import { scoreSelectionFromDraft } from './score';
import type { BangumiLabelPanelState } from './contract';
import { BangumiApplying, BangumiCancelledNotice, BangumiRemovedNotice, BangumiSignedOut } from './states';
import { BangumiUploadForm } from './upload';
import { useBangumiVisit, type BangumiVisit } from './visit';
import {
  captureStageFocusHandoff,
  consumeStageFocusHandoff,
  createStageFocusTracker,
  watchStageFocusMovement,
  type StageFocusTracker,
} from '../personal-import-stage-focus';

function noticeText(notice: BangumiJourneySnapshot['notice']): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_bangumi_uncertain();
  if (notice.kind === 'too-large') return m.library_bangumi_too_large();
  if (notice.kind === 'empty') return m.library_bangumi_invalid_empty();
  return bangumiFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

function clickedButton(target: EventTarget | null): HTMLButtonElement | null {
  return target instanceof Element ? target.closest('button') : null;
}

export function PersonalBangumiImportPage({ visit }: { visit?: BangumiVisit | null }) {
  const observed = useBangumiVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.put');
  if (!current) return <BangumiSignedOut />;
  return <BangumiImportSession key={current.identity} visit={current} />;
}

function BangumiImportSession({ visit }: { visit: BangumiVisit }) {
  const port = useBangumiImportPort();
  const journey = useRef<BangumiJourney | null>(null);
  if (!journey.current) journey.current = createBangumiJourney({ port, visit });
  const [snap, setSnap] = useState<BangumiJourneySnapshot>(() => journey.current!.snapshot());
  const [labelPanels, setLabelPanels] = useState<Record<string, BangumiLabelPanelState>>({});
  useEffect(() => () => visit.retire(), [visit]);
  useEffect(() => {
    if (snap.stage === 'upload' || snap.stage === 'cleanup' || snap.stage === 'removed') setLabelPanels({});
  }, [snap.stage]);

  function changeLabelPanel(
    key: string,
    update: (previous: BangumiLabelPanelState | undefined) => BangumiLabelPanelState,
  ) {
    setLabelPanels((previous) => {
      const current = previous[key];
      return { ...previous, [key]: update(current) };
    });
  }

  async function act(run: (current: BangumiJourney) => Promise<BangumiJourneySnapshot> | BangumiJourneySnapshot) {
    if (!journey.current) return;
    const result = run(journey.current);
    setSnap(journey.current.snapshot());
    const next = await result;
    if (visit.current()) setSnap(next);
  }

  async function saveReview(draft: RowDraft) {
    await act(async (current) => {
      const prior = current.snapshot().meta.find((item) => item.ordinal === draft.ordinal);
      const targetChanged = prior?.target !== draft.target;
      current.choose(draft.ordinal, { state: draft.state, skip: draft.skip, target: draft.target });
      const score =
        targetChanged || !draft.target
          ? { action: 'preserve' as const }
          : scoreSelectionFromDraft(draft.score, prior?.scoreReview, true);
      if (!score) return current.snapshot();
      return current.review(draft.ordinal, draft.target, score);
    });
  }

  const [inspectCancelled, setInspectCancelled] = useState(false);
  const visibleStage = snap.stage === 'cancelled' && inspectCancelled ? 'review' : snap.stage;
  const stageFocus = useRef<StageFocusTracker>(createStageFocusTracker());
  const uploadFocus = useRef<HTMLDivElement>(null);
  const reviewFocus = useRef<HTMLDivElement>(null);
  const confirmFocus = useRef<HTMLDivElement>(null);
  const resultsFocus = useRef<HTMLDivElement>(null);
  const cancelledFocus = useRef<HTMLDivElement>(null);
  const removedFocus = useRef<HTMLDivElement>(null);
  useEffect(() => watchStageFocusMovement(stageFocus.current), []);
  useEffect(() => {
    const target =
      visibleStage === 'upload' || visibleStage === 'cleanup'
        ? uploadFocus.current
        : visibleStage === 'review'
          ? reviewFocus.current
          : visibleStage === 'confirm'
            ? confirmFocus.current
            : visibleStage === 'results'
              ? resultsFocus.current
              : visibleStage === 'cancelled'
                ? cancelledFocus.current
                : visibleStage === 'removed'
                  ? removedFocus.current
                  : null;
    consumeStageFocusHandoff(
      stageFocus.current,
      visibleStage,
      target,
      () => visit.current() && !!journey.current?.live(),
    );
  }, [visibleStage]);
  const labelPending = Object.values(labelPanels).some((panel) => panel.busy || panel.command !== null);
  const locked = snap.busy || snap.notice?.kind === 'unknown' || snap.cleanupPending || labelPending || inspectCancelled;

  function captureStageAction(target: EventTarget | null) {
    const button = clickedButton(target);
    const label = button?.textContent?.replace(/\s+/g, ' ').trim();
    if (!button || !label) return;

    let next: string | null = null;
    let restoreOpener = true;
    if (visibleStage === 'review' && label === m.library_bangumi_continue_confirm()) next = 'confirm';
    else if (visibleStage === 'confirm' && label === m.library_bangumi_return_review()) next = 'review';
    else if (visibleStage === 'confirm' && label === m.library_bangumi_confirm()) next = 'results';
    else if (visibleStage === 'results' && label === m.library_bangumi_return_review()) next = 'review';
    else if (snap.stage === 'cancelled' && !inspectCancelled && label === m.library_bangumi_return_review()) {
      next = 'review';
      restoreOpener = false;
    } else if (
      (snap.stage === 'applying' || snap.stage === 'review' || snap.stage === 'confirm') &&
      label === m.library_bangumi_cancel()
    ) {
      next = snap.outcomes.length ? 'results' : 'cancelled';
    } else if (label === m.library_bangumi_retry_command() && snap.notice?.kind === 'unknown') {
      if (snap.notice.command.kind === 'apply' && visibleStage !== 'results') next = 'results';
      else if (snap.notice.command.kind === 'cancel') next = 'cancelled';
    } else if (snap.stage !== 'removed' && label === m.library_bangumi_discard()) next = 'removed';

    if (next && next !== visibleStage) {
      captureStageFocusHandoff(stageFocus.current, visibleStage, next, button, restoreOpener);
    }
  }

  return (
    <main
      className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6"
      onClickCapture={(event) => captureStageAction(event.target)}
    >
      <PageHeading>{m.library_bangumi_title()}</PageHeading>
      <ImportJourney stage={visibleStage} />
      {noticeText(snap.notice) ? (
        <p role="status" aria-live="polite">
          {noticeText(snap.notice)}
        </p>
      ) : null}
      {snap.notice?.kind === 'unknown' && !snap.cleanupPending ? (
        <BangumiAction type="button" disabled={snap.busy} onClick={() => void act((current) => current.retryUnknown())}>
          {m.library_bangumi_retry_command()}
        </BangumiAction>
      ) : null}
      {snap.pageReadFailed ? (
        <ImportPageReadRecovery busy={locked} onRetry={() => void act((current) => current.retryPage())} />
      ) : null}
      <ImportCleanupReceipts count={snap.cleanupReceipts.length} />
      {snap.cleanupPending ? (
        <ImportCleanupRecovery
          busy={snap.busy}
          replacementPending={snap.replacementPending}
          onRetry={() => void act((current) => current.retryUnknown())}
          onDiscardReplacement={() => void act((current) => current.discard())}
        />
      ) : null}
      {snap.stage === 'upload' || snap.stage === 'cleanup' ? (
        <div ref={uploadFocus} tabIndex={-1} role="region" aria-label={m.library_import_upload()}>
          <BangumiUploadForm
            busy={snap.cleanupPending ? false : snap.busy}
            disabled={!snap.cleanupPending && locked}
            onEdit={() => void act((current) => current.editReplacement())}
            onUpload={(upload) => void act((current) => current.preview(upload))}
            onReopen={
              snap.cleanupPending || snap.uploadId
                ? undefined
                : (uploadId) => void act((current) => current.loadPage(uploadId, -1))
            }
          />
        </div>
      ) : null}
      {snap.stage === 'cancelled' && !inspectCancelled ? (
        <div ref={cancelledFocus} tabIndex={-1} role="region" aria-label={m.library_bangumi_canceled()}>
          <BangumiCancelledNotice onReturn={() => setInspectCancelled(true)} />
        </div>
      ) : null}
      {snap.uploadId && !snap.cleanupPending && snap.stage !== 'upload' && snap.stage !== 'removed' ? (
        <div
          ref={reviewFocus}
          tabIndex={-1}
          role="region"
          aria-label={m.library_import_review()}
          hidden={snap.stage !== 'review' && !(snap.stage === 'cancelled' && inspectCancelled)}
        >
          <BangumiReviewPage
            key={snap.uploadId}
            snap={snap}
            busy={snap.busy || snap.notice?.kind === 'unknown' || snap.stage !== 'review'}
            navigationLocked={locked}
            port={port}
            visit={visit}
            labelPanels={labelPanels}
            onLabelPanelChange={changeLabelPanel}
            onSave={(draft) => void saveReview(draft)}
            onChoose={(draft) =>
              act((current) =>
                current.choose(draft.ordinal, { state: draft.state, skip: draft.skip, target: draft.target }),
              )
            }
            onNext={() => void act((current) => current.nextPage())}
            onPrevious={() => void act((current) => current.previousPage())}
            onFirst={() => void act((current) => current.firstPage())}
            onConfirm={() => act((current) => current.openConfirm())}
          />
        </div>
      ) : null}
      {snap.stage === 'confirm' ? (
        <div ref={confirmFocus} tabIndex={-1} role="region" aria-label={m.library_import_confirm()}>
          <BangumiConfirmPage
            rows={snap.meta}
            busy={locked}
            confirmPrivacy={snap.confirmPrivacy}
            confirmTimestamps={snap.confirmTimestamps}
            onBack={() => act((current) => current.backToReview())}
            onConfirm={() => void act((current) => current.confirm())}
            onConfirmSource={(choice) => act((current) => current.confirmSource(choice))}
            onScoreConsent={(ordinal, consent) => act((current) => current.confirmScore(ordinal, consent))}
          />
        </div>
      ) : null}
      {snap.stage === 'applying' ? (
        <div
          tabIndex={-1}
          role="region"
          aria-label={m.library_bangumi_applying({ applied: snap.applied, applying: snap.applying })}
        >
          <BangumiApplying applied={snap.applied} applying={snap.applying} />
        </div>
      ) : null}
      {snap.stage === 'results' ? (
        <div ref={resultsFocus} tabIndex={-1} role="region" aria-label={m.library_import_results()}>
          <BangumiResultPage
            outcomes={snap.outcomes}
            uploadId={snap.uploadId}
            labelPanels={labelPanels}
            remaining={snap.remaining}
            meta={snap.meta}
            busy={locked}
            cancelled={snap.cancelled}
            canRetry={snap.outcomes.some((item) => item.status === 'failed')}
            onRetry={() => void act((current) => current.retryFailed())}
            onReview={() => act((current) => current.backToReview())}
            onRefresh={() => void act((current) => current.refresh())}
            onInspect={(ordinal) => void act((current) => current.inspectCurrent(ordinal))}
          />
        </div>
      ) : null}
      {snap.stage === 'removed' ? (
        <div ref={removedFocus} tabIndex={-1} role="region" aria-label={m.library_bangumi_removed()}>
          <BangumiRemovedNotice />
        </div>
      ) : null}
      {snap.uploadId && !snap.cleanupPending && snap.stage !== 'upload' && snap.stage !== 'removed' ? (
        <div className="flex flex-wrap gap-3">
          {snap.stage !== 'applying' ? (
            <BangumiAction
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void act((current) => current.replaceSource())}
            >
              {m.library_import_replace()}
            </BangumiAction>
          ) : null}
          {snap.stage === 'applying' || snap.stage === 'review' || snap.stage === 'confirm' ? (
            <BangumiAction
              type="button"
              variant="outline"
              disabled={snap.busy || snap.notice?.kind === 'unknown'}
              onClick={() =>
                void act(async (current) => {
                  const next = await current.cancelAdmission();
                  if (next.cancelled) setLabelPanels({});
                  return next;
                })
              }
            >
              {snap.busy ? m.library_bangumi_cancelling() : m.library_bangumi_cancel()}
            </BangumiAction>
          ) : null}
          <BangumiAction
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              void act(async (current) => {
                const next = await current.discard();
                if (next.stage === 'removed' || !next.uploadId) setLabelPanels({});
                return next;
              })
            }
          >
            {m.library_bangumi_discard()}
          </BangumiAction>
        </div>
      ) : null}
      {snap.uploadId && snap.stage !== 'removed' ? (
        <ImportDetails title={m.library_import_retained()}>
          <p>{m.library_import_reopen_help()}</p>
          <p className="break-all">{snap.uploadId}</p>
        </ImportDetails>
      ) : null}
      {snap.uploadId && snap.stage === 'upload' ? (
        <BangumiAction
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => void act((current) => current.discard())}
        >
          {m.library_bangumi_discard()}
        </BangumiAction>
      ) : null}
      {snap.stage !== 'results' && (snap.stage !== 'cancelled' || inspectCancelled) && snap.stage !== 'removed' ? (
        <ImportReturn />
      ) : null}
      <BangumiDeparture
        active={!!snap.uploadId && snap.stage !== 'removed'}
        locked={locked}
        onDiscard={() =>
          void act(async (current) => {
            const next = await current.discard();
            if (next.stage === 'removed' || !next.uploadId) setLabelPanels({});
            return next;
          })
        }
      />
    </main>
  );
}
