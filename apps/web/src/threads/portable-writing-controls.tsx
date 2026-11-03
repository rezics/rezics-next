import { Button } from '@rezics/ui/shadcn/button';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { m } from '../paraglide/messages.js';
import {
  PortableWriting,
  portableWritingLimits,
  type PortableErrorCode,
  type WritingSource,
} from './portable-writing';
import { PortableWritingPreview, WritingRepairNotice, writingActionClass } from './portable-writing-preview';

/** Bind to the existing composer visit, never another storage or editor snapshot owner. */
export function usePortableWriting(source: WritingSource, admitted: boolean) {
  const latest = useRef(source);
  latest.current = source;
  const [transfer, setTransfer] = useState<PortableWriting | null>(null);
  useLayoutEffect(() => {
    if (!admitted || !source.current()) { setTransfer(null); return; }
    const local = new PortableWriting({
      signal: source.signal,
      current: () => latest.current.current(),
      revision: () => latest.current.revision(),
      replaceable: () => latest.current.replaceable(),
      snapshot: () => latest.current.snapshot(),
      replace: (body) => latest.current.replace(body),
      focus: () => latest.current.focus(),
    }, {
      createURL: (blob) => URL.createObjectURL(blob),
      revokeURL: (url) => URL.revokeObjectURL(url),
      download: (url, filename) => {
        if (typeof HTMLAnchorElement === 'undefined' || !('download' in HTMLAnchorElement.prototype))
          throw new Error('Download unavailable');
        const link = window.document.createElement('a');
        link.href = url;
        link.download = filename;
        link.hidden = true;
        window.document.body.append(link);
        try { link.click(); } finally { link.remove(); }
      },
      copy: async (text) => { await navigator.clipboard.writeText(text); },
    });
    setTransfer(local);
    return () => local.retire();
  }, [source.signal, admitted]);
  return transfer;
}

export function portableErrorText(code: PortableErrorCode): string {
  switch (code) {
    case 'type': return m.thread_portable_error_type();
    case 'size': return m.thread_portable_error_size({ bytes: portableWritingLimits.fileBytes });
    case 'read': return m.thread_portable_error_read();
    case 'json': return m.thread_portable_error_json();
    case 'document': return m.thread_portable_error_document();
    case 'depth': return m.thread_portable_error_depth({ depth: portableWritingLimits.depth });
    case 'expanded': return m.thread_portable_error_expanded({ bytes: portableWritingLimits.snapshotBytes });
    case 'changed': return m.thread_portable_error_changed();
    case 'busy': return m.thread_portable_error_busy();
    case 'pending': return m.thread_portable_error_pending();
    case 'recovery': return m.thread_portable_error_recovery();
    case 'download': return m.thread_portable_error_download();
    case 'copy': return m.thread_portable_error_copy();
  }
}

/** Redact synchronously on account/route retirement, including before React can commit a replacement. */
function usePrivateWritingRedaction(host: RefObject<HTMLDivElement | null>, signal: AbortSignal) {
  useLayoutEffect(() => {
    const redact = () => {
      const node = host.current;
      if (!node) return;
      node.hidden = true;
      for (const preview of node.querySelectorAll<HTMLElement>('[data-private-writing]')) preview.textContent = '';
      for (const field of node.querySelectorAll('textarea')) field.value = '';
      for (const input of node.querySelectorAll('input[type="file"]')) (input as HTMLInputElement).value = '';
    };
    signal.addEventListener('abort', redact, { once: true });
    if (signal.aborted) redact();
    return () => signal.removeEventListener('abort', redact);
  }, [host, signal]);
}

export function PortableWritingToolbar({ transfer }: { transfer: PortableWriting }) {
  const state = useSyncExternalStore(transfer.subscribe, transfer.snapshot, transfer.snapshot);
  return (
    <Button type="button" variant="outline" className={writingActionClass}
      aria-expanded={state.open} onClick={transfer.toggle}>
      {m.thread_portable_files()}
    </Button>
  );
}

