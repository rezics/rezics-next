import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import { RichTextEditor, type RichTextEditorLabels } from '@rezics/ui';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { DocumentBody } from '../document-body';
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
  createKnowledgePrivateDocumentRequest,
  createKnowledgePrivateNotebookRequest,
  prepareKnowledgePrivateVisit,
  readKnowledgeOutlineRequest,
  readKnowledgeOwnedNotebooksRequest,
  readKnowledgePrivateVisit,
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

const controlClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const inputClass =
  'min-h-11 min-w-0 max-w-full border-border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal break-words py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
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

export type KnowledgePrivateOperations = Readonly<{
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

function copyDraft(head: KnowledgePrivateHead): DocumentDraft {
  return {
    title: head.title,
    language: head.language,
    body: structuredClone(head.body),
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

function IdentityValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono text-sm text-muted-foreground">{value}</dd>
    </div>
  );
}

function PrivatePageFrame({ title, locale, children }: { title: string; locale: string; children: React.ReactNode }) {
  const options = localeOptions(locale);
  return (
    <main
      className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-4 py-6 text-foreground [overflow-wrap:anywhere] sm:px-6 sm:py-8"
      data-private-knowledge-visit
    >
      <header className="min-w-0 space-y-3">
        <PageHeading>{title}</PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.knowledge_private_intro({}, options)}
        </p>
      </header>
      {children}
    </main>
  );
}

function sameReceipt<T extends object>(value: unknown, fields: readonly (keyof T)[]): value is T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return fields.every((field) => isKnowledgeId(candidate[String(field)]));
}

