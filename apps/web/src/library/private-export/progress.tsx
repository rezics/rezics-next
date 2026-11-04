import { m } from '../../paraglide/messages.js';
import { ExportAction } from './controls';
import type { Ref } from 'react';

export function ExportProgress({
  records,
  pages,
  statusRef,
  onCancel,
}: {
  records: number;
  pages: number;
  statusRef?: Ref<HTMLParagraphElement>;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-4" data-export-stage="capturing" aria-live="polite">
      <p ref={statusRef} tabIndex={-1} role="status">
        {m.library_export_progress({ records, pages })}
      </p>
      <p className="text-sm text-muted-foreground">{m.library_export_capturing()}</p>
      <ExportAction type="button" variant="outline" disabled={false} onClick={onCancel}>
        {m.library_export_cancel()}
      </ExportAction>
    </section>
  );
}
