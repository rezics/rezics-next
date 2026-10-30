import { sessionCsrfToken, sessionQuery } from '../session/query';
import { QueryClientContext } from '@tanstack/react-query';
import { fromPlainText, hasDocumentContent, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor, type RichTextEditorLabels, type UploadState } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { lookupPostMention } from './mentions';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CurrentPost, EditFailure, RevisedPost, WriteFailure } from './actions';
import { checkDraftMediaStates, type DraftMediaState } from './media-state';
import { imageSources, replyImageLimit, uploadReplyImage, UploadRefusal } from './upload';
import { ReplyImageUploadRecovery, ReplyUploadRecoveryRefusal, type ReplyUploadTarget } from './media-upload-recovery';
import { ExistingReviewNotice } from './write-prompts';
import { ReplyIntent } from './reply-context-intent';
export { ExistingReviewNotice, SignInPrompt } from './write-prompts';

type WriteResult<T> = { ok: true; value: T } | WriteFailure;

function useComposerUpload(
  target: ReplyUploadTarget | undefined,
  owned: RefObject<Set<string>>,
  refusal: RefObject<UploadRefusal | null>,
) {
  const client = useContext(QueryClientContext);
  const current = useRef(() => ({ target, session: null }) as import('./media-upload-recovery').ReplyUploadContext);
  current.current = () => {
    const session = client?.getQueryData(sessionQuery.queryKey);
    return {
      target,
      session:
        session?.state === 'signed-in' && session.subject && session.csrfToken
          ? { subject: session.subject, csrfToken: session.csrfToken }
          : null,
    };
  };
  const [recovery] = useState(() => new ReplyImageUploadRecovery(() => current.current()));
  useEffect(() => {
    recovery.invalidate();
  });
  useEffect(() => () => recovery.clear(), [recovery]);
  return async (file: File, signal: AbortSignal) => {
    refusal.current = null;
    try {
      const uploaded = await recovery.upload(file, signal);
      owned.current.add(uploaded.src);
      return uploaded;
    } catch (error) {
      if (error instanceof UploadRefusal) refusal.current = error;
      throw error;
    }
  };
}

function useDraftMediaCheck(
  body: RefObject<DocumentSnapshot>,
  target: ReplyUploadTarget | undefined,
  failure: EditFailure | null,
  owned: RefObject<Set<string>>,
  update: (media: DraftMediaState[]) => void,
) {
  const client = useContext(QueryClientContext);
  const active = useRef<AbortController | null>(null);
  const [checking, setChecking] = useState(false);
  const latest = useRef({ target, failure });
  latest.current = { target, failure };
  useEffect(() => () => active.current?.abort(), []);
  const check = async () => {
    if (failure?.reason !== 'media-unavailable') return;
    const snapshot = body.current;
    const ids = mediaIdsFromSources(imageSources(snapshot));
    if (ids.length > replyImageLimit) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const context = JSON.stringify(target);
    const session = client?.getQueryData(sessionQuery.queryKey);
    setChecking(true);
    let media: DraftMediaState[];
    try {
      media = await checkDraftMediaStates({ data: ids, signal: controller.signal });
    } catch {
      media = ids.map((id) => ({ id, state: 'unavailable' }));
    }
    if (controller.signal.aborted) return;
    if (
      body.current === snapshot &&
      latest.current.failure === failure &&
      JSON.stringify(latest.current.target) === context &&
      client?.getQueryData(sessionQuery.queryKey) === session
    )
      update(mediaAfterRefusal(media, snapshot, owned.current));
    setChecking(false);
  };
  return { check, checking };
}

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
    case 'conflict':
      return m.thread_edit_conflict();
    case 'invalid':
      return m.thread_write_invalid();
    case 'media-unavailable':
      return m.thread_media_unavailable();
    case 'rate-limited':
      return m.thread_write_rate_limited({ seconds: failure.retryAfter ?? 1 });
    default:
      return m.thread_write_unavailable();
  }
}

