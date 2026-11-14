import { useEffect, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import { VndbAction } from './controls';

/** Recovery owns focus after the former review and its consent controls unmount. */
export function ImportCleanupRecovery({
  busy,
  replacementPending,
  onRetry,
  onDiscardReplacement,
}: {
  busy: boolean;
  replacementPending: boolean;
  onRetry: () => void;
  onDiscardReplacement: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => section.current?.focus({ preventScroll: true }), []);
  return (
    <section ref={section} tabIndex={-1} className="min-w-0 space-y-3" data-import-cleanup>
      <h2 className="text-lg font-semibold">{m.library_import_cleanup_title()}</h2>
      <p role="status" aria-live="polite">
        {busy ? m.library_import_cleanup_sending() : m.library_import_cleanup_help()}
      </p>
      <p>{replacementPending ? m.library_import_cleanup_selected() : m.library_import_cleanup_choose()}</p>
      <div className="flex flex-wrap gap-3">
        <VndbAction type="button" disabled={busy} onClick={onRetry}>
          {m.library_import_cleanup_retry()}
        </VndbAction>
        {replacementPending ? (
          <VndbAction type="button" variant="outline" onClick={onDiscardReplacement}>
            {m.library_import_cleanup_withdraw()}
          </VndbAction>
        ) : null}
      </div>
    </section>
  );
}

export function ImportCleanupReceipts({ count }: { count: number }) {
  return count ? <p role="status">{m.library_import_cleanup_receipts({ count })}</p> : null;
}
