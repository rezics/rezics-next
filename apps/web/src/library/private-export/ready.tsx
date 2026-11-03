import { m } from '../../paraglide/messages.js';
import type { ExportManifest } from './contract';
import { ExportAction } from './controls';
import { exportSectionLabel } from './meaning';

export function ExportReady({
  empty,
  saveFailed,
  bytesLost,
  manifest,
  busy,
  onDownload,
  onReplay,
}: {
  empty: boolean;
  saveFailed: boolean;
  bytesLost: boolean;
  manifest: ExportManifest;
  busy: boolean;
  onDownload: () => void;
  onReplay: () => void;
}) {
  return (
    <section className="space-y-6" data-export-stage={saveFailed ? 'save-failed' : empty ? 'empty' : 'ready'}>
      <p role="status">{empty ? m.library_export_empty() : m.library_export_ready()}</p>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="font-medium">{m.library_export_completeness({ value: manifest.completeness })}</dt>
        </div>
        <div>
          <dt>{m.library_export_version({ version: manifest.version })}</dt>
        </div>
        <div>
          <dt>{m.library_export_privacy_value({ value: manifest.privacy })}</dt>
        </div>
        <div>
          <dt>{m.library_export_captured_at({ value: manifest.capturedAt })}</dt>
        </div>
        <div>
          <dt>{m.library_export_expires_at({ value: manifest.expiresAt })}</dt>
        </div>
        <div>
          <dt>{m.library_export_manifest_rows({ rows: manifest.rows })}</dt>
        </div>
        <div>
          <dt>{m.library_export_manifest_bytes({ bytes: manifest.recordBytes })}</dt>
        </div>
      </dl>
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{m.library_export_omissions_heading()}</h2>
        <ul className="list-disc space-y-2 pl-6">
          {Object.entries(manifest.omissions).map(([key, value]) => (
            <li key={key}>
              <span className="font-medium">{key}: </span>
              {value}
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">{m.library_export_sections_heading()}</h2>
        <ul className="list-disc space-y-2 pl-6">
          {manifest.sections.map((section) => (
            <li key={section}>{exportSectionLabel(section)}</li>
          ))}
        </ul>
      </div>
      {saveFailed ? <p role="status">{m.library_export_save_failed()}</p> : null}
      {bytesLost ? <p role="status">{m.library_export_bytes_lost()}</p> : null}
      <div className="flex flex-wrap gap-3">
        {bytesLost ? (
          <ExportAction type="button" disabled={busy} onClick={onReplay}>
            {m.library_export_replay()}
          </ExportAction>
        ) : (
          <ExportAction type="button" disabled={busy} onClick={onDownload}>
            {saveFailed ? m.library_export_retry_save() : m.library_export_download()}
          </ExportAction>
        )}
      </div>
    </section>
  );
}
