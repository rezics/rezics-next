import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { createExportJourney, type ExportJourney, type ExportJourneySnapshot } from './controller';
import type { ExportFileDelivery } from './contract';
import { ExportAction } from './controls';
import { ExportCoverage } from './coverage';
import { bindArchiveCustodyOwner } from './custody';
import { ArchiveRecoveryDestinations } from './destinations';
import { ExportDeparture } from './departure';
import { exportFailureLabel, exportTerminalLabel } from './meaning';
import { useLibraryExportPort } from './port';
import { ExportProgress } from './progress';
import { ExportReady } from './ready';
import { ExportSignedOut, ExportTerminal, ExportUnavailable, LibraryReturnLink } from './states';
import { useExportVisit, type ExportVisit } from './visit';

function noticeText(notice: ExportJourneySnapshot['notice']): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown')
    return notice.command.kind === 'cancel' ? m.library_export_cancel_uncertain() : m.library_export_uncertain();
  if (notice.kind === 'saved') return m.library_export_downloaded();
  if (notice.kind === 'bytes-lost') return m.library_export_bytes_lost();
  return exportFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

function stageHeading(snap: ExportJourneySnapshot): string {
  if (snap.notice?.kind === 'unknown') return m.library_export_confirm_heading();
  if (snap.notice?.kind === 'bytes-lost') return m.library_export_replay_heading();
  if (snap.stage === 'coverage') return m.library_export_review_heading();
  if (snap.stage === 'preparing') return m.library_export_preparing();
  if (snap.stage === 'capturing') return m.library_export_progress_heading();
  if (snap.stage === 'cancelling') return m.library_export_cancelling();
  if (snap.stage === 'save-failed') return m.library_export_save_heading();
  if (snap.stage === 'ready' || snap.stage === 'empty') return m.library_export_completed_heading();
  return m.library_export_stopped_heading();
}

function announcement(snap: ExportJourneySnapshot): string {
  const notice = noticeText(snap.notice);
  if (notice) return notice;
  if (snap.stage === 'coverage') return '';
  if (snap.stage === 'preparing') return m.library_export_preparing();
  if (snap.stage === 'capturing') return m.library_export_progress({ records: snap.records, pages: snap.pages });
  if (snap.stage === 'cancelling') return m.library_export_cancelling();
  if (snap.stage === 'save-failed') return m.library_export_save_failed();
  if (snap.stage === 'ready') return m.library_export_ready();
  if (snap.stage === 'empty') return m.library_export_empty();
  if (snap.stage === 'conflict' || snap.stage === 'denied' || snap.stage === 'unavailable')
    return exportFailureLabel(snap.stage);
  return exportTerminalLabel(snap.stage);
}

/** An explicit keyboard action owns only its immediate render, never a later response. */
function useExportTransitionFocus() {
  const heading = useRef<HTMLHeadingElement>(null);
  const intent = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const revoke = () => { intent.current = null; };
    const moved = (event: FocusEvent) => {
      if (event.target !== intent.current) revoke();
    };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', revoke, true);
    document.addEventListener('keydown', revoke, true);
    return () => {
      revoke();
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', revoke, true);
      document.removeEventListener('keydown', revoke, true);
    };
  }, []);

  useLayoutEffect(() => {
    const source = intent.current;
    intent.current = null;
    if (!source) return;
    // A still-available control keeps its keyboard position (for example Download).
    if (source.isConnected && !source.disabled) return;
    const active = document.activeElement;
    if (active === source || active === document.body) heading.current?.focus({ preventScroll: true });
  });

  return {
    heading,
    begin(event: MouseEvent<HTMLButtonElement>) {
      intent.current = event.detail === 0 && document.activeElement === event.currentTarget ? event.currentTarget : null;
    },
  };
}

type ExportRuntime = { now?: () => number; deliver?: ExportFileDelivery };

export function PrivateLibraryExportPage({ visit, ...runtime }: { visit?: ExportVisit | null } & ExportRuntime) {
  const observed = useExportVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.list');
  if (!current) return <ExportSignedOut />;
  return <ExportSession key={`${current.subject}:${current.csrfToken}`} visit={current} {...runtime} />;
}

