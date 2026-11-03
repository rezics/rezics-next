import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { localizeHref } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { ExportAction, actionClass } from './controls';
import { exportTerminalLabel } from './meaning';
import type { ExportStage } from './controller';

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <PageHeading>{m.library_export_title()}</PageHeading>
      {children}
    </main>
  );
}

export function ExportPreparing() {
  return (
    <Shell>
      <p role="status">{m.library_export_preparing()}</p>
    </Shell>
  );
}

export function ExportSignedOut() {
  return (
    <Shell>
      <p role="status">{m.library_export_sign_in()}</p>
    </Shell>
  );
}

export function ExportUnavailable({ denied }: { denied?: boolean }) {
  return (
    <Shell>
      <p role="status">{denied ? m.library_export_denied() : m.library_export_unavailable()}</p>
    </Shell>
  );
}

export function LibraryReturnLink() {
  return (
    <a href={localizeHref('/library')} className={`${actionClass} inline-flex items-center underline`}>
      {m.library_export_return_library()}
    </a>
  );
}

function terminalMessage(
  stage: Extract<ExportStage, 'cancelled' | 'stale' | 'expired' | 'conflict' | 'limit' | 'denied' | 'unavailable'>,
): string {
  if (stage === 'denied') return m.library_export_denied();
  if (stage === 'unavailable') return m.library_export_unavailable();
  if (stage === 'conflict') return m.library_export_conflict();
  return exportTerminalLabel(stage);
}

export function ExportTerminal({
  stage,
  onRestart,
}: {
  stage: Extract<ExportStage, 'cancelled' | 'stale' | 'expired' | 'conflict' | 'limit' | 'denied' | 'unavailable'>;
  onRestart?: () => void;
}) {
  const restartable = stage === 'stale' || stage === 'expired' || stage === 'cancelled' || stage === 'limit';
  return (
    <section className="space-y-4" data-export-stage={stage}>
      <p role="status">{terminalMessage(stage)}</p>
      {stage === 'stale' ? <p>{m.library_export_stale_restart()}</p> : null}
      <div className="flex flex-wrap gap-3">
        {restartable && onRestart ? (
          <ExportAction type="button" onClick={onRestart}>
            {m.library_export_restart()}
          </ExportAction>
        ) : null}
        <LibraryReturnLink />
      </div>
    </section>
  );
}
