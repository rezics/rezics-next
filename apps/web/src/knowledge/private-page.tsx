import { knowledgeAuthoringImageSelection as knowledgePrivateMediaSelection } from './media';
import type { KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import { useKnowledgeImageUploader, type KnowledgeImageUploadBinding } from './media-upload';
import { useKnowledgeImageRenderer } from './media-view';
import { KnowledgeDetails, KnowledgeValue, knowledgeControl, knowledgeLink } from './workspace';
import { KnowledgeWorkspaceNavigation } from './workspace-navigation';
import { KnowledgeReferenceAuthoring } from './reference-authoring';
import { KnowledgeReferenceBody } from './reference-view';
import { admitReferenceManifest, referenceIssues, type KnowledgeReference } from './reference-model';
import type { ReferenceInspector } from './reference-read';
import { KnowledgeTransferCaller } from './transfer-caller';
import { useKnowledgeLifecycle } from './lifecycle-controller';
import { KnowledgeLifecyclePanel } from './lifecycle-panel';
import type { KnowledgeLifecycleOperations } from './lifecycle';
import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { PreferredRichTextEditor as RichTextEditor } from '../editor/preferred-rich-text-editor';
import { type RichTextEditorLabels } from '@rezics/editor';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { useOperationAdmission } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import { readerSessionSource } from '../reader/lifetime/index';
import { useSession } from '../session/query';
import { sessionRecoverySignInHref } from '../session/unavailable';
import {
  knowledgeAuthoringDestination,
  knowledgeAuthoringNotebookSelection,
  knowledgeAuthoringTemplateDraft,
  type KnowledgeAuthoringDestination,
  type KnowledgePlacementChoice,
  type KnowledgeTemplateKind,
} from './authoring.ts';
import {
  KnowledgeDestinationReview,
  KnowledgePlacementChoiceBar,
  KnowledgeTemplatePicker,
  knowledgeTemplateCopy,
} from './authoring-controls';
import {
  popKnowledgeBreadcrumb,
  pushKnowledgeBreadcrumb,
  type KnowledgeBreadcrumb,
  type KnowledgeOutlinePage,
  type KnowledgeOutlinePlacement,
  type KnowledgeOwnedNotebook,
  type KnowledgeOwnedNotebooksPage,
} from './navigation.ts';
import { KnowledgeOutlineList, KnowledgeOwnedNotebookList } from './navigation-lists';
import {
  inspectKnowledgePrivateReferenceRequest,
  readKnowledgeLifecycleVisit,
  changeKnowledgeLifecycleRequest,
  createKnowledgePrivateDocumentRequest,
  createKnowledgePrivateNotebookRequest,
  prepareKnowledgePrivateVisit,
  readKnowledgeOutlineRequest,
  readKnowledgeOwnedNotebooksRequest,
  readKnowledgePrivateVisit,
  readKnowledgeHistoryVisit,
  readKnowledgeHistoryComparisonVisit,
  reviseKnowledgePrivateDocumentRequest,
  selectKnowledgePublicationRequest,
  type KnowledgePrivatePreparation,
  type KnowledgePrivateVisitRead,
} from './private-server';
import {
  isKnowledgeId,
  type KnowledgeCommand,
  type KnowledgeDocumentReceipt,
  type KnowledgeNotebookReceipt,
  type KnowledgePrivateAddress,
  type KnowledgePrivateHead,
  type KnowledgeRevisionReceipt,
} from './private-knowledge';
import type { KnowledgeNavigationFailure } from './navigation.ts';

import { KnowledgePublicationPanel } from './publication-panel';
import type { KnowledgePublicationIntent, KnowledgePublicationResult } from './publication';
import { KnowledgeNavigationReturnLink } from './navigation-return-link';
import { knowledgeNavigationBinding } from './navigation-return';
import { KnowledgeHistoryPanel } from './history-panel';
import type { KnowledgeHistoryOperations, KnowledgeHistoryRevision } from './history';

const controlClass = knowledgeControl;
const inputClass = 'min-w-0 max-w-full text-foreground';
const linkClass = knowledgeLink;
const defaultLicence = 'LicenseRef-rezics-terms';
const operationSources = new WeakMap<object, number>();
let nextOperationSource = 0;

export type KnowledgePrivateNewAddress = Readonly<{ kind: 'create'; subjectId: string }>;
export type KnowledgePrivateResumeAddress = Readonly<{ kind: 'resume' } & KnowledgePrivateAddress>;
export type KnowledgePrivatePageAddress = KnowledgePrivateNewAddress | KnowledgePrivateResumeAddress;
export type KnowledgePrivateAdmission = 'unknown' | 'available' | 'denied' | 'unavailable';
export type KnowledgePrivatePageAccess =
  | { state: 'preparing' | 'signed-out' | 'unavailable' }
  | {
      state: 'ready';
      viewer: string;
      csrfToken: string;
      owner: string;
      read: KnowledgePrivateAdmission;
      createNotebook: KnowledgePrivateAdmission;
      listNotebooks: KnowledgePrivateAdmission;
      readOutline: KnowledgePrivateAdmission;
      createDocument: KnowledgePrivateAdmission;
      revise: KnowledgePrivateAdmission;
      publication: KnowledgePrivateAdmission;
      lifecycleRead?: KnowledgePrivateAdmission;
      trash?: KnowledgePrivateAdmission;
      restore?: KnowledgePrivateAdmission;
      history?: KnowledgePrivateAdmission;
      compare?: KnowledgePrivateAdmission;
    };

type Binding = Readonly<{ viewer: string; csrfToken: string; credential: string }>;
type NotebookIntent = Readonly<{
  subjectId: string;
  title: string;
  idempotencyKey: string;
  binding: Binding;
}>;
type DocumentDraft = Readonly<{
  title: string;
  language: string | null;
  body: DocumentSnapshot;
  references: readonly KnowledgeReference[];
  licence: string;
}>;
type DocumentIntent = Readonly<
  DocumentDraft & {
    notebookId: string;
    structureRevisionId: string;
    parentPlacementId: string | null;
    subjectId: string;
    idempotencyKey: string;
    binding: Binding;
  }
>;
type NavigationRead<T> =
  | { state: 'ready'; page: T }
  | KnowledgeNavigationFailure
  | { state: 'signed-out' | 'retired' }
  | { state: 'unavailable'; status?: number };
type RevisionIntent = Readonly<
  DocumentDraft & {
    documentId: string;
    expectedHeadRevisionId: string;
    subjectIds: readonly string[];
    idempotencyKey: string;
    binding: Binding;
  }
>;
type PrivateOperationResult<T> =
  | KnowledgeCommand<T>
  | { state: 'signed-out' | 'retired' }
  | { state: 'unavailable'; status?: number };
type LifecycleFocusRequest = {
  phase: 'review' | 'result' | 'return';
  action: 'trash' | 'restore';
  opener: HTMLElement;
  focusedTarget: HTMLElement;
};

export type KnowledgePrivateOperations = Readonly<{
  lifecycle?: KnowledgeLifecycleOperations;
  history?: KnowledgeHistoryOperations;
  inspectReference?: (
    input: Parameters<ReferenceInspector>[0],
    expected: Pick<Binding, 'viewer' | 'csrfToken'>,
  ) => ReturnType<ReferenceInspector>;
  prepare: (subjectId: string, expectedViewer: string) => Promise<KnowledgePrivatePreparation>;
  read: (
    address: KnowledgePrivateAddress,
    expected: Pick<Binding, 'viewer' | 'csrfToken'>,
  ) => Promise<KnowledgePrivateVisitRead>;
  createNotebook: (intent: NotebookIntent) => Promise<PrivateOperationResult<KnowledgeNotebookReceipt>>;
  listNotebooks: (
    cursor: string | null,
    expected: Pick<Binding, 'viewer' | 'csrfToken'>,
  ) => Promise<NavigationRead<KnowledgeOwnedNotebooksPage>>;
  readOutline: (
    input: { notebookId: string; parentPlacementId: string | null; cursor: string | null },
    expected: Pick<Binding, 'viewer' | 'csrfToken'>,
  ) => Promise<NavigationRead<KnowledgeOutlinePage>>;
  createDocument: (intent: DocumentIntent) => Promise<PrivateOperationResult<KnowledgeDocumentReceipt>>;
  revise: (intent: RevisionIntent) => Promise<PrivateOperationResult<KnowledgeRevisionReceipt>>;
  selectPublication: (intent: KnowledgePublicationIntent) => Promise<KnowledgePublicationResult>;
}>;

function operationSourceId(operations: KnowledgePrivateOperations): number {
  let current = operationSources.get(operations);
  if (current === undefined) {
    current = ++nextOperationSource;
    operationSources.set(operations, current);
  }
  return current;
}

const nativeOperations: KnowledgePrivateOperations = {
  inspectReference(input, expected) {
    return inspectKnowledgePrivateReferenceRequest({
      data: { ...input, expected },
      headers: { 'X-CSRF-Token': expected.csrfToken },
    });
  },
  lifecycle: {
    read(address, expected) {
      return readKnowledgeLifecycleVisit({
        data: { address, expected },
        headers: { 'X-CSRF-Token': expected.csrfToken },
      });
    },
    change(intent) {
      return changeKnowledgeLifecycleRequest({
        data: { ...intent, ...intent.binding },
        headers: { 'X-CSRF-Token': intent.binding.csrfToken },
      });
    },
  },
  history: {
    read(address, cursor, expected) {
      return readKnowledgeHistoryVisit({
        data: { address, cursor, expected },
        headers: { 'X-CSRF-Token': expected.csrfToken },
      });
    },
    compare(address, pair, expected) {
      return readKnowledgeHistoryComparisonVisit({
        data: { address, pair, expected },
        headers: { 'X-CSRF-Token': expected.csrfToken },
      });
    },
  },
  selectPublication(intent) {
    return selectKnowledgePublicationRequest({
      data: { ...intent, ...intent.binding },
      headers: { 'X-CSRF-Token': intent.binding.csrfToken },
    });
  },
  prepare(subjectId, expectedViewer) {
    return prepareKnowledgePrivateVisit({ data: { subjectId, expectedViewer } });
  },
  read(address, expected) {
    return readKnowledgePrivateVisit({
      data: { address, expected },
      headers: { 'X-CSRF-Token': expected.csrfToken },
    });
  },
  createNotebook(intent) {
    return createKnowledgePrivateNotebookRequest({
      data: { ...intent, ...intent.binding },
      headers: { 'X-CSRF-Token': intent.binding.csrfToken },
    });
  },
  listNotebooks(cursor, expected) {
    return readKnowledgeOwnedNotebooksRequest({
      data: { ...expected, cursor },
      headers: { 'X-CSRF-Token': expected.csrfToken },
    }) as Promise<NavigationRead<KnowledgeOwnedNotebooksPage>>;
  },
  readOutline(input, expected) {
    return readKnowledgeOutlineRequest({
      data: { ...expected, ...input },
      headers: { 'X-CSRF-Token': expected.csrfToken },
    }) as Promise<NavigationRead<KnowledgeOutlinePage>>;
  },
  createDocument(intent) {
    return createKnowledgePrivateDocumentRequest({
      data: { ...intent, ...intent.binding },
      headers: { 'X-CSRF-Token': intent.binding.csrfToken },
    });
  },
  revise(intent) {
    return reviseKnowledgePrivateDocumentRequest({
      data: { ...intent, ...intent.binding },
      headers: { 'X-CSRF-Token': intent.binding.csrfToken },
    });
  },
};

function localeOptions(locale: string) {
  return { locale: locale as never };
}

function pageCopy(locale: string) {
  const options = localeOptions(locale);
  return {
    notebookTitle: m.knowledge_private_default_notebook({}, options),
    documentTitle: m.knowledge_private_default_document({}, options),
  };
}

function knowledgeEditorLabels(): RichTextEditorLabels {
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

function privateDocumentHref(locale: string, notebookId: string, documentId: string): string {
  return `/${encodeURIComponent(locale)}/knowledge/notebooks/${encodeURIComponent(notebookId)}/documents/${encodeURIComponent(documentId)}`;
}

function immutable<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) immutable(nested);
  return Object.freeze(value);
}