function receiptStatus<T extends object>(
  result: PrivateOperationResult<T>,
  fields: readonly (keyof T)[],
): result is { state: 'acknowledged'; receipt: T } {
  return result.state === 'acknowledged' && sameReceipt<T>(result.receipt, fields);
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
}: {
  address: KnowledgePrivatePageAddress;
  locale: string;
  returnPath: string;
  access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>;
  operations: KnowledgePrivateOperations;
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
  const [documentDraft, setDocumentDraft] = useState<DocumentDraft>(() => ({
    title: copy.documentTitle,
    language: locale,
    body: fromPlainText('', 'blocks'),
    licence: defaultLicence,
  }));
  const [documentIntent, setDocumentIntent] = useState<DocumentIntent | null>(null);
  const [documentCreateState, setDocumentCreateState] = useState('idle');
  const [documentReceipt, setDocumentReceipt] = useState<KnowledgeDocumentReceipt | null>(null);
  const [head, setHead] = useState<KnowledgePrivateHead | null>(null);
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [readState, setReadState] = useState('preparing');
  const [readBusy, setReadBusy] = useState(false);
  const [revisionIntent, setRevisionIntent] = useState<RevisionIntent | null>(null);
  const [revisionState, setRevisionState] = useState('idle');
  const [revisionReceipt, setRevisionReceipt] = useState<KnowledgeRevisionReceipt | null>(null);
  const [acknowledgedDraft, setAcknowledgedDraft] = useState<DocumentDraft | null>(null);
  const [readbackState, setReadbackState] = useState('idle');
  const [reviewHead, setReviewHead] = useState<KnowledgePrivateHead | null>(null);
  const [requiresHeadReview, setRequiresHeadReview] = useState(false);
  const [retired, setRetired] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [pending, setPending] = useState(false);
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
  const notebookIntentRef = useRef(notebookIntent);
  const documentIntentRef = useRef(documentIntent);
  const revisionIntentRef = useRef(revisionIntent);
  const notebooksSequence = useRef(0);
  const outlineSequence = useRef(0);
  notebookIntentRef.current = notebookIntent;
  documentIntentRef.current = documentIntent;
  revisionIntentRef.current = revisionIntent;

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
    active.current = false;
    generation.current += 1;
    readSequence.current += 1;
    setBinding(null);
    setHead(null);
    setDraft(null);
    setReviewHead(null);
    setNotebookTitle('');
    setNotebookReceipt(null);
    setDocumentDraft({ title: '', language: null, body: fromPlainText('', 'blocks'), licence: '' });
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
    if (!currentAddress || !active.current || access.read !== 'available' || readBusy) return;
    const sequence = ++readSequence.current;
    setReadBusy(true);
    if (purpose === 'initial') setReadState('preparing');
    if (purpose === 'readback') setReadbackState('preparing');
    try {
      const result = await operations.read(currentAddress, { viewer: access.viewer, csrfToken: access.csrfToken });
      if (!active.current || readSequence.current !== sequence) return;
      const nextBinding = bindingFromRead(result, access);
      if (result.state === 'ready' && nextBinding) {
        setBinding(nextBinding);
        if (purpose === 'initial' || !head) {
          setHead(result.head);
          setDraft(copyDraft(result.head));
          setReadState('ready');
        } else if (purpose === 'conflict') {
          setReviewHead(result.head);
          setRequiresHeadReview(true);
          setReadState('ready');
        } else {
          if (expectedRevisionId === result.head.revisionId) {
            setHead(result.head);
            if (sameDraft(draftRef.current, submittedDraft ?? null)) setDraft(copyDraft(result.head));
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
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
          retire(result.state);
        if (purpose === 'initial' || purpose === 'conflict') setReadState(result.state);
        else setReadbackState(result.state);
      }
    } catch {
      if (active.current && readSequence.current === sequence) {
        if (purpose === 'initial' || purpose === 'conflict') setReadState('unavailable');
        else setReadbackState('unavailable');
      }
    } finally {
      if (active.current && readSequence.current === sequence) setReadBusy(false);
    }
  }

  useEffect(() => {
    if (address.kind !== 'resume' || retired) return;
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
    if (documentIntent || documentReceipt) return;
    setTemplateKind(kind);
    setDocumentDraft(knowledgeAuthoringTemplateDraft(knowledgeTemplateCopy(kind, locale), locale));
  }

  async function readCreated(addressToRead: KnowledgePrivateAddress) {
    if (!active.current || access.read !== 'available') return;
    const sequence = ++readSequence.current;
    setReadBusy(true);
    setReadState('preparing');
    try {
      const result = await operations.read(addressToRead, { viewer: access.viewer, csrfToken: access.csrfToken });
      if (!active.current || readSequence.current !== sequence) return;
      const nextBinding = bindingFromRead(result, access);
      if (result.state === 'ready' && nextBinding) {
        setBinding(nextBinding);
        setHead(result.head);
        setDraft(copyDraft(result.head));
        setReadState('ready');
      } else {
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
          retire(result.state);
        setReadState(result.state);
      }
    } catch {
      if (active.current && readSequence.current === sequence) setReadState('unavailable');
    } finally {
      if (active.current && readSequence.current === sequence) setReadBusy(false);
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
    if (pending || notebookReceipt || !active.current) return;
    const intent = startNotebookIntent();
    if (!intent) return;
    setPending(true);
    setUnresolved(true);
    setNotebookState('pending');
    try {
      const result = await operations.createNotebook(intent);
      if (!active.current) return;
      if (receiptStatus<KnowledgeNotebookReceipt>(result, ['notebookId', 'structureRevisionId'])) {
        setNotebookReceipt(result.receipt);
        setNotebookIntent(null);
        notebookIntentRef.current = null;
        setNotebookState('acknowledged');
        setUnresolved(false);
      } else {
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
          retire(result.state);
        setNotebookState(result.state);
        setUnresolved(result.state === 'uncertain' || result.state === 'unavailable');
      }
    } catch {
      if (active.current) {
        setNotebookState('uncertain');
        setUnresolved(true);
      }
    } finally {
      if (active.current) setPending(false);
    }
  }

  function startDocumentIntent(): DocumentIntent | null {
    if (documentIntentRef.current) return documentIntentRef.current;
    if (address.kind !== 'create' || !binding || access.createDocument !== 'available') return null;
    const existing = placementChoice === 'existing-notebook';
    if (!existing && !notebookReceipt) return null;
    if (existing && (!destination || !destinationReviewed)) return null;
    const next = immutable({
      ...structuredClone(documentDraft),
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

  async function submitDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || documentReceipt || !active.current) return;
    const intent = startDocumentIntent();
    if (!intent) return;
    setPending(true);
    setUnresolved(true);
    setDocumentCreateState('pending');
    try {
      const result = await operations.createDocument(intent);
      if (!active.current) return;
      if (
        receiptStatus<KnowledgeDocumentReceipt>(result, [
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
        setDocumentCreateState(result.state);
        setUnresolved(result.state === 'uncertain' || result.state === 'unavailable');
      }
    } catch {
      if (active.current) {
        setDocumentCreateState('uncertain');
        setUnresolved(true);
      }
    } finally {
      if (active.current) setPending(false);
    }
  }

  function startRevisionIntent(): RevisionIntent | null {
    if (revisionIntentRef.current) return revisionIntentRef.current;
    const currentAddress = resumeAddress();
    if (!currentAddress || !head || !draft || !binding || access.revise !== 'available' || requiresHeadReview)
      return null;
    const next = immutable({
      ...structuredClone(draft),
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

  async function submitRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || publicationBusy || !active.current) return;
    const intent = startRevisionIntent();
    if (!intent) return;
    setPending(true);
    setUnresolved(true);
    setRevisionState('pending');
    setRevisionReceipt(null);
    setAcknowledgedDraft(null);
    setReadbackState('idle');
    try {
      const result = await operations.revise(intent);
      if (!active.current) return;
      if (
        receiptStatus<KnowledgeRevisionReceipt>(result, ['documentId', 'revisionId']) &&
        result.receipt.documentId === intent.documentId
      ) {
        setRevisionReceipt(result.receipt);
        setAcknowledgedDraft(intentDraft(intent));
        setRevisionIntent(null);
        revisionIntentRef.current = null;
        setRevisionState('acknowledged');
        setUnresolved(false);
        void readCurrent('readback', result.receipt.revisionId, intentDraft(intent));
      } else {
        if (result.state === 'conflict') {
          setRevisionIntent(null);
          revisionIntentRef.current = null;
          setRevisionState('conflict');
          setRequiresHeadReview(true);
          setReadbackState('idle');
          setUnresolved(false);
        } else {
          if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
            retire(result.state);
          setRevisionState(result.state);
          setUnresolved(result.state === 'uncertain' || result.state === 'unavailable');
        }
      }
    } catch {
      if (active.current) {
        setRevisionState('uncertain');
        setUnresolved(true);
      }
    } finally {
      if (active.current) setPending(false);
    }
  }

  async function replayRevision() {
    const intent = revisionIntentRef.current;
    if (!intent || pending || publicationBusy || !active.current) return;
    setPending(true);
    setRevisionState('pending');
    try {
      const result = await operations.revise(intent);
      if (!active.current) return;
      if (
        receiptStatus<KnowledgeRevisionReceipt>(result, ['documentId', 'revisionId']) &&
        result.receipt.documentId === intent.documentId
      ) {
        setRevisionReceipt(result.receipt);
        setAcknowledgedDraft(intentDraft(intent));
        setRevisionIntent(null);
        revisionIntentRef.current = null;
        setRevisionState('acknowledged');
        setUnresolved(false);
        void readCurrent('readback', result.receipt.revisionId, intentDraft(intent));
      } else {
        if (result.state === 'conflict') {
          setRevisionIntent(null);
          revisionIntentRef.current = null;
          setRevisionState('conflict');
          setRequiresHeadReview(true);
          setUnresolved(false);
        } else {
          if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
            retire(result.state);
          setRevisionState(result.state);
          setUnresolved(result.state === 'uncertain' || result.state === 'unavailable');
        }
      }
    } catch {
      if (active.current) {
        setRevisionState('uncertain');
        setUnresolved(true);
      }
    } finally {
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
      !!selectedNotebook);
  const resumeDirty =
    (address.kind === 'resume' || !!createdAddress) &&
    !!head &&
    !sameDraft(draft, acknowledgedDraft ?? copyDraft(head));
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
    createDirty || resumeDirty || unresolved || pending,
    unresolved || pending,
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
          disabled={documentFrozen || !!documentReceipt}
          onSelect={applyTemplate}
        />
        <h2 className="text-lg font-semibold">{m.knowledge_private_document_title({}, options)}</h2>
        <DocumentDraftFields
          ids={ids}
          locale={locale}
          draft={documentDraft}
          disabled={documentFrozen || !!documentReceipt}
          onChange={setDocumentDraft}
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
            <DocumentBody document={documentDraft.body} locale={locale} />
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
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <IdentityValue label={m.knowledge_private_document_id({}, options)} value={documentReceipt.documentId} />
              <IdentityValue
                label={m.knowledge_private_placement_id({}, options)}
                value={documentReceipt.placementId}
              />
              <IdentityValue label={m.knowledge_private_revision({}, options)} value={documentReceipt.revisionId} />
            </dl>
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
              disabled={!canCreateDocument || documentBusy || !documentDraft.title.trim()}
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
        <section className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6">
          <KnowledgePlacementChoiceBar
            locale={locale}
            choice={placementChoice}
            disabled={!!notebookIntent || !!notebookReceipt || !!documentIntent || !!documentReceipt}
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
                  <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                    <IdentityValue
                      label={m.knowledge_private_notebook_title({}, options)}
                      value={selectedNotebook.title}
                    />
                    <IdentityValue
                      label={m.knowledge_private_notebook_id({}, options)}
                      value={selectedNotebook.notebookId}
                    />
                    <IdentityValue
                      label={m.knowledge_private_subject({}, options)}
                      value={selectedNotebook.subjectId}
                    />
                  </dl>
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
              <h2 className="text-lg font-semibold">{m.knowledge_private_notebook_title({}, options)}</h2>
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                <IdentityValue label={m.knowledge_private_subject({}, options)} value={address.subjectId} />
              </dl>
              <form className="min-w-0 space-y-5" onSubmit={(event) => void submitNotebook(event)}>
                <Field id={ids.notebookTitle} label={m.knowledge_private_notebook_title({}, options)}>
                  <Input
                    id={ids.notebookTitle}
                    className={inputClass}
                    value={notebookTitle}
                    maxLength={256}
                    autoComplete="off"
                    disabled={!!notebookIntent || !!notebookReceipt || !binding}
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
                  {documentForm}
                </div>
              ) : null}
            </>
          )}
        </section>
      </PrivatePageFrame>
    );
  }

  const canRead = access.read === 'available';
  if (!canRead || readState !== 'ready' || !head || !draft || !binding) {
    const state = !canRead ? (access.read === 'unknown' ? 'preparing' : access.read) : readState;
    return (
      <PrivatePageFrame title={m.knowledge_private_heading({}, options)} locale={locale}>
        <FailureNotice
          state={state}
          locale={locale}
          retry={canRead && state !== 'preparing' ? () => void readCurrent('initial') : undefined}
        />
      </PrivatePageFrame>
    );
  }

  const dirty = !sameDraft(draft, copyDraft(head));
  const revisionBusy = pending && revisionState === 'pending';
  const canSave =
    access.revise === 'available' &&
    dirty &&
    !pending &&
    !publicationBusy &&
    !requiresHeadReview &&
    (!revisionReceipt || readbackState === 'ready');
  const canReplay = !!revisionIntent && !pending && !publicationBusy;
  const showRevisionFailure = !['idle', 'pending', 'acknowledged'].includes(revisionState);
  const formLocked = !!revisionIntent || revisionBusy;
  return (
    <PrivatePageFrame title={head.title} locale={locale}>
      <div className="min-w-0 space-y-6 rounded-xl border border-border bg-card p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">{m.knowledge_private_current_head({}, options)}</p>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <IdentityValue label={m.knowledge_private_notebook_id({}, options)} value={head.notebookId} />
          <IdentityValue label={m.knowledge_private_revision({}, options)} value={head.revisionId} />
        </dl>
        <ReviewMetadata draft={draft} subjectIds={head.subjectIds} locale={locale} />
        <form className="min-w-0 space-y-5" onSubmit={(event) => void submitRevision(event)}>
          <DocumentDraftFields
            ids={ids}
            locale={locale}
            draft={draft}
            disabled={formLocked}
            onChange={setDraft}
            subjectIds={head.subjectIds}
          />
          {access.revise !== 'available' ? <FailureNotice state={access.revise} locale={locale} /> : null}
          {requiresHeadReview ? (
            <p role="status" className="border-t border-border pt-3 text-sm leading-relaxed">
              {m.knowledge_private_draft_retained({}, options)}
            </p>
          ) : null}
          {revisionState === 'conflict' ? <FailureNotice state="conflict" locale={locale} /> : null}
          {showRevisionFailure && revisionState !== 'conflict' ? (
            <FailureNotice state={revisionState} locale={locale} />
          ) : null}
          {revisionReceipt ? (
            <section className="min-w-0 space-y-3" aria-live="polite">
              <p role="status">{m.knowledge_private_saved_receipt({}, options)}</p>
              <IdentityValue label={m.knowledge_private_revision({}, options)} value={revisionReceipt.revisionId} />
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
                  <DocumentBody document={reviewHead.body} locale={locale} />
                </div>
                <div className="min-w-0 space-y-2">
                  <h3 className="font-medium">{m.knowledge_private_your_draft({}, options)}</h3>
                  <DocumentBody document={draft.body} locale={locale} />
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
        <KnowledgePublicationPanel
          head={reviewHead ?? head}
          binding={binding}
          admission={access.publication}
          locale={locale}
          blocked={pending || !!revisionIntent || readBusy}
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
}: {
  ids: { notebookTitle: string; documentTitle: string; language: string; licence: string };
  locale: string;
  draft: DocumentDraft;
  disabled: boolean;
  onChange: (draft: DocumentDraft) => void;
  subjectIds: readonly string[];
}) {
  const options = localeOptions(locale);
  const labels = useMemo(() => knowledgeEditorLabels(), [locale]);
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
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-medium">{m.knowledge_private_body({}, options)}</p>
        <RichTextEditor
          value={draft.body}
          onChange={(body) => onChange({ ...draft, body })}
          label={m.knowledge_private_body({}, options)}
          labels={labels}
          {...(draft.language ? { lang: draft.language } : {})}
          toolbar="always"
          disabled={disabled}
          className="min-w-0 [overflow-wrap:anywhere]"
        />
      </div>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2" aria-label={m.knowledge_private_subject_ids({}, options)}>
        {subjectIds.map((subjectId) => (
          <IdentityValue key={subjectId} label={m.knowledge_private_subject({}, options)} value={subjectId} />
        ))}
      </dl>
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
        operationSourceId(operations),
      ]),
      read,
      createNotebook,
      listNotebooks,
      readOutline,
      createDocument,
      revise,
      publication,
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
      {address.kind === 'resume' && access.state === 'ready' && (
        <KnowledgeNavigationReturnLink
          address={address}
          locale={locale}
          binding={knowledgeNavigationBinding(
            access.viewer,
            access.csrfToken,
            sessionRevision,
            exposureRevision,
            locale,
          )}
        />
      )}
      {access.state === 'ready' ? (
        <PrivateKnowledgeEditorOwner
          owner={owner}
          address={address}
          locale={locale}
          returnPath={returnPath}
          access={access}
          operations={operations}
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
}: {
  owner: string;
  address: KnowledgePrivatePageAddress;
  locale: string;
  returnPath: string;
  access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>;
  operations: KnowledgePrivateOperations;
}) {
  return (
    <PrivateKnowledgeEditor
      key={owner}
      address={address}
      locale={locale}
      returnPath={returnPath}
      access={access}
      operations={operations}
    />
  );
}
