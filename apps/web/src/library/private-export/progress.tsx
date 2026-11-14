import type { MouseEventHandler } from 'react';
import { m } from '../../paraglide/messages.js';
import { ExportAction } from './controls';

export function ExportProgress({
  records,
  pages,
  paused = false,
  onCancel,
}: {
  records: number;
  pages: number;
  paused?: boolean;
  onCancel: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <div className="space-y-4" data-export-stage="capturing">
      <p>{m.library_export_progress({ records, pages })}</p>
      <p className="text-sm text-muted-foreground">
        {paused ? m.library_export_paused() : m.library_export_capturing()}
      </p>
      <p className="text-sm">{m.library_export_no_partial()}</p>
      <ExportAction type="button" variant="outline" onClick={onCancel}>
        {m.library_export_cancel()}
      </ExportAction>
    </div>
  );
}