function currentVisibleTarget(target: HTMLElement | null): target is HTMLElement {
  if (
    !target?.isConnected ||
    target.hidden ||
    target.matches(':disabled') ||
    target.closest('[hidden], [inert], [aria-hidden="true"]')
  )
    return false;
  if (target.getClientRects().length === 0) return false;
  const style = getComputedStyle(target);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function copyDraft(head: KnowledgePrivateHead): DocumentDraft {
  return {
    title: head.title,
    language: head.language,
    body: structuredClone(head.body),
    references: structuredClone(head.references ?? []),
    licence: head.licence,
  };
}

function sameDraft(left: DocumentDraft | null, right: DocumentDraft | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function intentDraft(intent: RevisionIntent): DocumentDraft {
  return {
    title: intent.title,
    language: intent.language,
    body: intent.body,
    references: intent.references,
    licence: intent.licence,
  };
}

function statusText(state: string, locale: string): string {
  const options = localeOptions(locale);
  switch (state) {
    case 'preparing':
    case 'unknown':
      return m.knowledge_private_preparing({}, options);
    case 'signed-out':
      return m.knowledge_private_signed_out({}, options);
    case 'retired':
      return m.knowledge_private_retired({}, options);
    case 'denied':
      return m.knowledge_private_denied({}, options);
    case 'not-found':
      return m.knowledge_private_not_found({}, options);
    case 'conflict':
      return m.knowledge_private_conflict({}, options);
    case 'uncertain':
      return m.knowledge_private_uncertain({}, options);
    case 'invalid':
      return m.knowledge_private_invalid({}, options);
    default:
      return m.knowledge_private_unavailable({}, options);
  }
}

function FailureNotice({ state, locale, retry }: { state: string; locale: string; retry?: (() => void) | undefined }) {
  const options = localeOptions(locale);
  const isUnavailable = state === 'unavailable' || state === 'preparing';
  return (
    <section
      role={isUnavailable ? 'status' : 'alert'}
      className="min-w-0 space-y-4 border-t border-border pt-4 text-foreground"
      aria-live="polite"
    >
      <p className="min-w-0 break-words">{statusText(state, locale)}</p>
      {retry ? (
        <Button type="button" variant="outline" className={controlClass} onClick={retry}>
          {m.knowledge_private_retry({}, options)}
        </Button>
      ) : null}
    </section>
  );
}

function AccessNotice({
  state,
  locale,
  returnPath,
  retry,
}: {
  state: 'preparing' | 'signed-out' | 'unavailable';
  locale: string;
  returnPath: string;
  retry: () => void;
}) {
  const options = localeOptions(locale);
  if (state === 'signed-out')
    return (
      <section className="min-w-0 space-y-4 border-t border-border pt-4 text-foreground">
        <p role="status" className="break-words">
          {m.knowledge_private_signed_out({}, options)}
        </p>
        <a className={linkClass} href={sessionRecoverySignInHref(returnPath)}>
          {m.knowledge_private_sign_in({}, options)}
        </a>
      </section>
    );
  return <FailureNotice state={state} locale={locale} retry={retry} />;
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id} className="block min-w-0 whitespace-normal [overflow-wrap:anywhere]">
        {label}
      </Label>
      {children}
    </div>
  );
}

const IdentityValue = KnowledgeValue;

function PrivatePageFrame({
  title,
  locale,
  children,
  navigation,
  status,
  lifecycleFocusBoundaryRef,
  lifecycleHeadingRef,
}: {
  title: string;
  locale: string;
  children: React.ReactNode;
  navigation?: React.ReactNode;
  status?: React.ReactNode;
  lifecycleFocusBoundaryRef?: React.Ref<HTMLDivElement> | undefined;
  lifecycleHeadingRef?: React.Ref<HTMLElement> | undefined;
}) {
  const options = localeOptions(locale);
  return (
    <div
      className="mx-auto w-full min-w-0 max-w-6xl px-4 py-6 text-foreground [overflow-wrap:anywhere] sm:px-6 sm:py-8"
      data-private-knowledge-visit
    >
      <header
        ref={lifecycleHeadingRef}
        tabIndex={lifecycleHeadingRef ? -1 : undefined}
        aria-label={lifecycleHeadingRef ? title : undefined}
        className="mb-8 min-w-0 space-y-3 border-b border-border pb-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <p className="text-xs font-medium tracking-wide text-muted-foreground">
          {m.knowledge_workspace_only_you({}, options)}
        </p>
        <PageHeading>{title}</PageHeading>
        {status}
      </header>
      {navigation}
      <div
        key={lifecycleFocusBoundaryRef ? 'knowledge-lifecycle-focus-boundary' : undefined}
        ref={lifecycleFocusBoundaryRef}
        tabIndex={lifecycleFocusBoundaryRef ? -1 : undefined}
        role={lifecycleFocusBoundaryRef ? 'region' : undefined}
        aria-label={lifecycleFocusBoundaryRef ? title : undefined}
        className="mx-auto min-w-0 max-w-3xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <div className="min-w-0 space-y-8">{children}</div>
      </div>
    </div>
  );
}

