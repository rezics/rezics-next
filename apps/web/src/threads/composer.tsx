import { sessionCsrfToken, sessionQuery } from '../session/query';
import { QueryClientContext } from '@tanstack/react-query';
import {
  documentText,
  fromPlainText,
  hasDocumentContent,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import { RichTextEditor, type RichTextEditorLabels, type UploadState } from '@rezics/ui';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
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
import { imageSources, replyImageLimit, UploadRefusal } from './upload';
import { ReplyImageUploadRecovery, ReplyUploadRecoveryRefusal, type ReplyUploadTarget } from './media-upload-recovery';
import { ExistingReviewNotice } from './write-prompts';
import { ReplyIntent, type ReplyCommand } from './reply-context-intent';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from './authoring-departure';
import { EditConflictRecovery } from './edit-conflict-recovery';
import { SlowModeEligibility } from './slow-mode';
import { writingScope } from './local-writing-draft';
import { LocalWritingDraftControls, useLocalWritingDraft } from './local-writing-draft-controls';
import { PortableWritingControls, PortableWritingToolbar, usePortableWriting } from './portable-writing-controls';
export { ExistingReviewNotice, SignInPrompt } from './write-prompts';

type WriteResult<T> = { ok: true; value: T } | WriteFailure;

// Deliberate form actions only; the rich editor owns its formatting and image controls.
const authoringActionClassName =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-4 py-2 leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Cache notifications fence away/back changes even when React batches their renders. */
function useComposerLifetime() {
  const client = useContext(QueryClientContext);
  const latestClient = useRef(client);
  latestClient.current = client;
  const [, renderRetired] = useState(false);
  const [lifetime] = useState(() => {
    const identity = () => {
      const session = client?.getQueryData(sessionQuery.queryKey);
      return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
    };
    const owner = identity();
    const state: {
      controller: AbortController;
      retired: boolean;
      retire: () => void;
      current: (signal?: AbortSignal) => boolean;
    } = {
      controller: new AbortController(),
      retired: false,
      retire() {
        state.retired = true;
        state.controller.abort();
      },
      current(signal = state.controller.signal) {
        if (latestClient.current !== client || identity() !== owner) state.retire();
        return !state.retired && !signal.aborted && signal === state.controller.signal;
      },
    };
    return state;
  });
  useLayoutEffect(() => {
    // Strict Effects may reconnect the mounted editor; old operation signals remain aborted.
    if (!lifetime.retired && lifetime.controller.signal.aborted) lifetime.controller = new AbortController();
    const observe = () => {
      if (!lifetime.current()) renderRetired(true);
    };
    const unsubscribe = client?.getQueryCache().subscribe(observe);
    const signingOut = (event: SubmitEvent) => {
      const form = event.target;
      if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
      const action = new URL(form.action, window.location.href);
      if (action.origin === window.location.origin && action.pathname === '/auth/sign-out') {
        lifetime.retire();
        renderRetired(true);
      }
    };
    document.addEventListener('submit', signingOut);
    observe();
    return () => {
      unsubscribe?.();
      document.removeEventListener('submit', signingOut);
      lifetime.controller.abort();
    };
  }, [client, lifetime]);
  return lifetime;
}

type ComposerLifetime = ReturnType<typeof useComposerLifetime>;

type PendingComposerFocus = {
  request: number;
  caller: string;
  parentId: string | null | undefined;
  owner: AbortSignal;
  cleanup: () => void;
};

function useComposerUpload(
  target: ReplyUploadTarget | undefined,
  owned: RefObject<Set<string>>,
  refusal: RefObject<UploadRefusal | null>,
  lifetime: ComposerLifetime,
) {
  const client = useContext(QueryClientContext);
  const current = useRef(() => ({ target, session: null }) as import('./media-upload-recovery').ReplyUploadContext);
  current.current = () => {
    const session = client?.getQueryData(sessionQuery.queryKey);
    return {
      target,
      session:
        lifetime.current() && session?.state === 'signed-in' && session.subject && session.csrfToken
          ? { subject: session.subject, csrfToken: session.csrfToken }
          : null,
    };
  };
  const [recovery] = useState(() => new ReplyImageUploadRecovery(() => current.current()));
  const copies = useRef(new Map<string, { controller: AbortController; target: string; file?: File }>());
  const removeCopy = (source: string) => {
    copies.current.get(source)?.controller.abort();
    copies.current.delete(source);
  };
  useLayoutEffect(() => {
    recovery.invalidate();
    for (const entry of copies.current.values()) if (entry.target !== JSON.stringify(target)) entry.controller.abort();
  });
  useLayoutEffect(
    () => () => {
      for (const source of copies.current.keys()) removeCopy(source);
      recovery.clear();
    },
    [recovery],
  );
  const upload = async (file: File, signal: AbortSignal) => {
    const owner = lifetime.controller.signal;
    if (!lifetime.current(owner)) throw new DOMException('Editor retired', 'AbortError');
    refusal.current = null;
    try {
      const uploaded = await recovery.upload(file, AbortSignal.any([signal, owner]));
      if (!lifetime.current(owner)) throw new DOMException('Editor retired', 'AbortError');
      owned.current.add(uploaded.src);
      return uploaded;
    } catch (error) {
      if (lifetime.current(owner) && error instanceof UploadRefusal) refusal.current = error;
      throw error;
    }
  };
  const copy = async (source: string, id: string) => {
    const owner = lifetime.controller.signal;
    if (!lifetime.current(owner) || !current.current().session) throw new UploadRefusal('unavailable');
    let entry = copies.current.get(source);
    if (!entry) {
      if (copies.current.size >= replyImageLimit) throw new UploadRefusal('unavailable');
      entry = { controller: new AbortController(), target: JSON.stringify(target) };
      copies.current.set(source, entry);
    }
    const signal = AbortSignal.any([owner, entry.controller.signal]);
    if (!entry.file) entry.file = await readExistingSiteImage(id, signal);
    signal.throwIfAborted();
    if (!lifetime.current(owner) || entry.target !== JSON.stringify(current.current().target))
      throw new ReplyUploadRecoveryRefusal('target-changed');
    const uploaded = await upload(entry.file, signal);
    copies.current.delete(source);
    return uploaded;
  };
  return {
    upload,
    copy,
    removeCopy,
    copySources: () => copies.current.keys(),
    hasCopy: (source: string) => copies.current.has(source),
  };
}

function useDraftMediaCheck(
  body: RefObject<DocumentSnapshot>,
  target: ReplyUploadTarget | undefined,
  failure: EditFailure | null,
  owned: RefObject<Set<string>>,
  update: (media: DraftMediaState[]) => void,
  lifetime: ComposerLifetime,
) {
  const client = useContext(QueryClientContext);
  const active = useRef<AbortController | null>(null);
  const [checking, setChecking] = useState(false);
  const latest = useRef({ target, failure });
  latest.current = { target, failure };
  useEffect(() => () => active.current?.abort(), []);
  const check = async () => {
    if (!lifetime.current() || failure?.reason !== 'media-unavailable') return;
    const snapshot = body.current;
    const ids = mediaIdsFromSources(imageSources(snapshot));
    if (ids.length > replyImageLimit) return;
    active.current?.abort();
    const controller = new AbortController();
    const owner = lifetime.controller.signal;
    active.current = controller;
    const context = JSON.stringify(target);
    const session = client?.getQueryData(sessionQuery.queryKey);
    setChecking(true);
    let media: DraftMediaState[];
    try {
      media = await checkDraftMediaStates({ data: ids, signal: AbortSignal.any([controller.signal, owner]) });
    } catch {
      media = ids.map((id) => ({ id, state: 'unavailable' }));
    }
    if (controller.signal.aborted || !lifetime.current(owner)) return;
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

async function readExistingSiteImage(id: string, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted();
  const response = await fetch(`/media/${encodeURIComponent(id)}/original`, { signal, credentials: 'same-origin' });
  signal.throwIfAborted();
  if (!response.ok) throw new UploadRefusal('unavailable');
  const blob = await response.blob();
  signal.throwIfAborted();
  const type = blob.type.split(';')[0] || 'image/png';
  return new File([blob], 'pasted-image', { type });
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
    <ul className="min-w-0 space-y-2 [overflow-wrap:anywhere]" aria-label={m.thread_media_status()}>
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
          <li
            key={item.id}
            className="flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border border-border/70 p-3 [overflow-wrap:anywhere]"
          >
            <span className="min-w-0 max-w-full font-medium [overflow-wrap:anywhere]">{alt || m.editor_image()}</span>
            {!processing && !used && !unknown ? (
              <span className="min-w-0 max-w-full">{m.thread_media_unusable()}</span>
            ) : null}
            <span className="min-w-0 max-w-full">{status}</span>
            {processing || unknown ? (
              <Button
                type="button"
                variant="outline"
                className={authoringActionClassName}
                disabled={checking}
                onClick={retry}
              >
                {m.thread_media_check_again()}
              </Button>
            ) : used ? (
              <Button
                type="button"
                variant="outline"
                className={authoringActionClassName}
                onClick={() => uploadAgain(item.id)}
              >
                {m.thread_media_upload_again()}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={authoringActionClassName}
              onClick={() => remove(item.id)}
            >
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

type PostComposerProps<T, Context> = {
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
  submissionContext?: Context;
  onIntentLockChange?: (locked: boolean) => void;
  onSubmit: (input: ReplyCommand<Context>) => Promise<WriteResult<T>>;
  onSuccess: (value: T) => void;
};

export function PostComposer<T, Context = undefined>(props: PostComposerProps<T, Context>) {
  return (
    <AuthoringDepartureBoundary>
      <PostComposerContent<T, Context>
        key={JSON.stringify([props.containerId, props.boardId, props.initialKey])}
        {...props}
      />
    </AuthoringDepartureBoundary>
  );
}

function PostComposerContent<T, Context = undefined>({
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
  submissionContext,
  onIntentLockChange,
  onSubmit,
  onSuccess,
}: PostComposerProps<T, Context>) {
  const formId = useId();
  const lifetime = useComposerLifetime();
  const locale = getLocale();
  const labels = useMemo(() => editorLabels(), [locale]);
  const [initialForeignSources] = useState(() =>
    initialBody
      ? imageSources(initialBody)
          .filter((source) => siteMediaId(source))
          .slice(0, replyImageLimit)
      : [],
  );
  const [title, setTitle] = useState('');
  const [body, setBody] = useState(() => initialBody ?? fromPlainText('', 'blocks'));
  const initialBodyRef = useRef(body);
  const initialSubmissionContext = useRef(JSON.stringify(submissionContext));
  const initialReplyTarget = useRef(replyTargetId ?? null);
  const bodyRef = useRef(body);
  const [snapshotPhase, setSnapshotPhase] = useState<'ready' | 'pending' | 'failed'>('ready');
  const snapshotPhaseRef = useRef(snapshotPhase);
  const rawEditorWork = useRef<DocumentNode | null>(null);
  const writingRevision = useRef(0);
  const [bodyCanSend, setBodyCanSend] = useState(() => hasDocumentContent(body));
  const editorHost = useRef<HTMLDivElement>(null);
  const [editorReady, setEditorReady] = useState(false);
  const focusCaller = JSON.stringify([initialKey, containerId ?? null, boardId ?? null, submissionContext]);
  const focusLatest = useRef({ focusRequest, focusCaller, replyTargetId, editorReady });
  focusLatest.current = { focusRequest, focusCaller, replyTargetId, editorReady };
  const focusDelivery = useRef<{
    request: number;
    caller: string;
    parentId: string | null | undefined;
    pending: PendingComposerFocus | null;
  }>({ request: 0, caller: focusCaller, parentId: replyTargetId, pending: null });
  const [idempotencyKey, setIdempotencyKey] = useState(initialKey);
  const replyIntent = useRef(new ReplyIntent<Context>(initialKey));
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(() =>
    initialBody && imageSources(initialBody).length > replyImageLimit ? m.thread_image_limit() : null,
  );
  const [pendingUploads, setPendingUploads] = useState(initialForeignSources.length);
  const pendingRef = useRef(initialForeignSources.length);
  const editorPendingRef = useRef(0);
  const foreignPendingRef = useRef(initialForeignSources.length);
  const ownedMediaIds = useRef(new Set<string>());
  const reuploading = useRef(new Map(initialForeignSources.map((source) => [source, Symbol(source)])));
  const initialUploadsStarted = useRef(false);
  const refusalRef = useRef<UploadRefusal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const sessionClient = useContext(QueryClientContext);
  const session = sessionClient?.getQueryData(sessionQuery.queryKey);
  const commandContext = JSON.stringify([containerId, boardId, session?.subject, session?.csrfToken]);
  const uncertainChanged = !replyIntent.current.canPrepare(
    {
      title,
      body,
      mediaIds: mediaIdsFromSources(imageSources(body)),
      ...(submissionContext === undefined ? {} : { submissionContext }),
    },
    replyTargetId ?? null,
    commandContext,
  );
  const ready =
    canSubmit &&
    snapshotPhase === 'ready' &&
    bodyCanSend &&
    (!titleRequired || Boolean(title.trim())) &&
    !draftHasMediaIssues(failure, body) &&
    !uncertainChanged;
  const departureSignature = JSON.stringify([
    title,
    bodyRef.current,
    submissionContext,
    replyTargetId ?? null,
    pendingRef.current,
    submittingRef.current,
    replyIntent.current.unresolved,
  ]);
  const departure = useAuthoringDeparture(
    lifetime.current() &&
      (title !== '' ||
        JSON.stringify(bodyRef.current) !== JSON.stringify(initialBodyRef.current) ||
        JSON.stringify(submissionContext) !== initialSubmissionContext.current ||
        (replyTargetId ?? null) !== initialReplyTarget.current ||
        pendingRef.current > 0 ||
        submittingRef.current ||
        replyIntent.current.unresolved ||
        uncertainChanged),
    lifetime.current() && (submittingRef.current || replyIntent.current.unresolved),
    departureSignature,
    undefined,
    () => lifetime.retire(),
  );
  const uploadTarget = containerId ?? (boardId ? { newThread: { boardId, idempotencyKey } } : undefined);
  const mediaUpload = useComposerUpload(uploadTarget, ownedMediaIds, refusalRef, lifetime);
  const upload = uploadTarget ? mediaUpload.upload : undefined;
  const { check: checkMedia, checking } = useDraftMediaCheck(
    bodyRef,
    uploadTarget,
    failure,
    ownedMediaIds,
    (media) => setFailure((current) => (current?.reason === 'media-unavailable' ? { ...current, media } : current)),
    lifetime,
  );

  const writing = usePortableWriting({
    current: () => lifetime.current(),
    signal: lifetime.controller.signal,
    revision: () => writingRevision.current,
    replaceable: () => lifetime.current() && canSubmit && !submittingRef.current &&
      !replyIntent.current.unresolved && pendingRef.current === 0 && snapshotPhaseRef.current !== 'pending',
    snapshot: () => ({ body: bodyRef.current, phase: snapshotPhaseRef.current, raw: rawEditorWork.current }),
    replace: (next) => {
      if (!lifetime.current() || submittingRef.current || replyIntent.current.unresolved || pendingRef.current > 0) return;
      const nextKey = crypto.randomUUID();
      replyIntent.current.reset(nextKey);
      setIdempotencyKey(nextKey);
      updateBody(next);
      setFailure(null);
      setUploadNotice(null);
    },
    focus: () => {
      if (!lifetime.current()) return;
      editorHost.current?.querySelector<HTMLElement>(
        '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]',
      )?.focus();
    },
  }, session?.state === 'signed-in' && canSubmit);

  function invalidateWriting() {
    writingRevision.current++;
    writing?.changed();
  }
  function snapshotPending() {
    if (!lifetime.current()) return;
    snapshotPhaseRef.current = 'pending';
    rawEditorWork.current = null;
    setSnapshotPhase('pending');
    invalidateWriting();
  }
  function snapshotFailed(raw: DocumentNode) {
    if (!lifetime.current()) return;
    snapshotPhaseRef.current = 'failed';
    rawEditorWork.current = raw;
    setSnapshotPhase('failed');
    invalidateWriting();
  }

  const localWriting = useLocalWritingDraft({
    actor: session?.state === 'signed-in' ? (session.subject ?? null) : null,
    scope: writingScope({ containerId, boardId, replyTargetId, submissionContext }),
    current: () => lifetime.current(),
    signal: lifetime.controller.signal,
    admitted: canSubmit,
    title,
    body,
    suspended: submitting || replyIntent.current.unresolved || snapshotPhase !== 'ready',
  });

  useEffect(() => {
    if (!containerId) return;
    document.cookie = 'rezics_draft_key=; Path=/; Max-Age=0; SameSite=Lax';
  }, [containerId]);
  useEffect(() => {
    if (initialUploadsStarted.current) return;
    initialUploadsStarted.current = true;
    for (const source of initialForeignSources) {
      const id = siteMediaId(source);
      if (id) {
        reuploading.current.set(source, Symbol(source));
        startForeignImageUpload(source, id);
      }
    }
    return () => {
      initialUploadsStarted.current = false;
    };
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
    setIdempotencyKey(key);
    setFailure((current) => (current?.reason === 'media-unavailable' ? current : null));
  }, [replyTargetId]);

  function cancelPendingFocus() {
    const pending = focusDelivery.current.pending;
    if (!pending) return;
    focusDelivery.current.pending = null;
    pending.cleanup();
  }

  function deliverPendingFocus() {
    const pending = focusDelivery.current.pending;
    if (!pending) return;
    const current = focusLatest.current;
    const host = editorHost.current;
    if (
      pending.request !== current.focusRequest ||
      pending.caller !== current.focusCaller ||
      pending.parentId !== current.replyTargetId ||
      !lifetime.current(pending.owner) ||
      !host?.isConnected
    ) {
      cancelPendingFocus();
      return;
    }
    if (!current.editorReady) return;
    const editor = host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
    if (!editor?.isConnected || !host.contains(editor)) {
      cancelPendingFocus();
      return;
    }
    cancelPendingFocus();
    editor.focus({ preventScroll: true });
    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function requestComposerFocus(request: number) {
    const owner = lifetime.controller.signal;
    const host = editorHost.current;
    if (!host?.isConnected || !lifetime.current(owner)) return;
    let pending!: PendingComposerFocus;
    const cancel = () => {
      if (focusDelivery.current.pending === pending) cancelPendingFocus();
    };
    const onKeyDown: EventListener = (event) => {
      if ((event as KeyboardEvent).key === 'Tab') cancel();
    };
    pending = {
      request,
      caller: focusCaller,
      parentId: replyTargetId,
      owner,
      cleanup: () => {
        owner.removeEventListener('abort', cancel);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('focusin', cancel, true);
        document.removeEventListener('keydown', onKeyDown, true);
      },
    };
    focusDelivery.current.pending = pending;
    if (!focusLatest.current.editorReady) {
      owner.addEventListener('abort', cancel, { once: true });
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('focusin', cancel, true);
      document.addEventListener('keydown', onKeyDown, true);
    }
    deliverPendingFocus();
  }

  useEffect(() => {
    const state = focusDelivery.current;
    if (state.caller !== focusCaller || state.parentId !== replyTargetId) {
      cancelPendingFocus();
      state.caller = focusCaller;
      state.parentId = replyTargetId;
    }
    if (state.request !== focusRequest) {
      state.request = focusRequest;
      cancelPendingFocus();
      if (focusRequest !== 0) requestComposerFocus(focusRequest);
    }
    return () => {
      if (focusDelivery.current.pending?.request === focusRequest) cancelPendingFocus();
    };
  }, [focusRequest, focusCaller, replyTargetId]);

  useEffect(() => {
    deliverPendingFocus();
  }, [editorReady, focusRequest, focusCaller, replyTargetId]);

  function updateBody(next: DocumentSnapshot) {
    if (!lifetime.current()) return;
    snapshotPhaseRef.current = 'ready';
    setSnapshotPhase('ready');
    rawEditorWork.current = null;
    invalidateWriting();
    bodyRef.current = next;
    setBody(next);
    setBodyCanSend(hasDocumentContent(next));
    pruneCopiedImages(next);
    queueForeignImages(next);
  }

  function updatePending() {
    if (!lifetime.current()) return;
    const count = editorPendingRef.current + foreignPendingRef.current;
    pendingRef.current = count;
    setPendingUploads(count);
  }

  function queueForeignImages(snapshot: DocumentSnapshot, explicitId?: string) {
    if (!lifetime.current()) return;
    const sources = imageSources(snapshot);
    if (sources.length > replyImageLimit) setUploadNotice(m.thread_image_limit());
    for (const source of sources.slice(0, replyImageLimit)) {
      const id = siteMediaId(source);
      if (id !== explicitId && failure?.media?.some((item) => item.id === id || item.id === source)) continue;
      if (!id || ownedMediaIds.current.has(source) || ownedMediaIds.current.has(id) || reuploading.current.has(source))
        continue;
      reuploading.current.set(source, Symbol(source));
      foreignPendingRef.current++;
      updatePending();
      startForeignImageUpload(source, id);
    }
  }

  function startForeignImageUpload(source: string, id: string) {
    const owner = lifetime.controller.signal;
    const attempt = reuploading.current.get(source);
    const current = () => lifetime.current(owner) && reuploading.current.get(source) === attempt;
    void (async () => {
      try {
        const uploaded = await mediaUpload.copy(source, id);
        if (!current()) return;
        const next = replaceImageSource(bodyRef.current, source, uploaded.src);
        invalidateWriting();
        bodyRef.current = next;
        setBody(next);
        setBodyCanSend(hasDocumentContent(next));
        setFailure((failure) => {
          if (failure?.reason !== 'media-unavailable') return failure;
          const media = (failure.media ?? []).filter((item) => item.id !== source && item.id !== id);
          return media.every((item) => item.state === 'available')
            ? null
            : { ...failure, media: [...media, { id: uploaded.src, state: 'available' }] };
        });
      } catch (error) {
        if (!current()) return;
        setFailure((failure) => ({
          ok: false,
          reason: 'media-unavailable',
          media: [
            ...(failure && 'media' in failure
              ? (failure.media ?? []).filter((item) => item.id !== source && item.id !== id)
              : []),
            {
              id: source,
              state: error instanceof UploadRefusal && error.reason === 'rejected' ? 'rejected' : 'unavailable',
            },
          ],
        }));
      } finally {
        if (current()) {
          reuploading.current.delete(source);
          foreignPendingRef.current--;
          updatePending();
        }
      }
    })();
  }

  function pruneCopiedImages(snapshot: DocumentSnapshot) {
    const sources = new Set(imageSources(snapshot));
    for (const source of new Set([...reuploading.current.keys(), ...mediaUpload.copySources()])) {
      if (sources.has(source)) continue;
      mediaUpload.removeCopy(source);
      if (reuploading.current.delete(source)) foreignPendingRef.current--;
    }
    updatePending();
  }

  function retryMedia() {
    const sources = imageSources(bodyRef.current).filter((source) => mediaUpload.hasCopy(source));
    if (sources.length) for (const source of sources) queueForeignImages(bodyRef.current, siteMediaId(source));
    else void checkMedia();
  }

  function uploadAgain(id: string) {
    if (!lifetime.current()) return;
    const source = imageSources(bodyRef.current).find((item) => item === id || siteMediaId(item) === id);
    if (source) queueForeignImages(bodyRef.current, id);
  }

  function removeIssueImage(id: string) {
    if (!lifetime.current()) return;
    const next = withoutImage(bodyRef.current, id);
    invalidateWriting();
    pruneCopiedImages(next);
    bodyRef.current = next;
    setBody(next);
    setBodyCanSend(hasDocumentContent(next) || imageSources(next).length > 0);
    setFailure((current) =>
      current && 'media' in current ? { ...current, media: current.media?.filter((item) => item.id !== id) } : current,
    );
  }

  function captureEditorInput(event: FormEvent<HTMLDivElement>) {
    if (!lifetime.current()) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute('contenteditable') !== 'true') return;
    const next = fromPlainText(target.innerText, 'blocks');
    const hasMedia = target.querySelector('img, [data-media-id], [data-type="image"]') !== null;
    setBodyCanSend(hasDocumentContent(next) || hasMedia);
    // Tiptap publishes the structured snapshot; only the pre-hydration fallback is plain text.
    if (target.classList.contains('ProseMirror')) return;
    invalidateWriting();
    bodyRef.current = next;
    if (plainEditorVisible) setBody(next);
  }

  function handleUploadState(state: UploadState, count: number) {
    if (!lifetime.current()) return;
    editorPendingRef.current = count;
    updatePending();
    if (state === 'pending') setUploadNotice(null);
    if (state === 'failed') setUploadNotice(uploadRefusalText(refusalRef.current ?? new UploadRefusal('unavailable')));
  }

  async function submit(event?: FormEvent) {
    if (event && event.target !== event.currentTarget) return;
    event?.preventDefault();
    if (
      !lifetime.current() ||
      pendingRef.current > 0 ||
      snapshotPhaseRef.current !== 'ready' ||
      !hasDocumentContent(bodyRef.current) ||
      !ready ||
      submittingRef.current
    )
      return;
    const sources = imageSources(bodyRef.current);
    if (sources.length > replyImageLimit) {
      setUploadNotice(m.thread_image_limit());
      return;
    }
    const mediaIds = mediaIdsFromSources(sources);
    const draft = {
      title,
      body: bodyRef.current,
      mediaIds,
      ...(submissionContext === undefined ? {} : { submissionContext }),
    };
    if (!replyIntent.current.canPrepare(draft, replyTargetId ?? null, commandContext)) return;
    if (localWriting.draft && !localWriting.draft.beginSubmission()) return;
    const command = replyIntent.current.prepare(draft, replyTargetId ?? null, commandContext);
    // Pending and lost responses both retain the entire command until its outcome is known.
    replyIntent.current.settle(false);
    writing?.cancel();
    setIdempotencyKey(command.idempotencyKey);
    submittingRef.current = true;
    setSubmitting(true);
    const owner = lifetime.controller.signal;
    onIntentLockChange?.(true);
    if (!lifetime.current(owner)) return;
    onPendingChange?.(true);
    setFailure(null);
    try {
      if (!lifetime.current(owner)) return;
      const result = await onSubmit(command);
      if (!lifetime.current(owner)) return;
      if (!result.ok) {
        replyIntent.current.settle(result.reason !== 'unavailable');
        localWriting.draft?.settle(result.reason === 'unavailable' ? 'unknown' : 'refused');
        setFailure({
          ...result,
          ...(result.reason === 'media-unavailable'
            ? { media: mediaAfterRefusal(result.media ?? [], bodyRef.current, ownedMediaIds.current) }
            : {}),
        });
        return;
      }
      replyIntent.current.settle(true);
      localWriting.draft?.settle('success');
      setTitle('');
      invalidateWriting();
      const empty = fromPlainText('', 'blocks');
      initialBodyRef.current = empty;
      bodyRef.current = empty;
      setBody(empty);
      setBodyCanSend(false);
      setUploadNotice(null);
      if (containerId || !boardId) {
        const nextKey = crypto.randomUUID();
        setIdempotencyKey(nextKey);
        replyIntent.current.reset(nextKey);
      }
      departure.release();
      onSuccess(result.value);
    } catch {
      if (!lifetime.current(owner)) return;
      replyIntent.current.settle(false);
      localWriting.draft?.settle('unknown');
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (lifetime.current(owner)) {
        submittingRef.current = false;
        setSubmitting(false);
        onIntentLockChange?.(replyIntent.current.unresolved);
        if (lifetime.current(owner)) onPendingChange?.(false);
      }
    }
  }

  if (!lifetime.current())
    return (
      <p className="min-w-0 [overflow-wrap:anywhere]" role="alert">
        {m.thread_authoring_session_changed()}
      </p>
    );

  const bodyLabel = titleRequired ? m.thread_new_body_label() : m.thread_reply_label();
  const editorSize = titleRequired ? 'thread-opening-editor' : 'thread-reply-editor';
  const fallbackSize = titleRequired ? 'thread-opening-fallback' : 'thread-reply-fallback';
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-card p-5 [container-type:inline-size] [overflow-wrap:anywhere]">
      {replyContext}
      {boardId ? <SlowModeEligibility boardId={boardId} refusal={failure} /> : null}
      <form id={formId} className="min-w-0 [overflow-wrap:anywhere]" onSubmit={submit}>
        {titleRequired ? (
          <div className="mb-5 min-w-0 space-y-2 [overflow-wrap:anywhere]">
            <Label htmlFor="thread-title" className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
              {m.thread_title_label()}
            </Label>
            <Input
              id="thread-title"
              className="h-11 min-w-0 max-w-full border-border bg-background px-3"
              value={title}
              onChange={(event) => { invalidateWriting(); setTitle(event.currentTarget.value); }}
              autoComplete="off"
            />
          </div>
        ) : null}
        <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      </form>
      <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]" onInputCapture={captureEditorInput}>
        <p className={titleRequired ? 'text-sm font-medium' : 'sr-only'}>{bodyLabel}</p>
        <div ref={editorHost} className="min-w-0">
          {plainEditorVisible ? (
            <div
              aria-label={bodyLabel}
              aria-multiline="true"
              aria-placeholder={titleRequired ? undefined : m.thread_reply_placeholder()}
              data-placeholder={titleRequired ? undefined : m.thread_reply_placeholder()}
              className={`${fallbackSize} min-w-0 max-w-full [overflow-wrap:anywhere] rounded-2xl border border-border/60 bg-background px-4 py-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] sm:px-6`}
              contentEditable={!submitting}
              role="textbox"
              suppressContentEditableWarning
            >
              {documentText(body)}
            </div>
          ) : null}
          <RichTextEditor
            value={body}
            disabled={submitting}
            onChange={updateBody}
            onSnapshotPending={snapshotPending}
            onSnapshotError={snapshotFailed}
            label={bodyLabel}
            {...(titleRequired ? {} : { placeholder: m.thread_reply_placeholder() })}
            {...(titleRequired ? { toolbar: 'always' as const } : {})}
            labels={labels}
            lookupMention={lookupPostMention}
            className={`thread-post-editor ${editorSize}${plainEditorVisible ? ' thread-editor-pending' : ''}`}
            actions={
              <>
              {writing ? <PortableWritingToolbar transfer={writing} /> : null}
              <Button
                type="submit"
                form={formId}
                className={`${authoringActionClassName} max-w-[min(24rem,50cqi)] disabled:bg-primary disabled:text-primary-foreground disabled:opacity-100`}
                disabled={!ready || submitting || pendingUploads > 0}
              >
                {m.thread_write_send()}
              </Button>
              </>
            }
            {...(upload ? { upload, onUploadState: handleUploadState } : {})}
          />
        </div>
      </div>
      {writing ? <PortableWritingControls transfer={writing} signal={lifetime.controller.signal}
        disabled={submitting || replyIntent.current.unresolved || pendingUploads > 0 || snapshotPhase === 'pending'}
        phase={snapshotPhase} /> : null}
      {foreignPendingRef.current > 0 ? (
        <p
          className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]"
          role="status"
          aria-label={m.editor_uploading()}
        >
          {m.editor_uploading()}
        </p>
      ) : null}
      {failure ? (
        <div className="mt-5 min-w-0 space-y-3 [overflow-wrap:anywhere]" role="alert">
          {failure.existingReviewId ? (
            <ExistingReviewNotice reviewId={failure.existingReviewId} />
          ) : (
            <>
              <p>{refusalText(failure)}</p>
              {failure.reason !== 'media-unavailable' ? (
                <Button
                  type="button"
                  variant="outline"
                  className={authoringActionClassName}
                  disabled={submitting || uncertainChanged}
                  onClick={() => void submit()}
                >
                  {m.thread_write_retry()}
                </Button>
              ) : null}
              {mediaIssueList(failure.media, bodyRef.current, retryMedia, uploadAgain, removeIssueImage, checking)}
            </>
          )}
        </div>
      ) : null}
      {uploadNotice ? (
        <p className="mt-5 min-w-0 [overflow-wrap:anywhere]" role="alert">
          {uploadNotice}
        </p>
      ) : null}
      {localWriting.draft ? (
        <LocalWritingDraftControls
          key={JSON.stringify(localWriting.draft.scope)}
          draft={localWriting.draft}
          read={localWriting.read}
          live={() => ({ title, body: bodyRef.current })}
          suspended={submitting || replyIntent.current.unresolved || snapshotPhase !== 'ready'}
          restoreDisabled={pendingUploads > 0}
          hasLiveWriting={Boolean(title) || hasDocumentContent(body)}
          onRestore={(payload) => {
            if (
              !lifetime.current() ||
              submittingRef.current ||
              replyIntent.current.unresolved ||
              pendingRef.current > 0
            )
              return;
            const nextKey = crypto.randomUUID();
            replyIntent.current.reset(nextKey);
            setIdempotencyKey(nextKey);
            setTitle(payload.title);
            updateBody(payload.body);
            setFailure(null);
            setUploadNotice(payload.attachmentRepair ? m.thread_draft_attachments() : null);
            requestComposerFocus(focusRequest);
          }}
        />
      ) : null}
      {uncertainChanged ? (
        <p className="mt-5 min-w-0 [overflow-wrap:anywhere]" role="alert">
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

type InlinePostEditorProps = {
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
};

export function InlinePostEditor(props: InlinePostEditorProps) {
  return (
    <AuthoringDepartureBoundary>
      <InlinePostEditorContent key={JSON.stringify([props.containerId, props.idempotencyKey])} {...props} />
    </AuthoringDepartureBoundary>
  );
}

function InlinePostEditorContent({
  initialBody,
  initialMediaIds = [],
  revisionId: initialRevisionId,
  idempotencyKey,
  containerId,
  onSubmit,
  onCancel,
  onSuccess,
}: InlinePostEditorProps) {
  const lifetime = useComposerLifetime();
  const editorRoot = useRef<HTMLDivElement>(null);
  const locale = getLocale();
  const labels = useMemo(() => editorLabels(), [locale]);
  const [body, setBody] = useState(initialBody);
  const initialBodyRef = useRef(initialBody);
  const bodyRef = useRef(body);
  const [revisionId, setRevisionId] = useState(initialRevisionId);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const pendingRef = useRef(0);
  const editorPendingRef = useRef(0);
  const foreignPendingRef = useRef(0);
  const ownedMediaIds = useRef(new Set(initialMediaIds));
  const reuploading = useRef(new Map<string, symbol>());
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
  const departureSignature = JSON.stringify([
    bodyRef.current,
    revisionId,
    pendingRef.current,
    submitting,
    editIntent.current.unresolved,
  ]);
  const departure = useAuthoringDeparture(
    lifetime.current() &&
      (JSON.stringify(bodyRef.current) !== JSON.stringify(initialBodyRef.current) ||
        pendingRef.current > 0 ||
        editIntent.current.unresolved ||
        uncertainChanged),
    lifetime.current() && (submitting || editIntent.current.unresolved),
    departureSignature,
    onCancel,
  );
  const mediaUpload = useComposerUpload(containerId, ownedMediaIds, refusalRef, lifetime);
  const upload = mediaUpload.upload;
  const { check: checkMedia, checking } = useDraftMediaCheck(
    bodyRef,
    containerId,
    failure,
    ownedMediaIds,
    (media) => setFailure((current) => (current?.reason === 'media-unavailable' ? { ...current, media } : current)),
    lifetime,
  );

  function updateBody(next: DocumentSnapshot) {
    if (!lifetime.current()) return;
    bodyRef.current = next;
    setBody(next);
    pruneCopiedImages(next);
    queueForeignImages(next);
  }

  function updatePending() {
    if (!lifetime.current()) return;
    const count = editorPendingRef.current + foreignPendingRef.current;
    pendingRef.current = count;
    setPendingUploads(count);
  }

  function queueForeignImages(snapshot: DocumentSnapshot, explicitId?: string) {
    if (!lifetime.current()) return;
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
      reuploading.current.set(source, Symbol(source));
      foreignPendingRef.current++;
      updatePending();
      startForeignImageUpload(source, id);
    }
  }

  function startForeignImageUpload(source: string, id: string) {
    const owner = lifetime.controller.signal;
    const attempt = reuploading.current.get(source);
    const current = () => lifetime.current(owner) && reuploading.current.get(source) === attempt;
    void (async () => {
      try {
        const uploaded = await mediaUpload.copy(source, id);
        if (!current()) return;
        const next = replaceImageSource(bodyRef.current, source, uploaded.src);
        bodyRef.current = next;
        setBody(next);
        setFailure((failure) => {
          if (failure?.reason !== 'media-unavailable') return failure;
          const media = (failure.media ?? []).filter((item) => item.id !== source && item.id !== id);
          return media.every((item) => item.state === 'available')
            ? null
            : { ...failure, media: [...media, { id: uploaded.src, state: 'available' }] };
        });
      } catch (error) {
        if (!current()) return;
        setFailure((failure) => ({
          ok: false,
          reason: 'media-unavailable',
          media: [
            ...(failure && 'media' in failure
              ? (failure.media ?? []).filter((item) => item.id !== source && item.id !== id)
              : []),
            {
              id: source,
              state: error instanceof UploadRefusal && error.reason === 'rejected' ? 'rejected' : 'unavailable',
            },
          ],
        }));
      } finally {
        if (current()) {
          reuploading.current.delete(source);
          foreignPendingRef.current--;
          updatePending();
        }
      }
    })();
  }

  function pruneCopiedImages(snapshot: DocumentSnapshot) {
    const sources = new Set(imageSources(snapshot));
    for (const source of new Set([...reuploading.current.keys(), ...mediaUpload.copySources()])) {
      if (sources.has(source)) continue;
      mediaUpload.removeCopy(source);
      if (reuploading.current.delete(source)) foreignPendingRef.current--;
    }
    updatePending();
  }

  function retryMedia() {
    const sources = imageSources(bodyRef.current).filter((source) => mediaUpload.hasCopy(source));
    if (sources.length) for (const source of sources) queueForeignImages(bodyRef.current, siteMediaId(source));
    else void checkMedia();
  }

  function uploadAgain(id: string) {
    if (!lifetime.current()) return;
    const source = imageSources(bodyRef.current).find((item) => item === id || siteMediaId(item) === id);
    if (source) queueForeignImages(bodyRef.current, id);
  }

  function removeIssueImage(id: string) {
    if (!lifetime.current()) return;
    const next = withoutImage(bodyRef.current, id);
    pruneCopiedImages(next);
    bodyRef.current = next;
    setBody(next);
    setFailure((current) =>
      current && 'media' in current ? { ...current, media: current.media?.filter((item) => item.id !== id) } : current,
    );
  }

  function captureEditorInput(event: FormEvent<HTMLDivElement>) {
    if (!lifetime.current()) return;
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
    if (!lifetime.current() || pendingRef.current > 0 || !ready || submittingRef.current) return;
    const sources = imageSources(bodyRef.current);
    if (sources.length > replyImageLimit) {
      setUploadNotice(m.editor_image_limit());
      return;
    }
    const mediaIds = mediaIdsFromSources(sources);
    const draft = { title: '', body: bodyRef.current, mediaIds };
    if (!editIntent.current.canPrepare(draft, null, commandContext)) return;
    const command = editIntent.current.prepare(draft, null, commandContext);
    editIntent.current.settle(false);
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    const owner = lifetime.controller.signal;
    try {
      const result = await onSubmit({
        body: command.body,
        revisionId,
        idempotencyKey: command.idempotencyKey,
        mediaIds: command.mediaIds,
      });
      if (!lifetime.current(owner)) return;
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
      editIntent.current.settle(true);
      departure.release();
      onSuccess(result.post);
    } catch {
      if (!lifetime.current(owner)) return;
      editIntent.current.settle(false);
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (lifetime.current(owner)) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  function replaceWithCurrent(current: CurrentPost) {
    if (
      !lifetime.current() ||
      submittingRef.current ||
      editIntent.current.unresolved ||
      failure?.reason !== 'stale' ||
      failure.currentPost !== current ||
      current.availability !== 'available' ||
      current.body === null
    )
      return;
    // The delivered revision owns its media; no discarded upload may rewrite it later.
    for (const source of new Set([...reuploading.current.keys(), ...mediaUpload.copySources()]))
      mediaUpload.removeCopy(source);
    reuploading.current.clear();
    foreignPendingRef.current = 0;
    editorPendingRef.current = 0;
    updatePending();
    initialBodyRef.current = current.body;
    bodyRef.current = current.body;
    setBody(current.body);
    ownedMediaIds.current = new Set(current.mediaIds);
    setRevisionId(current.revisionId);
    editIntent.current.reset(crypto.randomUUID());
    setFailure(null);
    setUploadNotice(null);
  }

  function handleUploadState(state: UploadState, count: number) {
    if (!lifetime.current()) return;
    editorPendingRef.current = count;
    updatePending();
    if (state === 'pending') setUploadNotice(null);
    if (state === 'failed') setUploadNotice(uploadRefusalText(refusalRef.current ?? new UploadRefusal('unavailable')));
  }

  if (!lifetime.current())
    return (
      <p className="min-w-0 [overflow-wrap:anywhere]" role="alert">
        {m.thread_authoring_session_changed()}
      </p>
    );

  return (
    <div
      ref={editorRoot}
      className="min-w-0 space-y-4 rounded-xl border border-border/70 bg-card p-5 [overflow-wrap:anywhere]"
      onInputCapture={captureEditorInput}
      onKeyDownCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          (event.target.closest('[role="combobox"][aria-expanded="true"]') ||
            event.currentTarget.querySelector('[data-slot="editor-mention"]'))
        )
          return;
        if (
          event.key === 'Escape' &&
          !submitting &&
          !event.defaultPrevented &&
          !(event.target instanceof HTMLElement && event.target.closest('[role="alertdialog"]'))
        ) {
          event.preventDefault();
          departure.requestDiscard(onCancel);
        }
      }}
    >
      {foreignPendingRef.current > 0 ? (
        <p
          className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]"
          role="status"
          aria-label={m.editor_uploading()}
        >
          {m.editor_uploading()}
        </p>
      ) : null}
      <form className="min-w-0 space-y-4 [overflow-wrap:anywhere]" onSubmit={submit}>
        <p className="text-sm font-medium">{m.thread_reply_body_label()}</p>
        {submitting ? (
          <p
            className="min-w-0 min-h-32 [overflow-wrap:anywhere] rounded-xl border border-border/60 bg-background px-4 py-3 text-sm text-muted-foreground"
            role="status"
          >
            {m.thread_edit_saving()}
          </p>
        ) : (
          <RichTextEditor
            key={revisionId}
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
          <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]" role="alert">
            <p>{postEditFailureText(failure)}</p>
            {mediaIssueList(
              'media' in failure ? failure.media : undefined,
              bodyRef.current,
              retryMedia,
              uploadAgain,
              removeIssueImage,
              checking,
            )}
          </div>
        ) : null}
        <EditConflictRecovery
          current={failure?.reason === 'stale' && !editIntent.current.unresolved ? failure.currentPost : undefined}
          onReplace={replaceWithCurrent}
          returningFocus={() => editorRoot.current?.querySelector<HTMLElement>('[role="textbox"]') ?? null}
        />
        {uploadNotice ? (
          <p className="min-w-0 text-sm [overflow-wrap:anywhere]" role="alert">
            {uploadNotice}
          </p>
        ) : null}
        {uncertainChanged ? (
          <p className="min-w-0 [overflow-wrap:anywhere]" role="alert">
            {m.thread_write_uncertain_changed()}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-wrap gap-2 [overflow-wrap:anywhere]">
          <Button
            type="submit"
            className={authoringActionClassName}
            disabled={!ready || submitting || pendingUploads > 0}
          >
            {submitting ? <Spinner aria-hidden="true" role="presentation" /> : null}
            {m.thread_edit_save()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={authoringActionClassName}
            disabled={submitting}
            onClick={() => departure.requestDiscard(onCancel)}
          >
            {m.thread_edit_cancel()}
          </Button>
        </div>
      </form>
    </div>
  );
}

// Shared localized controls for catalogue and community document authoring.
export { editorLabels };
