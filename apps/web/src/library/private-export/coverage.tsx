import type { MouseEventHandler } from 'react';
import { m } from '../../paraglide/messages.js';
import { EXPORT_SECTIONS_V4, EXPORT_TTL_MINUTES, EXPORT_VERSION } from './contract';
import { ExportAction, actionClass } from './controls';
import { exportSectionLabel } from './meaning';

export function ExportCoverage({
  busy,
  locked,
  previousDisposition,
  onCapture,
}: {
  busy: boolean;
  locked: boolean;
  previousDisposition: string | null;
  onCapture: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <div className="space-y-5" data-export-stage="coverage">
      <p>{m.library_export_intro()}</p>
      <div className="space-y-2">
        <h3 className="font-semibold">{m.library_export_coverage_heading()}</h3>
        <p>{m.library_export_coverage()}</p>
        <p>{m.library_export_independent_facts()}</p>
        <p className="text-sm">{m.library_export_privacy()}</p>
        <p className="text-sm text-muted-foreground">{m.library_export_version({ version: EXPORT_VERSION })}</p>
      </div>
      <div className="space-y-2 rounded-lg border p-4">
        <h3 className="font-semibold">{m.library_export_omissions_heading()}</h3>
        <p>{m.library_export_full_false()}</p>
        <p>{m.library_export_excluded()}</p>
        <p>{m.library_export_no_finance()}</p>
        <p className="text-sm">{m.library_export_no_reimport()}</p>
      </div>
      <div className="space-y-3">
        <p className="text-sm">{m.library_export_expiry({ minutes: EXPORT_TTL_MINUTES })}</p>
        {previousDisposition ? <p>{m.library_export_restart_help()}</p> : null}
        <ExportAction type="button" disabled={busy || locked} onClick={onCapture}>
          {busy ? m.library_export_capturing() : m.library_export_capture()}
        </ExportAction>
      </div>
      <details className="rounded-lg border">
        <summary className={`${actionClass} cursor-pointer font-medium`}>
          {m.library_export_sections_heading()}
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            {EXPORT_SECTIONS_V4.map((section) => (
              <li key={section}>{exportSectionLabel(section)}</li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{m.library_export_timestamps()}</p>
        </div>
      </details>
    </div>
  );
}
