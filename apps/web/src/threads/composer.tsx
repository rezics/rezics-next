import { sessionCsrfToken } from '../session/query';
import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor, type RichTextEditorLabels, type UploadState } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CurrentPost, EditFailure, RevisedPost, WriteFailure } from './actions';
import { imageSources, replyImageLimit, uploadReplyImage, UploadRefusal } from './upload';

type WriteResult<T> = { ok: true; value: T } | WriteFailure;

export function csrfHeaders(): HeadersInit {
  const token = sessionCsrfToken() ?? '';
  return { 'X-CSRF-Token': token };
}

export function draftFetch(body: DocumentSnapshot): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof init?.body !== 'string') return globalThis.fetch(input, init);
      try {
        const payload = JSON.parse(init.body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return globalThis.fetch(input, init);
        return globalThis.fetch(input, { ...init, body: JSON.stringify({ ...payload, body }) });
      } catch {
        return globalThis.fetch(input, init);
      }
    },
    { preconnect: globalThis.fetch.preconnect },
  ) as typeof fetch;
}

export function refusalText(failure: WriteFailure): string {
  switch (failure.reason) {
    case 'closed':
      return m.thread_write_closed();
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

function uploadRefusalText(refusal: UploadRefusal): string {
  switch (refusal.reason) {
    case 'closed':
      return m.editor_upload_closed();
    case 'type':
      return m.editor_upload_type();
    case 'too-large':
      return m.editor_upload_too_large();
    case 'rejected':
      return m.editor_upload_rejected();
    case 'rate-limited':
      return m.editor_upload_rate_limited({ seconds: refusal.retryAfter ?? 1 });
    default:
      return m.editor_upload_unavailable();
  }
}

function editorLabels(): RichTextEditorLabels {
  return {
    toolbar: m.editor_toolbar(),
    blocks: m.editor_blocks(),
    undo: m.editor_undo(),
    redo: m.editor_redo(),
    hideKeyboard: m.editor_hide_keyboard(),
    formatting: m.editor_formatting(),
    turnInto: m.editor_turn_into(),
    paragraph: m.editor_paragraph(),
    heading1: m.editor_heading_1(),
    heading2: m.editor_heading_2(),
    heading3: m.editor_heading_3(),
    bulletList: m.editor_bullet_list(),
    orderedList: m.editor_ordered_list(),
    taskList: m.editor_task_list(),
    quote: m.editor_quote(),
    codeBlock: m.editor_code_block(),
    horizontalRule: m.editor_horizontal_rule(),
    table: m.editor_table(),
    insertBlock: m.editor_insert_block(),
    slashEmpty: m.editor_slash_empty(),
    bold: m.editor_bold(),
    italic: m.editor_italic(),
    strike: m.editor_strike(),
    inlineCode: m.editor_inline_code(),
    link: m.editor_link(),
    clearFormatting: m.editor_clear_formatting(),
    url: m.editor_url(),
    apply: m.editor_apply(),
    cancel: m.editor_cancel(),
    unlink: m.editor_unlink(),
    editLink: m.editor_edit_link(),
    openLink: m.editor_open_link(),
    invalidUrl: m.editor_invalid_url(),
    image: m.editor_image(),
    uploadFile: m.editor_upload_file(),
    imageAlt: m.editor_image_alt(),
    editImageAlt: m.editor_edit_image_alt(),
    insertImage: m.editor_insert_image(),
    uploading: m.editor_uploading(),
    uploadFailed: m.editor_upload_failed(),
    retryUpload: m.editor_retry_upload(),
    dismissUpload: m.editor_dismiss_upload(),
    unsupportedImage: m.editor_unsupported_image(),
    imageLimit: m.editor_image_limit(),
    documentError: m.editor_document_error(),
  };
}

export function SignInPrompt({
  returnTo,
  label,
  compact = false,
}: {
  returnTo: string;
  label?: string;
  compact?: boolean;
}) {
  const href = `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`;
  const text = label ?? m.account_sign_in();
  if (compact)
    return (
      <a
        className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 font-medium text-primary underline-offset-4 outline-none hover:bg-muted hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        href={href}
      >
        {text}
      </a>
    );
  return (
    <p className="rounded-lg border border-border/70 bg-card p-4 text-muted-foreground">
      <a className="font-medium text-primary underline-offset-4 hover:underline" href={href}>
        {text}
      </a>
    </p>
  );
}

export function PostComposer<T>({
  initialKey,
  titleRequired = false,
  canSubmit = true,
  containerId,
  boardId,
  onSubmit,
  onSuccess,
}: {
  initialKey: string;
  titleRequired?: boolean;
  canSubmit?: boolean;
  containerId?: string;
  boardId?: string;
  onSubmit: (input: {
    title: string;
    body: DocumentSnapshot;
    idempotencyKey: string;
    mediaIds: string[];
  }) => Promise<WriteResult<T>>;
  onSuccess: (value: T) => void;
}) {
  const formId = useId();
  const locale = getLocale();
  const labels = useMemo(() => editorLabels(), [locale]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(() => fromPlainText('', 'blocks'));
  const bodyRef = useRef(body);
  const [bodyCanSend, setBodyCanSend] = useState(() => hasDocumentContent(body));
  const editorHost = useRef<HTMLDivElement>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);
  const idempotencyRef = useRef(initialKey);
  idempotencyRef.current = idempotencyKey;
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState(0);
  const pendingRef = useRef(0);
  const refusalRef = useRef<UploadRefusal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = canSubmit && bodyCanSend && (!titleRequired || Boolean(title.trim()));
  const upload =
    containerId || boardId
      ? async (file: File, signal: AbortSignal) => {
          refusalRef.current = null;
          try {
            return await uploadReplyImage(
              containerId ?? { newThread: { boardId: boardId!, idempotencyKey: idempotencyRef.current } },
              file,
              signal,
            );
          } catch (error) {
            if (error instanceof UploadRefusal) refusalRef.current = error;
            throw error;
          }
        }
      : undefined;

  useEffect(() => {
    if (!containerId) return;
    document.cookie = 'rezics_draft_key=; Path=/; Max-Age=0; SameSite=Lax';
  }, [containerId]);
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
  const plainEditorVisible = !editorReady;

  function updateBody(next: DocumentSnapshot) {
    bodyRef.current = next;
    setBody(next);
    setBodyCanSend(hasDocumentContent(next));
  }

  function captureEditorInput(event: FormEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('contenteditable') !== 'true') return;
    const next = fromPlainText(target.innerText, 'blocks');
    bodyRef.current = next;
    if (plainEditorVisible) setBody(next);
    const hasMedia = target.querySelector('img, [data-media-id], [data-type="image"]') !== null;
    setBodyCanSend(hasDocumentContent(next) || hasMedia);
  }

  function handleUploadState(state: UploadState, count: number) {
    pendingRef.current = count;
    setPendingUploads(count);
    if (state === 'pending') setUploadNotice(null);
    if (state === 'failed') setUploadNotice(uploadRefusalText(refusalRef.current ?? new UploadRefusal('unavailable')));
  }

  async function submit(event?: FormEvent) {
    if (event && event.target !== event.currentTarget) return;
    event?.preventDefault();
    if (pendingRef.current > 0 || !hasDocumentContent(bodyRef.current) || !ready || submitting) return;
    const sources = imageSources(bodyRef.current);
    if (sources.length > replyImageLimit) {
      setUploadNotice(m.thread_image_limit());
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await onSubmit({ title, body: bodyRef.current, idempotencyKey, mediaIds: sources });
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setTitle('');
      const empty = fromPlainText('', 'blocks');
      bodyRef.current = empty;
      setBody(empty);
      setBodyCanSend(false);
      setUploadNotice(null);
      if (containerId || !boardId) {
        const nextKey = crypto.randomUUID();
        idempotencyRef.current = nextKey;
        setIdempotencyKey(nextKey);
      }
      onSuccess(result.value);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setSubmitting(false);
    }
  }

  const bodyLabel = titleRequired ? m.thread_new_body_label() : m.thread_reply_label();
  const editorSize = titleRequired ? 'thread-opening-editor' : 'thread-reply-editor';
  const fallbackSize = titleRequired ? 'thread-opening-fallback' : 'thread-reply-fallback';
  return (
    <div className="rounded-xl border border-border/70 bg-card p-5">
      <form id={formId} onSubmit={submit}>
        {titleRequired ? (
          <div className="mb-5 space-y-2">
            <Label htmlFor="thread-title">{m.thread_title_label()}</Label>
            <Input
              id="thread-title"
              className="h-11 border-border bg-background px-3"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
        <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      </form>
      <div className="space-y-2" onInputCapture={captureEditorInput}>
        <p className={titleRequired ? 'text-sm font-medium' : 'sr-only'}>{bodyLabel}</p>
        <div ref={editorHost}>
          {plainEditorVisible ? (
            <div
              aria-label={bodyLabel}
              aria-multiline="true"
              aria-placeholder={titleRequired ? undefined : m.thread_reply_placeholder()}
              data-placeholder={titleRequired ? undefined : m.thread_reply_placeholder()}
              className={`${fallbackSize} rounded-2xl border border-border/60 bg-background px-4 py-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] sm:px-6`}
              contentEditable
              role="textbox"
              suppressContentEditableWarning
            />
          ) : null}
          <RichTextEditor
            value={body}
            onChange={updateBody}
            label={bodyLabel}
            {...(titleRequired ? {} : { placeholder: m.thread_reply_placeholder() })}
            {...(titleRequired ? { toolbar: 'always' as const } : {})}
            labels={labels}
            className={`thread-post-editor ${editorSize}${plainEditorVisible ? ' thread-editor-pending' : ''}`}
            actions={
              <Button
                type="submit"
                form={formId}
                className="disabled:bg-primary disabled:text-primary-foreground disabled:opacity-100"
                disabled={!ready || submitting || pendingUploads > 0}
              >
                {m.thread_write_send()}
              </Button>
            }
            {...(upload ? { upload, onUploadState: handleUploadState } : {})}
          />
        </div>
      </div>
      {failure ? (
        <div className="mt-5 space-y-3" role="alert">
          {failure.existingReviewId ? (
            <p>
              {m.thread_review_duplicate()}{' '}
              <a
                className="font-medium text-primary underline underline-offset-4"
                href={`/${locale}/threads/${failure.existingReviewId}`}
              >
                {m.thread_review_existing()}
              </a>
            </p>
          ) : (
            <>
              <p>{refusalText(failure)}</p>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => void submit()}>
                {m.thread_write_retry()}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {uploadNotice ? (
        <p className="mt-5" role="alert">
          {uploadNotice}
        </p>
      ) : null}
    </div>
  );
}

export function postEditFailureText(failure: EditFailure): string {
  switch (failure.reason) {
    case 'closed':
      return m.thread_write_closed();
    case 'forbidden':
      return m.thread_edit_forbidden();
    case 'not-found':
      return m.thread_edit_not_found();
    case 'conflict':
      return m.thread_edit_conflict();
    case 'invalid':
      return m.thread_edit_invalid();
    case 'rate-limited':
      return m.thread_edit_rate_limited({ seconds: failure.retryAfter ?? 1 });
    case 'stale':
      return m.thread_edit_stale();
    default:
      return m.thread_edit_unavailable();
  }
}

export function InlinePostEditor({
  initialBody,
  revisionId: initialRevisionId,
  idempotencyKey,
  containerId,
  onSubmit,
  onCancel,
  onSuccess,
}: {
  initialBody: DocumentSnapshot;
  revisionId: string;
  idempotencyKey: string;
  containerId: string;
  onSubmit: (input: {
    body: DocumentSnapshot;
    revisionId: string;
    idempotencyKey: string;
    mediaIds: string[];
  }) => Promise<{ ok: true; post: RevisedPost } | EditFailure>;
  onCancel: () => void;
  onSuccess: (post: RevisedPost) => void;
}) {
  const locale = getLocale();
  const labels = useMemo(() => editorLabels(), [locale]);
  const [body, setBody] = useState(initialBody);
  const bodyRef = useRef(body);
  const [revisionId, setRevisionId] = useState(initialRevisionId);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const pendingRef = useRef(0);
  const refusalRef = useRef<UploadRefusal | null>(null);
  const ready = hasDocumentContent(body);

  function updateBody(next: DocumentSnapshot) {
    bodyRef.current = next;
    setBody(next);
  }

  function captureEditorInput(event: FormEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('contenteditable') !== 'true') return;
    const next = fromPlainText(target.innerText, 'blocks');
    bodyRef.current = next;
    setBody(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current > 0 || !hasDocumentContent(bodyRef.current) || submitting) return;
    const mediaIds = imageSources(bodyRef.current);
    if (mediaIds.length > replyImageLimit) {
      setUploadNotice(m.editor_image_limit());
      return;
    }
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await onSubmit({ body: bodyRef.current, revisionId, idempotencyKey, mediaIds });
      if (!result.ok) {
        setFailure(result);
        return;
      }
      onSuccess(result.post);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      setSubmitting(false);
    }
  }

  async function loadCurrentVersion() {
    if (!failure || failure.reason !== 'stale' || !failure.currentPost) return;
    const current = failure.currentPost as CurrentPost;
    if (current.body === null) {
      setFailure({ ok: false, reason: 'not-found' });
      return;
    }
    bodyRef.current = current.body;
    setBody(current.body);
    setRevisionId(current.revisionId);
    setFailure(null);
  }

  const upload = async (file: File, signal: AbortSignal) => {
    refusalRef.current = null;
    try {
      return await uploadReplyImage(containerId, file, signal);
    } catch (error) {
      if (error instanceof UploadRefusal) refusalRef.current = error;
      throw error;
    }
  };

  function handleUploadState(state: UploadState, count: number) {
    pendingRef.current = count;
    setPendingUploads(count);
    if (state === 'pending') setUploadNotice(null);
    if (state === 'failed') setUploadNotice(uploadRefusalText(refusalRef.current ?? new UploadRefusal('unavailable')));
  }

  return (
    <div
      className="space-y-4 rounded-xl border border-border/70 bg-card p-5"
      onInputCapture={captureEditorInput}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && !submitting) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm font-medium">{m.thread_reply_body_label()}</p>
        {submitting ? (
          <p
            className="min-h-32 rounded-xl border border-border/60 bg-background px-4 py-3 text-sm text-muted-foreground"
            role="status"
          >
            {m.thread_edit_saving()}
          </p>
        ) : (
          <RichTextEditor
            value={body}
            onChange={updateBody}
            label={m.thread_reply_body_label()}
            labels={labels}
            className="thread-post-editor"
            upload={upload}
            onUploadState={handleUploadState}
          />
        )}
        {failure ? (
          <div className="space-y-3" role="alert">
            <p>{postEditFailureText(failure)}</p>
            {failure.reason === 'stale' && failure.currentPost ? (
              <Button type="button" variant="outline" onClick={() => void loadCurrentVersion()}>
                {m.thread_edit_load_current()}
              </Button>
            ) : null}
          </div>
        ) : null}
        {uploadNotice ? (
          <p className="text-sm" role="alert">
            {uploadNotice}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!ready || submitting || pendingUploads > 0}>
            {submitting ? <Spinner aria-hidden="true" role="presentation" /> : null}
            {m.thread_edit_save()}
          </Button>
          <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
            {m.thread_edit_cancel()}
          </Button>
        </div>
      </form>
    </div>
  );
}
