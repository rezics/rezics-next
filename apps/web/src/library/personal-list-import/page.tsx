import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibraryWorkspaceAdmission } from '../library-workspace-admission';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { createVndbJourney, type VndbJourney, type VndbJourneySnapshot } from './controller';
import { VndbConfirmPage } from './confirm';
import { VndbAction } from './controls';
import { VndbDeparture } from './departure';
import { useVndbImportPort } from './port';
import { VndbResultPage } from './results';
import { VndbReviewPage } from './review';
import { VndbApplying, VndbRemoved, VndbSignedOut, VndbUnavailable } from './states';
import { VndbUploadForm } from './upload';
import { useVndbVisit, type VndbVisit } from './visit';
import type { VndbNotice } from './controller';
import { CurrentImportLibrary } from '../showcase-import-return/current';

function noticeText(notice: VndbNotice): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_bangumi_uncertain();
  if (notice.kind === 'file-read') return m.library_vndb_file_read_error();
  if (notice.kind === 'admission') return m.library_vndb_admission_error({ code: notice.code ?? 'HTTP 400' });
  if (notice.kind === 'wire-too-large') return m.library_vndb_wire_error({ code: notice.code ?? 'HTTP 413' });
  if (notice.kind === 'denied') return m.library_bangumi_denied();
  if (notice.kind === 'not-found') return m.library_bangumi_missing_upload();
  if (notice.kind === 'conflict') return m.library_bangumi_conflict_upload();
  if (notice.kind === 'idempotency') return m.library_bangumi_idempotency();
  if (notice.kind === 'rejected') return m.library_vndb_rejected({ status: notice.status, code: notice.code ?? '' });
  return m.library_bangumi_unavailable();
}

