import { DocumentBody } from '../document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useId, useRef } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PortableWriting, WritingPreview, WritingRepairs } from './portable-writing';

export const writingActionClass =
  'min-h-11 min-w-11 h-auto max-w-full px-3 py-2 whitespace-normal leading-snug [overflow-wrap:anywhere]';

export function WritingRepairNotice({ repairs }: { repairs: WritingRepairs }) {
  if (!repairs.attachments && !repairs.components && !repairs.links) return null;
  return (
    <div role="status" className="space-y-2 text-sm">
      {repairs.attachments > 0 ? <p>{m.thread_portable_attachments({ count: repairs.attachments })}</p> : null}
      {repairs.components > 0 ? <p>{m.thread_portable_components({ count: repairs.components })}</p> : null}
      {repairs.links > 0 ? <p>{m.thread_portable_links({ count: repairs.links })}</p> : null}
    </div>
  );
}

/** Only the admitted projection is rendered. No metadata resolver, external image or private context. */
export function PortableWritingPreview({
  preview,
  transfer,
  disabled,
}: {
  preview: WritingPreview;
  transfer: PortableWriting;
  disabled: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [preview]);
  const format = preview.format === 'json'
    ? m.thread_portable_format_json()
    : preview.format === 'markdown'
      ? m.thread_portable_format_markdown()
      : m.thread_portable_format_text();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-3 rounded-xl border p-4" data-private-writing>
      <h3 id={id} ref={heading} tabIndex={-1} className="font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {m.thread_portable_preview()}
      </h3>
      <p className="text-sm text-muted-foreground">{m.thread_portable_format({ format, bytes: preview.inputBytes })}</p>
      <p className="text-sm">{m.thread_portable_authority()}</p>
      <WritingRepairNotice repairs={preview.repairs} />
      <div className="min-w-0 max-h-96 overflow-auto rounded-lg bg-muted/40 p-3">
        <DocumentBody
          document={preview.body}
          locale={getLocale()}
          labels={{
            imageUnavailable: m.thread_portable_media_unavailable(),
          }}
          renderImage={() => <span>{m.thread_portable_media_unavailable()}</span>}
        />
      </div>
      {!preview.text ? <p className="text-sm">{m.thread_portable_empty()}</p> : null}
      <p>{m.thread_portable_replace_warning()}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={writingActionClass} disabled={disabled} onClick={transfer.confirm}>
          {m.thread_portable_replace()}
        </Button>
        <Button type="button" className={writingActionClass} variant="outline" onClick={transfer.cancel}>
          {m.thread_portable_keep()}
        </Button>
      </div>
    </section>
  );
}
