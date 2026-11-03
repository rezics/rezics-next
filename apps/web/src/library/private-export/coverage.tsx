import { m } from '../../paraglide/messages.js';
import { EXPORT_SECTIONS, EXPORT_TTL_MINUTES } from './contract';
import { ExportAction } from './controls';
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
  onCapture: () => void;
}) {
  return (
    <section className="space-y-6" data-export-stage="coverage">
      <p>{m.library_export_intro()}</p>
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{m.library_export_coverage_heading()}</h2>
        <p>{m.library_export_coverage()}</p>
        <p>{m.library_export_full_false()}</p>
      </div>
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{m.library_export_sections_heading()}</h2>
        <ul className="list-disc space-y-2 pl-6">
          {EXPORT_SECTIONS.filter(
            (section) => section !== 'bangumiEvidence' && section !== 'malEvidence',
          ).map((section) => (
            <li key={section}>{exportSectionLabel(section)}</li>
          ))}
        </ul>
      </div>
      <ul className="list-disc space-y-2 pl-6 text-sm">
        <li>{m.library_export_independent_facts()}</li>
        <li>{m.library_export_timestamps()}</li>
        <li>{m.library_export_privacy()}</li>
        <li>{m.library_export_no_reimport()}</li>
        <li>{m.library_export_no_finance()}</li>
        <li>{m.library_export_expiry({ minutes: EXPORT_TTL_MINUTES })}</li>
      </ul>
      {previousDisposition ? <p role="status">{m.library_export_restart_help()}</p> : null}
      <ExportAction type="button" disabled={busy || locked} onClick={onCapture}>
        {busy ? m.library_export_capturing() : m.library_export_capture()}
      </ExportAction>
    </section>
  );
}