function download(xml: string) {
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'vndb-export.xml';
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PersonalVndbImportPage({ visit }: { visit?: VndbVisit | null }) {
  const observed = useVndbVisit();
  const current = visit === undefined ? observed : visit;
  useEffect(() => () => current?.retire(), [current]);
  if (!current) return <VndbSignedOut />;
  return <VndbImportAccess visit={current} />;
}

const importOperations = ['library_entry.put'] as const;

function VndbImportAccess({ visit }: { visit: VndbVisit }) {
  const { store, value } = useLibraryWorkspaceAdmission(importOperations);
  const version = value.dispatch[0];
  const scoped = useMemo<VndbVisit>(() => {
    const controller = new AbortController();
    return {
      subject: visit.subject,
      csrfToken: visit.csrfToken,
      controller,
      retire: () => controller.abort(),
      current: (signal) => {
        if (
          !visit.current(signal) ||
          !store.allowed('library_entry.put') ||
          store.dispatchVersion('library_entry.put') !== version
        )
          controller.abort();
        return !controller.signal.aborted;
      },
    };
  }, [visit, store, version]);
  const identity = [visit.subject, visit.csrfToken, getLocale(), version].join(':');
  if (!value.allowed[0]) return <VndbUnavailable />;
  return <VndbImportSession key={identity} visit={scoped} />;
}

function VndbImportSession({ visit }: { visit: VndbVisit }) {
  const port = useVndbImportPort(visit);
  const journey = useRef<VndbJourney | null>(null);
  const main = useRef<HTMLElement>(null);
  if (!journey.current) journey.current = createVndbJourney({ port, visit });
  const [snap, setSnap] = useState<VndbJourneySnapshot>(() => journey.current!.snapshot());
  useEffect(() => () => journey.current?.retire(), [visit]);
  useEffect(() => {
    main.current?.querySelector<HTMLElement>(`[data-vndb-stage="${snap.stage}"]`)?.focus({ preventScroll: true });
  }, [snap.stage, snap.page?.rows[0]?.ordinal]);

  async function act(run: (current: VndbJourney) => Promise<VndbJourneySnapshot> | VndbJourneySnapshot) {
    if (!journey.current) return;
    const result = run(journey.current);
    setSnap(journey.current.snapshot());
    setSnap(await result);
  }

  const locked = snap.busy || !!snap.retryCommand;
  const showSourceRetry = snap.notice?.kind === 'unknown' && snap.notice.command.kind === 'source';
  return (
    <main ref={main} className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_vndb_title()}</PageHeading>
      {noticeText(snap.notice) ? (
        <p role="status" aria-live="polite">
          {noticeText(snap.notice)}
        </p>
      ) : null}
      {snap.retryCommand ? (
        <VndbAction type="button" disabled={snap.busy} onClick={() => void act((current) => current.retryUnknown())}>
          {m.library_bangumi_retry_command()}
        </VndbAction>
      ) : null}
      {showSourceRetry ? <p className="text-sm">{m.library_vndb_source_retry_help()}</p> : null}
      {snap.stage === 'upload' ? (
        <VndbUploadForm
          busy={snap.busy}
          disabled={locked}
          onUpload={(xml) => void act((current) => current.preview(xml))}
          onReadFailure={() => void act((current) => current.fileReadFailed())}
        />
      ) : null}
      {snap.stage === 'review' ? (
        <>
          {snap.limits ? (
            <p className="text-sm text-muted-foreground">
              {m.library_vndb_native_limits({
                xml: snap.limits.bytes,
                wire: snap.limits.wireBytes,
                rows: snap.limits.rows,
                page: snap.limits.page,
              })}
            </p>
          ) : null}
          <VndbReviewPage
            snap={snap}
            busy={snap.busy || locked}
            onReview={(body) => void act((current) => current.review(body))}
            onNext={() => void act((current) => current.loadPage(snap.page?.next ?? 0))}
            onPrevious={() => void act((current) => current.loadPage(Math.max(0, snap.offset - 8)))}
            onRefresh={() => void act((current) => current.loadPage(snap.offset))}
            onConfirm={() => void act((current) => current.openConfirm())}
            onSource={() => void act((current) => current.source())}
            onHideSource={() => void act((current) => current.hideSource())}
          />
        </>
      ) : null}
      {snap.stage === 'confirm' ? (
        <VndbConfirmPage
          snap={snap}
          busy={snap.busy || locked}
          onBack={() => void act((current) => current.backToReview())}
          onConfirm={() => void act((current) => current.confirm())}
        />
      ) : null}
      {snap.stage === 'applying' ? (
        <VndbApplying
          applied={snap.applied}
          applying={snap.applying}
          total={snap.outcomes.length + snap.unattemptedEffects.length}
        />
      ) : null}
      {snap.stage === 'results' ? (
        <>
          <VndbResultPage
            snap={snap}
            busy={snap.busy}
            onResume={() => void act((current) => current.resume())}
            onReview={() => void act((current) => current.backToReview())}
            onDiscard={() => void act((current) => current.discard())}
          />
          <CurrentImportLibrary
            key={`${snap.uploadId}:${snap.outcomes.map((row) => `${typeof row.scoreReviewId === 'string' ? 'score' : 'entry-state'}:${typeof row.scoreReviewId === 'string' ? row.scoreReviewId : row.reviewId}:${row.status}`).join(',')}`}
            visit={visit}
          />
        </>
      ) : null}
      {snap.stage === 'removed' ? <VndbRemoved outcomes={snap.outcomes} effects={snap.settledEffects} /> : null}
      {snap.sourceVisible && snap.sourceXML !== null ? (
        <VndbAction type="button" variant="outline" onClick={() => download(snap.sourceXML!)}>
          {m.library_vndb_download_source()}
        </VndbAction>
      ) : null}
      {snap.uploadId && snap.stage !== 'removed' ? (
        <div className="flex flex-wrap gap-3">
          {snap.stage === 'review' || snap.stage === 'results' ? (
            <VndbAction
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void act((current) => current.replaceSource())}
            >
              {m.library_vndb_replace_source()}
            </VndbAction>
          ) : null}
          {snap.stage !== 'results' || !snap.cancelled ? (
            <VndbAction
              type="button"
              variant="outline"
              disabled={locked && snap.stage !== 'applying'}
              onClick={() => void act((current) => current.cancelAdmission())}
            >
              {snap.busy ? m.library_bangumi_cancelling() : m.library_bangumi_cancel()}
            </VndbAction>
          ) : null}
          {snap.stage !== 'results' ? (
            <VndbAction
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => void act((current) => current.discard())}
            >
              {m.library_bangumi_discard()}
            </VndbAction>
          ) : null}
        </div>
      ) : null}
      <VndbDeparture
        active={!!snap.uploadId && snap.stage !== 'removed'}
        locked={locked}
        onLeave={async () => {
          if (snap.retryCommand || snap.busy) return false;
          if (snap.cancelled) return true;
          const result = await journey.current?.cancelAdmission();
          if (result) setSnap(result);
          return result?.cancelled === true;
        }}
      />
    </main>
  );
}