export function PortableWritingControls({
  transfer,
  signal,
  disabled,
  phase,
}: {
  transfer: PortableWriting;
  signal: AbortSignal;
  disabled: boolean;
  phase: 'ready' | 'pending' | 'failed';
}) {
  const state = useSyncExternalStore(transfer.subscribe, transfer.snapshot, transfer.snapshot);
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);
  const host = useRef<HTMLDivElement>(null);
  usePrivateWritingRedaction(host, signal);
  useLayoutEffect(() => {
    if (!state.download || !state.open) return;
    copyField.current?.focus();
    copyField.current?.select();
  }, [state.download, state.open]);
  if (!state.open) return null;
  return (
    <div ref={host} className="mt-4 min-w-0 space-y-4 rounded-xl border p-4 [overflow-wrap:anywhere]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); transfer.close(); }
      }}>
      <h2 className="font-medium">{m.thread_portable_heading()}</h2>
      <p className="text-sm text-muted-foreground">{m.thread_portable_privacy()}</p>
      {disabled ? <p role="status">{m.thread_portable_error_busy()}</p> : null}
      {phase === 'failed' ? <p role="alert">{m.thread_portable_raw_warning()}</p> : null}
      <input ref={fileInput} type="file" className="sr-only" tabIndex={-1}
        accept=".json,.txt,.md,.markdown,application/json,text/plain,text/markdown"
        aria-label={m.thread_portable_choose()} disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0] ?? null;
          event.currentTarget.value = '';
          void transfer.select(file);
        }} />
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button type="button" variant="outline" className={writingActionClass} disabled={disabled}
          onClick={() => fileInput.current?.click()}>{m.thread_portable_choose()}</Button>
        <Button type="button" variant="outline" className={writingActionClass} disabled={phase !== 'ready'}
          onClick={() => transfer.export('json')}>{m.thread_portable_export_json()}</Button>
        <Button type="button" variant="outline" className={writingActionClass} disabled={phase !== 'ready'}
          onClick={() => transfer.export('text')}>{m.thread_portable_export_text()}</Button>
        {phase === 'failed' ? (
          <Button type="button" variant="outline" className={writingActionClass} onClick={() => transfer.export('raw')}>
            {m.thread_portable_export_raw()}
          </Button>
        ) : null}
      </div>
      {state.reading ? (
        <div className="space-y-2">
          <p role="status">{m.thread_portable_reading()}</p>
          <Button type="button" variant="outline" className={writingActionClass} onClick={transfer.cancel}>
            {m.thread_portable_cancel()}
          </Button>
        </div>
      ) : null}
      {state.error ? <p role="alert">{portableErrorText(state.error)}</p> : null}
      {state.preview ? <PortableWritingPreview preview={state.preview} transfer={transfer} disabled={disabled} /> : null}
      {state.download ? (
        <section aria-labelledby={`${id}-export`} className="min-w-0 space-y-3" data-private-writing>
          <h3 id={`${id}-export`} className="font-medium">
            {state.download.kind === 'raw' ? m.thread_portable_export_raw() : m.thread_portable_export_preview()}
          </h3>
          {state.download.kind === 'raw' ? <p>{m.thread_portable_raw_warning()}</p> : null}
          {state.downloaded ? <p role="status">{m.thread_portable_download_started()}</p> : null}
          <WritingRepairNotice repairs={state.download.repairs} />
          <label htmlFor={`${id}-copy`} className="block text-sm">{m.thread_portable_copy_hint()}</label>
          <textarea id={`${id}-copy`} ref={copyField} readOnly value={state.download.content}
            className="min-h-32 w-full min-w-0 rounded-lg border bg-background p-3 font-mono text-sm" />
          <Button type="button" variant="outline" className={writingActionClass} onClick={() => void transfer.copy()}>
            {m.thread_portable_copy()}
          </Button>
          {state.copied ? <p role="status">{m.thread_portable_copied()}</p> : null}
        </section>
      ) : null}
      <Button type="button" variant="ghost" className={writingActionClass} onClick={transfer.close}>
        {m.thread_portable_close()}
      </Button>
    </div>
  );
}