function hasReceiptIds<T extends object>(value: T, fields: readonly (keyof T)[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return fields.every((field) => isKnowledgeId(value[field]));
}

function mayHaveCommitted(state: PrivateOperationResult<unknown>['state']): boolean {
  return state === 'acknowledged' || state === 'uncertain' || state === 'unavailable';
}

function bindingFromPreparation(
  result: KnowledgePrivatePreparation,
  access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>,
): Binding | null {
  return result.state === 'ready' &&
    result.viewer === access.viewer &&
    result.csrfToken === access.csrfToken &&
    result.credential.length > 0
    ? immutable({ viewer: result.viewer, csrfToken: result.csrfToken, credential: result.credential })
    : null;
}

function bindingFromRead(
  result: KnowledgePrivateVisitRead,
  access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>,
): Binding | null {
  return result.state === 'ready' &&
    result.viewer === access.viewer &&
    result.csrfToken === access.csrfToken &&
    result.credential.length > 0
    ? immutable({ viewer: result.viewer, csrfToken: result.csrfToken, credential: result.credential })
    : null;
}

function PrivateKnowledgeEditor({
  address,
  locale,
  returnPath,
  access,
  operations,
  notebookReturn,
}: {
  address: KnowledgePrivatePageAddress;
  locale: string;
  returnPath: string;
  access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>;
  operations: KnowledgePrivateOperations;
  notebookReturn?: React.ReactNode;
}) {
  const options = localeOptions(locale);
  const copy = pageCopy(locale);
  const ids = {
    notebookTitle: `knowledge-notebook-title-${useId()}`,
    documentTitle: `knowledge-document-title-${useId()}`,
    language: `knowledge-document-language-${useId()}`,
    licence: `knowledge-document-licence-${useId()}`,
  };
  const active = useRef(true);
  const generation = useRef(0);
  const readSequence = useRef(0);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [preparationState, setPreparationState] = useState('preparing');
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const [notebookTitle, setNotebookTitle] = useState<string>(copy.notebookTitle);
  const [notebookIntent, setNotebookIntent] = useState<NotebookIntent | null>(null);
  const [notebookState, setNotebookState] = useState('idle');
  const [notebookReceipt, setNotebookReceipt] = useState<KnowledgeNotebookReceipt | null>(null);
  const [documentDraft, renderDocumentDraft] = useState<DocumentDraft>(() => ({
    title: copy.documentTitle,
    language: locale,
    body: fromPlainText('', 'blocks'),
    references: [],
    licence: defaultLicence,
  }));
  const documentDraftRef = useRef(documentDraft);
  const setDocumentDraft = (next: DocumentDraft) => {
    documentDraftRef.current = next;
    renderDocumentDraft(next);
  };
  const [documentIntent, setDocumentIntent] = useState<DocumentIntent | null>(null);
  const [documentCreateState, setDocumentCreateState] = useState('idle');
  const [documentReceipt, setDocumentReceipt] = useState<KnowledgeDocumentReceipt | null>(null);
  const [head, setHead] = useState<KnowledgePrivateHead | null>(null);
  const [headLifecycleRevision, setHeadLifecycleRevision] = useState(0);
  const [editorPending, renderEditorPending] = useState(false);
  const editorPendingRef = useRef(false);
  const setEditorPending = (next: boolean) => {
    editorPendingRef.current = next;
    renderEditorPending(next);
  };
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [draft, renderDraft] = useState<DocumentDraft | null>(null);
  const draftRef = useRef(draft);
  const setDraft = (next: DocumentDraft | null) => {
    draftRef.current = next;
    renderDraft(next);
  };
  const [readState, setReadState] = useState('preparing');
  const [readBusy, setReadBusy] = useState(false);
  const readBusyRef = useRef(false);
  const [revisionIntent, setRevisionIntent] = useState<RevisionIntent | null>(null);
  const [revisionState, setRevisionState] = useState('idle');
  const [revisionReceipt, setRevisionReceipt] = useState<KnowledgeRevisionReceipt | null>(null);
  const [acknowledgedDraft, setAcknowledgedDraft] = useState<DocumentDraft | null>(null);
  const [readbackState, setReadbackState] = useState('idle');
  const [conflictReadFailure, setConflictReadFailure] = useState<string | null>(null);
  const [versionRestored, setVersionRestored] = useState(false);
  const [reviewHead, setReviewHead] = useState<KnowledgePrivateHead | null>(null);
  const [requiresHeadReview, setRequiresHeadReview] = useState(false);
  const [retired, setRetired] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [pending, setPending] = useState(false);
  const commandInFlight = useRef(false);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [retirementState, setRetirementState] = useState<'retired' | 'denied' | 'signed-out'>('retired');
  const [placementChoice, setPlacementChoice] = useState<KnowledgePlacementChoice>('new-notebook');
  const [notebooksPage, setNotebooksPage] = useState<KnowledgeOwnedNotebooksPage | null>(null);
  const [notebooksState, setNotebooksState] = useState('idle');
  const [notebooksBusy, setNotebooksBusy] = useState(false);
  const [notebooksCursor, setNotebooksCursor] = useState<string | null>(null);
  const [selectedNotebook, setSelectedNotebook] = useState<KnowledgeOwnedNotebook | null>(null);
  const [outlinePage, setOutlinePage] = useState<KnowledgeOutlinePage | null>(null);
  const [outlineState, setOutlineState] = useState('idle');
  const [outlineBusy, setOutlineBusy] = useState(false);
  const [outlineCursor, setOutlineCursor] = useState<string | null>(null);
  const [outlineParent, setOutlineParent] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<KnowledgeBreadcrumb[]>([]);
  const [destination, setDestination] = useState<KnowledgeAuthoringDestination | null>(null);
  const [destinationReviewed, setDestinationReviewed] = useState(false);
  const [templateKind, setTemplateKind] = useState<KnowledgeTemplateKind | null>(null);
  const [createdAddress, setCreatedAddress] = useState<KnowledgePrivateAddress | null>(null);
  const [lifecycleOperationAction, setLifecycleOperationAction] = useState<'trash' | 'restore' | null>(null);
  const lifecycleFocusRequest = useRef<LifecycleFocusRequest | null>(null);
  const lifecycleFocusBoundaryRef = useRef<HTMLDivElement>(null);
  const lifecycleHeadingRef = useRef<HTMLElement>(null);
  const lifecycleReviewTargetRef = useRef<HTMLDivElement>(null);
  const lifecycleReviewOpenerRef = useRef<HTMLButtonElement>(null);
  const notebookIntentRef = useRef(notebookIntent);
  const documentIntentRef = useRef(documentIntent);
  const revisionIntentRef = useRef(revisionIntent);
  const notebooksSequence = useRef(0);
  const outlineSequence = useRef(0);
  const lifecycle = useKnowledgeLifecycle({
    address: createdAddress ?? (address.kind === 'resume' ? address : null),
    expected: { viewer: access.viewer, csrfToken: access.csrfToken },
    operations: operations.lifecycle,
    admission: access.lifecycleRead ?? 'unavailable',
    trashAdmission: access.trash ?? 'unavailable',
    restoreAdmission: access.restore ?? 'unavailable',
    onRetire: retire,
  });
  notebookIntentRef.current = notebookIntent;
  documentIntentRef.current = documentIntent;
  revisionIntentRef.current = revisionIntent;

  useEffect(() => {
    const cancel = () => {
      lifecycleFocusRequest.current = null;
    };
    const onFocusIn = (event: FocusEvent) => {
      const request = lifecycleFocusRequest.current;
      if (!request) return;
      if (
        event.target === request.focusedTarget ||
        event.target === request.opener ||
        ((event.target === document.body || event.target === document.documentElement) &&
          request.focusedTarget === request.opener)
      )
        return;
      cancel();
    };
    const onKeyDown = () => cancel();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') cancel();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', cancel);
      cancel();
    };
  }, []);

  function claimLifecycleFocus(
    event: MouseEvent<HTMLButtonElement>,
    phase: LifecycleFocusRequest['phase'],
    action: LifecycleFocusRequest['action'],
  ) {
    if (event.detail !== 0 || document.activeElement !== event.currentTarget || !active.current || retired) {
      lifecycleFocusRequest.current = null;
      return;
    }
    lifecycleFocusRequest.current = {
      phase,
      action,
      opener: event.currentTarget,
      focusedTarget: event.currentTarget,
    };
  }

  function reviewLifecycle(event: MouseEvent<HTMLButtonElement>, action: 'trash' | 'restore', blocked: boolean) {
    setLifecycleOperationAction(action);
    claimLifecycleFocus(event, 'review', action);
    lifecycle.review(blocked);
  }

  function submitLifecycle(event: MouseEvent<HTMLButtonElement>, action: 'trash' | 'restore', blocked: boolean) {
    setLifecycleOperationAction(action);
    claimLifecycleFocus(event, 'result', action);
    void lifecycle.submit(blocked);
  }

  function cancelLifecycle(event: MouseEvent<HTMLButtonElement>, action: 'trash' | 'restore') {
    claimLifecycleFocus(event, 'return', action);
    lifecycle.cancel();
  }

  useLayoutEffect(() => {
    const request = lifecycleFocusRequest.current;
    if (!request || !active.current || retired || lifecycleOperationAction !== request.action) return;
    if (document.visibilityState === 'hidden') {
      lifecycleFocusRequest.current = null;
      return;
    }
    let target: HTMLElement | null = null;
    if (request.phase === 'review') {
      if (lifecycle.commandState !== 'confirm') return;
      target = lifecycleReviewTargetRef.current;
    } else if (request.phase === 'return') {
      if (lifecycle.commandState !== 'idle') return;
      const opener = lifecycleReviewOpenerRef.current;
      target = opener && !opener.disabled ? opener : lifecycleHeadingRef.current;
    } else {
      if (
        !['pending', 'acknowledged', 'conflict', 'not-found', 'uncertain', 'unavailable'].includes(
          lifecycle.commandState,
        )
      )
        return;
      target = lifecycleFocusBoundaryRef.current;
    }
    if (!currentVisibleTarget(target)) {
      lifecycleFocusRequest.current = null;
      return;
    }
    if (request.focusedTarget === target && document.activeElement === target) return;
    request.focusedTarget = target;
    target.focus({ preventScroll: true });
    if (request.phase === 'return') lifecycleFocusRequest.current = null;
  }, [
    lifecycle.commandState,
    lifecycle.readState,
    lifecycle.revision,
    lifecycle.editing,
    lifecycleOperationAction,
    retired,
  ]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
      readSequence.current += 1;
    };
  }, []);

  function retire(state: 'retired' | 'denied' | 'signed-out' = 'retired') {
    if (!active.current) return;
    lifecycleFocusRequest.current = null;
    active.current = false;
    generation.current += 1;
    readSequence.current += 1;
    setBinding(null);
    setHead(null);
    setDraft(null);
    setEditorPending(false);
    setReviewHead(null);
    setNotebookTitle('');
    setNotebookReceipt(null);
    setDocumentDraft({ title: '', language: null, body: fromPlainText('', 'blocks'), references: [], licence: '' });
    setDocumentReceipt(null);
    setRevisionReceipt(null);
    setAcknowledgedDraft(null);
    setNotebookIntent(null);
    setDocumentIntent(null);
    setRevisionIntent(null);
    setUnresolved(false);
    setPending(false);
    notebookIntentRef.current = null;
    documentIntentRef.current = null;
    revisionIntentRef.current = null;
    notebooksSequence.current += 1;
    outlineSequence.current += 1;
    setPlacementChoice('new-notebook');
    setNotebooksPage(null);
    setNotebooksState('idle');
    setNotebooksBusy(false);
    setNotebooksCursor(null);
    setSelectedNotebook(null);
    setOutlinePage(null);
    setOutlineState('idle');
    setOutlineBusy(false);
    setOutlineCursor(null);
    setOutlineParent(null);
    setBreadcrumbs([]);
    setDestination(null);
    setDestinationReviewed(false);
    setTemplateKind(null);
    setCreatedAddress(null);
    setRetirementState(state);
    setRetired(true);
  }

  useEffect(() => {
    if (address.kind !== 'create' || retired) return;
    const attempt = ++generation.current;
    let connected = true;
    setPreparationState('preparing');
    void operations
      .prepare(address.subjectId, access.viewer)
      .then((result) => {
        if (!connected || !active.current || generation.current !== attempt) return;
        const next = bindingFromPreparation(result, access);
        if (next) {
          setBinding(next);
          setPreparationState('ready');
        } else {
          setBinding(null);
          setPreparationState(result.state);
          if (result.state === 'retired' || result.state === 'signed-out') retire(result.state);
        }
      })
      .catch(() => {
        if (connected && active.current && generation.current === attempt) setPreparationState('unavailable');
      });
    return () => {
      connected = false;
    };
  }, [
    access.owner,
    access.viewer,
    access.csrfToken,
    address.kind,
    address.kind === 'create' ? address.subjectId : '',
    operations.prepare,
    preparationAttempt,
    retired,
  ]);

  function resumeAddress(): KnowledgePrivateAddress | null {
    if (createdAddress) return createdAddress;
    return address.kind === 'resume' ? address : null;
  }

  async function readCurrent(
    purpose: 'initial' | 'conflict' | 'readback',
    expectedRevisionId?: string,
    submittedDraft?: DocumentDraft,
  ) {
    const currentAddress = resumeAddress();
    if (!currentAddress || !active.current || access.read !== 'available' || readBusyRef.current || !lifecycle.editing)
      return;
    const expected = expectedRevisionId ?? revisionReceipt?.revisionId;
    const submitted = submittedDraft ?? acknowledgedDraft;
    if (purpose === 'readback' && !expected) return;
    const sequence = ++readSequence.current;
    readBusyRef.current = true;
    setReadBusy(true);
    if (purpose === 'initial') setReadState('preparing');
    if (purpose === 'readback') setReadbackState('preparing');
    if (purpose === 'conflict') setConflictReadFailure(null);
    try {
      const result = await operations.read(currentAddress, { viewer: access.viewer, csrfToken: access.csrfToken });
      if (!active.current || readSequence.current !== sequence) return;
      const nextBinding = bindingFromRead(result, access);
      if (result.state === 'ready' && nextBinding) {
        setBinding(nextBinding);
        if (purpose === 'initial' || !head) {
          setHead(result.head);
          setHeadLifecycleRevision(lifecycle.revision);
          setDraft(copyDraft(result.head));
          setReadState('ready');
        } else if (purpose === 'conflict') {
          setReviewHead(result.head);
          setRequiresHeadReview(true);
          setReadState('ready');
        } else {
          if (expected === result.head.revisionId) {
            setHead(result.head);
            if (!editorPendingRef.current && sameDraft(draftRef.current, submitted)) setDraft(copyDraft(result.head));
            setReviewHead(null);
            setRequiresHeadReview(false);
            setAcknowledgedDraft(null);
            setReadbackState('ready');
          } else {
            setReviewHead(result.head);
            setRequiresHeadReview(true);
            setReadbackState('review');
          }
        }
      } else {
        const state = result.state === 'ready' ? 'retired' : result.state;
        if (state === 'retired' || state === 'signed-out' || state === 'denied') {
          retire(state);
          return;
        }
        if (purpose === 'initial' || state === 'not-found') setReadState(state);
        else if (purpose === 'conflict') setConflictReadFailure(state);
        else setReadbackState(state);
      }
    } catch {
      if (active.current && readSequence.current === sequence) {
        if (purpose === 'initial') setReadState('unavailable');
        else if (purpose === 'conflict') setConflictReadFailure('unavailable');
        else setReadbackState('unavailable');
      }
    } finally {
      if (active.current && readSequence.current === sequence) {
        readBusyRef.current = false;
        setReadBusy(false);
      }
    }
  }

  useEffect(() => {
    if ((address.kind !== 'resume' && !createdAddress) || retired || !lifecycle.editing) return;
    if (access.read !== 'available') {
      setReadState(access.read === 'denied' ? 'denied' : access.read === 'unavailable' ? 'unavailable' : 'preparing');
      return;
    }
    void readCurrent('initial');
  }, [
    access.owner,
    access.viewer,
    access.csrfToken,
    access.read,
    address.kind,
    address.kind === 'resume' ? address.notebookId : '',
    address.kind === 'resume' ? address.documentId : '',
    operations.read,
    createdAddress,
    lifecycle.editing,
    lifecycle.revision,
    retired,
  ]);

  function closeNavigation(result: NavigationRead<unknown>, kind: 'notebooks' | 'outline') {
    if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied') retire(result.state);
    if (kind === 'notebooks') setNotebooksState(result.state);
    else setOutlineState(result.state);
  }

  async function loadNotebooks(cursor: string | null) {
    if (!binding || access.listNotebooks !== 'available' || !active.current) return;
    const sequence = ++notebooksSequence.current;
    setNotebooksCursor(cursor);
    setNotebooksBusy(true);
    setNotebooksState('preparing');
    try {
      const result = await operations.listNotebooks(cursor, { viewer: access.viewer, csrfToken: access.csrfToken });
      if (!active.current || notebooksSequence.current !== sequence) return;
      if (result.state === 'ready') {
        setNotebooksPage(result.page);
        setNotebooksState('ready');
      } else closeNavigation(result, 'notebooks');
    } catch {
      if (active.current && notebooksSequence.current === sequence) setNotebooksState('unavailable');
    } finally {
      if (active.current && notebooksSequence.current === sequence) setNotebooksBusy(false);
    }
  }

  async function loadOutline(parentPlacementId: string | null, cursor: string | null) {
    if (!binding || !selectedNotebook || access.readOutline !== 'available' || !active.current) return;
    const sequence = ++outlineSequence.current;
    setOutlineParent(parentPlacementId);
    setOutlineCursor(cursor);
    setOutlineBusy(true);
    setOutlineState('preparing');
    try {
      const result = await operations.readOutline(
        { notebookId: selectedNotebook.notebookId, parentPlacementId, cursor },
        { viewer: access.viewer, csrfToken: access.csrfToken },
      );
      if (!active.current || outlineSequence.current !== sequence) return;
      if (result.state === 'ready' && result.page.notebookId === selectedNotebook.notebookId) {
        setOutlinePage(result.page);
        setOutlineState('ready');
        setDestination(null);
        setDestinationReviewed(false);
      } else closeNavigation(result, 'outline');
    } catch {
      if (active.current && outlineSequence.current === sequence) setOutlineState('unavailable');
    } finally {
      if (active.current && outlineSequence.current === sequence) setOutlineBusy(false);
    }
  }

  function resetExistingPlacement() {
    notebooksSequence.current += 1;
    outlineSequence.current += 1;
    setNotebooksPage(null);
    setNotebooksState('idle');
    setNotebooksBusy(false);
    setNotebooksCursor(null);
    setSelectedNotebook(null);
    setOutlinePage(null);
    setOutlineState('idle');
    setOutlineBusy(false);
    setOutlineCursor(null);
    setOutlineParent(null);
    setBreadcrumbs([]);
    setDestination(null);
    setDestinationReviewed(false);
    setTemplateKind(null);
  }

  function choosePlacement(next: KnowledgePlacementChoice) {
    if (next === placementChoice || !!documentIntent || !!documentReceipt) return;
    setPlacementChoice(next);
    if (next === 'new-notebook') resetExistingPlacement();
  }

  function selectExistingNotebook(row: KnowledgeOwnedNotebook) {
    if (documentIntent || documentReceipt) return;
    outlineSequence.current += 1;
    setSelectedNotebook(knowledgeAuthoringNotebookSelection(row));
    setOutlinePage(null);
    setOutlineState('idle');
    setOutlineBusy(false);
    setOutlineCursor(null);
    setOutlineParent(null);
    setBreadcrumbs([]);
    setDestination(null);
    setDestinationReviewed(false);
  }

  function placeAtObservedOutline() {
    if (!selectedNotebook || !outlinePage || outlinePage.notebookId !== selectedNotebook.notebookId) return;
    const next = knowledgeAuthoringDestination(selectedNotebook, outlinePage, breadcrumbs.at(-1)?.title ?? null);
    if (!next) return;
    setDestination(next);
    setDestinationReviewed(true);
  }

  function openNestedParent(placement: KnowledgeOutlinePlacement) {
    if (!selectedNotebook || documentIntent || documentReceipt) return;
    setBreadcrumbs(
      pushKnowledgeBreadcrumb(breadcrumbs, { placementId: placement.placementId, title: placement.title }),
    );
    setDestination(null);
    setDestinationReviewed(false);
    void loadOutline(placement.placementId, null);
  }

  function returnDestination() {
    if (documentIntent || documentReceipt) return;
    const next = popKnowledgeBreadcrumb(breadcrumbs);
    setBreadcrumbs(next.trail);
    setDestination(null);
    setDestinationReviewed(false);
    void loadOutline(next.parentPlacementId, null);
  }

  function applyTemplate(kind: KnowledgeTemplateKind) {
    if (documentIntentRef.current || documentReceipt || editorPendingRef.current) return;
    setTemplateKind(kind);
    setDocumentDraft({
      ...knowledgeAuthoringTemplateDraft(knowledgeTemplateCopy(kind, locale), locale),
      references: [],
    });
  }

  async function readCreated(addressToRead: KnowledgePrivateAddress) {
    if (!active.current || access.read !== 'available') return;
    const sequence = ++readSequence.current;
    readBusyRef.current = true;
    setReadBusy(true);
    setReadState('preparing');
    try {
      const result = await operations.read(addressToRead, { viewer: access.viewer, csrfToken: access.csrfToken });
      if (!active.current || readSequence.current !== sequence) return;
      const nextBinding = bindingFromRead(result, access);
      if (result.state === 'ready' && nextBinding) {
        setBinding(nextBinding);
        setHead(result.head);
        setHeadLifecycleRevision(lifecycle.revision);
        setDraft(copyDraft(result.head));
        setReadState('ready');
      } else {
        const state = result.state === 'ready' ? 'retired' : result.state;
        if (state === 'retired' || state === 'signed-out' || state === 'denied') retire(state);
        setReadState(state);
      }
    } catch {
      if (active.current && readSequence.current === sequence) setReadState('unavailable');
    } finally {
      if (active.current && readSequence.current === sequence) {
        readBusyRef.current = false;
        setReadBusy(false);
      }
    }
  }

  function startNotebookIntent(): NotebookIntent | null {
    if (notebookIntentRef.current) return notebookIntentRef.current;
    if (address.kind !== 'create' || !binding || access.createNotebook !== 'available') return null;
    const next = immutable({
      subjectId: address.subjectId,
      title: notebookTitle,
      idempotencyKey: crypto.randomUUID(),
      binding,
    });
    notebookIntentRef.current = next;
    setNotebookIntent(next);
    return next;
  }

  async function submitNotebook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (commandInFlight.current || notebookReceipt || !active.current) return;
    const intent = startNotebookIntent();
    if (!intent) return;
    commandInFlight.current = true;
    setPending(true);
    setUnresolved(true);
    setNotebookState('pending');
    try {
      const result = await operations.createNotebook(intent);
      if (!active.current) return;
      if (
        result.state === 'acknowledged' &&
        hasReceiptIds(result.receipt, ['notebookId', 'structureRevisionId'])
      ) {
        setNotebookReceipt(result.receipt);
        setNotebookIntent(null);
        notebookIntentRef.current = null;
        setNotebookState('acknowledged');
        setUnresolved(false);
      } else {
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
          retire(result.state);
        const unresolved = mayHaveCommitted(result.state);
        if (!unresolved) {
          setNotebookIntent(null);
          notebookIntentRef.current = null;
        }
        setNotebookState(result.state === 'acknowledged' ? 'uncertain' : result.state);
        setUnresolved(unresolved);
      }
    } catch {
      if (active.current) {
        setNotebookState('uncertain');
        setUnresolved(true);
      }
    } finally {
      commandInFlight.current = false;
      if (active.current) setPending(false);
    }
  }

  function startDocumentIntent(): DocumentIntent | null {
    if (documentIntentRef.current) return documentIntentRef.current;
    const writing = documentDraftRef.current;
    if (
      address.kind !== 'create' ||
      !binding ||
      access.createDocument !== 'available' ||
      editorPendingRef.current ||
      !writing.title.trim() ||
      referenceIssues(writing).length
    )
      return null;
    const existing = placementChoice === 'existing-notebook';
    if (!existing && !notebookReceipt) return null;
    if (existing && (!destination || !destinationReviewed)) return null;
    const next = immutable({
      ...structuredClone(writing),
      notebookId: existing ? destination!.notebookId : notebookReceipt!.notebookId,
      structureRevisionId: existing ? destination!.structureRevisionId : notebookReceipt!.structureRevisionId,
      parentPlacementId: existing ? destination!.parentPlacementId : null,
      subjectId: existing ? destination!.subjectId : address.subjectId,
      idempotencyKey: crypto.randomUUID(),
      binding,
    });
    documentIntentRef.current = next;
    setDocumentIntent(next);
    return next;
  }

  async function submitDocument(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (commandInFlight.current || documentReceipt || !active.current) return;
    const intent = startDocumentIntent();
    if (!intent) return;
    commandInFlight.current = true;
    setPending(true);
    setUnresolved(true);
    setDocumentCreateState('pending');
    try {
      const result = await operations.createDocument(intent);
      if (!active.current) return;
      if (
        result.state === 'acknowledged' &&
        hasReceiptIds(result.receipt, [
          'notebookId',
          'documentId',
          'placementId',
          'revisionId',
          'structureRevisionId',
        ]) &&
        result.receipt.notebookId === intent.notebookId
      ) {
        setDocumentReceipt(result.receipt);
        setDocumentIntent(null);
        documentIntentRef.current = null;
        setDocumentCreateState('acknowledged');
        setUnresolved(false);
        const opened = { notebookId: result.receipt.notebookId, documentId: result.receipt.documentId };
        setCreatedAddress(opened);
        void readCreated(opened);
      } else if (result.state === 'conflict') {
        setDocumentIntent(null);
        documentIntentRef.current = null;
        setDocumentCreateState('conflict');
        setDestinationReviewed(false);
        setUnresolved(false);
        if (placementChoice === 'existing-notebook' && selectedNotebook) void loadOutline(outlineParent, null);
      } else {
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
          retire(result.state);
        const unresolved = mayHaveCommitted(result.state);
        if (!unresolved) {
          setDocumentIntent(null);
          documentIntentRef.current = null;
        }
        setDocumentCreateState(result.state === 'acknowledged' ? 'uncertain' : result.state);
        setUnresolved(unresolved);
      }
    } catch {
      if (active.current) {
        setDocumentCreateState('uncertain');
        setUnresolved(true);
      }
    } finally {
      commandInFlight.current = false;
      if (active.current) setPending(false);
    }
  }

  function startRevisionIntent(): RevisionIntent | null {
    const currentAddress = resumeAddress();
    const writing = draftRef.current;
    if (
      !currentAddress ||
      !head ||
      !writing ||
      !writing.title.trim() ||
      editorPendingRef.current ||
      sameDraft(writing, copyDraft(head)) ||
      referenceIssues(writing).length > 0 ||
      !binding ||
      access.revise !== 'available' ||
      requiresHeadReview ||
      lifecycle.locked ||
      (revisionReceipt !== null && readbackState !== 'ready')
    )
      return null;
    const next = immutable({
      ...structuredClone(writing),
      documentId: currentAddress.documentId,
      expectedHeadRevisionId: head.revisionId,
      subjectIds: [...head.subjectIds],
      idempotencyKey: crypto.randomUUID(),
      binding,
    });
    revisionIntentRef.current = next;
    setRevisionIntent(next);
    return next;
  }

  async function submitRevision(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (commandInFlight.current || publicationBusy || !active.current || revisionIntentRef.current) return;
    const intent = startRevisionIntent();
    if (!intent) return;
    setVersionRestored(false);
    setRevisionReceipt(null);
    setAcknowledgedDraft(null);
    setReadbackState('idle');
    await sendRevision(intent);
  }

  async function replayRevision() {
    const intent = revisionIntentRef.current;
    if (!intent || commandInFlight.current || publicationBusy || lifecycle.locked || !active.current) return;
    await sendRevision(intent);
  }

  async function sendRevision(intent: RevisionIntent) {
    commandInFlight.current = true;
    setPending(true);
    setUnresolved(true);
    setRevisionState('pending');
    try {
      const result = await operations.revise(intent);
      if (!active.current) return;
      if (
        result.state === 'acknowledged' &&
        hasReceiptIds(result.receipt, ['documentId', 'revisionId']) &&
        result.receipt.documentId === intent.documentId
      ) {
        setRevisionReceipt(result.receipt);
        const submitted = intentDraft(intent);
        setAcknowledgedDraft(submitted);
        setRevisionIntent(null);
        revisionIntentRef.current = null;
        setRevisionState('acknowledged');
        setUnresolved(false);
        void readCurrent('readback', result.receipt.revisionId, submitted);
      } else {
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied') {
          retire(result.state);
          return;
        }
        const unresolved = mayHaveCommitted(result.state);
        if (!unresolved) {
          setRevisionIntent(null);
          revisionIntentRef.current = null;
        }
        if (result.state === 'conflict') {
          setRequiresHeadReview(true);
          setConflictReadFailure(null);
          setReadbackState('idle');
        }
        setRevisionState(result.state === 'acknowledged' ? 'uncertain' : result.state);
        setUnresolved(unresolved);
      }
    } catch {
      if (active.current) {
        setRevisionState('uncertain');
        setUnresolved(true);
      }
    } finally {
      commandInFlight.current = false;
      if (active.current) setPending(false);
    }
  }

  function acceptReviewedHead() {
    if (!reviewHead || !active.current) return;
    setHead(reviewHead);
    setReviewHead(null);
    setRequiresHeadReview(false);
    setRevisionReceipt(null);
    setAcknowledgedDraft(null);
    setRevisionState('idle');
    setReadbackState('idle');
  }

  function discardDraft() {
    setVersionRestored(false);
    setEditorPending(false);
    setEditorGeneration((version) => version + 1);
    setNotebookIntent(null);
    notebookIntentRef.current = null;
    setDocumentIntent(null);
    documentIntentRef.current = null;
    setRevisionIntent(null);
    revisionIntentRef.current = null;
    setUnresolved(false);
    if ((address.kind === 'resume' || createdAddress) && head) setDraft(copyDraft(head));
    if (address.kind === 'create' && !createdAddress) {
      setNotebookTitle(copy.notebookTitle);
      setDocumentDraft({
        title: copy.documentTitle,
        language: locale,
        body: fromPlainText('', 'blocks'),
        references: [],
        licence: defaultLicence,
      });
      setTemplateKind(null);
    }
  }

  const createDirty =
    address.kind === 'create' &&
    !documentReceipt &&
    (notebookTitle !== copy.notebookTitle ||
      documentDraft.title !== copy.documentTitle ||
      documentDraft.language !== locale ||
      documentDraft.licence !== defaultLicence ||
      hasDocumentContent(documentDraft.body) ||
      !!selectedNotebook ||
      editorPending);
  const resumeDirty =
    (address.kind === 'resume' || !!createdAddress) &&
    !!head &&
    (!sameDraft(draft, acknowledgedDraft ?? copyDraft(head)) || editorPending);
  const departureSignature = JSON.stringify([
    access.owner,
    notebookTitle,
    documentDraft,
    draft,
    notebookReceipt,
    documentReceipt,
    revisionReceipt,
    unresolved,
    pending,
  ]);
  useAuthoringDeparture(
    createDirty || resumeDirty || unresolved || pending || lifecycle.unresolved || lifecycle.pending,
    unresolved || pending || lifecycle.unresolved || lifecycle.pending,
    departureSignature,
    discardDraft,
    retire,
  );

  if (retired || preparationState === 'retired' || readState === 'retired')
    return (
      <PrivatePageFrame title={m.knowledge_private_heading({}, options)} locale={locale}>
        {retirementState === 'signed-out' ? (
          <AccessNotice state="signed-out" locale={locale} returnPath={returnPath} retry={() => undefined} />
        ) : (
          <FailureNotice state={retirementState} locale={locale} />
        )}
      </PrivatePageFrame>
    );

  if (address.kind === 'create' && !(createdAddress && head && draft && readState === 'ready')) {
    const existing = placementChoice === 'existing-notebook';
    // Admission can still replace the editor owner while the first exposure read is pending.
    const placementLocked =
      !binding ||
      access.listNotebooks === 'unknown' ||
      !!(notebookIntent || notebookReceipt || documentIntent || documentReceipt);
    const canCreateNotebook = access.createNotebook === 'available' && !!binding && !notebookReceipt && !existing;
    const canCreateDocument =
      access.createDocument === 'available' &&
      !documentReceipt &&
      (existing ? !!destination && destinationReviewed : !!notebookReceipt);
    const notebookBusy = pending && notebookState === 'pending';
    const documentBusy = pending && documentCreateState === 'pending';
    const notebookRetry = !!notebookIntent && !notebookReceipt && !notebookBusy;
    const documentRetry = !!documentIntent && !documentReceipt && !documentBusy;
    const notebookFailure = !['idle', 'pending', 'acknowledged'].includes(notebookState);
    const documentFailure = !['idle', 'pending', 'acknowledged'].includes(documentCreateState);
    const documentFrozen = !!documentIntent;
    const subjectIds = existing && destination ? [destination.subjectId] : [address.subjectId];
    const documentForm = (
      <div className="min-w-0 space-y-5">
        <KnowledgeTemplatePicker
          locale={locale}
          selected={templateKind}
          disabled={documentFrozen || !!documentReceipt || editorPending}
          onSelect={applyTemplate}
        />
        <DocumentDraftFields
          key={editorGeneration}
          ids={ids}
          locale={locale}
          draft={documentDraft}
          disabled={documentFrozen || !!documentReceipt}
          onChange={setDocumentDraft}
          onPendingChange={setEditorPending}
          onSave={documentFrozen || !!documentReceipt ? undefined : () => void submitDocument()}
          inspect={
            binding && operations.inspectReference ? (input) => operations.inspectReference!(input, binding) : undefined
          }
          subjectIds={subjectIds}
        />
        {destination && existing ? (
          <KnowledgeDestinationReview locale={locale} destination={destination} subjectIds={subjectIds} />
        ) : null}
        <section
          className="min-w-0 space-y-3 border-t border-border pt-5"
          aria-labelledby="knowledge-private-document-review"
        >
          <h3 id="knowledge-private-document-review" className="font-medium">
            {m.knowledge_private_review({}, options)}
          </h3>
          <ReviewMetadata draft={documentDraft} subjectIds={subjectIds} locale={locale} />
          <div className="min-w-0 border-t border-border pt-3">
            <KnowledgeReferenceBody
              inspectable={false}
              document={documentDraft.body}
              references={documentDraft.references}
              locale={locale}
            />
          </div>
        </section>
        {documentCreateState === 'conflict' ? (
          <FailureNotice state="conflict" locale={locale} />
        ) : documentFailure ? (
          <FailureNotice state={documentCreateState} locale={locale} />
        ) : null}
        {documentCreateState === 'conflict' ? (
          <p role="status" className="break-words">
            {m.knowledge_private_structure_changed({}, options)}
          </p>
        ) : null}
        {documentReceipt ? (
          <section className="min-w-0 space-y-3" aria-live="polite">
            <p role="status" className="break-words">
              {m.knowledge_private_document_acknowledged({}, options)}
            </p>
            <KnowledgeDetails label={m.knowledge_workspace_details({}, options)}>
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                <IdentityValue
                  label={m.knowledge_private_document_id({}, options)}
                  value={documentReceipt.documentId}
                />
                <IdentityValue
                  label={m.knowledge_private_placement_id({}, options)}
                  value={documentReceipt.placementId}
                />
                <IdentityValue label={m.knowledge_private_revision({}, options)} value={documentReceipt.revisionId} />
              </dl>
            </KnowledgeDetails>
            {readState === 'preparing' ? <p role="status">{m.knowledge_private_readback({}, options)}</p> : null}
            {readState !== 'ready' && readState !== 'preparing' && createdAddress ? (
              <FailureNotice state={readState} locale={locale} retry={() => void readCreated(createdAddress)} />
            ) : null}
            <a
              className={buttonVariants({ className: controlClass })}
              href={privateDocumentHref(locale, documentReceipt.notebookId, documentReceipt.documentId)}
            >
              {m.knowledge_private_open_document({}, options)}
            </a>
          </section>
        ) : (
          <form className="min-w-0 space-y-5" onSubmit={(event) => void submitDocument(event)}>
            {access.createDocument !== 'available' ? (
              <FailureNotice state={access.createDocument} locale={locale} />
            ) : null}
            {existing && !destinationReviewed ? (
              <p role="status" className="break-words text-sm">
                {m.knowledge_private_review_destination({}, options)}
              </p>
            ) : null}
            <Button
              type="submit"
              className={controlClass}
              disabled={
                !canCreateDocument ||
                documentBusy ||
                editorPending ||
                referenceIssues(documentDraft).length > 0 ||
                !documentDraft.title.trim()
              }
            >
              {documentBusy
                ? m.knowledge_private_creating_document({}, options)
                : documentRetry
                  ? m.knowledge_private_retry_exact({}, options)
                  : m.knowledge_private_create_document({}, options)}
            </Button>
          </form>
        )}
      </div>
    );
    return (
      <PrivatePageFrame title={m.knowledge_private_create_kind({}, options)} locale={locale}>
        {preparationState !== 'ready' || !binding ? (
          <FailureNotice
            state={preparationState}
            locale={locale}
            retry={preparationState !== 'preparing' ? () => setPreparationAttempt((value) => value + 1) : undefined}
          />
        ) : null}
        <section className="min-w-0 space-y-6">
          <KnowledgePlacementChoiceBar
            locale={locale}
            choice={placementChoice}
            disabled={placementLocked}
            onChange={choosePlacement}
          />
          {existing ? (
            <div className="min-w-0 space-y-5">
              {access.listNotebooks !== 'available' ? (
                <FailureNotice state={access.listNotebooks} locale={locale} />
              ) : (
                <KnowledgeOwnedNotebookList
                  locale={locale}
                  state={notebooksState}
                  page={notebooksPage}
                  busy={notebooksBusy}
                  selectedId={selectedNotebook?.notebookId ?? null}
                  onOpen={() => void loadNotebooks(null)}
                  onMore={() => void loadNotebooks(notebooksPage?.next ?? null)}
                  onRetry={() => void loadNotebooks(notebooksCursor)}
                  onSelect={selectExistingNotebook}
                />
              )}
              {selectedNotebook ? (
                <div className="min-w-0 space-y-5 border-t border-border pt-5">
                  <p role="status" className="break-words">
                    {m.knowledge_private_creating_at({}, options)}
                  </p>
                  <h2 className="text-lg font-semibold">{selectedNotebook.title}</h2>
                  <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
                    <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                      <IdentityValue
                        label={m.knowledge_private_notebook_id({}, options)}
                        value={selectedNotebook.notebookId}
                        exact
                      />
                      <IdentityValue
                        label={m.knowledge_private_subject({}, options)}
                        value={selectedNotebook.subjectId}
                        exact
                      />
                    </dl>
                  </KnowledgeDetails>
                  {access.readOutline !== 'available' ? (
                    <FailureNotice state={access.readOutline} locale={locale} />
                  ) : (
                    <KnowledgeOutlineList
                      locale={locale}
                      state={outlineState}
                      page={outlinePage}
                      busy={outlineBusy}
                      trail={breadcrumbs}
                      onOpen={() => void loadOutline(outlineParent, null)}
                      onMore={() => void loadOutline(outlineParent, outlinePage?.next ?? null)}
                      onRetry={() => void loadOutline(outlineParent, outlineCursor)}
                      onOpenParent={openNestedParent}
                      onReturn={returnDestination}
                      onPlaceHere={placeAtObservedOutline}
                    />
                  )}
                  {documentForm}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
                <dl>
                  <IdentityValue label={m.knowledge_private_subject({}, options)} value={address.subjectId} exact />
                </dl>
              </KnowledgeDetails>
              <form className="min-w-0 space-y-5" onSubmit={(event) => void submitNotebook(event)}>
                <Field id={ids.notebookTitle} label={m.knowledge_private_notebook_title({}, options)}>
                  <Input
                    id={ids.notebookTitle}
                    className={inputClass}
                    value={notebookTitle}
                    maxLength={256}
                    autoComplete="off"
                    disabled={!canCreateNotebook || !!notebookIntent}
                    onChange={(event) => setNotebookTitle(event.currentTarget.value)}
                  />
                </Field>
                {access.createNotebook !== 'available' && !notebookReceipt ? (
                  <FailureNotice state={access.createNotebook} locale={locale} />
                ) : null}
                {notebookFailure ? <FailureNotice state={notebookState} locale={locale} /> : null}
                <Button
                  type="submit"
                  className={controlClass}
                  disabled={!canCreateNotebook || notebookBusy || !notebookTitle.trim()}
                >
                  {notebookBusy
                    ? m.knowledge_private_creating_notebook({}, options)
                    : notebookRetry
                      ? m.knowledge_private_retry_exact({}, options)
                      : m.knowledge_private_create_notebook({}, options)}
                </Button>
              </form>
              {notebookReceipt ? (
                <div className="min-w-0 space-y-5 border-t border-border pt-5">
                  <p role="status" className="break-words">
                    {m.knowledge_private_notebook_acknowledged({}, options)}
                  </p>
                  <KnowledgeDetails label={m.knowledge_workspace_notebook_details({}, options)}>
                    <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                      <IdentityValue
                        label={m.knowledge_private_notebook_id({}, options)}
                        value={notebookReceipt.notebookId}
                      />
                      <IdentityValue
                        label={m.knowledge_private_structure_revision({}, options)}
                        value={notebookReceipt.structureRevisionId}
                      />
                    </dl>
                  </KnowledgeDetails>
                  {documentForm}
                </div>
              ) : null}
            </>
          )}
        </section>
      </PrivatePageFrame>
    );
  }

  const lifecycleBlocked =
    resumeDirty || pending || !!revisionIntent || readBusy || requiresHeadReview || publicationBusy;
  const lifecycleResultPresent =
    !!lifecycleOperationAction &&
    ['pending', 'acknowledged', 'conflict', 'not-found', 'uncertain', 'unavailable'].includes(lifecycle.commandState);
  if (lifecycle.enabled && !lifecycle.editing) {
    return (
      <PrivatePageFrame
        title={m.knowledge_private_heading({}, options)}
        locale={locale}
        lifecycleFocusBoundaryRef={lifecycle.enabled ? lifecycleFocusBoundaryRef : undefined}
        lifecycleHeadingRef={lifecycle.enabled ? lifecycleHeadingRef : undefined}
      >
        <KnowledgeLifecyclePanel
          controller={lifecycle}
          blocked={lifecycleBlocked}
          locale={locale}
          operationAction={lifecycleOperationAction}
          reviewTargetRef={lifecycleReviewTargetRef}
          reviewOpenerRef={lifecycleReviewOpenerRef}
          onReview={reviewLifecycle}
          onSubmit={submitLifecycle}
          onCancel={cancelLifecycle}
        />
      </PrivatePageFrame>
    );
  }

  const canRead = access.read === 'available';
  const freshLifecycleHead = !lifecycle.enabled || headLifecycleRevision === lifecycle.revision;
  if (!canRead || readState !== 'ready' || !head || !draft || !binding || !freshLifecycleHead) {
    const state = !canRead
      ? access.read === 'unknown'
        ? 'preparing'
        : access.read
      : !freshLifecycleHead && readState === 'ready'
        ? 'preparing'
        : readState;
    return (
      <PrivatePageFrame
        title={m.knowledge_private_heading({}, options)}
        locale={locale}
        lifecycleFocusBoundaryRef={lifecycle.enabled ? lifecycleFocusBoundaryRef : undefined}
        lifecycleHeadingRef={lifecycle.enabled ? lifecycleHeadingRef : undefined}
      >
        <>
          <FailureNotice
            state={state}
            locale={locale}
            retry={canRead && state !== 'preparing' ? () => void readCurrent('initial') : undefined}
          />
          {lifecycleResultPresent ? (
            <KnowledgeLifecyclePanel
              controller={lifecycle}
              blocked
              showBlockedMessage={false}
              locale={locale}
              operationAction={lifecycleOperationAction}
              reviewTargetRef={lifecycleReviewTargetRef}
              reviewOpenerRef={lifecycleReviewOpenerRef}
              onReview={reviewLifecycle}
              onSubmit={submitLifecycle}
              onCancel={cancelLifecycle}
            />
          ) : null}
        </>
      </PrivatePageFrame>
    );
  }

  const dirty = !sameDraft(draft, copyDraft(head));
  const revisionBusy = pending && revisionState === 'pending';
  const canSave =
    access.revise === 'available' &&
    !editorPending &&
    referenceIssues(draft).length === 0 &&
    !!draft.title.trim() &&
    dirty &&
    !pending &&
    !publicationBusy &&
    !lifecycle.locked &&
    !requiresHeadReview &&
    (!revisionReceipt || readbackState === 'ready');
  const canReplay = !!revisionIntent && !pending && !publicationBusy && !lifecycle.locked;
  const showRevisionFailure = !['idle', 'pending', 'acknowledged'].includes(revisionState);
  const formLocked = !!revisionIntent || revisionBusy || lifecycle.locked || access.revise !== 'available';
  const canRestoreVersion =
    !dirty &&
    !editorPending &&
    !formLocked &&
    !readBusy &&
    !publicationBusy &&
    !requiresHeadReview &&
    (!revisionReceipt || readbackState === 'ready');
  function restoreVersion(revision: KnowledgeHistoryRevision): boolean {
    if (
      !head ||
      !active.current ||
      !canRestoreVersion ||
      editorPendingRef.current ||
      commandInFlight.current ||
      !sameDraft(draftRef.current, copyDraft(head)) ||
      revision.documentId !== head.documentId ||
      revision.revisionId === head.revisionId
    )
      return false;
    const restored = structuredClone(revision);
    const references = admitReferenceManifest(restored.body, restored.references);
    if (references === null) return false;
    setDraft({
      title: restored.title,
      language: restored.language,
      licence: restored.licence,
      body: restored.body,
      references,
    });
    setEditorGeneration((version) => version + 1);
    setVersionRestored(true);
    return true;
  }
  return (
    <PrivatePageFrame
      title={head.title}
      locale={locale}
      lifecycleFocusBoundaryRef={lifecycle.enabled ? lifecycleFocusBoundaryRef : undefined}
      lifecycleHeadingRef={lifecycle.enabled ? lifecycleHeadingRef : undefined}
      status={
        <p role="status" className="text-sm text-muted-foreground">
          {revisionBusy
            ? m.knowledge_private_saving({}, options)
            : canReplay
              ? m.knowledge_private_uncertain({}, options)
              : requiresHeadReview
                ? m.knowledge_private_review_before_save({}, options)
                : editorPending
                  ? m.studio_workspace_snapshot_pending({}, options)
                  : dirty && versionRestored
                    ? m.studio_workspace_restored({}, options)
                    : dirty
                      ? m.knowledge_workspace_unsaved({}, options)
                      : m.knowledge_private_current_head({}, options)}
        </p>
      }
      navigation={
        <KnowledgeWorkspaceNavigation
          address={{ notebookId: head.notebookId, documentId: head.documentId }}
          title={head.title}
          locale={locale}
          binding={binding}
          operations={operations}
          admission={access.readOutline}
          current={() => active.current}
          notebookReturn={notebookReturn}
        />
      }
    >
      <div className="min-w-0 space-y-8">
        <KnowledgeDetails label={m.knowledge_workspace_details({}, options)}>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <IdentityValue label={m.knowledge_private_notebook_id({}, options)} value={head.notebookId} exact />
            <IdentityValue label={m.knowledge_private_document_id({}, options)} value={head.documentId} exact />
            <IdentityValue label={m.knowledge_private_revision({}, options)} value={head.revisionId} exact />
          </dl>
        </KnowledgeDetails>
        <form className="min-w-0 space-y-5" onSubmit={(event) => void submitRevision(event)}>
          <DocumentDraftFields
            key={editorGeneration}
            ids={ids}
            locale={locale}
            draft={draft}
            disabled={formLocked}
            onChange={setDraft}
            onPendingChange={setEditorPending}
            onSave={() => void submitRevision()}
            inspect={operations.inspectReference ? (input) => operations.inspectReference!(input, binding) : undefined}
            subjectIds={head.subjectIds}
            mediaSelection={knowledgePrivateMediaSelection(head)}
            uploadBinding={
              binding && access.revise === 'available'
                ? {
                    documentId: head.documentId,
                    viewer: binding.viewer,
                    csrfToken: binding.csrfToken,
                    lifetime: access.owner,
                    current: () => active.current,
                  }
                : null
            }
          />
          {access.revise !== 'available' ? <FailureNotice state={access.revise} locale={locale} /> : null}
          {requiresHeadReview ? (
            <p role="status" className="border-t border-border pt-3 text-sm leading-relaxed">
              {m.knowledge_private_draft_retained({}, options)}
            </p>
          ) : null}
          {revisionState === 'conflict' ? <FailureNotice state="conflict" locale={locale} /> : null}
          {conflictReadFailure ? <FailureNotice state={conflictReadFailure} locale={locale} /> : null}
          {showRevisionFailure && revisionState !== 'conflict' ? (
            <FailureNotice state={revisionState} locale={locale} />
          ) : null}
          {revisionReceipt ? (
            <section className="min-w-0 space-y-3" aria-live="polite">
              <p role="status">{m.knowledge_private_saved_receipt({}, options)}</p>
              <KnowledgeDetails label={m.knowledge_workspace_saved({}, options)}>
                <dl>
                  <IdentityValue
                    label={m.knowledge_private_revision({}, options)}
                    value={revisionReceipt.revisionId}
                    exact
                  />
                </dl>
              </KnowledgeDetails>
              {readbackState === 'preparing' ? <p role="status">{m.knowledge_private_readback({}, options)}</p> : null}
              {readbackState === 'unavailable' || readbackState === 'not-found' || readbackState === 'denied' ? (
                <FailureNotice state={readbackState} locale={locale} retry={() => void readCurrent('readback')} />
              ) : null}
              {readbackState === 'review' ? <FailureNotice state="conflict" locale={locale} /> : null}
              {readbackState === 'ready' ? (
                <p role="status">{m.knowledge_private_readback_confirmed({}, options)}</p>
              ) : null}
            </section>
          ) : null}
          {requiresHeadReview && reviewHead ? (
            <section
              className="min-w-0 space-y-4 border-t border-border pt-5"
              aria-labelledby="knowledge-private-head-review"
            >
              <h2 id="knowledge-private-head-review" className="text-base font-semibold">
                {m.knowledge_private_review_current_head({}, options)}
              </h2>
              <p className="break-all font-mono text-sm text-muted-foreground">{reviewHead.revisionId}</p>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <div className="min-w-0 space-y-2">
                  <h3 className="font-medium">{m.knowledge_private_native_version({}, options)}</h3>
                  <ReviewMetadata draft={copyDraft(reviewHead)} subjectIds={reviewHead.subjectIds} locale={locale} />
                  <KnowledgeReferenceBody
                    inspectable={false}
                    document={reviewHead.body}
                    references={reviewHead.references}
                    locale={locale}
                    mediaSelection={knowledgePrivateMediaSelection(reviewHead)}
                  />
                </div>
                <div className="min-w-0 space-y-2">
                  <h3 className="font-medium">{m.knowledge_private_your_draft({}, options)}</h3>
                  <KnowledgeReferenceBody
                    inspectable={false}
                    document={draft.body}
                    references={draft.references}
                    locale={locale}
                    mediaSelection={knowledgePrivateMediaSelection(head)}
                  />
                </div>
              </div>
              <Button type="button" variant="outline" className={controlClass} onClick={acceptReviewedHead}>
                {m.knowledge_private_use_reviewed_head({}, options)}
              </Button>
            </section>
          ) : null}
          <div className="flex min-w-0 flex-wrap gap-3">
            {requiresHeadReview && !reviewHead ? (
              <Button
                type="button"
                variant="outline"
                className={controlClass}
                disabled={readBusy}
                onClick={() => void readCurrent('conflict')}
              >
                {readBusy ? m.knowledge_private_readback({}, options) : m.knowledge_private_reread({}, options)}
              </Button>
            ) : null}
            {canReplay ? (
              <Button type="button" variant="outline" className={controlClass} onClick={() => void replayRevision()}>
                {m.knowledge_private_retry_exact({}, options)}
              </Button>
            ) : null}
            <Button type="submit" className={controlClass} disabled={!canSave}>
              {revisionBusy
                ? m.knowledge_private_saving({}, options)
                : requiresHeadReview
                  ? m.knowledge_private_review_before_save({}, options)
                  : m.knowledge_private_save({}, options)}
            </Button>
          </div>
        </form>
        <nav
          aria-label={m.knowledge_workspace_tools({}, options)}
          className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3"
        >
          <a href="#knowledge-revisions" className={linkClass}>
            {m.knowledge_history_heading({}, options)}
          </a>
          <a href="#knowledge-publication" className={linkClass}>
            {m.knowledge_publication_heading({}, options)}
          </a>
        </nav>
        <KnowledgeLifecyclePanel
          controller={lifecycle}
          blocked={lifecycleBlocked}
          locale={locale}
          operationAction={lifecycleOperationAction}
          reviewTargetRef={lifecycleReviewTargetRef}
          reviewOpenerRef={lifecycleReviewOpenerRef}
          onReview={reviewLifecycle}
          onSubmit={submitLifecycle}
          onCancel={cancelLifecycle}
        />
        <KnowledgeHistoryPanel
          address={{ notebookId: head.notebookId, documentId: head.documentId }}
          binding={binding}
          admission={access.history ?? 'unavailable'}
          compareAdmission={access.compare ?? 'unavailable'}
          operations={operations.history}
          conflictPair={
            requiresHeadReview && reviewHead && head.revisionId !== reviewHead.revisionId
              ? { leftRevisionId: head.revisionId, rightRevisionId: reviewHead.revisionId }
              : null
          }
          draft={draft.body}
          locale={locale}
          isCurrent={() => active.current}
          onRetire={retire}
          onRestore={canRestoreVersion ? restoreVersion : undefined}
          workingRevisionId={head.revisionId}
        />
        <KnowledgeTransferCaller
          source={{
            representation: 'authoring',
            accountId: access.viewer,
            notebookId: head.notebookId,
            documentId: head.documentId,
            revisionId: head.revisionId,
          }}
          title={head.title}
          locale={locale}
          binding={binding}
          lifetime={access.owner}
          blocked={
            dirty ||
            pending ||
            !!revisionIntent ||
            readBusy ||
            requiresHeadReview ||
            publicationBusy ||
            lifecycle.locked
          }
        />
        <KnowledgePublicationPanel
          head={reviewHead ?? head}
          binding={binding}
          admission={access.publication}
          locale={locale}
          blocked={pending || !!revisionIntent || readBusy || lifecycle.locked}
          operations={operations}
          onRetire={retire}
          onBusyChange={setPublicationBusy}
          onObservation={(observed, nextBinding) => {
            setBinding(nextBinding);
            if (observed.revisionId === head.revisionId) {
              setHead(observed);
              setReviewHead(null);
            } else {
              setReviewHead(observed);
              setRequiresHeadReview(true);
            }
          }}
        />
      </div>
    </PrivatePageFrame>
  );
}

function DocumentDraftFields({
  ids,
  locale,
  draft,
  disabled,
  onChange,
  subjectIds,
  inspect,
  onPendingChange,
  onSave,
  uploadBinding = null,
  mediaSelection = null,
}: {
  uploadBinding?: KnowledgeImageUploadBinding | null;
  mediaSelection?: KnowledgeMediaSelection | null;
  ids: { notebookTitle: string; documentTitle: string; language: string; licence: string };
  locale: string;
  draft: DocumentDraft;
  disabled: boolean;
  onChange: (draft: DocumentDraft) => void;
  inspect?: ReferenceInspector | undefined;
  onPendingChange: (pending: boolean) => void;
  onSave?: (() => void) | undefined;
  subjectIds: readonly string[];
}) {
  const options = localeOptions(locale);
  const labels = useMemo(() => knowledgeEditorLabels(), [locale]);
  const [pendingSnapshot, setPendingSnapshot] = useState(false);
  const [referencePending, setReferencePending] = useState(false);
  const [snapshotError, setSnapshotError] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [imageBusy, setImageBusy] = useState(false);
  const pending = useRef({ snapshot: false, reference: false, image: false });
  function updatePending(kind: keyof typeof pending.current, busy: boolean) {
    pending.current[kind] = busy;
    const { snapshot, reference, image } = pending.current;
    onPendingChange(snapshot || reference || image);
  }
  const media = useKnowledgeImageUploader(draft.body, uploadBinding);
  const renderImage = useKnowledgeImageRenderer(draft.body, mediaSelection, locale, media.ownedOriginal);
  return (
    <div className="min-w-0 space-y-5">
      <Field id={ids.documentTitle} label={m.knowledge_private_document_title({}, options)}>
        <Input
          id={ids.documentTitle}
          className={inputClass}
          value={draft.title}
          maxLength={512}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, title: event.currentTarget.value })}
        />
      </Field>
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">{m.knowledge_private_body({}, options)}</p>
        <RichTextEditor
          preset="knowledge"
          key={editorVersion}
          value={draft.body}
          onSnapshotPending={() => {
            setPendingSnapshot(true);
            updatePending('snapshot', true);
          }}
          onSnapshotError={() => {
            setSnapshotError(true);
            setPendingSnapshot(true);
            updatePending('snapshot', true);
          }}
          onChange={(body) => {
            setSnapshotError(false);
            setPendingSnapshot(false);
            onChange({ ...draft, body });
            updatePending('snapshot', false);
          }}
          label={m.knowledge_private_body({}, options)}
          labels={labels}
          {...(media.upload ? { upload: media.upload } : {})}
          renderImage={renderImage}
          mediaVisitKey={uploadBinding?.lifetime}
          onUploadState={(state, _count, attachments) => {
            const busy = state !== 'ready' || (attachments ?? 0) > 0;
            setImageBusy(busy);
            updatePending('image', busy);
          }}
          {...(onSave ? { onSave } : {})}
          {...(draft.language ? { lang: draft.language } : {})}
          toolbar="always"
          disabled={disabled || referencePending}
          className="min-w-0 [overflow-wrap:anywhere]"
        />
      </div>
      {!uploadBinding ? (
        <p className="text-sm text-muted-foreground">{m.knowledge_media_save_first({}, options)}</p>
      ) : null}
      {snapshotError ? (
        <div className="space-y-3" role="alert">
          <p>{m.knowledge_reference_repairReview({}, options)}</p>
          <Button
            type="button"
            variant="outline"
            className={controlClass}
            onClick={() => {
              setEditorVersion(editorVersion + 1);
              setSnapshotError(false);
              setPendingSnapshot(false);
              updatePending('snapshot', false);
            }}
          >
            {m.knowledge_reference_restore({}, options)}
          </Button>
        </div>
      ) : null}
      <KnowledgeDetails label={m.knowledge_workspace_metadata({}, options)}>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field id={ids.language} label={m.knowledge_private_language({}, options)}>
            <Input
              id={ids.language}
              className={inputClass}
              value={draft.language ?? ''}
              maxLength={64}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, language: event.currentTarget.value || null })}
            />
          </Field>
          <Field id={ids.licence} label={m.knowledge_private_licence({}, options)}>
            <Input
              id={ids.licence}
              className={inputClass}
              value={draft.licence}
              maxLength={128}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, licence: event.currentTarget.value })}
            />
          </Field>
        </div>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          {subjectIds.map((subjectId) => (
            <IdentityValue key={subjectId} label={m.knowledge_private_subject({}, options)} value={subjectId} exact />
          ))}
        </dl>
      </KnowledgeDetails>
      <KnowledgeReferenceAuthoring
        onEditingChange={(editing) => {
          setReferencePending(editing);
          updatePending('reference', editing);
        }}
        draft={draft}
        locale={locale}
        disabled={disabled || pendingSnapshot || imageBusy}
        onChange={(next) => onChange({ ...draft, ...next })}
        inspect={inspect}
      />
    </div>
  );
}

