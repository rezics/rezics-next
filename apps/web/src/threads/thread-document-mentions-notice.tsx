import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';

/** Per-post recovery text sits beside the existing shared document renderer. */
export function ThreadDocumentMentionsNotice({
  identity,
  notice,
  overflow,
  retryable,
  onRetry,
}: {
  identity: string;
  notice: 'unavailable' | 'changed' | 'overflow' | null;
  overflow: boolean;
  retryable: boolean;
  onRetry?: () => Promise<unknown>;
}) {
  const [attempt, setAttempt] = useState({ identity, pending: false, failed: false });
  if (attempt.identity !== identity) setAttempt({ identity, pending: false, failed: false });
  if (!notice && !overflow) return null;

  async function retry() {
    if (!onRetry || attempt.pending) return;
    setAttempt({ identity, pending: true, failed: false });
    try {
      if (!(await onRetry())) throw new Error('Current thread page was not refreshed');
      setAttempt({ identity, pending: false, failed: false });
    } catch {
      setAttempt({ identity, pending: false, failed: true });
    }
  }

  return (
    <aside
      data-slot="thread-document-mentions-notice"
      className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {notice === 'unavailable' ? <p>{m.thread_document_mentions_unavailable()}</p> : null}
      {notice === 'changed' ? <p>{m.thread_document_mentions_changed()}</p> : null}
      {overflow ? <p>{m.thread_document_mentions_overflow()}</p> : null}
      {attempt.failed ? <p>{m.thread_document_mentions_retry_failed()}</p> : null}
      {retryable && onRetry ? (
        <Button variant="outline" size="sm" disabled={attempt.pending} onClick={() => void retry()}>
          {attempt.pending ? m.thread_document_mentions_retrying() : m.thread_document_mentions_retry()}
        </Button>
      ) : null}
    </aside>
  );
}