function ExportSession({ visit, ...runtime }: { visit: ExportVisit } & ExportRuntime) {
  const port = useLibraryExportPort();
  const focus = useExportTransitionFocus();
  const headingId = useId();
  const publish = useRef<(snapshot: ExportJourneySnapshot) => void>(() => {});
  const journey = useRef<ExportJourney | null>(null);
  if (!journey.current) {
    journey.current = createExportJourney({
      ...runtime,
      port,
      visit,
      onChange(current) { publish.current(current); },
    });
  }
  const [snap, setSnap] = useState<ExportJourneySnapshot>(() => journey.current!.snapshot());
  publish.current = setSnap;
  useEffect(() => () => journey.current?.retire(), [visit]);

  async function act(
    event: MouseEvent<HTMLButtonElement>,
    run: (current: ExportJourney) => Promise<ExportJourneySnapshot> | ExportJourneySnapshot,
  ) {
    focus.begin(event);
    setSnap(await run(journey.current!));
  }

  bindArchiveCustodyOwner(visit.subject);
  const locked = snap.notice?.kind === 'unknown';
  const complete = snap.stage === 'ready' || snap.stage === 'empty' || snap.stage === 'save-failed';
  const terminal =
    snap.stage === 'cancelled' || snap.stage === 'stale' || snap.stage === 'expired' ||
    snap.stage === 'conflict' || snap.stage === 'limit' || snap.stage === 'denied' || snap.stage === 'unavailable';
  const text = noticeText(snap.notice);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 [overflow-wrap:anywhere]">
      <PageHeading>{m.library_export_title()}</PageHeading>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement(snap)}</p>
      <section aria-labelledby={headingId} className="space-y-5 rounded-xl border bg-card p-4 sm:p-6">
        <h2 ref={focus.heading} id={headingId} tabIndex={-1} className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          {stageHeading(snap)}
        </h2>
        {locked ? (
          <div className="space-y-3 rounded-lg border border-amber-600/40 bg-amber-500/5 p-4" data-export-outcome="unknown">
            <p>{text}</p>
            <ExportAction type="button" disabled={snap.busy} onClick={(event) => void act(event, (current) => current.retryUnknown())}>
              {m.library_export_retry_command()}
            </ExportAction>
          </div>
        ) : text && !complete && !terminal ? <p>{text}</p> : null}
        {snap.stage === 'coverage' ? (
          <ExportCoverage busy={snap.busy} locked={locked} previousDisposition={snap.previousDisposition}
            onCapture={(event) => void act(event, (current) => current.capture())} />
        ) : null}
        {snap.stage === 'preparing' && !locked ? <p>{m.library_export_preparing_help()}</p> : null}
        {snap.stage === 'capturing' ? (
          <ExportProgress records={snap.records} pages={snap.pages} paused={locked}
            onCancel={(event) => void act(event, (current) => current.cancel())} />
        ) : null}
        {snap.stage === 'cancelling' && !locked ? <p>{m.library_export_cancelling_help()}</p> : null}
        {complete ? (
          snap.manifest ? (
            <ExportReady empty={snap.stage === 'empty' || snap.manifest.rows === 0}
              saveFailed={snap.stage === 'save-failed'} bytesLost={snap.notice?.kind === 'bytes-lost'}
              saved={snap.notice?.kind === 'saved'} manifest={snap.manifest} busy={snap.busy}
              onDownload={(event) => void act(event, (current) => current.download())}
              onReplay={(event) => void act(event, (current) => current.replay())} />
          ) : <ExportTerminal stage="unavailable" onRestart={(event) => void act(event, (current) => current.restart())} />
        ) : null}
        {terminal ? (
          <ExportTerminal stage={snap.stage as 'cancelled' | 'stale' | 'expired' | 'conflict' | 'limit' | 'denied' | 'unavailable'}
            notice={text} onRestart={(event) => void act(event, (current) => current.restart())} />
        ) : null}
      </section>
      <ArchiveRecoveryDestinations current="export" />
      {!terminal ? <LibraryReturnLink /> : null}
      <ExportDeparture active={snap.stage !== 'coverage' && !terminal} locked={locked} onLeave={() => journey.current?.retire()} />
    </main>
  );
}

export { ExportUnavailable };