function ReviewMetadata({
  draft,
  subjectIds,
  locale,
}: {
  draft: DocumentDraft;
  subjectIds: readonly string[];
  locale: string;
}) {
  const options = localeOptions(locale);
  return (
    <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
      <IdentityValue label={m.knowledge_private_document_title({}, options)} value={draft.title || '—'} />
      <IdentityValue label={m.knowledge_private_language({}, options)} value={draft.language ?? '—'} />
      <IdentityValue label={m.knowledge_private_licence({}, options)} value={draft.licence || '—'} />
      <IdentityValue label={m.knowledge_private_subject_ids({}, options)} value={subjectIds.join(', ')} />
    </dl>
  );
}

/** Session, exposure, locale and exact address are one mount key; late responses belong only to that visit. */
export function KnowledgePrivatePage({
  address,
  locale = getLocale(),
  operations = nativeOperations,
}: {
  address: KnowledgePrivatePageAddress;
  locale?: string;
  operations?: KnowledgePrivateOperations;
}) {
  const queryClient = useQueryClient();
  const location = useLocation({ select: (item) => item.pathname });
  const session = useSession();
  const sessionSource = readerSessionSource(queryClient);
  const sessionRevision = useSyncExternalStore(
    sessionSource.subscribe,
    sessionSource.snapshot,
    sessionSource.serverSnapshot,
  );
  const exposureLifetime = viewerExposureLifetime(queryClient);
  const exposureSnapshot = useSyncExternalStore(
    exposureLifetime.subscribe,
    exposureLifetime.getSnapshot,
    exposureLifetime.getServerSnapshot,
  );
  const read = useOperationAdmission('knowledge_document.private_read');
  const createNotebook = useOperationAdmission('knowledge_notebook.create');
  const listNotebooks = useOperationAdmission('knowledge_notebook.owned_list');
  const readOutline = useOperationAdmission('knowledge_notebook.outline');
  const createDocument = useOperationAdmission('knowledge_document.create');
  const revise = useOperationAdmission('knowledge_document.revise');
  const publication = useOperationAdmission('knowledge_document.select_publication');
  const history = useOperationAdmission('knowledge_document.history');
  const compare = useOperationAdmission('knowledge_document.compare');
  const lifecycleRead = useOperationAdmission('knowledge_document.lifecycle');
  const trash = useOperationAdmission('knowledge_document.trash');
  const restore = useOperationAdmission('knowledge_document.restore');

  const viewer = session.state === 'signed-in' && typeof session.subject === 'string' ? session.subject : null;
  let exposureRevision = 'closed';
  if (exposureSnapshot.state === 'signed-in' && exposureSnapshot.observation.subject === viewer) {
    const key = viewerExposureQuery(exposureSnapshot.observation).queryKey;
    const state = queryClient.getQueryState(key);
    exposureRevision = JSON.stringify([
      exposureSnapshot.observation.id,
      state?.status,
      state?.dataUpdateCount,
      state?.dataUpdatedAt,
      state?.isInvalidated,
    ]);
  }

  let access: KnowledgePrivatePageAccess;
  if (session.state === 'signed-out') access = { state: 'signed-out' };
  else if (session.state === 'unavailable') access = { state: 'unavailable' };
  else if (
    session.state === 'signed-in' &&
    viewer &&
    isKnowledgeId(viewer) &&
    typeof session.csrfToken === 'string' &&
    exposureSnapshot.state === 'signed-in' &&
    exposureSnapshot.observation.subject === viewer
  ) {
    access = {
      state: 'ready',
      viewer,
      csrfToken: session.csrfToken,
      owner: JSON.stringify([
        viewer,
        session.csrfToken,
        sessionRevision,
        exposureRevision,
        locale,
        address,
        read,
        createNotebook,
        listNotebooks,
        readOutline,
        createDocument,
        revise,
        publication,
        history,
        compare,
        lifecycleRead,
        trash,
        restore,
        operationSourceId(operations),
      ]),
      read,
      createNotebook,
      listNotebooks,
      readOutline,
      createDocument,
      revise,
      publication,
      history,
      compare,
      lifecycleRead,
      trash,
      restore,
    };
  } else access = { state: 'preparing' };

  const owner =
    access.state === 'ready'
      ? access.owner
      : JSON.stringify([sessionRevision, exposureRevision, locale, address, access.state]);
  const returnPath =
    address.kind === 'create' ? `${location}?subjectId=${encodeURIComponent(address.subjectId)}` : location;
  const retrySession = () => {
    void queryClient.invalidateQueries({ queryKey: ['session'], exact: true });
  };
  return (
    <AuthoringDepartureBoundary sessionBound>
      {access.state === 'ready' ? (
        <PrivateKnowledgeEditorOwner
          owner={owner}
          address={address}
          locale={locale}
          returnPath={returnPath}
          access={access}
          operations={operations}
          notebookReturn={
            address.kind === 'resume' ? (
              <KnowledgeNavigationReturnLink
                address={address}
                locale={locale}
                embedded
                binding={knowledgeNavigationBinding(
                  access.viewer,
                  access.csrfToken,
                  sessionRevision,
                  exposureRevision,
                  locale,
                )}
              />
            ) : null
          }
        />
      ) : (
        <PrivatePageFrame title={m.knowledge_private_heading({}, localeOptions(locale))} locale={locale}>
          <AccessNotice state={access.state} locale={locale} returnPath={returnPath} retry={retrySession} />
        </PrivatePageFrame>
      )}
    </AuthoringDepartureBoundary>
  );
}

