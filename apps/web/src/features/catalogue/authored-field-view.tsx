import { useCandidateWork, type CandidateWork } from '../../subject/candidate-lifetime';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useCurrentReadingActive, useCurrentReadingVisible } from './editor-lifetime';
import { RichTextEditor } from '@rezics/ui';
import { DocumentBody } from '../../document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import type { Violation } from '@rezics/definitions/validate';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { editorLabels } from '../../threads/composer';
import { CandidateValue, pageText } from '../pages/data';
import { SpoilerGate } from '../pages/values';
import { spoilerLevel } from '../pages/shared';
import {
  EditorFailure,
  PartValue,
  StatementFields,
  StatementViolationLinks,
  type StatementFieldsRead,
} from './statement-editor-view';
import { authoredDraftHasContent, authoredState, initialAuthoredState, type AuthoredDraft } from './authored-field-state';
import { AuthoredFieldNavigation } from './authored-field-navigation';
import {
  authoredProperties,
  authoredDocumentError,
  authoredStatement,
  validateAuthored,
  type AuthoredStatement,
  type AuthoredBody,
  type AuthoredRead,
  type AuthoredTransport,
} from './authored-field';
import { presentStatementViolations, type StatementFeedback } from './statement-validation-presentation';
import type { StatementInput } from './statement-editor';

// Match the caller-level phone targets while retaining dense fine-pointer desktop controls.
const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-w-0 min-h-11 md:pointer-fine:min-h-8';
// NativeSelect puts className on the wrapper, so size its actual native control as well.
const selectClassName = 'min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const labelClassName = 'min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 text-primary underline underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const summaryClassName =
  'min-h-11 min-w-11 cursor-pointer py-3 text-sm [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const useFocusLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

type ReadRecoveryFocus = {
  opener: HTMLButtonElement;
  label: string;
  generation: number;
  reviewDraft: boolean;
  completed: boolean;
  cancel: () => void;
};

type DiscardQuestion = { property: string; draft: AuthoredDraft; editor: number; keyboard: boolean };

function Provenance({ body, locale }: { body: AuthoredBody | null | undefined; locale: string }) {
  if (!body?.ok || body.document.availability !== 'available' || !body.document.body) return null;
  const o = { locale: locale as never };
  const document = body.document;
  return (
    <div className="space-y-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
      <p>
        {m.authored_language({}, o)}: {document.language}
      </p>
      <p>
        {m.authored_licence({}, o)}:{' '}
        {'origin' in document && document.origin === 'account'
          ? document.licence
          : 'rights' in document
            ? document.rights.license
            : ''}
      </p>
      {'rights' in document && <p>{document.rights.attribution}</p>}
    </div>
  );
}

function Body({
  body,
  locale,
  includeProvenance = true,
}: {
  body: AuthoredBody | null | undefined;
  locale: string;
  includeProvenance?: boolean;
}) {
  const o = { locale: locale as never };
  if (!body?.ok || body.document.availability !== 'available' || !body.document.body)
    return <p role="status">{m.authored_body_unavailable({}, o)}</p>;
  const document = body.document;
  return (
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <div lang={document.language}>
        <DocumentBody
          document={document.body!}
          locale={locale}
          labels={{ revealSpoiler: m.thread_reveal_spoiler({}, o) }}
        />
      </div>
      {includeProvenance && <Provenance body={body} locale={locale} />}
    </div>
  );
}

type PreparedReview = { subject: string; property: string; statement: AuthoredStatement; original: true };
type AuthoredCurrent = Extract<AuthoredRead, { ok: true }>;

function selectedLanguage(current: AuthoredCurrent): string | undefined {
  const content = current.selected?.value.type === 'value' ? current.selected.value.content : undefined;
  return content && typeof content === 'object' && 'language' in content && typeof content.language === 'string'
    ? content.language
    : undefined;
}

