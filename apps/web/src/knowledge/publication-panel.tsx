import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { useAuthoringDeparture } from '../threads/authoring-departure';
import type { KnowledgePrivateHead } from './private-knowledge';
import type { KnowledgePrivateVisitRead } from './private-server';
import { knowledgeExactHref, knowledgeLiveHref } from './public-read';
import {
  knowledgePublicationObservation,
  reviewKnowledgePublication,
  type KnowledgePublicationBinding,
  type KnowledgePublicationIntent,
  type KnowledgePublicationReceipt,
  type KnowledgePublicationResult,
} from './publication';

type Review = ReturnType<typeof reviewKnowledgePublication>;
export type KnowledgePublicationOperations = Readonly<{
  read: (
    address: { notebookId: string; documentId: string },
    expected: Pick<KnowledgePublicationBinding, 'viewer' | 'csrfToken'>,
  ) => Promise<KnowledgePrivateVisitRead>;
  selectPublication: (intent: KnowledgePublicationIntent) => Promise<KnowledgePublicationResult>;
}>;

const control =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-2 leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const link =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal break-words py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

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
  const active = useRef(true);
  const commandBusy = useRef(false);
  const readSequence = useRef(0);
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
    };
  }, []);

  useEffect(() => {
    if (review && review.observation !== observation) setReview(null);
    if (receipt && receipt.before !== observation && receipt.value.publicationId !== head.publicationId)
      setReceipt(null);
  }, [observation, review, receipt, head.publicationId]);

  useEffect(() => {
    onBusyChange(reading || state === 'pending');
  }, [reading, state, onBusyChange]);

  function clearReview() {
    setReview(null);
  }

  function retire() {
    active.current = false;
    readSequence.current++;
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

  function begin(action: 'publish' | 'withdraw') {
    if (blocked || unresolved || reading || needsRead || admission !== 'available') return;
    if (action === 'withdraw' && head.publicationId === null) return;
    setReview(reviewKnowledgePublication(head, binding, action));
    setState('idle');
  }

  async function reread(acknowledged?: KnowledgePublicationReceipt) {
    if (!active.current) return;
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
        if (failure === 'retired' || failure === 'signed-out' || failure === 'denied') onRetire(failure);
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

  async function submit(replay: boolean) {
    if (!active.current || commandBusy.current || admission !== 'available' || blocked) return;
    const selected = replay ? intentRef.current : currentReview?.intent;
    if (!selected || (!replay && needsRead)) return;
    const before = latestObservation.current;
    intentRef.current = selected;
    setIntent(selected);
    commandBusy.current = true;
    setState('pending');
    setReview(null);
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
        if (result.state === 'retired' || result.state === 'signed-out' || result.state === 'denied')
          onRetire(result.state);
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
  return (
    <section className="min-w-0 space-y-5 border-t border-border pt-6" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-xl font-semibold leading-snug text-balance">
        {m.knowledge_publication_heading({}, options)}
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.knowledge_publication_intro({}, options)}
      </p>
      {admission !== 'available' ? <p role="status">{failureText(admission)}</p> : null}
      {currentReceipt ? (
        <div className="min-w-0 space-y-3" aria-live="polite">
          <p role="status">
            {currentReceipt.publicationId === null
              ? m.knowledge_publication_withdrawn({}, options)
              : m.knowledge_publication_acknowledged({}, options)}
          </p>
          {currentReceipt.publicationId !== null && currentReceipt.revisionId !== null ? (
            <>
              <PublicationIdentity
                label={m.knowledge_publication_identity({}, options)}
                value={currentReceipt.publicationId}
              />
              <PublicationIdentity
                label={m.knowledge_private_revision({}, options)}
                value={currentReceipt.revisionId}
              />
              <p className="text-sm leading-relaxed text-muted-foreground">
                {m.knowledge_publication_public_admission({}, options)}
              </p>
              <nav
                className="flex min-w-0 flex-wrap gap-x-6 gap-y-2"
                aria-label={m.knowledge_publication_links({}, options)}
              >
                <a
                  className={link}
                  href={knowledgeExactHref(locale, currentReceipt.documentId, currentReceipt.revisionId)}
                >
                  {m.knowledge_publication_exact({}, options)}
                </a>
                <a className={link} href={knowledgeLiveHref(locale, currentReceipt.documentId)}>
                  {m.knowledge_publication_live({}, options)}
                </a>
              </nav>
              {head.revisionId !== currentReceipt.revisionId ? (
                <p role="status">{m.knowledge_publication_new_draft({}, options)}</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {head.publicationId !== null && !currentReceipt ? (
        <PublicationIdentity label={m.knowledge_publication_identity({}, options)} value={head.publicationId} />
      ) : null}
      {failure ? <p role="alert">{failureText(state)}</p> : null}
      {state === 'pending' ? <p role="status">{m.knowledge_publication_pending({}, options)}</p> : null}
      {intent ? (
        <div className="min-w-0 space-y-3">
          <PublicationIdentity
            label={m.knowledge_private_revision({}, options)}
            value={intent.expectedHeadRevisionId}
          />
          {intent.expectedPublicationId ? (
            <PublicationIdentity
              label={m.knowledge_publication_identity({}, options)}
              value={intent.expectedPublicationId}
            />
          ) : null}
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
            onClick={() => void submit(true)}
          >
            {m.knowledge_publication_replay({}, options)}
          </Button>
        </div>
      ) : null}
      {readState === 'preparing' ? <p role="status">{m.knowledge_private_readback({}, options)}</p> : null}
      {readState === 'observed' ? <p role="status">{m.knowledge_publication_observed({}, options)}</p> : null}
      {readState === 'changed' ? <p role="status">{m.knowledge_publication_changed({}, options)}</p> : null}
      {['unavailable', 'not-found', 'denied'].includes(readState) ? <p role="alert">{failureText(readState)}</p> : null}
      <div className="flex min-w-0 flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={!canReview}
          onClick={() => begin('publish')}
        >
          {m.knowledge_publication_review({}, options)}
        </Button>
        {head.publicationId !== null ? (
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={!canReview}
            onClick={() => begin('withdraw')}
          >
            {m.knowledge_publication_withdraw_review({}, options)}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={reading || state === 'pending' || blocked}
          onClick={() => void reread()}
        >
          {m.knowledge_publication_reread({}, options)}
        </Button>
      </div>
      {review && !currentReview ? <p role="status">{m.knowledge_publication_changed({}, options)}</p> : null}
      {currentReview ? (
        <section className="min-w-0 space-y-4 border-t border-border pt-5" aria-labelledby={reviewId}>
          <h3 id={reviewId} className="text-lg font-semibold">
            {currentReview.intent.revisionId === null
              ? m.knowledge_publication_withdraw_review({}, options)
              : m.knowledge_publication_review({}, options)}
          </h3>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.knowledge_publication_private_review({}, options)}
          </p>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <PublicationIdentity
              label={m.knowledge_private_document_id({}, options)}
              value={currentReview.head.documentId}
            />
            <PublicationIdentity
              label={m.knowledge_private_document_title({}, options)}
              value={currentReview.head.title}
            />
            <PublicationIdentity
              label={m.knowledge_private_language({}, options)}
              value={currentReview.head.language ?? '—'}
            />
            <PublicationIdentity label={m.knowledge_private_licence({}, options)} value={currentReview.head.licence} />
            <PublicationIdentity
              label={m.knowledge_private_revision({}, options)}
              value={currentReview.head.revisionId}
            />
            {currentReview.head.publicationId ? (
              <PublicationIdentity
                label={m.knowledge_publication_identity({}, options)}
                value={currentReview.head.publicationId}
              />
            ) : null}
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
              <DocumentBody document={currentReview.head.body} locale={locale} />
            </div>
          )}
          <div className="flex min-w-0 flex-wrap gap-3">
            <Button type="button" className={control} disabled={!canReview} onClick={() => void submit(false)}>
              {currentReview.intent.revisionId === null
                ? m.knowledge_publication_confirm_withdraw({}, options)
                : m.knowledge_publication_confirm({}, options)}
            </Button>
            <Button type="button" variant="outline" className={control} onClick={clearReview}>
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
