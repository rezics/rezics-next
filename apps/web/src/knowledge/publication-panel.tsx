import { knowledgeAuthoringImageSelection } from './media';
import { KnowledgeDetails, KnowledgeValue, knowledgeControl, knowledgeLink } from './workspace';
import { KnowledgePublicationReaderLink } from './publication-return';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { KnowledgeReferenceBody } from './reference-view';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { KnowledgePrivateHead } from './private-knowledge';
import type { KnowledgePrivateVisitRead } from './private-server';
import {
  knowledgePublicationObservation,
  reviewKnowledgePublication,
  type KnowledgePublicationBinding,
  type KnowledgePublicationIntent,
  type KnowledgePublicationReceipt,
  type KnowledgePublicationResult,
} from './publication';

type Review = ReturnType<typeof reviewKnowledgePublication>;
type PresentationKind = 'review' | 'return' | 'command' | 'read';
type PresentationRequest = Readonly<{
  id: number;
  source: object;
  owner: HTMLButtonElement;
  kind: PresentationKind;
  returnTo: HTMLElement | null;
}>;
export type KnowledgePublicationOperations = Readonly<{
  read: (
    address: { notebookId: string; documentId: string },
    expected: Pick<KnowledgePublicationBinding, 'viewer' | 'csrfToken'>,
  ) => Promise<KnowledgePrivateVisitRead>;
  selectPublication: (intent: KnowledgePublicationIntent) => Promise<KnowledgePublicationResult>;
}>;

const control = knowledgeControl;
const link = knowledgeLink;

