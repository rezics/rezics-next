import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { documentText, type DocumentSnapshot } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import {
  BrowserWritingStore,
  LocalWritingDraft,
  prepareWriting,
  type WritingPayload,
  type WritingScope,
} from './local-writing-draft';

const action =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal px-4 py-2 text-left leading-snug [overflow-wrap:anywhere]';
const date = (value: number) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(value);

/** Only the existing admitted editor supplies authority; this hook adds no read or network autosave. */
export function useLocalWritingDraft(input: {
  actor: string | null;
  scope: WritingScope | null;
  current: () => boolean;
  signal: AbortSignal;
  admitted: boolean;
  title: string;
  body: DocumentSnapshot;
  suspended: boolean;
}) {
  const latest = useRef(input);
  latest.current = input;
  const scopeKey = JSON.stringify([input.actor, input.scope]);
  const [bound, setBound] = useState<{ key: string; draft: LocalWritingDraft } | null>(null);
  useLayoutEffect(() => {
    if (!input.actor || !input.scope || !input.admitted || !input.current()) {
      setBound(null);
      return;
    }
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, input.signal]);
    const draft = new LocalWritingDraft(
      () => new BrowserWritingStore(window.localStorage),
      input.actor,
      input.scope,
      () =>
        latest.current.current() &&
        latest.current.admitted &&
        JSON.stringify([latest.current.actor, latest.current.scope]) === scopeKey,
      signal,
    );
    setBound({ key: scopeKey, draft });
    draft.load();
    // Another tab may have changed exact revisions. Retire instead of silently clobbering its writing.
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith('rezics:private-writing:v1')) owner.abort();
    };
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener('storage', storageChanged);
      owner.abort();
    };
  }, [scopeKey, input.signal, input.admitted]);
  const draft = bound?.key === scopeKey && input.admitted && input.current() ? bound.draft : null;
  const read = () => prepareWriting(latest.current.title, latest.current.body);
  useLayoutEffect(() => {
    if (!draft) return;
    if (input.suspended) draft.cancel();
    else draft.schedule(read);
  }, [draft, input.title, input.body, input.suspended]);
  return { draft, read };
}

function useRedaction(host: RefObject<HTMLDivElement | null>, draft: LocalWritingDraft) {
  useLayoutEffect(() => {
    const redact = () => {
      const node = host.current;
      if (!node) return;
      node.hidden = true;
      for (const preview of node.querySelectorAll<HTMLElement>('[data-private-writing]')) preview.textContent = '';
      for (const field of node.querySelectorAll('textarea')) field.value = '';
    };
    draft.signal.addEventListener('abort', redact, { once: true });
    if (draft.signal.aborted) redact();
    return () => draft.signal.removeEventListener('abort', redact);
  }, [draft, host]);
}

