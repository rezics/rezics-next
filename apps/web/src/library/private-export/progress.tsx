import { m } from '../../paraglide/messages.js';
import { ExportAction } from './controls';

export function ExportProgress({
  records,
  pages,
  busy,
  onCancel,
}: {
  records: number;
  pages: number;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-4" data-export-stage="capturing" aria-live="polite">
      <p role="status">{m.library_export_progress({ records, pages })}</p>
      <p className="text-sm text-muted-foreground">{m.library_export_capturing()}</p>
      <ExportAction type="button" variant="outline" disabled={false} onClick={onCancel}>
        {busy ? m.library_export_cancelling() : m.library_export_cancel()}
      </ExportAction>
    </section>
  );
}
