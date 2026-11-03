import { useEffect, useRef, useState } from 'react';
import { useOperation } from '../../kernel/exposure';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { createExportJourney, type ExportJourney, type ExportJourneySnapshot } from './controller';
import { ExportAction } from './controls';
import { ExportCoverage } from './coverage';
import { ExportDeparture } from './departure';
import { exportFailureLabel } from './meaning';
import { useLibraryExportPort } from './port';
import { ExportProgress } from './progress';
import { ExportReady } from './ready';
import {
  ExportSignedOut,
  ExportTerminal,
  ExportUnavailable,
  LibraryReturnLink,
} from './states';
import { useExportVisit, type ExportVisit } from './visit';

function noticeText(notice: ExportJourneySnapshot['notice']): string | null {
  if (!notice) return null;
  if (notice.kind === 'unknown') return m.library_export_uncertain();
  if (notice.kind === 'saved') return m.library_export_downloaded();
  if (notice.kind === 'bytes-lost') return m.library_export_bytes_lost();
  return exportFailureLabel(notice.kind, 'detail' in notice ? notice.detail : undefined);
}

export function PrivateLibraryExportPage({ visit }: { visit?: ExportVisit | null }) {
  const observed = useExportVisit();
  const current = visit === undefined ? observed : visit;
  useOperation('library_entry.list');
  if (!current) return <ExportSignedOut />;
  return <ExportSession key={`${current.subject}:${current.csrfToken}`} visit={current} />;
}

function ExportSession({ visit }: { visit: ExportVisit }) {
  const port = useLibraryExportPort();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const publish = useRef<(snapshot: ExportJourneySnapshot) => void>(() => {});
  const journey = useRef<ExportJourney | null>(null);
  if (!journey.current) {
    journey.current = createExportJourney({
      port,
      visit,
      onChange(current) {
        publish.current(current);
      },
    });
  }
  const [snap, setSnap] = useState<ExportJourneySnapshot>(() => journey.current!.snapshot());
  publish.current = setSnap;

  useEffect(() => () => journey.current?.retire(), [visit]);

  useEffect(() => {
    statusRef.current?.focus();
  }, [snap.stage, snap.notice?.kind]);

  async function act(run: (current: ExportJourney) => Promise<ExportJourneySnapshot> | ExportJourneySnapshot) {
    if (!journey.current) return;
    setSnap(await run(journey.current));
  }

  const locked = snap.notice?.kind === 'unknown';
  const terminal =
    snap.stage === 'cancelled' ||
    snap.stage === 'stale' ||
    snap.stage === 'expired' ||
    snap.stage === 'conflict' ||
    snap.stage === 'limit' ||
    snap.stage === 'denied' ||
    snap.stage === 'unavailable';
  const text = noticeText(snap.notice);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_export_title()}</PageHeading>
      {text ? (
        <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite">
          {text}
        </p>
      ) : null}
      {snap.notice?.kind === 'unknown' ? (
        <ExportAction type="button" disabled={snap.busy} onClick={() => void act((current) => current.retryUnknown())}>
          {m.library_export_retry_command()}
        </ExportAction>
      ) : null}
      {snap.stage === 'coverage' ? (
        <ExportCoverage
          busy={snap.busy}
          locked={locked}
          previousDisposition={snap.previousDisposition}
          onCapture={() => void act((current) => current.capture())}
        />
      ) : null}
      {snap.stage === 'preparing' ? (
        <p ref={text ? undefined : statusRef} tabIndex={-1} role="status" aria-live="polite">
          {m.library_export_preparing()}
        </p>
      ) : null}
      {snap.stage === 'capturing' ? (
        <ExportProgress
          records={snap.records}
          pages={snap.pages}
          busy={snap.busy}
          onCancel={() => void act((current) => current.cancel())}
        />
      ) : null}
      {snap.stage === 'ready' || snap.stage === 'empty' || snap.stage === 'save-failed' ? (
        snap.manifest ? (
          <ExportReady
            empty={snap.stage === 'empty' || snap.manifest.rows === 0}
            saveFailed={snap.stage === 'save-failed'}
            bytesLost={snap.notice?.kind === 'bytes-lost'}
            manifest={snap.manifest}
            busy={snap.busy}
            onDownload={() => void act((current) => current.download())}
            onReplay={() => void act((current) => current.replay())}
          />
        ) : (
          <ExportTerminal stage="unavailable" onRestart={() => act((current) => current.restart())} />
        )
      ) : null}
      {terminal ? (
        <ExportTerminal
          stage={snap.stage as 'cancelled' | 'stale' | 'expired' | 'conflict' | 'limit' | 'denied' | 'unavailable'}
          onRestart={() => act((current) => current.restart())}
        />
      ) : null}
      {snap.stage === 'coverage' || snap.stage === 'ready' || snap.stage === 'empty' || snap.stage === 'save-failed' ? (
        <LibraryReturnLink />
      ) : null}
      <ExportDeparture
        active={snap.stage !== 'coverage' && !terminal}
        locked={locked || snap.notice?.kind === 'unknown'}
        onLeave={() => journey.current?.retire()}
      />
    </main>
  );
}

export { ExportUnavailable };
