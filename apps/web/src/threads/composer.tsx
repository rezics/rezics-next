import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor } from '@rezics/ui';
import { Button } from '@rezics/ui/button';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import type { WriteFailure } from './actions';

type WriteResult<T> = { ok: true; value: T } | WriteFailure;

export function csrfHeaders(): HeadersInit {
  const token = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
  return { 'X-CSRF-Token': token };
}

export function draftFetch(body: DocumentSnapshot): typeof fetch {
  const fetchDraft: typeof fetch = (input, init) => {
    if (typeof init?.body !== 'string') return globalThis.fetch(input, init);
    try {
      const payload = JSON.parse(init.body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return globalThis.fetch(input, init);
      return globalThis.fetch(input, { ...init, body: JSON.stringify({ ...payload, body }) });
    } catch {
      return globalThis.fetch(input, init);
    }
  };
  return Object.assign(fetchDraft, { preconnect: globalThis.fetch.preconnect });
}

export function refusalText(failure: WriteFailure): string {
  switch (failure.reason) {
    case 'forbidden':
      return m.thread_write_forbidden();
    case 'invalid':
      return m.thread_write_invalid();
    case 'rate-limited':
      return m.thread_write_rate_limited({ seconds: failure.retryAfter ?? 1 });
    default:
      return m.thread_write_unavailable();
  }
}

export function SignInPrompt({ returnTo }: { returnTo: string }) {
  return (
    <p className="rounded-lg border border-border/70 bg-card p-4 text-muted-foreground">
      <a
        className="font-medium text-primary underline-offset-4 hover:underline"
        href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}
      >
        {m.account_sign_in()}
      </a>
    </p>
  );
}

export function PostComposer<T>({
  initialKey,
  titleRequired = false,
  onSubmit,
  onSuccess,
}: {
  initialKey: string;
  titleRequired?: boolean;
  onSubmit: (input: { title: string; body: DocumentSnapshot; idempotencyKey: string }) => Promise<WriteResult<T>>;
  onSuccess: (value: T) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(() => fromPlainText('', 'blocks'));
  const bodyRef = useRef(body);
  const [bodyCanSend, setBodyCanSend] = useState(() => hasDocumentContent(body));
  const editorHost = useRef<HTMLDivElement>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [showPlainEditor, setShowPlainEditor] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = bodyCanSend && (!titleRequired || Boolean(title.trim()));

  useEffect(() => {
    const host = editorHost.current;
    if (!host) return;
    const revealEditor = () => {
      if (host.querySelector('.ProseMirror[contenteditable="true"]')) setEditorReady(true);
    };
    revealEditor();
    const observer = new MutationObserver(revealEditor);
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] });
    return () => observer.disconnect();
  }, []);
  const plainEditorVisible = !editorReady || showPlainEditor;

  function updateBody(next: DocumentSnapshot) {
    bodyRef.current = next;
    setBody(next);
    setBodyCanSend(hasDocumentContent(next));
  }

  function captureEditorInput(event: FormEvent<HTMLFormElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('contenteditable') !== 'true') return;
    const next = fromPlainText(target.innerText, 'blocks');
    bodyRef.current = next;
    if (plainEditorVisible) setBody(next);
    const hasMedia = target.querySelector('img, [data-media-id], [data-type="image"]') !== null;
    setBodyCanSend(hasDocumentContent(next) || hasMedia);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!hasDocumentContent(bodyRef.current) || !ready || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await onSubmit({ title, body: bodyRef.current, idempotencyKey });
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setTitle('');
      const empty = fromPlainText('', 'blocks');
      bodyRef.current = empty;
      setBody(empty);
      setBodyCanSend(false);
      setShowPlainEditor(true);
      setIdempotencyKey(crypto.randomUUID());
      onSuccess(result.value);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setSubmitting(false);
    }
  }

  const bodyLabel = titleRequired ? m.thread_new_body_label() : m.thread_reply_body_label();
  return (
    <form
      className="space-y-5 rounded-xl border border-border/70 bg-card p-5"
      onInputCapture={captureEditorInput}
      onSubmit={submit}
    >
      {titleRequired ? (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="thread-title">
            {m.thread_title_label()}
          </label>
          <input
            id="thread-title"
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            autoComplete="off"
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <p className="text-sm font-medium">{bodyLabel}</p>
        <div ref={editorHost}>
          <div className={plainEditorVisible ? 'hidden' : undefined} aria-hidden={plainEditorVisible}>
            <RichTextEditor value={body} onChange={updateBody} label={bodyLabel} className="thread-post-editor" />
          </div>
          {plainEditorVisible ? (
            <div
              aria-label={bodyLabel}
              aria-multiline="true"
              className="min-h-[50dvh] rounded-2xl border border-border/60 bg-background px-4 py-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-6"
              contentEditable
              onBlur={() => setShowPlainEditor(false)}
              role="textbox"
              suppressContentEditableWarning
            />
          ) : null}
        </div>
      </div>
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      {failure ? (
        <div className="space-y-3" role="alert">
          <p>{refusalText(failure)}</p>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => void submit()}>
            {m.thread_write_retry()}
          </Button>
        </div>
      ) : null}
      <Button type="submit" disabled={!ready || submitting}>
        {m.thread_write_send()}
      </Button>
    </form>
  );
}