/** This panel receives saved observations only; the editor draft is deliberately absent from its interface. */
export function KnowledgePublicationPanel({
  head,
  binding,
  admission,
  locale,
  blocked,
  operations,
  onObservation,
  onBusyChange,
  onRetire,
}: {
  head: KnowledgePrivateHead;
  binding: KnowledgePublicationBinding;
  admission: 'unknown' | 'available' | 'denied' | 'unavailable';
  locale: string;
  blocked: boolean;
  operations: KnowledgePublicationOperations;
  onObservation: (head: KnowledgePrivateHead, binding: KnowledgePublicationBinding) => void;
  onBusyChange: (busy: boolean) => void;
  onRetire: (state?: 'retired' | 'denied' | 'signed-out') => void;
}) {
  const options = { locale: locale as never };
  const headingId = useId();
  const reviewId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const savedSourceRef = useRef<HTMLParagraphElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const commandResultRef = useRef<HTMLParagraphElement>(null);
  const readResultRef = useRef<HTMLParagraphElement>(null);
  const active = useRef(true);
  const commandBusy = useRef(false);
  const readSequence = useRef(0);
  const presentationSource = useRef({ observation: '', binding, locale });
  const presentation = useRef<PresentationRequest | null>(null);
  const presentationListeners = useRef<(() => void) | null>(null);
  const nextPresentationId = useRef(0);
  const opener = useRef<{ element: HTMLElement; source: object } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [intent, setIntent] = useState<KnowledgePublicationIntent | null>(null);
  const intentRef = useRef(intent);
  intentRef.current = intent;
  const [state, setState] = useState('idle');
  const [readState, setReadState] = useState('idle');
  const [needsRead, setNeedsRead] = useState(false);
  const [reading, setReading] = useState(false);
  const [receipt, setReceipt] = useState<{
    value: KnowledgePublicationReceipt;
    before: string;
  } | null>(null);
  const observation = knowledgePublicationObservation(head);
  const latestObservation = useRef(observation);
  latestObservation.current = observation;
  if (
    presentationSource.current.observation !== observation ||
    presentationSource.current.binding !== binding ||
    presentationSource.current.locale !== locale
  ) {
    presentationSource.current = { observation, binding, locale };
    presentation.current = null;
    opener.current = null;
  }
  const currentReview = review?.observation === observation ? review : null;
  const currentReceipt =
    receipt && (receipt.before === observation || receipt.value.publicationId === head.publicationId)
      ? receipt.value
      : null;
  const unresolved = !!intent;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      readSequence.current++;
      cancelPresentation();
      opener.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    stopPresentationListeners();
  }, [observation, binding, locale]);

  useLayoutEffect(() => {
    const request = presentation.current;
    if (!request) return;
    stopPresentationListeners();
    const document = request.owner.ownerDocument;
    const focused = document.activeElement;
    const focusWasRetained =
      focused === request.owner ||
      focused === document.body ||
      focused === document.documentElement;
    if (
      !active.current ||
      request.source !== presentationSource.current ||
      !focusWasRetained
    ) {
      presentation.current = null;
      return;
    }
    presentation.current = null;

    const target =
      request.kind === 'review'
        ? currentReview
          ? reviewHeadingRef.current
          : null
        : request.kind === 'return'
          ? isVisibleFocusTarget(request.returnTo)
            ? request.returnTo
            : headingRef.current
          : request.kind === 'command'
            ? commandResultRef.current ?? readResultRef.current
            : readResultRef.current ?? savedSourceRef.current;
    (isVisibleFocusTarget(target) ? target : headingRef.current)?.focus();
  });

  useEffect(() => {
    if (review && review.observation !== observation) setReview(null);
    if (receipt && receipt.before !== observation && receipt.value.publicationId !== head.publicationId)
      setReceipt(null);
  }, [observation, review, receipt, head.publicationId]);

  useEffect(() => {
    onBusyChange(reading || state === 'pending');
  }, [reading, state, onBusyChange]);

  function stopPresentationListeners() {
    presentationListeners.current?.();
    presentationListeners.current = null;
  }

  function cancelPresentation() {
    presentation.current = null;
    stopPresentationListeners();
  }

  function requestPresentation(
    event: ReactMouseEvent<HTMLButtonElement>,
    kind: PresentationKind,
    returnTo: HTMLElement | null = null,
  ) {
    cancelPresentation();
    const owner = event.currentTarget;
    const document = owner.ownerDocument;
    if (event.detail !== 0 || document.activeElement !== owner) return null;

    const request: PresentationRequest = {
      id: ++nextPresentationId.current,
      source: presentationSource.current,
      owner,
      kind,
      returnTo,
    };
    presentation.current = request;
    const cancelIfMoved = () => {
      if (presentation.current?.id === request.id) cancelPresentation();
    };
    const cancelOnFocusMove = (focusEvent: FocusEvent) => {
      if (
        focusEvent.target !== owner &&
        focusEvent.target !== document.body &&
        focusEvent.target !== document.documentElement
      )
        cancelIfMoved();
    };
    document.addEventListener('pointerdown', cancelIfMoved, true);
    document.addEventListener('keydown', cancelIfMoved, true);
    document.addEventListener('focusin', cancelOnFocusMove, true);
    presentationListeners.current = () => {
      document.removeEventListener('pointerdown', cancelIfMoved, true);
      document.removeEventListener('keydown', cancelIfMoved, true);
      document.removeEventListener('focusin', cancelOnFocusMove, true);
    };
    return request;
  }

  function clearReview(event?: ReactMouseEvent<HTMLButtonElement>) {
    if (event) {
      const source = presentationSource.current;
      const returnTo = opener.current?.source === source ? opener.current.element : null;
      requestPresentation(event, 'return', returnTo);
      opener.current = null;
    } else {
      cancelPresentation();
      opener.current = null;
    }
    setReview(null);
  }

  function retire() {
    active.current = false;
    readSequence.current++;
    cancelPresentation();
    opener.current = null;
    setReview(null);
    setReceipt(null);
    setIntent(null);
    intentRef.current = null;
  }

  useAuthoringDeparture(
    !!currentReview || unresolved || state === 'pending',
    unresolved || state === 'pending',
    JSON.stringify([observation, review?.intent.idempotencyKey, intent?.idempotencyKey, state]),
    () => {
      clearReview();
      setIntent(null);
      intentRef.current = null;
    },
    retire,
  );

  function begin(action: 'publish' | 'withdraw', event: ReactMouseEvent<HTMLButtonElement>) {
    if (blocked || unresolved || reading || needsRead || admission !== 'available') return;
    if (action === 'withdraw' && head.publicationId === null) return;
    const request = requestPresentation(event, 'review');
    opener.current = request ? { element: request.owner, source: request.source } : null;
    setReview(reviewKnowledgePublication(head, binding, action));
    setState('idle');
  }

  async function reread(acknowledged?: KnowledgePublicationReceipt, event?: ReactMouseEvent<HTMLButtonElement>) {
    if (!active.current) return;
    if (event) requestPresentation(event, 'read');
    opener.current = null;
    const sequence = ++readSequence.current;
    setReading(true);
    setReadState('preparing');
    setReview(null);
    try {
      const result = await operations.read(
        { notebookId: head.notebookId, documentId: head.documentId },
        { viewer: binding.viewer, csrfToken: binding.csrfToken },
      );
      if (!active.current || sequence !== readSequence.current) return;
      if (result.state === 'ready' && result.viewer === binding.viewer && result.csrfToken === binding.csrfToken) {
        onObservation(result.head, {
          viewer: result.viewer,
          csrfToken: result.csrfToken,
          credential: result.credential,
        });
        setNeedsRead(false);
        setReadState(
          acknowledged ? (result.head.publicationId === acknowledged.publicationId ? 'observed' : 'changed') : 'ready',
        );
        // A read never settles an uncertain command or supplies its acknowledgement.
        if (!intentRef.current) setState('idle');
      } else {
        const failure = result.state === 'ready' ? 'retired' : result.state;
        setReadState(failure);
        setNeedsRead(true);
        if (failure === 'retired' || failure === 'signed-out' || failure === 'denied') {
          cancelPresentation();
          onRetire(failure);
        }
        if (failure === 'not-found') setReceipt(null);
      }
    } catch {
      if (active.current && sequence === readSequence.current) {
        setReadState('unavailable');
        setNeedsRead(true);
      }
    } finally {
      if (active.current && sequence === readSequence.current) setReading(false);
    }
  }

  async function submit(replay: boolean, event: ReactMouseEvent<HTMLButtonElement>) {
    if (!active.current || commandBusy.current || admission !== 'available' || blocked) return;
    const selected = replay ? intentRef.current : currentReview?.intent;
    if (!selected || (!replay && needsRead)) return;
    requestPresentation(event, 'command');
    const before = latestObservation.current;
    intentRef.current = selected;
    setIntent(selected);
    commandBusy.current = true;
    setState('pending');
    setReview(null);
    opener.current = null;
    // Starting an update or withdrawal retires the previous current-publication links.
    setReceipt(null);
    try {
      const result = await operations.selectPublication(selected);
      if (!active.current) return;
      if (result.state === 'acknowledged') {
        setReceipt({ value: result.receipt, before });
        setState('acknowledged');
        setIntent(null);
        intentRef.current = null;
        setNeedsRead(true);
        void reread(result.receipt);
      } else {
        setState(result.state);
        if (result.state === 'conflict') {
          setIntent(null);
          intentRef.current = null;
          setNeedsRead(true);
          setReadState('idle');
        }
        if (result.state === 'not-found') {
          setIntent(null);
          intentRef.current = null;
          setNeedsRead(true);
        }
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied') {
          cancelPresentation();
          onRetire(result.state);
        }
      }
    } catch {
      if (active.current) setState('uncertain');
    } finally {
      commandBusy.current = false;
    }
  }

  const failureText = (failure: string) => {
    switch (failure) {
      case 'conflict':
        return m.knowledge_publication_conflict({}, options);
      case 'uncertain':
        return m.knowledge_publication_uncertain({}, options);
      case 'not-found':
        return m.knowledge_private_not_found({}, options);
      case 'denied':
        return m.knowledge_private_denied({}, options);
      case 'unknown':
      case 'preparing':
        return m.knowledge_private_preparing({}, options);
      default:
        return m.knowledge_publication_unavailable({}, options);
    }
  };
  const canReview = admission === 'available' && !blocked && !unresolved && !reading && !needsRead;
  const failure = !['idle', 'pending', 'acknowledged'].includes(state);
  const commandMessage =
    state === 'pending'
      ? m.knowledge_publication_pending({}, options)
      : failure
        ? failureText(state)
        : currentReceipt
          ? currentReceipt.publicationId === null
            ? m.knowledge_publication_withdrawn({}, options)
            : m.knowledge_publication_acknowledged({}, options)
          : null;
  const readMessage =
    readState === 'preparing'
      ? m.knowledge_private_readback({}, options)
      : readState === 'observed'
        ? m.knowledge_publication_observed({}, options)
        : readState === 'changed'
          ? m.knowledge_publication_changed({}, options)
          : ['unavailable', 'not-found', 'denied'].includes(readState)
            ? failureText(readState)
            : null;
  const readFailed = ['unavailable', 'not-found', 'denied'].includes(readState);
  return (
    <section
      id="knowledge-publication"
      className="min-w-0 scroll-mt-6 space-y-5 border-t border-border pt-6"
      aria-labelledby={headingId}
    >
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {m.knowledge_publication_heading({}, options)}
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.knowledge_publication_intro({}, options)}
      </p>
      {admission !== 'available' ? <p role="status">{failureText(admission)}</p> : null}
      <p
        ref={savedSourceRef}
        tabIndex={-1}
        className="text-xl font-semibold leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {head.title}
      </p>
      {commandMessage ? (
        <p
          ref={commandResultRef}
          tabIndex={-1}
          role={failure ? 'alert' : 'status'}
          className="text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {commandMessage}
        </p>
      ) : null}
      {readMessage ? (
        <p
          ref={readResultRef}
          tabIndex={-1}
          role={readFailed ? 'alert' : 'status'}
          className="text-sm leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {readMessage}
        </p>
      ) : null}
      {head.publicationId !== null && !currentReceipt ? (
        <p className="text-sm font-medium">{m.knowledge_workspace_publication_selected({}, options)}</p>
      ) : null}
      {currentReceipt ? (
        <div className="min-w-0 space-y-3">
          {currentReceipt.publicationId !== null && currentReceipt.revisionId !== null ? (
            <>
              <KnowledgeDetails label={m.knowledge_workspace_saved({}, options)}>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <KnowledgeValue
                    label={m.knowledge_publication_identity({}, options)}
                    value={currentReceipt.publicationId}
                    exact
                  />
                  <KnowledgeValue
                    label={m.knowledge_private_revision({}, options)}
                    value={currentReceipt.revisionId}
                    exact
                  />
                </dl>
              </KnowledgeDetails>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {m.knowledge_publication_public_admission({}, options)}
              </p>
              <nav
                className="flex min-w-0 flex-wrap gap-x-6 gap-y-2"
                aria-label={m.knowledge_publication_links({}, options)}
              >
                <KnowledgePublicationReaderLink
                  address={{ notebookId: head.notebookId, documentId: currentReceipt.documentId }}
                  locale={locale}
                  revisionId={currentReceipt.revisionId}
                >
                  {m.knowledge_publication_exact({}, options)}
                </KnowledgePublicationReaderLink>
                <KnowledgePublicationReaderLink
                  address={{ notebookId: head.notebookId, documentId: currentReceipt.documentId }}
                  locale={locale}
                >
                  {m.knowledge_publication_live({}, options)}
                </KnowledgePublicationReaderLink>
              </nav>
              {head.revisionId !== currentReceipt.revisionId ? (
                <p role="status">{m.knowledge_publication_new_draft({}, options)}</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {intent ? (
        <div className="min-w-0 space-y-3">
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <PublicationIdentity label={m.knowledge_private_document_id({}, options)} value={intent.documentId} />
            <PublicationIdentity
              label={m.knowledge_workspace_saved({}, options)}
              value={intent.expectedHeadRevisionId}
            />
            <PublicationIdentity
              label={m.knowledge_publication_identity({}, options)}
              value={intent.expectedPublicationId ?? '—'}
            />
            <PublicationIdentity
              label={m.knowledge_private_revision({}, options)}
              value={intent.revisionId ?? '—'}
            />
          </div>
          <p className="text-sm">
            {intent.revisionId === null
              ? m.knowledge_publication_withdraw_review({}, options)
              : m.knowledge_publication_review({}, options)}
          </p>
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={state === 'pending' || blocked || admission !== 'available'}
            onClick={(event) => void submit(true, event)}
          >
            {m.knowledge_publication_replay({}, options)}
          </Button>
        </div>
      ) : null}
      <KnowledgeDetails label={m.knowledge_workspace_saved({}, options)}>
        <dl className="grid gap-4 sm:grid-cols-2">
          <KnowledgeValue label={m.knowledge_private_revision({}, options)} value={head.revisionId} exact />
          <KnowledgeValue
            label={m.knowledge_publication_identity({}, options)}
            value={head.publicationId ?? '—'}
            exact
          />
        </dl>
      </KnowledgeDetails>
      <div className="flex min-w-0 flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={!canReview}
          onClick={(event) => begin('publish', event)}
        >
          {m.knowledge_publication_review({}, options)}
        </Button>
        {head.publicationId !== null ? (
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={!canReview}
            onClick={(event) => begin('withdraw', event)}
          >
            {m.knowledge_publication_withdraw_review({}, options)}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={reading || state === 'pending' || blocked}
          onClick={(event) => void reread(undefined, event)}
        >
          {m.knowledge_publication_reread({}, options)}
        </Button>
      </div>
      {review && !currentReview ? <p role="status">{m.knowledge_publication_changed({}, options)}</p> : null}
      {currentReview ? (
        <section className="min-w-0 space-y-4 border-t border-border pt-5" aria-labelledby={reviewId}>
          <h3
            id={reviewId}
            ref={reviewHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {currentReview.intent.revisionId === null
              ? m.knowledge_publication_withdraw_review({}, options)
              : m.knowledge_publication_review({}, options)}
          </h3>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.knowledge_publication_private_review({}, options)}
          </p>
          <p className="text-xl font-semibold leading-snug">{currentReview.head.title}</p>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <PublicationIdentity
              label={m.knowledge_private_document_id({}, options)}
              value={currentReview.intent.documentId}
            />
            <PublicationIdentity
              label={m.knowledge_private_language({}, options)}
              value={currentReview.head.language ?? '—'}
            />
            <PublicationIdentity label={m.knowledge_private_licence({}, options)} value={currentReview.head.licence} />
            <PublicationIdentity
              label={m.knowledge_workspace_saved({}, options)}
              value={currentReview.intent.expectedHeadRevisionId}
            />
            <PublicationIdentity
              label={m.knowledge_publication_identity({}, options)}
              value={currentReview.intent.expectedPublicationId ?? '—'}
            />
            <PublicationIdentity
              label={m.knowledge_private_revision({}, options)}
              value={currentReview.intent.revisionId ?? '—'}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <h4 className="font-medium">{m.knowledge_private_subject_ids({}, options)}</h4>
            <ul className="min-w-0 space-y-1">
              {currentReview.head.subjectIds.map((id) => (
                <li key={id}>
                  <a className={link} href={subjectHref({ id, label: '' }, locale).href}>
                    {id}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          {currentReview.intent.revisionId === null ? (
            <p>{m.knowledge_publication_withdraw_scope({}, options)}</p>
          ) : (
            <div className="min-w-0 max-w-prose border-t border-border pt-4">
              <KnowledgeReferenceBody
                document={currentReview.head.body}
                references={currentReview.head.references}
                locale={locale}
                mediaSelection={knowledgeAuthoringImageSelection(currentReview.head)}
                inspectable={false}
              />
            </div>
          )}
          <div className="flex min-w-0 flex-wrap gap-3">
            <Button
              type="button"
              className={control}
              disabled={!canReview}
              onClick={(event) => void submit(false, event)}
            >
              {currentReview.intent.revisionId === null
                ? m.knowledge_publication_confirm_withdraw({}, options)
                : m.knowledge_publication_confirm({}, options)}
            </Button>
            <Button type="button" variant="outline" className={control} onClick={(event) => clearReview(event)}>
              {m.editor_cancel({}, options)}
            </Button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function PublicationIdentity({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm font-medium">{label}</p>
      <p className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}

function isVisibleFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target || !target.isConnected) return false;
  if (
    target.getClientRects().length === 0 ||
    target.closest('[hidden], [inert], [aria-hidden="true"]')
  )
    return false;
  if ('disabled' in target && Boolean((target as HTMLButtonElement).disabled)) return false;
  const visibility = target.ownerDocument.defaultView?.getComputedStyle(target).visibility;
  return visibility !== 'hidden' && visibility !== 'collapse';
}