function DraftReviewCard({
  prepared,
  current,
  locale,
  heading,
}: {
  prepared: PreparedReview;
  current: AuthoredCurrent;
  locale: string;
  heading: string;
}) {
  const o = { locale: locale as never };
  const content = (prepared.statement.value as {
    type: 'value';
    content: { document: AuthoredDraft['document']; language: string; licence: string };
  }).content;
  const documentError = authoredDocumentError(content.document);
  const property = current.release.properties[prepared.property];
  const read: StatementFieldsRead = {
    release: current.release,
    source: current.selected,
    public: { related: current.public.related, subject: { type: current.public.subject.type } },
  };
  return (
    <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
      <ContentItemHeading className="text-lg font-semibold">{heading}</ContentItemHeading>
      <p className="text-sm text-muted-foreground">{m.authored_local_preview({}, o)}</p>
      <p className="font-medium">
        {m.candidate_field({}, o)}: {pageText(property?.labels, locale).text || m.subject_value_unlabelled({}, o)}
      </p>
      {documentError ? (
        <p role="alert">{m.authored_preview_unavailable({}, o)}</p>
      ) : (
        <div lang={content.language}>
          <DocumentBody
            document={content.document}
            locale={locale}
            labels={{ revealSpoiler: m.thread_reveal_spoiler({}, o) }}
          />
        </div>
      )}
      <section aria-label={m.authored_contribution_details({}, o)} className="space-y-2 text-sm">
        <h3 className="font-semibold">{m.authored_contribution_details({}, o)}</h3>
        <p>
          {m.authored_language({}, o)}: {content.language}
        </p>
        <p>
          {m.authored_licence({}, o)}: {content.licence}
        </p>
        <p>{m.authored_original({}, o)}</p>
      </section>
      <section aria-label={m.authored_evidence({}, o)} className="space-y-3">
        <h3 className="font-semibold">{m.authored_evidence({}, o)}</h3>
        {prepared.statement.references.length ? (
          <ol className="min-w-0 space-y-3">
            {prepared.statement.references.map((reference, referenceIndex) => (
              <li key={referenceIndex} className="min-w-0 border-s-2 border-border ps-3">
                <p className="text-sm font-medium">{m.correction_references({}, o)} {referenceIndex + 1}</p>
                {reference.parts.length ? (
                  <ol className="min-w-0 space-y-2">
                    {reference.parts.map((part, partIndex) => (
                      <li key={partIndex} className="min-w-0">
                        <p className="text-sm text-muted-foreground">
                          {pageText(current.release.properties[part.property.id]?.labels, locale).text ||
                            m.subject_value_unlabelled({}, o)}
                        </p>
                        <PartValue part={part} read={read} locale={locale} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>{m.authored_no_citations({}, o)}</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p>{m.authored_no_citations({}, o)}</p>
        )}
      </section>
    </ContentItemFrame>
  );
}

/**
 * Always composes a new original work; existing rich documents and candidates remain intact.
 *
 * Cost: render the supplied authored form and readback.
 * - Touches: supplied bodies, citations and the active type's field choices; no presentation I/O.
 * - Bound: O(supplied text/citations/fields), with one unconditional form identity and fixed DOM associations.
 * - Growth check: authored-field-family.test.tsx supplies three citation/unrelated-definition scales (UNRUN).
 */
export function AuthoredField(props: Omit<ComponentProps<typeof AuthoredFieldLive>, 'work'>) {
  const subject = useRef<string | undefined>(undefined);
  if (props.initial.ok) subject.current = props.initial.public.subject.id;
  const mount = useCandidateWork(JSON.stringify([subject.current, props.locale]), props.transport.reader);
  const active = useCurrentReadingActive();
  const work = useMemo(() => ({ ...mount, live: () => mount.live() && active() }), [mount, active]);
  if (!mount.live()) return null;
  return <AuthoredFieldLive key={mount.generation} {...props} work={work} />;
}

function AuthoredFieldLive({
  initial,
  locale,
  transport,
  confirm,
  work,
}: {
  work: CandidateWork;
  initial: AuthoredRead;
  locale: string;
  transport: AuthoredTransport;
  confirm: CandidateTransport['confirm'];
}) {
  const formId = useId();
  const ids = {
    property: `${formId}-property`,
    document: `${formId}-document`,
    language: `${formId}-language`,
    licence: `${formId}-licence`,
    evidence: `${formId}-evidence`,
    original: `${formId}-original`,
    draft: `${formId}-draft`,
    draftHint: `${formId}-draft-hint`,
    errors: `${formId}-errors`,
    failure: `${formId}-failure`,
    discard: `${formId}-discard`,
  };
  const visible = useCurrentReadingVisible();
  const o = { locale: locale as never };
  const [metadata, setMetadata] = useState(initial);
  const [current, setCurrent] = useState(initial.ok ? initial : undefined);
  const [{ drafts, command, proposed, failure: submissionFailure }, dispatch] = useReducer(
    authoredState,
    initial,
    initialAuthoredState,
  );
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readFailure, setReadFailure] = useState(initial.ok ? undefined : initial.reason);
  const [errors, setErrors] = useState<Violation[]>([]);
  const [stage, setStage] = useState<'compose' | 'preview' | 'review'>('compose');
  const [prepared, setPrepared] = useState<PreparedReview>();
  const preparedReview = useRef<PreparedReview | undefined>(undefined);
  const [reviewing, setReviewing] = useState(false);
  const [proposalBody, setProposalBody] = useState<AuthoredBody | null>();
  const [comparisonCurrent, setComparisonCurrent] = useState<Extract<AuthoredRead, { ok: true }>>();
  const [discarding, setDiscarding] = useState<DiscardQuestion>();
  const discardQuestion = useRef<DiscardQuestion | undefined>(undefined);
  const discardGroup = useRef<HTMLDivElement>(null);
  const focusEditor = useRef(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorGeneration = useRef(0);
  const discardButton = useRef<HTMLButtonElement>(null);
  const readRecoveryFocus = useRef<ReadRecoveryFocus | null>(null);
  const selectedBoundary = useRef<HTMLElement>(null);
  const emptyBoundary = useRef<HTMLParagraphElement>(null);
  const draftBoundary = useRef<HTMLFormElement>(null);
  const compositionFocus = useRef<HTMLElement | null>(null);
  const restoreCompositionFocus = useRef(false);
  const readFailureBoundary = useRef<HTMLParagraphElement>(null);
  const running = useRef(false);
  const session = useRef(initial.ok ? initial.session : undefined);
  const requestedProperty = useRef(initial.ok ? initial.property : '');
  const readGeneration = useRef(0);
  const comparisonGeneration = useRef(0);
  const readVersion = readGeneration.current;
  const comparisonVersion = comparisonGeneration.current;
  const readingLive = () => work.live() && readGeneration.current === readVersion;
  const comparisonLive = () => work.live() && comparisonGeneration.current === comparisonVersion;
  function retireDiscard() {
    discardQuestion.current = undefined;
    setDiscarding(undefined);
  }
  function clearReadRecoveryFocus(focus = readRecoveryFocus.current) {
    if (!focus) return;
    focus.cancel();
    if (readRecoveryFocus.current === focus) readRecoveryFocus.current = null;
  }
  function noteReadRecovery(event: ReactMouseEvent<HTMLButtonElement>, reviewDraft: boolean) {
    clearReadRecoveryFocus();
    const opener = event.currentTarget;
    const document = opener.ownerDocument;
    if (event.detail !== 0 || document.activeElement !== opener || !opener.isConnected) return undefined;
    let focus: ReadRecoveryFocus;
    const cancel = () => {
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', tabbed, true);
      document.defaultView?.removeEventListener('blur', cancel);
      if (readRecoveryFocus.current === focus) readRecoveryFocus.current = null;
    };
    const moved = (change: FocusEvent) => {
      const lostToPage = change.target === document.body || change.target === document.documentElement;
      if (change.target !== opener && !(lostToPage && (!opener.isConnected || opener.matches(':disabled'))))
        clearReadRecoveryFocus(focus);
    };
    const tabbed = (key: KeyboardEvent) => {
      if (key.key === 'Tab') clearReadRecoveryFocus(focus);
    };
    focus = {
      opener,
      label: opener.getAttribute('aria-label') ?? opener.textContent?.trim() ?? '',
      generation: -1,
      reviewDraft,
      completed: false,
      cancel,
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', tabbed, true);
    document.defaultView?.addEventListener('blur', cancel);
    readRecoveryFocus.current = focus;
    return focus;
  }
  useFocusLayoutEffect(() => () => clearReadRecoveryFocus(), []);
  useFocusLayoutEffect(() => {
    const focus = readRecoveryFocus.current;
    if (!focus) return;
    if (!work.live() || focus.generation !== readGeneration.current) {
      clearReadRecoveryFocus(focus);
      return;
    }
    if (busy || !focus.completed) return;
    const document = focus.opener.ownerDocument;
    const active = document.activeElement;
    if (active !== focus.opener && active !== document.body && active !== document.documentElement) {
      clearReadRecoveryFocus(focus);
      return;
    }
    const openerLabel = focus.opener.getAttribute('aria-label') ?? focus.opener.textContent?.trim() ?? '';
    const openerSurvives = focus.opener.isConnected && !focus.opener.disabled && openerLabel === focus.label;
    clearReadRecoveryFocus(focus);
    if (openerSurvives) {
      if (active !== focus.opener) focus.opener.focus();
      return;
    }
    (
      readFailureBoundary.current ??
      (focus.reviewDraft ? draftBoundary.current : selectedBoundary.current) ??
      emptyBoundary.current
    )?.focus();
  }, [busy, current, readFailure, work, ids.failure]);
  useFocusLayoutEffect(() => {
    if (stage !== 'compose' || !restoreCompositionFocus.current) return;
    restoreCompositionFocus.current = false;
    const previous = compositionFocus.current;
    if (previous?.isConnected && !previous.matches(':disabled, [hidden], [inert]')) {
      previous.focus();
      return;
    }
    draftBoundary.current?.querySelector<HTMLElement>('.ProseMirror')?.focus();
  }, [stage]);
  function retireReading(retireComparison = true, keepFocus?: ReadRecoveryFocus) {
    retireDiscard();
    focusEditor.current = false;
    preparedReview.current = undefined;
    setPrepared(undefined);
    setStage('compose');
    if (readRecoveryFocus.current !== keepFocus) clearReadRecoveryFocus();
    const generation = ++readGeneration.current;
    setCurrent(undefined);
    if (retireComparison) {
      comparisonGeneration.current++;
      setComparisonCurrent(undefined);
      setProposalBody(undefined);
    }
    return () => work.live() && readGeneration.current === generation;
  }
  useEffect(() => {
    if (work.live() && initial.ok) session.current = initial.session ?? session.current;
  }, [initial]);
  // A metadata refresh replaces read authority without remounting or discarding the submission state.
  if (metadata !== initial) {
    retireReading();
    running.current = false;
    setBusy(false);
    setReading(false);
    if (command) dispatch({ type: 'result', result: { ok: false, reason: 'unavailable' } });
    setMetadata(initial);
    setCurrent(initial.ok ? initial : undefined);
    setReadFailure(initial.ok ? undefined : initial.reason);
    dispatch({ type: 'read', read: initial, reviewDraft: false });
  }
  const wasVisible = useRef(visible);
  const resumeRead = useRef(false);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    if (!visible) {
      retireReading();
      resumeRead.current = true;
      running.current = false;
      setBusy(false);
      setReading(false);
      setCurrent(undefined);
      setProposalBody(undefined);
      setReviewing(false);
      // A retired completion cannot settle a sealed command. Retain its exact retry.
      if (command) dispatch({ type: 'result', result: { ok: false, reason: 'unavailable' } });
    }
  }
  useEffect(() => {
    if (!visible || !resumeRead.current) return;
    resumeRead.current = false;
    void refresh(requestedProperty.current, false, true);
  }, [visible]);
  const property = current?.property ?? requestedProperty.current;
  const draft = drafts[property];
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const failure = submissionFailure ?? (!current ? 'unavailable' : undefined);
  const proposalSelected =
    !!proposed &&
    !busy &&
    !failure &&
    current?.public.subject.statements[property]?.some(
      (statement) =>
        statement.id === proposed.candidate &&
        statement.property.id === property &&
        (statement.rank === 'normal' || statement.rank === 'preferred'),
    );
  const locked = busy || !!command || !!proposed || !current || failure === 'denied';
  const canDiscard = !locked && failure !== 'stale' && !!draft;
  const confirmingDiscard = canDiscard && discarding?.property === property && discarding.draft === draft;
  const title = current ? pageText(current.public.subject.labels, locale).text : '';
  const comparisonReading = comparisonCurrent ?? current;
  const id = comparisonReading?.public.subject.id;
  const update = (change: Partial<AuthoredDraft>) => {
    if (
      !readingLive() ||
      locked ||
      confirmingDiscard ||
      running.current ||
      !draft ||
      editorGeneration.current !== editorVersion
    )
      return;
    retireDiscard();
    if (stage !== 'compose') restoreCompositionFocus.current = true;
    preparedReview.current = undefined;
    setPrepared(undefined);
    setStage('compose');
    currentDraft.current = undefined;
    dispatch({ type: 'edit', property, change });
    setErrors([]);
  };
  function questionLive(question: DiscardQuestion | undefined): question is DiscardQuestion {
    return (
      !!question &&
      discardQuestion.current === question &&
      readingLive() &&
      canDiscard &&
      !running.current &&
      currentDraft.current === question.draft &&
      editorGeneration.current === question.editor
    );
  }
  function questionFocused() {
    return !!discardGroup.current?.contains(discardGroup.current.ownerDocument.activeElement);
  }
  function discard(question: DiscardQuestion | undefined, keyboard: boolean) {
    if (!questionLive(question)) return;
    focusEditor.current =
      keyboard && (questionFocused() || discardButton.current?.ownerDocument.activeElement === discardButton.current);
    // Consume synchronously: callbacks retained by this question cannot act again before React commits.
    retireDiscard();
    dispatch({ type: 'discard', property: question.property });
    setErrors([]);
    // Remount the composer to clear undo history and retire delayed emissions from the discarded editor.
    setEditorVersion(++editorGeneration.current);
  }
  function cancelDiscard(question: DiscardQuestion | undefined, keyboard: boolean) {
    if (!questionLive(question)) return;
    const restoreFocus = keyboard && questionFocused();
    retireDiscard();
    if (restoreFocus) discardButton.current?.focus();
  }
  function requestDiscard(keyboard: boolean) {
    if (
      !readingLive() ||
      !canDiscard ||
      running.current ||
      !draft ||
      currentDraft.current !== draft ||
      editorGeneration.current !== editorVersion
    )
      return;
    const question = {
      property,
      draft,
      editor: editorVersion,
      keyboard: keyboard && discardButton.current?.ownerDocument.activeElement === discardButton.current,
    };
    discardQuestion.current = question;
    if (
      authoredDraftHasContent(draft)
    )
      setDiscarding(question);
    else discard(question, keyboard);
  }

  function returnToCompose() {
    preparedReview.current = undefined;
    setPrepared(undefined);
    restoreCompositionFocus.current = true;
    setStage('compose');
  }

  function returnToPreview() {
    if (!preparedReview.current || !readingLive()) return;
    setStage('preview');
  }

  function preparePreview() {
    if (!readingLive() || running.current || proposed || !current || !draft || !property || locked) return;
    const statement = authoredStatement(property, draft.document, draft.language, draft.licence, draft.references);
    const violations = validateAuthored(statement, current.release);
    if (!draft.original) violations.push({ pointer: '/original', code: 'required' });
    setErrors(violations);
    if (violations.length) {
      preparedReview.current = undefined;
      setPrepared(undefined);
      setStage('compose');
      return;
    }
    const next: PreparedReview = {
      subject: current.public.subject.id,
      property,
      statement: structuredClone(statement),
      original: true,
    };
    preparedReview.current = next;
    setPrepared(next);
    setStage('preview');
  }

  async function refresh(
    nextProperty = property,
    reviewDraft = false,
    readingOnly = false,
    origin: CandidateWork = work,
    focus?: ReadRecoveryFocus,
  ) {
    if (!readingLive() || !origin.live() || running.current || (command && !reviewDraft && !readingOnly)) {
      clearReadRecoveryFocus(focus);
      return;
    }
    const live = retireReading(!readingOnly, focus);
    if (focus) focus.generation = readGeneration.current;
    // The owner now holds recovery; retiring its child comparison must not cancel this read.
    const readWork = { reader: origin.reader, live };
    requestedProperty.current = nextProperty;
    running.current = true;
    setBusy(true);
    setReading(true);
    setReadFailure(undefined);
    try {
      // Decision recovery refreshes both authorities. The current-text action reads only the
      // public text and leaves an independently authorized comparison intact while it remains readable.
      const comparison =
        !readingOnly && proposed && reviewing && nextProperty === property
          ? await transport.review(property, proposed.candidate, undefined, session.current, readWork)
          : undefined;
      if (!readWork.live()) return;
      const next: AuthoredRead = comparison
        ? (comparison.current ??
          (comparison.comparison.ok ? { ok: false, reason: 'unavailable' } : comparison.comparison))
        : await transport.read(nextProperty || undefined, session.current);
      if (!readWork.live()) return;
      if (comparison) {
        setComparisonCurrent(comparison.current);
        setProposalBody(comparison.body);
        if (comparison.comparison.ok) session.current = comparison.comparison.session ?? session.current;
      }
      dispatch({ type: 'read', read: next, reviewDraft });
      setReadFailure(next.ok ? undefined : next.reason);
      if (!next.ok) {
        comparisonGeneration.current++;
        setComparisonCurrent(undefined);
        setCurrent(undefined);
        setProposalBody(undefined);
        setReviewing(false);
      } else {
        setCurrent(next);
        session.current = next.session ?? session.current;
      }
    } catch {
      if (!readWork.live()) return;
      comparisonGeneration.current++;
      setComparisonCurrent(undefined);
      setCurrent(undefined);
      setProposalBody(undefined);
      setReviewing(false);
      setReadFailure('unavailable');
      dispatch({ type: 'read', read: { ok: false, reason: 'unavailable' }, reviewDraft });
    } finally {
      if (!readWork.live()) return;
      if (focus && focus.generation === readGeneration.current) focus.completed = true;
      running.current = false;
      setBusy(false);
      setReading(false);
    }
  }

  async function rereadAfterDenial(origin: CandidateWork = work) {
    if (!readingLive() || !origin.live()) return;
    const live = retireReading();
    // A write denial clears private comparison data. Only a fresh public read may restore selected text.
    setCurrent(undefined);
    setProposalBody(undefined);
    setReviewing(false);
    try {
      const next = await transport.read(property || undefined, session.current);
      if (!live()) return;
      if (next.ok) {
        session.current = next.session ?? session.current;
        setCurrent(next);
      }
    } catch {
      // Keep the unavailable read empty; neither the draft nor the previous body is a fallback.
    } finally {
      if (live()) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  async function submit() {
    if (
      !readingLive() ||
      running.current ||
      proposed ||
      !current ||
      !draft ||
      failure === 'stale' ||
      discardQuestion.current ||
      failure === 'denied'
    )
      return;
    let request = command;
    if (!request) {
      const prepared = preparedReview.current;
      if (
        stage !== 'review' ||
        !prepared ||
        prepared.subject !== current.public.subject.id ||
        prepared.property !== property
      )
        return;
      request = {
        id: prepared.subject,
        key: crypto.randomUUID(),
        statement: structuredClone(prepared.statement),
        ...(session.current ? { session: session.current } : {}),
      };
    }
    running.current = true;
    setBusy(true);
    setReadFailure(undefined);
    dispatch({ type: 'submit', command: request });
    try {
      const result = await transport.propose(request);
      if (!readingLive()) return;
      dispatch({ type: 'result', result });
      if (result.ok) {
        session.current = result.session ?? session.current;
      } else {
        if (result.reason === 'denied') await rereadAfterDenial();
      }
    } catch {
      if (!readingLive()) return;
      dispatch({ type: 'result', result: { ok: false, reason: 'unavailable' } });
    } finally {
      if (!readingLive()) return;
      running.current = false;
      setBusy(false);
    }
  }

  const errorField = (error: Violation) =>
    error.pointer === '/original'
      ? 'original'
      : error.pointer.includes('/language')
        ? 'language'
        : error.pointer.includes('/licence')
          ? 'licence'
          : error.pointer.includes('/references')
          ? 'evidence'
            : 'document';
  const labels = {
    original: m.authored_original({}, o),
    language: m.authored_language({}, o),
    licence: m.authored_licence({}, o),
    evidence: m.authored_evidence({}, o),
    document: m.authored_text({}, o),
  };
  const statementDraft: StatementInput | undefined = current && property && draft
    ? {
        property: { id: property },
        value: {
          type: 'value',
          content: { document: draft.document, language: draft.language, licence: draft.licence },
        },
        references: draft.references,
        qualifiers: [],
        rank: 'normal',
      }
    : undefined;
  const fieldsRead: StatementFieldsRead | undefined = current
    ? {
        release: current.release,
        source: current.selected,
        public: { related: current.public.related, subject: { type: current.public.subject.type } },
      }
    : undefined;
  const evidenceFeedback: StatementFeedback = {
    id: ids.evidence,
    errors:
      statementDraft && current
        ? presentStatementViolations(
            errors
              .filter((error) => errorField(error) === 'evidence')
              .map((error) => ({
                ...error,
                pointer: error.pointer.startsWith('/statement') ? error.pointer : `/statement${error.pointer}`,
              })),
            statementDraft,
            current.release,
            locale,
            ids.evidence,
          )
        : [],
  };
  const review: CandidateTransport = {
    reader: work.reader,
    read: async (field, cursor, continuity, origin = work) => {
      if (!readingLive() || !comparisonLive() || !origin.live()) return { ok: false, reason: 'denied' };
      if (!proposed || !id || field !== property) return { ok: false, reason: 'invalid' };
      setProposalBody(undefined);
      const result = await transport.review(property, proposed.candidate, cursor, continuity ?? session.current, {
        reader: origin.reader,
        live: () => comparisonLive() && origin.live(),
      });
      if (!comparisonLive() || !origin.live()) return { ok: false, reason: 'denied' };
      if (result.comparison.ok) session.current = result.comparison.session ?? session.current;
      if (readingLive() && result.current) setCurrent(result.current);
      setComparisonCurrent(result.current);
      setProposalBody(result.body);
      return result.comparison;
    },
    confirm: async (input, origin = work) => {
      if (!readingLive() || !comparisonLive() || !origin.live() || running.current)
        return { ok: false, reason: 'denied' };
      const result = await confirm(input, { reader: origin.reader, live: () => readingLive() && origin.live() });
      if (!readingLive() || !comparisonLive() || !origin.live()) return { ok: false, reason: 'unavailable' };
      setProposalBody(undefined);
      if (result.ok) {
        session.current = result.session ?? session.current;
        // Read the actual public statement and its authorized body, never the submission or decision receipt.
        await refresh(property, false, false, origin);
      } else if (result.reason === 'denied') {
        dispatch({ type: 'denied' });
        await rereadAfterDenial(origin);
      }
      return result;
    },
  };
  // Keep the private navigation holder mounted when the public reading retires.
  const navigation = (
    <AuthoredFieldNavigation drafts={drafts} pending={!!command || (busy && !reading)} confirmed={!!proposed} />
  );
  if (!visible) return <article>{navigation}</article>;
  const selectedContent = current?.selected && (
    <>
      <Body body={current.body} locale={locale} includeProvenance={false} />
      <details>
        <summary className={summaryClassName}>{m.authored_current_citations({}, o)}</summary>
        <div className="min-w-0 py-2 [overflow-wrap:anywhere] [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:py-2 [&_a]:whitespace-normal [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring">
          {current.selected.references.length ? (
            <ul className="min-w-0 space-y-2">
              {current.selected.references.map((reference, index) => (
                <ContentItem
                  key={index}
                  title={m.authored_citation({}, o)}
                  headingLevel={3}
                  preview={reference.parts.map((part, index) => (
                    <div key={index} className="min-w-0">
                      <CandidateValue snak={part} related={current.public.related} locale={locale} />
                    </div>
                  ))}
                />
              ))}
            </ul>
          ) : (
            <p>{m.authored_no_citations({}, o)}</p>
          )}
        </div>
      </details>
    </>
  );
  const selectedHeading = stage === 'compose' ? m.authored_selected({}, o) : m.authored_current_comparison({}, o);
  const selectedSection = current && (
    <section ref={selectedBoundary} aria-label={selectedHeading} tabIndex={-1}>
      <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
        <ContentItemHeading className="text-lg font-semibold">{selectedHeading}</ContentItemHeading>
        {current.selected ? (
          spoilerLevel(current.selected) > 0 ? (
            <SpoilerGate label={m.thread_reveal_spoiler({}, o)}>{selectedContent}</SpoilerGate>
          ) : (
            selectedContent
          )
        ) : (
          <p>{m.authored_no_selected({}, o)}</p>
        )}
        {current.selected && (
          <p className="text-sm text-muted-foreground">
            {m.authored_language({}, o)}: {selectedLanguage(current) ?? m.authored_body_unavailable({}, o)}
          </p>
        )}
        {current.selected && <Provenance body={current.body} locale={locale} />}
        <Button
          variant="outline"
          className={actionClassName}
          disabled={busy || !!command || confirmingDiscard}
          onClick={(event) => {
            const focus = noteReadRecovery(event, false);
            void refresh(property, false, true, work, focus);
          }}
        >
          {m.authored_reload_current_text({}, o)}
        </Button>
      </ContentItemFrame>
    </section>
  );
  const stageNavigation = (
    <nav aria-label={m.authored_steps({}, o)}>
      <ol className="flex flex-wrap gap-2">
        <li>
          <Button
            data-authored-step
            type="button"
            variant={stage === 'compose' ? 'default' : 'outline'}
            className={actionClassName}
            aria-current={stage === 'compose' ? 'step' : undefined}
            disabled={stage === 'compose'}
            onClick={returnToCompose}
          >
            {m.authored_compose_step({}, o)}
          </Button>
        </li>
        <li>
          <Button
            data-authored-step
            type="button"
            variant={stage === 'preview' ? 'default' : 'outline'}
            className={actionClassName}
            aria-current={stage === 'preview' ? 'step' : undefined}
            disabled={!prepared || stage === 'preview'}
            onClick={() => preparedReview.current && readingLive() && setStage('preview')}
          >
            {m.authored_preview_step({}, o)}
          </Button>
        </li>
        <li>
          <Button
            data-authored-step
            type="button"
            variant={stage === 'review' ? 'default' : 'outline'}
            className={actionClassName}
            aria-current={stage === 'review' ? 'step' : undefined}
            disabled={!prepared || stage === 'review'}
            onClick={() => preparedReview.current && readingLive() && setStage('review')}
          >
            {m.authored_review_step({}, o)}
          </Button>
        </li>
      </ol>
    </nav>
  );

  return (
    <article className="mx-auto min-w-0 w-full max-w-4xl space-y-6 p-4 [overflow-wrap:anywhere] sm:p-6">
      {navigation}
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.authored_title({}, o)}</h1>
        {current && (
          <p>
            <a
              className={linkClassName}
              href={subjectHref({ id: current.public.subject.id, label: title }, locale).href}
            >
              {title || m.subject_value_unlabelled({}, o)}
            </a>
            <span className="ml-3 text-sm text-muted-foreground">
              {pageText(current.release.types[current.public.subject.type]?.labels, locale).text}
            </span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{m.authored_intro({}, o)}</p>
      </header>
      {stageNavigation}
      {failure && (
        <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
          {readFailure && !command ? (
            <p id={ids.failure} ref={readFailureBoundary} role="alert" tabIndex={-1}>
              {readFailure === 'denied'
                ? m.catalogue_result_read_denied({}, o)
                : m.catalogue_result_read_unavailable({}, o)}
            </p>
          ) : (
            <EditorFailure reason={failure} locale={locale} id={ids.failure} tabIndex={-1} />
          )}
          <Button
            variant="outline"
            className={actionClassName}
            disabled={busy}
            onClick={(event) => {
              if (command && failure === 'unavailable' && current) void submit();
              else {
                const reviewDraft = failure === 'stale';
                const focus = noteReadRecovery(event, reviewDraft);
                void refresh(property, reviewDraft, !!readFailure || !current, work, focus);
              }
            }}
          >
            {command && failure === 'unavailable' && current
              ? m.correction_retry({}, o)
              : !current || (readFailure && !command)
                ? m.catalogue_retry_loading_result({}, o)
                : failure === 'stale'
                  ? m.authored_review_draft({}, o)
                  : m.correction_reload({}, o)}
          </Button>
        </ContentItemFrame>
      )}
      {busy && <p role="status">{reading ? m.candidate_loading({}, o) : m.correction_saving({}, o)}</p>}
      {proposed && !current && <p role="status">{m.authored_submitted({}, o)}</p>}
      {current && !property && (
        <p ref={emptyBoundary} tabIndex={-1}>
          {m.authored_empty({}, o)}
        </p>
      )}
      {current && property && stage === 'compose' && (
        <>
          <Field>
            <FieldLabel htmlFor={ids.property} className={labelClassName}>
              {m.candidate_field({}, o)}
            </FieldLabel>
            <NativeSelect
              id={ids.property}
              className={selectClassName}
              value={property}
              disabled={locked || confirmingDiscard}
              onChange={(event) => void refresh(event.target.value)}
            >
              {authoredProperties(current.release, current.public.subject.type).map((id) => (
                <NativeSelectOption key={id} value={id}>
                  {pageText(current.release.properties[id]!.labels, locale).text}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {selectedSection}
        </>
      )}
      {(current || command || comparisonCurrent) && property && (
        <>
          {(current || command) && draft && failure !== 'denied' && (
            <form
              ref={draftBoundary}
              className="min-w-0"
              hidden={stage !== 'compose'}
              aria-labelledby={ids.draft}
              aria-describedby={ids.draftHint}
              aria-busy={busy}
              tabIndex={-1}
              onFocusCapture={(event) => {
                const target = event.target;
                if (target instanceof HTMLElement && !target.closest('[data-authored-step]'))
                  compositionFocus.current = target;
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (stage === 'compose') preparePreview();
                else if (stage === 'review') void submit();
              }}
            >
              <ContentItemFrame as="div" className="min-w-0 p-4">
                <FieldSet disabled={locked || confirmingDiscard || stage !== 'compose'} className="min-w-0 gap-4">
                  <FieldLegend className="mb-0 max-w-full">
                    <ContentItemHeading id={ids.draft} className="text-lg font-semibold">
                      {m.authored_replacement({}, o)}
                    </ContentItemHeading>
                  </FieldLegend>
                  <FieldDescription id={ids.draftHint}>{m.authored_preserved({}, o)}</FieldDescription>
                  {errors.length > 0 && (
                    <FieldError id={ids.errors} className="space-y-2">
                      <p>{m.authored_invalid({}, o)}</p>
                      {errors.some((error) => errorField(error) === 'document') && (
                        <p>{m.authored_preview_unavailable({}, o)}</p>
                      )}
                      <ul>
                        {[...new Set(errors.map(errorField))].map((field) => (
                          <li key={field} id={`${ids[field]}-error`}>
                            <a className={linkClassName} href={`#${ids[field]}`}>
                              {labels[field]}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </FieldError>
                  )}
                  <Field
                    id={ids.document}
                    tabIndex={-1}
                    aria-label={labels.document}
                    aria-invalid={errors.some((error) => errorField(error) === 'document')}
                    aria-describedby={
                      errors.some((error) => errorField(error) === 'document') ? `${ids.document}-error` : undefined
                    }
                    className="min-w-0 scroll-mt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <RichTextEditor
                      key={`${property}:${editorVersion}`}
                      autoFocus={focusEditor.current}
                      value={draft.document}
                      label={labels.document}
                      labels={editorLabels()}
                      disabled={locked || confirmingDiscard}
                      onChange={(document) => update({ document })}
                      {...(draft.language ? { lang: draft.language } : {})}
                    />
                  </Field>
                  <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={ids.language} className={labelClassName}>
                        {labels.language}
                      </FieldLabel>
                      <Input
                        id={ids.language}
                        className={inputClassName}
                        value={draft.language}
                        maxLength={128}
                        disabled={locked}
                        aria-invalid={errors.some((error) => errorField(error) === 'language')}
                        aria-describedby={`${ids.language}-hint${errors.some((error) => errorField(error) === 'language') ? ` ${ids.language}-error` : ''}`}
                        placeholder="en"
                        onChange={(event) => update({ language: event.target.value })}
                      />
                      <FieldDescription id={`${ids.language}-hint`}>{m.authored_language_hint({}, o)}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={ids.licence} className={labelClassName}>
                        {labels.licence}
                      </FieldLabel>
                      <Input
                        id={ids.licence}
                        className={inputClassName}
                        value={draft.licence}
                        maxLength={128}
                        disabled={locked}
                        aria-invalid={errors.some((error) => errorField(error) === 'licence')}
                        aria-describedby={`${ids.licence}-hint${errors.some((error) => errorField(error) === 'licence') ? ` ${ids.licence}-error` : ''}`}
                        placeholder="CC-BY-4.0"
                        onChange={(event) => update({ licence: event.target.value })}
                      />
                      <FieldDescription id={`${ids.licence}-hint`}>{m.authored_licence_hint({}, o)}</FieldDescription>
                    </Field>
                  </div>
                  <div id={ids.evidence} className="min-w-0 space-y-3">
                    {evidenceFeedback.errors.length > 0 && (
                      <StatementViolationLinks feedback={evidenceFeedback} locale={locale} active={readingLive} />
                    )}
                    {statementDraft && fieldsRead && (
                      <StatementFields
                        draft={statementDraft}
                        current={fieldsRead}
                        locale={locale}
                        change={(next) => update({ references: next.references })}
                        feedback={evidenceFeedback}
                        localDraft
                        referencePartLabel={(part, referenceIndex, partIndex) =>
                          referenceIndex === 0 && partIndex === 0 && part.property.id === 'schema:url'
                            ? m.authored_citation({}, o)
                            : undefined
                        }
                        referencesOnly
                      />
                    )}
                  </div>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={ids.original}
                      className="size-11 shrink-0 md:pointer-fine:size-4"
                      aria-invalid={errors.some((error) => errorField(error) === 'original')}
                      aria-describedby={
                        errors.some((error) => errorField(error) === 'original') ? `${ids.original}-error` : undefined
                      }
                      checked={draft.original}
                      disabled={locked}
                      onCheckedChange={(checked) => update({ original: checked === true })}
                    />
                    <FieldLabel
                      htmlFor={ids.original}
                      className="min-h-11 min-w-0 max-w-full whitespace-normal break-words md:pointer-fine:min-h-0"
                    >
                      {labels.original}
                    </FieldLabel>
                  </Field>
                  <p role="status" className="text-sm text-muted-foreground">
                    {proposed
                      ? proposalSelected
                        ? m.candidate_selected({}, o)
                        : m.authored_submitted({}, o)
                      : m.authored_draft({}, o)}
                  </p>
                  {!proposed && (
                    <Button
                      data-authored-step
                      type="button"
                      className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
                      disabled={locked}
                      onClick={preparePreview}
                    >
                      {m.authored_preview_draft({}, o)}
                    </Button>
                  )}
                </FieldSet>
                {!proposed && (
                  <div className="mt-4 space-y-3">
                    <Button
                      ref={discardButton}
                      type="button"
                      variant="outline"
                      className={actionClassName}
                      disabled={!canDiscard}
                      onClick={(event) => requestDiscard(event.detail === 0)}
                    >
                      {m.authored_discard({}, o)}
                    </Button>
                    {confirmingDiscard && (
                      <div
                        ref={discardGroup}
                        role="group"
                        aria-labelledby={ids.discard}
                        className="space-y-3"
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelDiscard(discarding, true);
                          }
                        }}
                      >
                        <p id={ids.discard}>{m.authored_discard_warning({}, o)}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className={actionClassName}
                            autoFocus={discarding?.keyboard}
                            onClick={(event) => cancelDiscard(discarding, event.detail === 0)}
                          >
                            {m.authored_keep_draft({}, o)}
                          </Button>
                          <Button
                            type="button"
                            className={actionClassName}
                            onClick={(event) => discard(discarding, event.detail === 0)}
                          >
                            {m.authored_discard_confirm({}, o)}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </ContentItemFrame>
            </form>
          )}
          {prepared && current && stage === 'preview' && (
            <section aria-label={m.authored_preview_step({}, o)} className="min-w-0 space-y-4">
              <ContentItemHeading className="text-xl font-semibold">{m.authored_preview_step({}, o)}</ContentItemHeading>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <DraftReviewCard
                  prepared={prepared}
                  current={current}
                  locale={locale}
                  heading={m.authored_draft_preview({}, o)}
                />
                {selectedSection}
              </div>
              <div className="flex flex-wrap gap-3">
                <Button type="button" variant="outline" className={actionClassName} onClick={returnToCompose}>
                  {m.authored_edit_draft({}, o)}
                </Button>
                <Button
                  type="button"
                  className={actionClassName}
                  disabled={!readingLive() || !!command}
                  onClick={() => preparedReview.current && readingLive() && setStage('review')}
                >
                  {m.authored_continue_review({}, o)}
                </Button>
              </div>
            </section>
          )}
          {prepared && current && stage === 'review' && (
            <section aria-label={m.authored_review_contribution({}, o)} className="min-w-0 space-y-4">
              <ContentItemHeading className="text-xl font-semibold">
                {m.authored_review_contribution({}, o)}
              </ContentItemHeading>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <DraftReviewCard
                  prepared={prepared}
                  current={current}
                  locale={locale}
                  heading={m.authored_draft_preview({}, o)}
                />
                {selectedSection}
              </div>
              <p className="text-sm text-muted-foreground">{m.authored_submit_notice({}, o)}</p>
              {proposed && <p role="status">{m.authored_submitted({}, o)}</p>}
              <div className="flex flex-wrap gap-3">
                {!proposed && (
                  <Button type="button" variant="outline" className={actionClassName} onClick={returnToCompose}>
                    {m.authored_edit_draft({}, o)}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className={actionClassName}
                  disabled={!prepared || !readingLive()}
                  onClick={returnToPreview}
                >
                  {m.authored_back_to_preview({}, o)}
                </Button>
                {!proposed && (
                  <Button type="button" className={actionClassName} disabled={locked} onClick={() => void submit()}>
                    {command && failure === 'unavailable' ? m.correction_retry({}, o) : m.authored_submit_contribution({}, o)}
                  </Button>
                )}
              </div>
            </section>
          )}
          {proposed && id && comparisonReading && (
            <section className="space-y-4">
              {!reviewing ? (
                <Button
                  variant="outline"
                  className={actionClassName}
                  onClick={() => readingLive() && setReviewing(true)}
                >
                  {m.correction_review({}, o)}
                </Button>
              ) : (
                <>
                  {proposalBody !== undefined && (
                    <section aria-label={m.authored_candidate({}, o)}>
                      <ContentItemFrame as="div" className="min-w-0 space-y-3 p-4">
                        <ContentItemHeading className="text-lg font-semibold">
                          {m.authored_candidate({}, o)}
                        </ContentItemHeading>
                        <p className="text-sm text-muted-foreground">{m.authored_candidate_hint({}, o)}</p>
                        <Body body={proposalBody} locale={locale} />
                      </ContentItemFrame>
                    </section>
                  )}
                  <CandidateReview
                    key={comparisonVersion}
                    id={id}
                    locale={locale}
                    transport={review}
                    initialProperty={property}
                    exactCandidate={proposed.candidate}
                    documents={{
                      public: comparisonReading.body?.ok
                        ? { [comparisonReading.body.document.candidateId]: comparisonReading.body.document }
                        : {},
                      candidates: {
                        ...(comparisonReading.body?.ok
                          ? { [comparisonReading.body.document.candidateId]: comparisonReading.body.document }
                          : {}),
                        ...(proposalBody?.ok ? { [proposalBody.document.candidateId]: proposalBody.document } : {}),
                      },
                    }}
                  />
                </>
              )}
            </section>
          )}
        </>
      )}
    </article>
  );
}