export function LocalWritingDraftControls({
  draft,
  read,
  live,
  suspended,
  restoreDisabled,
  onRestore,
  hasLiveWriting,
}: {
  draft: LocalWritingDraft;
  read: () => WritingPayload;
  live: () => { title: string; body: DocumentSnapshot };
  suspended: boolean;
  restoreDisabled: boolean;
  onRestore: (payload: WritingPayload) => void;
  hasLiveWriting: boolean;
}) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const exportId = useId();
  const host = useRef<HTMLDivElement>(null);
  const exportField = useRef<HTMLTextAreaElement>(null);
  const [exportText, setExportText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useRedaction(host, draft);
  useLayoutEffect(() => {
    if (exportText === null) return;
    exportField.current?.focus();
    exportField.current?.select();
  }, [exportText]);
  const blocked = suspended || state.pending;
  const preview = state.preview;
  const unavailable = state.issue !== null;
  const exportLive = () => {
    if (draft.signal.aborted) return;
    const current = live();
    setCopied(false);
    // Safe plain text remains available even if schema/storage validation failed.
    setExportText(`${current.title}${current.title ? '\n\n' : ''}${documentText(current.body)}`);
  };
  const restore = () => {
    if (blocked || restoreDisabled || draft.signal.aborted) return;
    if (hasLiveWriting && !confirmRestore) {
      setConfirmRestore(true);
      return;
    }
    const payload = draft.restore();
    if (payload) {
      setConfirmRestore(false);
      onRestore(payload);
    }
  };
  return (
    <div
      ref={host}
      className="mt-5 min-w-0 space-y-3 rounded-lg border border-border p-3 text-sm [overflow-wrap:anywhere]"
      aria-label={m.thread_draft_heading()}
    >
      <h3 className="font-medium">{m.thread_draft_heading()}</h3>
      <p>{m.thread_draft_privacy()}</p>
      {blocked ? <p role="status">{m.thread_draft_unknown()}</p> : null}
      {preview ? (
        <section className="min-w-0 space-y-2" aria-label={m.thread_draft_preview()}>
          <p>{m.thread_draft_dated({ date: date(preview.updated) })}</p>
          {preview.state === 'unknown' ? (
            <p role="alert">{m.thread_draft_unknown()}</p>
          ) : (
            <pre
              data-private-writing
              className="max-h-48 min-w-0 overflow-y-auto whitespace-pre-wrap font-sans [overflow-wrap:anywhere]"
            >
              {[preview.payload.title, preview.payload.text].filter(Boolean).join('\n\n')}
            </pre>
          )}
          {preview.payload.attachmentRepair ? <p>{m.thread_draft_attachments()}</p> : null}
          {confirmRestore ? <p role="alert">{m.thread_draft_replace_live()}</p> : null}
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              className={action}
              disabled={blocked || restoreDisabled || preview.state === 'unknown' || unavailable}
              onClick={restore}
            >
              {confirmRestore ? m.thread_draft_confirm_restore() : m.thread_draft_restore()}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={action}
              disabled={blocked}
              onClick={() => {
                draft.discard();
                setConfirmRestore(false);
              }}
            >
              {m.thread_draft_discard()}
            </Button>
          </div>
        </section>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className={action}
            disabled={blocked || unavailable}
            onClick={() => (state.enabled ? draft.pause() : draft.enable(read))}
          >
            {state.enabled ? m.thread_draft_pause() : m.thread_draft_save()}
          </Button>
          {state.saved ? (
            <Button
              type="button"
              variant="outline"
              className={action}
              disabled={blocked}
              onClick={() => draft.discard()}
            >
              {m.thread_draft_discard()}
            </Button>
          ) : null}
        </div>
      )}
      {state.saved ? <p role="status">{m.thread_draft_saved({ date: date(state.saved.updated) })}</p> : null}
      {state.replacement ? (
        <div className="space-y-2" role="alert">
          <p>{m.thread_draft_eviction({ date: date(state.replacement.updated) })}</p>
          <Button
            type="button"
            variant="outline"
            className={action}
            disabled={blocked}
            onClick={() => draft.replace(read)}
          >
            {m.thread_draft_replace_saved()}
          </Button>
          <Button type="button" variant="ghost" className={action} disabled={blocked} onClick={() => draft.pause()}>
            {m.thread_draft_pause()}
          </Button>
        </div>
      ) : null}
      {unavailable ? (
        <div className="space-y-2" role="alert">
          <p>
            {state.issue === 'limit'
              ? m.thread_draft_limit()
              : state.issue === 'version' || state.issue === 'document'
                ? m.thread_draft_version()
                : m.thread_draft_storage_error()}
          </p>
          <Button
            type="button"
            variant="outline"
            className={action}
            disabled={blocked || Boolean(preview)}
            onClick={() => draft.retry(read)}
          >
            {m.thread_draft_retry()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={action}
            disabled={blocked}
            onClick={() => setConfirmDiscard(true)}
          >
            {m.thread_draft_reset()}
          </Button>
          {confirmDiscard ? (
            <div className="space-y-2">
              <p>{m.thread_draft_reset_warning()}</p>
              <Button
                type="button"
                variant="outline"
                className={action}
                disabled={blocked}
                onClick={() => {
                  draft.discardBroken();
                  setConfirmDiscard(false);
                }}
              >
                {m.thread_draft_confirm_discard()}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <Button type="button" variant="ghost" className={action} onClick={exportLive}>
        {m.thread_draft_export()}
      </Button>
      {exportText !== null ? (
        <div className="min-w-0 space-y-2">
          <label className="block" htmlFor={exportId}>
            {m.thread_draft_export_hint()}
          </label>
          <textarea
            ref={exportField}
            id={exportId}
            className="min-h-32 w-full min-w-0 rounded border border-border bg-background p-3"
            readOnly
            value={exportText}
          />
          <Button
            type="button"
            variant="outline"
            className={action}
            onClick={async () => {
              const owner = draft.signal;
              if (owner.aborted) return;
              try {
                await navigator.clipboard.writeText(exportText);
                if (!owner.aborted) setCopied(true);
              } catch {
                if (!owner.aborted) {
                  exportField.current?.focus();
                  exportField.current?.select();
                }
              }
            }}
          >
            {m.thread_draft_copy()}
          </Button>
          <Button type="button" variant="ghost" className={action} onClick={() => setExportText(null)}>
            {m.thread_draft_close()}
          </Button>
          {copied ? <p role="status">{m.thread_draft_copied()}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
