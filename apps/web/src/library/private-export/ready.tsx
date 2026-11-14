import { useId, useMemo, type MouseEventHandler } from 'react';
import { m } from '../../paraglide/messages.js';
import type { ExportManifest, ExportOmissionKey } from './contract';
import { ExportAction, actionClass } from './controls';
import { exportSectionLabel } from './meaning';

function omissionLabel(key: ExportOmissionKey): string {
  if (key === 'trash') return m.library_export_omission_trash();
  if (key === 'providerIdentifiers') return m.library_export_omission_identifiers();
  if (key === 'personalImportEvidence') return m.library_export_omission_imports();
  if (key === 'commerce') return m.library_export_omission_commerce();
  if (key === 'publication') return m.library_export_omission_publication();
  return m.library_export_omission_reimport();
}

export function ExportReady({
  empty,
  saveFailed,
  bytesLost,
  saved = false,
  manifest,
  busy,
  onDownload,
  onReplay,
}: {
  empty: boolean;
  saveFailed: boolean;
  bytesLost: boolean;
  saved?: boolean;
  manifest: ExportManifest;
  busy: boolean;
  onDownload: MouseEventHandler<HTMLButtonElement>;
  onReplay: MouseEventHandler<HTMLButtonElement>;
}) {
  const omissionsId = useId();
  const warningId = useId();
  // Index the supplied inventory once per manifest; no record traversal or additional reads.
  const sections = useMemo(
    () =>
      manifest.sections.map((section) => ({
        section,
        total:
          manifest.version === 1
            ? null
            : manifest.version === 4
              ? manifest.sectionTotals[section]
              : manifest.sectionTotals[section as keyof typeof manifest.sectionTotals],
      })),
    [manifest],
  );

  return (
    <div className="space-y-5" data-export-stage={saveFailed ? 'save-failed' : empty ? 'empty' : 'ready'}>
      {!bytesLost ? <p>{empty ? m.library_export_empty() : m.library_export_ready()}</p> : null}
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <p>{m.library_export_manifest_rows({ rows: manifest.rows })}</p>
        <p>{m.library_export_manifest_bytes({ bytes: manifest.recordBytes })}</p>
      </div>
      <div className="space-y-3 rounded-lg border p-4">
        <div id={warningId} className="space-y-2">
          {bytesLost ? (
            <p>{m.library_export_bytes_lost()}</p>
          ) : saveFailed ? (
            <p>{m.library_export_save_failed()}</p>
          ) : saved ? (
            <p>{m.library_export_downloaded()}</p>
          ) : null}
          {busy ? <p>{m.library_export_saving()}</p> : null}
          <p>{m.library_export_restore_separate()}</p>
        </div>
        <ExportAction
          type="button"
          disabled={busy}
          aria-busy={busy}
          aria-describedby={`${warningId} ${omissionsId}`}
          onClick={bytesLost ? onReplay : onDownload}
        >
          {bytesLost
            ? m.library_export_replay()
            : saveFailed
              ? m.library_export_retry_save()
              : m.library_export_download()}
        </ExportAction>
      </div>
      <section aria-labelledby={omissionsId} className="space-y-3">
        <h3 id={omissionsId} className="font-semibold">
          {m.library_export_omissions_heading()}
        </h3>
        <p>{m.library_export_full_false()}</p>
        <p className="text-sm">{m.library_export_no_reimport()}</p>
        <dl className="space-y-3 rounded-lg border p-4 text-sm">
          {Object.entries(manifest.omissions).map(([key, value]) => (
            <div key={key} className="space-y-1 [overflow-wrap:anywhere]">
              <dt className="font-medium">{omissionLabel(key as ExportOmissionKey)}</dt>
              <dd className="text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <details className="rounded-lg border">
        <summary className={`${actionClass} cursor-pointer font-medium`}>{m.library_export_inspect_manifest()}</summary>
        <div className="space-y-5 px-4 pb-4 text-sm [overflow-wrap:anywhere]">
          <ul className="space-y-2">
            <li>{m.library_export_manifest_identity({ value: manifest.exportId })}</li>
            <li>{m.library_export_manifest_format({ value: manifest.format })}</li>
            <li>{m.library_export_version({ version: manifest.version })}</li>
            {manifest.version !== 1 ? (
              <li>{m.library_export_manifest_coverage({ value: manifest.coverage })}</li>
            ) : null}
            <li>{m.library_export_completeness({ value: manifest.completeness })}</li>
            <li>
              <code>fullExport: {String(manifest.fullExport)}</code>
            </li>
            <li>{m.library_export_privacy_value({ value: manifest.privacy })}</li>
            <li>{m.library_export_captured_at({ value: manifest.capturedAt })}</li>
            <li>{m.library_export_expires_at({ value: manifest.expiresAt })}</li>
            <li>{m.library_export_manifest_rows({ rows: manifest.rows })}</li>
            <li>{m.library_export_manifest_bytes({ bytes: manifest.recordBytes })}</li>
          </ul>
          <section className="space-y-3" aria-label={m.library_export_sections_heading()}>
            <h3 className="font-semibold">{m.library_export_sections_heading()}</h3>
            <ul className="list-disc space-y-3 pl-5">
              {sections.map(({ section, total }) => (
                <li key={section}>
                  <p>{exportSectionLabel(section)}</p>
                  {total ? (
                    <p className="text-muted-foreground">
                      {m.library_export_section_total({ rows: total.rows, bytes: total.recordBytes })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </details>
    </div>
  );
}