function imageAlt(snapshot: DocumentSnapshot, id: string): string {
  let alt = '';
  const visit = (node: DocumentNode) => {
    if (
      node.type === 'image' &&
      (node.attrs?.src === id || (typeof node.attrs?.src === 'string' && siteMediaId(node.attrs.src) === id)) &&
      typeof node.attrs.alt === 'string'
    )
      alt = node.attrs.alt;
    for (const child of node.content ?? []) visit(child);
  };
  visit(snapshot.doc);
  return alt;
}

function withoutImage(snapshot: DocumentSnapshot, id: string): DocumentSnapshot {
  const visit = (node: DocumentNode): DocumentNode | null => {
    if (
      node.type === 'image' &&
      (node.attrs?.src === id || (typeof node.attrs?.src === 'string' && siteMediaId(node.attrs.src) === id))
    )
      return null;
    return {
      ...node,
      ...(node.content
        ? { content: node.content.map(visit).filter((child): child is DocumentNode => child !== null) }
        : {}),
    };
  };
  return { ...snapshot, doc: visit(snapshot.doc)! };
}

function siteMediaId(src: string): string | undefined {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(src)) return src;
  const localPath = /^\/media\/([0-9a-f-]{36})(?:\/[^/]+)?\/?$/i.exec(src);
  if (localPath) return localPath[1];
  try {
    const url = new URL(src);
    if (typeof window === 'undefined') return undefined;
    if (url.origin !== window.location.origin) return undefined;
    return /^\/media\/([0-9a-f-]{36})(?:\/[^/]+)?\/?$/i.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function mediaIdsFromSources(sources: string[]): string[] {
  return [...new Set(sources.map((source) => siteMediaId(source) ?? source))];
}

async function uploadExistingSiteImage(
  id: string,
  target: string | { containerId: string } | { newThread: { boardId: string; idempotencyKey: string } },
  signal: AbortSignal,
) {
  const response = await fetch(`/media/${encodeURIComponent(id)}/original`, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new UploadRefusal('unavailable');
  const blob = await response.blob();
  const type = blob.type.split(';')[0] || 'image/png';
  const file = new File([blob], 'pasted-image', { type });
  return uploadReplyImage(target, file, signal);
}

function replaceImageSource(snapshot: DocumentSnapshot, from: string, to: string): DocumentSnapshot {
  const visit = (node: DocumentNode): DocumentNode => ({
    ...node,
    ...(node.type === 'image' && node.attrs?.src === from ? { attrs: { ...node.attrs, src: to } } : {}),
    ...(node.content ? { content: node.content.map(visit) } : {}),
  });
  return { ...snapshot, doc: visit(snapshot.doc) };
}

export function mediaAfterRefusal(media: DraftMediaState[], snapshot: DocumentSnapshot, owned: Set<string>) {
  const sources = imageSources(snapshot);
  const byId = new Map(media.map((item) => [item.id, item]));
  return mediaIdsFromSources(sources).map((id): DraftMediaState => {
    const item = byId.get(id) ?? { id, state: 'unavailable' };
    if (item.state !== 'available' || owned.has(item.id)) return item;
    owned.delete(item.id);
    for (const source of sources) if (source === item.id || siteMediaId(source) === item.id) owned.delete(source);
    return { ...item, state: 'used' as const };
  });
}

export function draftHasMediaIssues(failure: EditFailure | null, snapshot: DocumentSnapshot): boolean {
  if (failure?.reason !== 'media-unavailable') return false;
  const states = new Map(failure.media?.map((item) => [item.id, item.state]));
  return mediaIdsFromSources(imageSources(snapshot)).some((id) => states.get(id) !== 'available');
}

export function mediaIssueList(
  media: DraftMediaState[] | undefined,
  snapshot: DocumentSnapshot,
  retry: () => void,
  uploadAgain: (id: string) => void,
  remove: (id: string) => void,
  checking = false,
) {
  if (!media?.length) return null;
  const issues = media.filter(
    (item) =>
      item.state === 'reserved' ||
      item.state === 'uploaded' ||
      item.state === 'rejected' ||
      item.state === 'erased' ||
      item.state === 'missing' ||
      item.state === 'used' ||
      item.state === 'unavailable',
  );
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label={m.thread_media_status()}>
      {issues.map((item) => {
        const processing = item.state === 'reserved' || item.state === 'uploaded';
        const alt = imageAlt(snapshot, item.id);
        const used = item.state === 'used';
        const unknown = item.state === 'unavailable';
        const status = processing
          ? m.thread_media_processing()
          : used
            ? m.thread_media_used()
            : unknown
              ? m.thread_media_state_unavailable()
              : item.state === 'rejected'
                ? m.thread_media_rejected()
                : item.state === 'erased'
                  ? m.thread_media_erased()
                  : m.thread_media_missing();
        return (
          <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 p-3">
            <span className="font-medium">{alt || m.editor_image()}</span>
            {!processing && !used && !unknown ? <span>{m.thread_media_unusable()}</span> : null}
            <span>{status}</span>
            {processing || unknown ? (
              <Button type="button" variant="outline" disabled={checking} onClick={retry}>
                {m.thread_media_check_again()}
              </Button>
            ) : used ? (
              <Button type="button" variant="outline" onClick={() => uploadAgain(item.id)}>
                {m.thread_media_upload_again()}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => remove(item.id)}>
              {m.thread_media_remove()}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function uploadRefusalText(refusal: UploadRefusal): string {
  if (refusal instanceof ReplyUploadRecoveryRefusal)
    return refusal.recovery === 'target-changed' ? m.thread_media_target_changed() : m.thread_media_choose_again();
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
    mentionAccounts: m.editor_mention_accounts(),
    mentionLoading: m.editor_mention_loading(),
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

export function PostComposer<T>({
  initialKey,
  initialBody,
  titleRequired = false,
  canSubmit = true,
  containerId,
  boardId,
  replyTargetId,
  replyContext,
  focusRequest = 0,
  onPendingChange,
  onSubmit,
  onSuccess,
}: {
  initialKey: string;
  initialBody?: DocumentSnapshot;
  titleRequired?: boolean;
  canSubmit?: boolean;
  containerId?: string;
  boardId?: string;
  replyTargetId?: string | null;
  replyContext?: ReactNode;
  focusRequest?: number;
  onPendingChange?: (pending: boolean) => void;
  onSubmit: (input: {
    title: string;
    body: DocumentSnapshot;
    idempotencyKey: string;
    mediaIds: string[];
    parentId?: string;
  }) => Promise<WriteResult<T>>;
  onSuccess: (value: T) => void;
}) {
  const formId = useId();
  const locale = getLocale();
  const labels = useMemo(() => editorLabels(), [locale]);
  const initialForeignSources = useMemo(
    () =>
      initialBody
        ? imageSources(initialBody)
            .filter((source) => siteMediaId(source))
            .slice(0, replyImageLimit)
        : [],
    [initialBody],
  );
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(() => initialBody ?? fromPlainText('', 'blocks'));
  const bodyRef = useRef(body);
  const [bodyCanSend, setBodyCanSend] = useState(() => hasDocumentContent(body));
  const editorHost = useRef<HTMLDivElement>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);
  const idempotencyRef = useRef(initialKey);
  const replyIntent = useRef(new ReplyIntent(initialKey));
  idempotencyRef.current = idempotencyKey;
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(() =>
    initialBody && imageSources(initialBody).length > replyImageLimit ? m.thread_image_limit() : null,
  );
  const [pendingUploads, setPendingUploads] = useState(initialForeignSources.length);
  const pendingRef = useRef(initialForeignSources.length);
  const editorPendingRef = useRef(0);
  const foreignPendingRef = useRef(initialForeignSources.length);
  const ownedMediaIds = useRef(new Set<string>());
  const reuploading = useRef(new Set(initialForeignSources));
  const initialUploadsStarted = useRef(false);
  const refusalRef = useRef<UploadRefusal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const sessionClient = useContext(QueryClientContext);
  const session = sessionClient?.getQueryData(sessionQuery.queryKey);
  const commandContext = JSON.stringify([containerId, boardId, session?.subject, session?.csrfToken]);
  const uncertainChanged = !replyIntent.current.canPrepare(
    { title, body, mediaIds: mediaIdsFromSources(imageSources(body)) },
    replyTargetId ?? null,
    commandContext,
  );
  const ready =
    canSubmit &&
    bodyCanSend &&
    (!titleRequired || Boolean(title.trim())) &&
    !draftHasMediaIssues(failure, body) &&
    !uncertainChanged;
  const uploadTarget = containerId ?? (boardId ? { newThread: { boardId, idempotencyKey } } : undefined);
  const recoverUpload = useComposerUpload(uploadTarget, ownedMediaIds, refusalRef);
  const upload = uploadTarget ? recoverUpload : undefined;
  const { check: checkMedia, checking } = useDraftMediaCheck(bodyRef, uploadTarget, failure, ownedMediaIds, (media) =>
    setFailure((current) => (current?.reason === 'media-unavailable' ? { ...current, media } : current)),
  );

  useEffect(() => {
    if (!containerId) return;
    document.cookie = 'rezics_draft_key=; Path=/; Max-Age=0; SameSite=Lax';
  }, [containerId]);
  useEffect(() => {
    if (initialUploadsStarted.current) return;
    initialUploadsStarted.current = true;
    for (const source of initialForeignSources) {
      const id = siteMediaId(source);
      if (id) startForeignImageUpload(source, id);
    }
  }, [initialForeignSources]);
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

  useEffect(() => {
    if (replyTargetId === undefined) return;
    const key = replyIntent.current.selectParent(replyTargetId);
    idempotencyRef.current = key;
    setIdempotencyKey(key);
    setFailure((current) => (current?.reason === 'media-unavailable' ? current : null));
  }, [replyTargetId]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const editor = editorHost.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    editor?.focus({ preventScroll: true });
    editor?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusRequest, editorReady]);

  function updateBody(next: DocumentSnapshot) {
    bodyRef.current = next;
    setBody(next);
    setBodyCanSend(hasDocumentContent(next));
    queueForeignImages(next);
  }

  function updatePending() {
    const count = editorPendingRef.current + foreignPendingRef.current;
    pendingRef.current = count;
    setPendingUploads(count);
  }

  function queueForeignImages(snapshot: DocumentSnapshot, explicitId?: string) {
    const sources = imageSources(snapshot);
    if (sources.length > replyImageLimit) setUploadNotice(m.thread_image_limit());
    for (const source of sources.slice(0, replyImageLimit)) {
      const id = siteMediaId(source);
      if (id !== explicitId && failure?.media?.some((item) => item.id === id || item.id === source)) continue;
      if (!id || ownedMediaIds.current.has(source) || ownedMediaIds.current.has(id) || reuploading.current.has(source))
        continue;
      reuploading.current.add(source);
      foreignPendingRef.current++;
      updatePending();
      startForeignImageUpload(source, id);
    }
  }

  function startForeignImageUpload(source: string, id: string) {
    void (async () => {
      try {
        const uploaded = await uploadExistingSiteImage(
          id,
          containerId ?? { newThread: { boardId: boardId!, idempotencyKey: idempotencyRef.current } },
          new AbortController().signal,
        );
        ownedMediaIds.current.add(uploaded.src);
        const next = replaceImageSource(bodyRef.current, source, uploaded.src);
        bodyRef.current = next;
        setBody(next);
        setBodyCanSend(hasDocumentContent(next));
        setFailure((current) =>
          current && 'media' in current
            ? { ...current, media: current.media?.filter((item) => item.id !== source && item.id !== id) }
            : current,
        );
      } catch {
        setFailure((current) => ({
          ok: false,
          reason: 'media-unavailable',
          media: [
            ...(current && 'media' in current
              ? (current.media ?? []).filter((item) => item.id !== source && item.id !== id)
              : []),
            { id: source, state: 'rejected' },
          ],
        }));
      } finally {
        reuploading.current.delete(source);
        foreignPendingRef.current--;
        updatePending();
      }
    })();
  }

  function uploadAgain(id: string) {
    const source = imageSources(bodyRef.current).find((item) => item === id || siteMediaId(item) === id);
    if (source) queueForeignImages(bodyRef.current, id);
  }

  function removeIssueImage(id: string) {
    const next = withoutImage(bodyRef.current, id);
    bodyRef.current = next;
    setBody(next);
    setBodyCanSend(hasDocumentContent(next) || imageSources(next).length > 0);
    setFailure((current) =>
      current && 'media' in current ? { ...current, media: current.media?.filter((item) => item.id !== id) } : current,
    );
  }

  function captureEditorInput(event: FormEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('contenteditable') !== 'true') return;
    const next = fromPlainText(target.innerText, 'blocks');
    const hasMedia = target.querySelector('img, [data-media-id], [data-type="image"]') !== null;
    setBodyCanSend(hasDocumentContent(next) || hasMedia);
    // Tiptap publishes the structured snapshot; only the pre-hydration fallback is plain text.
    if (target.classList.contains('ProseMirror')) return;
    bodyRef.current = next;
    if (plainEditorVisible) setBody(next);
  }

  function handleUploadState(state: UploadState, count: number) {
    editorPendingRef.current = count;
    updatePending();
    if (state === 'pending') setUploadNotice(null);
    if (state === 'failed') setUploadNotice(uploadRefusalText(refusalRef.current ?? new UploadRefusal('unavailable')));
  }

  async function submit(event?: FormEvent) {
    if (event && event.target !== event.currentTarget) return;
    event?.preventDefault();
    if (pendingRef.current > 0 || !hasDocumentContent(bodyRef.current) || !ready || submittingRef.current) return;
    const sources = imageSources(bodyRef.current);
    if (sources.length > replyImageLimit) {
      setUploadNotice(m.thread_image_limit());
      return;
    }
    const mediaIds = mediaIdsFromSources(sources);
    const draft = { title, body: bodyRef.current, mediaIds };
    if (!replyIntent.current.canPrepare(draft, replyTargetId ?? null, commandContext)) return;
    const command = replyIntent.current.prepare(draft, replyTargetId ?? null, commandContext);
    idempotencyRef.current = command.idempotencyKey;
    setIdempotencyKey(command.idempotencyKey);
    submittingRef.current = true;
    setSubmitting(true);
    onPendingChange?.(true);
    setFailure(null);
    try {
      const result = await onSubmit(command);
      if (!result.ok) {
        replyIntent.current.settle(result.reason !== 'unavailable');
        setFailure({
          ...result,
          ...(result.reason === 'media-unavailable'
            ? { media: mediaAfterRefusal(result.media ?? [], bodyRef.current, ownedMediaIds.current) }
            : {}),
        });
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
        replyIntent.current.reset(nextKey);
      }
      onSuccess(result.value);
    } catch {
      replyIntent.current.settle(false);
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      onPendingChange?.(false);
    }
  }

  const bodyLabel = titleRequired ? m.thread_new_body_label() : m.thread_reply_label();
  const editorSize = titleRequired ? 'thread-opening-editor' : 'thread-reply-editor';
  const fallbackSize = titleRequired ? 'thread-opening-fallback' : 'thread-reply-fallback';
  return (
    <div className="rounded-xl border border-border/70 bg-card p-5">
      {replyContext}
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
              contentEditable={!submitting}
              role="textbox"
              suppressContentEditableWarning
            />
          ) : null}
          <RichTextEditor
            value={body}
            disabled={submitting}
            onChange={updateBody}
            label={bodyLabel}
            {...(titleRequired ? {} : { placeholder: m.thread_reply_placeholder() })}
            {...(titleRequired ? { toolbar: 'always' as const } : {})}
            labels={labels}
            lookupMention={lookupPostMention}
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
      {foreignPendingRef.current > 0 ? (
        <p className="text-sm text-muted-foreground" role="status" aria-label={m.editor_uploading()}>
          {m.editor_uploading()}
        </p>
      ) : null}
      {failure ? (
        <div className="mt-5 space-y-3" role="alert">
          {failure.existingReviewId ? (
            <ExistingReviewNotice reviewId={failure.existingReviewId} />
          ) : (
            <>
              <p>{refusalText(failure)}</p>
              {failure.reason !== 'media-unavailable' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting || uncertainChanged}
                  onClick={() => void submit()}
                >
                  {m.thread_write_retry()}
                </Button>
              ) : null}
              {mediaIssueList(
                failure.media,
                bodyRef.current,
                () => void checkMedia(),
                uploadAgain,
                removeIssueImage,
                checking,
              )}
            </>
          )}
        </div>
      ) : null}
      {uploadNotice ? (
        <p className="mt-5" role="alert">
          {uploadNotice}
        </p>
      ) : null}
      {uncertainChanged ? (
        <p className="mt-5" role="alert">
          {m.thread_write_uncertain_changed()}
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
    case 'media-unavailable':
      return m.thread_media_unavailable();
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
  initialMediaIds = [],
  revisionId: initialRevisionId,
  idempotencyKey,
  containerId,
  onSubmit,
  onCancel,
  onSuccess,
}: {
  initialBody: DocumentSnapshot;
  initialMediaIds?: readonly string[];
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
  const editorPendingRef = useRef(0);
  const foreignPendingRef = useRef(0);
  const ownedMediaIds = useRef(new Set(initialMediaIds));
  const reuploading = useRef(new Set<string>());
  const refusalRef = useRef<UploadRefusal | null>(null);
  const editIntent = useRef(new ReplyIntent(idempotencyKey));
  const sessionClient = useContext(QueryClientContext);
  const session = sessionClient?.getQueryData(sessionQuery.queryKey);
  const commandContext = JSON.stringify([containerId, revisionId, session?.subject, session?.csrfToken]);
  const uncertainChanged = !editIntent.current.canPrepare(
    { title: '', body, mediaIds: mediaIdsFromSources(imageSources(body)) },
    null,
    commandContext,
  );
  const ready = hasDocumentContent(body) && !draftHasMediaIssues(failure, body) && !uncertainChanged;
  const upload = useComposerUpload(containerId, ownedMediaIds, refusalRef);
  const { check: checkMedia, checking } = useDraftMediaCheck(bodyRef, containerId, failure, ownedMediaIds, (media) =>
    setFailure((current) => (current?.reason === 'media-unavailable' ? { ...current, media } : current)),
  );

  function updateBody(next: DocumentSnapshot) {
    bodyRef.current = next;
    setBody(next);
    queueForeignImages(next);
  }

  function updatePending() {
    const count = editorPendingRef.current + foreignPendingRef.current;
    pendingRef.current = count;
    setPendingUploads(count);
  }

  function queueForeignImages(snapshot: DocumentSnapshot, explicitId?: string) {
    const sources = imageSources(snapshot);
    if (sources.length > replyImageLimit) setUploadNotice(m.editor_image_limit());
    for (const source of sources.slice(0, replyImageLimit)) {
      const id = siteMediaId(source);
      if (
        id !== explicitId &&
        failure &&
        'media' in failure &&
        failure.media?.some((item) => item.id === id || item.id === source)
      )
        continue;
      if (!id || ownedMediaIds.current.has(source) || ownedMediaIds.current.has(id) || reuploading.current.has(source))
        continue;
      reuploading.current.add(source);
      foreignPendingRef.current++;
      updatePending();
      void (async () => {
        try {
          const uploaded = await uploadExistingSiteImage(id, containerId, new AbortController().signal);
          ownedMediaIds.current.add(uploaded.src);
          const next = replaceImageSource(bodyRef.current, source, uploaded.src);
          bodyRef.current = next;
          setBody(next);
          setFailure((current) =>
            current && 'media' in current
              ? { ...current, media: current.media?.filter((item) => item.id !== source && item.id !== id) }
              : current,
          );
        } catch {
          setFailure((current) => ({
            ok: false,
            reason: 'media-unavailable',
            media: [
              ...(current && 'media' in current
                ? (current.media ?? []).filter((item) => item.id !== source && item.id !== id)
                : []),
              { id: source, state: 'rejected' },
            ],
          }));
        } finally {
          reuploading.current.delete(source);
          foreignPendingRef.current--;
          updatePending();
        }
      })();
    }
  }

  function uploadAgain(id: string) {
    const source = imageSources(bodyRef.current).find((item) => item === id || siteMediaId(item) === id);
    if (source) queueForeignImages(bodyRef.current, id);
  }

  function removeIssueImage(id: string) {
    const next = withoutImage(bodyRef.current, id);
    bodyRef.current = next;
    setBody(next);
    setFailure((current) =>
      current && 'media' in current ? { ...current, media: current.media?.filter((item) => item.id !== id) } : current,
    );
  }

  function captureEditorInput(event: FormEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('contenteditable') !== 'true') return;
    // Tiptap publishes the structured snapshot; only the pre-hydration fallback is plain text.
    if (target.classList.contains('ProseMirror')) return;
    const next = fromPlainText(target.innerText, 'blocks');
    bodyRef.current = next;
    setBody(next);
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pendingRef.current > 0 || !ready || submitting) return;
    const sources = imageSources(bodyRef.current);
    if (sources.length > replyImageLimit) {
      setUploadNotice(m.editor_image_limit());
      return;
    }
    const mediaIds = mediaIdsFromSources(sources);
    const command = editIntent.current.prepare({ title: '', body: bodyRef.current, mediaIds }, null, commandContext);
    setSubmitting(true);
    setFailure(null);
    try {
      const result = await onSubmit({
        body: bodyRef.current,
        revisionId,
        idempotencyKey: command.idempotencyKey,
        mediaIds,
      });
      if (!result.ok) {
        editIntent.current.settle(result.reason !== 'unavailable');
        setFailure({
          ...result,
          ...(result.reason === 'media-unavailable'
            ? { media: mediaAfterRefusal(result.media ?? [], bodyRef.current, ownedMediaIds.current) }
            : {}),
        });
        return;
      }
      onSuccess(result.post);
    } catch {
      editIntent.current.settle(false);
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
    ownedMediaIds.current = new Set(current.mediaIds);
    setRevisionId(current.revisionId);
    editIntent.current.reset(crypto.randomUUID());
    setFailure(null);
  }

  function handleUploadState(state: UploadState, count: number) {
    editorPendingRef.current = count;
    updatePending();
    if (state === 'pending') setUploadNotice(null);
    if (state === 'failed') setUploadNotice(uploadRefusalText(refusalRef.current ?? new UploadRefusal('unavailable')));
  }

  return (
    <div
      className="space-y-4 rounded-xl border border-border/70 bg-card p-5"
      onInputCapture={captureEditorInput}
      onKeyDownCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          (event.target.closest('[role="combobox"][aria-expanded="true"]') ||
            event.currentTarget.querySelector('[data-slot="editor-mention"]'))
        )
          return;
        if (event.key === 'Escape' && !submitting) {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      {foreignPendingRef.current > 0 ? (
        <p className="text-sm text-muted-foreground" role="status" aria-label={m.editor_uploading()}>
          {m.editor_uploading()}
        </p>
      ) : null}
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
            lookupMention={lookupPostMention}
            className="thread-post-editor"
            upload={upload}
            onUploadState={handleUploadState}
          />
        )}
        {failure ? (
          <div className="space-y-3" role="alert">
            <p>{postEditFailureText(failure)}</p>
            {mediaIssueList(
              'media' in failure ? failure.media : undefined,
              bodyRef.current,
              () => void checkMedia(),
              uploadAgain,
              removeIssueImage,
              checking,
            )}
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
        {uncertainChanged ? <p role="alert">{m.thread_write_uncertain_changed()}</p> : null}
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

// Shared localized controls for catalogue and community document authoring.
export { editorLabels };