/** Small view entry used by recorded stories and the two localized file routes. */
export function KnowledgePrivateAccessEntry({
  address,
  access,
  locale,
  operations = nativeOperations,
}: {
  address: KnowledgePrivatePageAddress;
  access: KnowledgePrivatePageAccess;
  locale: string;
  operations?: KnowledgePrivateOperations;
}) {
  const returnPath =
    address.kind === 'create'
      ? `/knowledge/new?subjectId=${encodeURIComponent(address.subjectId)}`
      : `/knowledge/notebooks/${encodeURIComponent(address.notebookId)}/documents/${encodeURIComponent(address.documentId)}`;
  if (access.state !== 'ready')
    return (
      <PrivatePageFrame title={m.knowledge_private_heading({}, localeOptions(locale))} locale={locale}>
        <AccessNotice state={access.state} locale={locale} returnPath={returnPath} retry={() => undefined} />
      </PrivatePageFrame>
    );
  return (
    <KnowledgePrivateVisitBoundary>
      <PrivateKnowledgeEditorOwner
        owner={JSON.stringify([access, locale, address, operationSourceId(operations)])}
        address={address}
        locale={locale}
        returnPath={returnPath}
        access={access}
        operations={operations}
      />
    </KnowledgePrivateVisitBoundary>
  );
}

function KnowledgePrivateVisitBoundary({ children }: { children: React.ReactNode }) {
  return <AuthoringDepartureBoundary sessionBound>{children}</AuthoringDepartureBoundary>;
}

function PrivateKnowledgeEditorOwner({
  owner,
  address,
  locale,
  returnPath,
  access,
  operations,
  notebookReturn,
}: {
  owner: string;
  address: KnowledgePrivatePageAddress;
  locale: string;
  returnPath: string;
  access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>;
  operations: KnowledgePrivateOperations;
  notebookReturn?: React.ReactNode;
}) {
  return (
    <PrivateKnowledgeEditor
      key={owner}
      address={address}
      locale={locale}
      returnPath={returnPath}
      access={access}
      operations={operations}
      notebookReturn={notebookReturn}
    />
  );
}
