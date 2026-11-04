import type { UploadAttachment, UploadAttachmentActions } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { useId, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import type { AttachmentObservation } from './attachments';

function status(observation: AttachmentObservation | undefined, failed: boolean): string {
  if (failed && observation?.stage === 'insertion') return m.thread_attachment_insertion_failed();
  if (!observation) return m.editor_upload_unavailable();
  switch (observation.stage) {
    case 'reservation':
      return m.thread_attachment_reserving();
    case 'transfer':
      return m.thread_attachment_transferring();
    case 'processing':
      return m.thread_attachment_processing();
    case 'insertion':
      return m.thread_attachment_inserting();
    case 'failed': {
      switch (observation.refusal?.reason) {
        case 'rejected':
          return m.editor_upload_rejected();
        case 'closed':
          return m.editor_upload_closed();
        case 'type':
          return m.editor_upload_type();
        case 'too-large':
          return m.editor_upload_too_large();
        case 'rate-limited':
          return m.editor_upload_rate_limited({ seconds: observation.refusal.retryAfter ?? 1 });
        default:
          return observation.recovery === 'known-media'
            ? m.thread_attachment_known_unknown()
            : m.thread_attachment_reservation_unknown();
      }
    }
  }
}

/** The single row of controls delegates all editor operations to its original owner. */
export function ComposerAttachmentRow({
  attachment,
  observation,
  actions,
  current,
}: {
  attachment: UploadAttachment;
  observation: AttachmentObservation | undefined;
  actions: UploadAttachmentActions;
  current: () => boolean;
}) {
  const label = useId();
  const input = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const failed = attachment.phase === 'failed';
  const insertionFailed = failed && observation?.stage === 'insertion';
  const retry =
    failed && (insertionFailed || observation?.recovery === 'exact' || observation?.recovery === 'known-media');
  // An uncertain reserve cannot be disguised as a fresh command. Definitive local
  // validation/native rejection and a still-running selection can be replaced.
  const replace = !failed || insertionFailed || observation?.recovery === 'replace';
  function focusEditor() {
    if (!current()) return;
    host.current?.closest('[data-slot="rich-text-editor"]')?.querySelector<HTMLElement>('.ProseMirror')?.focus();
  }
  function dismiss() {
    if (!current()) return;
    const editor = host.current?.closest('[data-slot="rich-text-editor"]')?.querySelector<HTMLElement>('.ProseMirror');
    const focused = document.activeElement;
    actions.dismiss();
    // Synchronous deliberate action only. A later user focus action always wins.
    if (focused && host.current?.contains(focused) && current()) editor?.focus();
  }
  return (
    <div ref={host} role="group" aria-labelledby={label} className="my-2 min-w-0 rounded-md border p-3 text-sm">
      <p id={label} className="min-w-0 font-medium [overflow-wrap:anywhere]">
        {attachment.alt || m.thread_attachment_image()}
      </p>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{attachment.file.name}</p>
      <p role="status" aria-live="polite" aria-atomic="true" className="mt-1 [overflow-wrap:anywhere]">
        {status(observation, failed)}
      </p>
      {failed ? (
        <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
          {insertionFailed
            ? m.thread_attachment_insertion_retry()
            : observation?.recovery === 'exact'
              ? m.thread_attachment_exact_retry()
              : observation?.recovery === 'known-media'
                ? m.thread_attachment_resume()
                : observation?.recovery === 'replace'
                  ? m.thread_attachment_replace_advice()
                  : m.thread_attachment_no_recovery()}
        </p>
      ) : null}
      <div className="mt-2 flex min-w-0 flex-wrap gap-2">
        {retry ? (
          <Button
            type="button"
            variant="secondary"
            className="h-auto min-h-11 whitespace-normal"
            onClick={() => {
              if (current()) {
                actions.retry();
                focusEditor();
              }
            }}
          >
            {m.editor_retry_upload()}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" className="h-auto min-h-11 whitespace-normal" onClick={dismiss}>
          {m.editor_dismiss_upload()}
        </Button>
        {replace ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal"
            onClick={() => {
              if (current()) input.current?.click();
            }}
          >
            {m.thread_attachment_replace()}
          </Button>
        ) : null}
      </div>
      {replace ? (
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label={m.thread_attachment_replace()}
          accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file && current()) {
              actions.replace(file);
              focusEditor();
            }
          }}
        />
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">{m.thread_attachment_local_remove()}</p>
    </div>
  );
}
