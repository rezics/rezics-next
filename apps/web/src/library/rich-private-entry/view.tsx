import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../../kernel/exposure';
import type { useSession } from '../../session';
import { annotationWrite, annotationIssues, annotationDraftChanged, annotationConfirmation, annotationVersion, renewAnnotationDraft, draftOf, type AnnotationDraft, type AnnotationConfirmation, type AnnotationField } from './contract';
import { focusAnnotationEditor } from './annotation-editor';
import type { AnnotationDepartureIntent } from './annotation-departure';
import { EntryWorkspace } from './entry-workspace';
import { readPrivateEntryForSubject, savePrivateAnnotations, savePrivateSourceCorrection, type PrivateEntryCommandResult, type PrivateEntryReadResult, type SourceCorrectionCommandResult } from './server';
import type {
  PersonalEntry,
  PersonalEntryGuard,
  PersonalEntryObservation,
  PersonalEntrySourceCorrection,
} from '@rezics/client';
import type { SourceCorrectionNotice } from './source-correction-editor';
import { Button } from '@rezics/ui/shadcn/button';

type ReaderSession = ReturnType<typeof useSession>;

type AnnotationCommand = {
  subjectId: string;
  viewer: string;
  csrfToken: string;
  key: string;
  credential: string;
  body: NonNullable<ReturnType<typeof annotationWrite>>;
};

type SourceCorrectionCommand = {
  subjectId: string;
  viewer: string;
  csrfToken: string;
  credential: string;
  key: string;
  originLifetime: string;
  entryGuard: Pick<PersonalEntryGuard, 'incarnationId' | 'currentRevision'>;
  body: PersonalEntrySourceCorrection;
};

type PrivateEntryTransport = {
  read: (input: { data: { subjectId: string } }) => Promise<PrivateEntryReadResult>;
  annotations: (input: { data: AnnotationCommand }) => Promise<PrivateEntryCommandResult>;
  sourceCorrection: (input: { data: SourceCorrectionCommand }) => Promise<SourceCorrectionCommandResult>;
};
const nativeTransport: PrivateEntryTransport = {
  read: readPrivateEntryForSubject,
  annotations: savePrivateAnnotations,
  sourceCorrection: savePrivateSourceCorrection,
};
type Review = { entry: PersonalEntry; guard: PersonalEntryGuard };
const reviewVersion = annotationVersion;
type PrivateEntryProps = {
  subject: { id: string; label: string };
  session: ReaderSession;
  admitted: boolean;
  returnTo: string;
  entryGuard: PersonalEntryGuard | null;
  origin: { lifetime: string; isCurrent: () => boolean; refreshEntry: () => Promise<boolean> };
  transport?: PrivateEntryTransport;
};

export function RichPrivateEntry(props: PrivateEntryProps) {
  return (
    <PrivateEntryReview
      key={JSON.stringify([
        props.subject.id,
        props.admitted,
        props.session.state,
        props.session.state === 'signed-in' ? props.session.subject : null,
        props.session.state === 'signed-in' ? props.session.csrfToken : null,
        props.origin.lifetime,
        props.returnTo,
      ])}
      {...props}
    />
  );
}

function PrivateEntryReview({
  subject,
  session,
  admitted,
  returnTo,
  entryGuard,
  origin,
  transport = nativeTransport,
}: PrivateEntryProps) {
  const readAllowed = useOperation('library_entry.get');
  const writeAllowed = useOperation('library_entry.put');
  const queryClient = useQueryClient();
  const viewer = session.state === 'signed-in' ? session.subject : null;
  const csrfToken = session.state === 'signed-in' ? session.csrfToken : null;
  const enabled = readAllowed && admitted && viewer !== null && csrfToken !== null;
  const mounted = useRef(true);
  const retired = useRef(false);
  const generation = useRef(0);
  const current = useRef({ origin, enabled, subjectId: subject.id, viewer, entryGuard });
  current.current = { origin, enabled, subjectId: subject.id, viewer, entryGuard };
  const currentResult = () => {
    if (!current.current.origin.isCurrent()) retired.current = true;
    return mounted.current && !retired.current && current.current.enabled;
  };
  const queryKey = useMemo(
    () => ['library', 'rich-private-entry', subject.id, viewer, origin.lifetime] as const,
    [subject.id, viewer, origin.lifetime],
  );
  const query = useQuery<PrivateEntryReadResult>({
    queryKey,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const episode = generation.current;
      if (!currentResult()) throw new Error('Private entry review retired');
      const result = await transport.read({ data: { subjectId: subject.id } });
      signal.throwIfAborted();
      if (!currentResult() || episode !== generation.current) throw new Error('Private entry review retired');
      return result;
    },
  });
  const result = query.data;
  const entry =
    result?.kind === 'ready' && result.entry.subjectId === subject.id && result.viewer === viewer ? result.entry : null;
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [annotationCommand, setAnnotationCommand] = useState<AnnotationCommand | null>(null);
  const [annotationNotice, setAnnotationNotice] = useState<'conflict' | 'uncertain' | 'denied' | 'missing' | null>(
    null,
  );
  const [confirmation, setConfirmationState] = useState<AnnotationConfirmation | null>(null);
  // Invalidate synchronously so two events in the same tick cannot reuse a closed confirmation.
  const confirmationRef = useRef<AnnotationConfirmation | null>(null);
  function setConfirmation(next: AnnotationConfirmation | null) {
    confirmationRef.current = next;
    setConfirmationState(next);
  }
  const [localOutcome, setLocalOutcome] = useState<'unchanged' | 'discarded' | null>(null);
  const [savedAnnotation, setSavedAnnotation] = useState<PersonalEntry | null>(null);
  const [departure, setDeparture] = useState<AnnotationDepartureIntent | null>(null);
  const departureTrigger = useRef<HTMLElement | null>(null);
  const noteEditor = useRef<HTMLTextAreaElement>(null);
  const priorityEditor = useRef<HTMLInputElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const editorRefs = { note: noteEditor, priority: priorityEditor, review: reviewTrigger };
  const [editorFocus, setEditorFocus] = useState<AnnotationField | 'review' | 'discard' | null>(null);
  useEffect(() => {
    if (!editorFocus || confirmation) return;
    if (editorFocus === 'discard') {
      if (departureTrigger.current?.isConnected) departureTrigger.current.focus();
      else if (reviewTrigger.current && !reviewTrigger.current.disabled) reviewTrigger.current.focus();
      else noteEditor.current?.focus();
    } else if (editorFocus === 'review') reviewTrigger.current?.focus();
    else focusAnnotationEditor(editorRefs, editorFocus);
    setEditorFocus(null);
  }, [editorFocus, confirmation]);
  const [annotationRefreshing, setAnnotationRefreshing] = useState(false);
  const [conflictRefreshed, setConflictRefreshed] = useState(false);
  const annotationBusy = useRef(false);
  const [sourceEditor, setSourceEditor] = useState<string | null>(null);
  const [sourceBaseObservation, setSourceBaseObservation] = useState<PersonalEntryObservation | null>(null);
  const [sourceCommand, setSourceCommand] = useState<SourceCorrectionCommand | null>(null);
  const [sourceNotice, setSourceNotice] = useState<SourceCorrectionNotice | null>(null);
  const [sourceSavedBody, setSourceSavedBody] = useState<PersonalEntrySourceCorrection | null>(null);
  const [sourceSavedObservation, setSourceSavedObservation] = useState<PersonalEntryObservation | null>(null);
  const [sourceConflictRevision, setSourceConflictRevision] = useState<number | null>(null);
  const [privateAuthorityRetired, setPrivateAuthorityRetired] = useState(false);
  const [retirementKind, setRetirementKind] = useState<'account' | 'entry' | 'exposure' | null>(null);
  const sourceBusy = useRef(false);
  const sourceOpener = useRef<HTMLButtonElement | null>(null);
  const sourceHeading = useRef<HTMLHeadingElement>(null);
  const sourceOwnerKey = JSON.stringify([subject.id, viewer, origin.lifetime, entryGuard]);
  useEffect(() => {
    mounted.current = true;
    const stop = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed' && JSON.stringify(event.query.queryKey) === JSON.stringify(queryKey)) {
        retired.current = true;
        generation.current++;
        setPrivateAuthorityRetired(true);
        setDraft(null);
        setReview(null);
        setConfirmation(null);
        setAnnotationCommand(null);
        setSavedAnnotation(null);
        setDeparture(null);
      }
    });
    return () => {
      mounted.current = false;
      generation.current++;
      stop();
    };
  }, [queryClient, queryKey]);

  const lastSourceOwner = useRef(sourceOwnerKey);
  useEffect(() => {
    if (lastSourceOwner.current === sourceOwnerKey) return;
    lastSourceOwner.current = sourceOwnerKey;
    sourceBusy.current = false;
    setSourceEditor(null);
    setSourceBaseObservation(null);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setSourceConflictRevision(null);
    if (!entryGuard) {
      generation.current++;
      annotationBusy.current = false;
      setAnnotationCommand(null);
      setAnnotationNotice(null);
    }
    const incarnationChanged = review && review.guard.incarnationId !== entryGuard?.incarnationId;
    if (!entryGuard || (incarnationChanged && annotationNotice !== 'conflict' && !annotationCommand)) {
      setDraft(null);
      setReview(null);
    }
    setConfirmation(null);
    setDeparture(null);
    setLocalOutcome(null);
    setSavedAnnotation(null);
    setPrivateAuthorityRetired(true);
    setRetirementKind('entry');
    void query.refetch().then((fresh) => {
      const latest = current.current;
      if (
        latest.origin.isCurrent() &&
        JSON.stringify([latest.subjectId, latest.viewer, latest.origin.lifetime, latest.entryGuard]) ===
          sourceOwnerKey &&
        !fresh.isError &&
        fresh.data?.kind === 'ready'
      ) {
        setPrivateAuthorityRetired(false);
        setRetirementKind(null);
      }
    });
  }, [sourceOwnerKey]);

  useEffect(() => {
    if (result?.kind !== 'signed-out') return;
    retired.current = true;
    generation.current++;
    annotationBusy.current = false;
    sourceBusy.current = false;
    setDraft(null);
    setReview(null);
    setConfirmation(null);
    setAnnotationCommand(null);
    setAnnotationNotice(null);
    setSavedAnnotation(null);
    setLocalOutcome(null);
    setDeparture(null);
    setSourceEditor(null);
    setSourceBaseObservation(null);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setPrivateAuthorityRetired(true);
    setRetirementKind('account');
  }, [result?.kind]);

  const lastReadExposure = useRef(enabled);
  useEffect(() => {
    if (lastReadExposure.current === enabled) return;
    lastReadExposure.current = enabled;
    generation.current++;
    sourceBusy.current = false;
    setSourceEditor(null);
    setSourceBaseObservation(null);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setSourceConflictRevision(null);
    setDraft(null);
    setReview(null);
    setConfirmation(null);
    setDeparture(null);
    setLocalOutcome(null);
    setSavedAnnotation(null);
    setAnnotationCommand(null);
    setAnnotationNotice(null);
    setRetirementKind('exposure');
    setPrivateAuthorityRetired(true);
    if (!enabled) {
      retired.current = true;
      queryClient.removeQueries({ queryKey });
    } else {
      retired.current = false;
      void query.refetch().then((fresh) => {
        if (currentResult() && !fresh.isError && fresh.data?.kind === 'ready') {
          setPrivateAuthorityRetired(false);
          setRetirementKind(null);
        }
      });
    }
  }, [enabled, queryClient, queryKey]);

  const lastWriteExposure = useRef(writeAllowed);
  const sourceOwnerChanged = lastSourceOwner.current !== sourceOwnerKey;
  const readExposureChanged = lastReadExposure.current !== enabled;
  const writeExposureChanged = lastWriteExposure.current !== writeAllowed;
  useEffect(() => {
    if (lastWriteExposure.current === writeAllowed) return;
    lastWriteExposure.current = writeAllowed;
    generation.current++;
    sourceBusy.current = false;
    setSourceEditor(null);
    setSourceBaseObservation(null);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setSourceConflictRevision(null);
    setDraft(null);
    setReview(null);
    setConfirmation(null);
    setDeparture(null);
    setLocalOutcome(null);
    setSavedAnnotation(null);
    setAnnotationCommand(null);
    setAnnotationNotice(null);
    setPrivateAuthorityRetired(true);
    setRetirementKind('exposure');
    if (!enabled) {
      retired.current = true;
      queryClient.removeQueries({ queryKey });
      return;
    }
    retired.current = false;
    void query.refetch().then((fresh) => {
      if (currentResult() && !fresh.isError && fresh.data?.kind === 'ready') {
        setPrivateAuthorityRetired(false);
        setRetirementKind(null);
      }
    });
  }, [writeAllowed]);

  const workingDraft = draft ?? (entry ? draftOf(entry) : { note: '', priority: '' });
  const staleReview = !!(
    entry &&
    review &&
    reviewVersion(review.entry, review.guard) !== reviewVersion(entry, entryGuard)
  );
  const conflictWaiting = !annotationCommand && (annotationNotice === 'conflict' || staleReview);
  const issues = annotationIssues(workingDraft);
  const unsentDraft = !!draft && !!entry && annotationDraftChanged(review?.entry ?? entry, draft);
  const diaryHref = '/library/history?returnTo=' + encodeURIComponent(returnTo);
  const annotationEditable = !!entryGuard && writeAllowed && !annotationCommand && !sourceCommand;

  const reviewAvailable =
    !!entryGuard &&
    !query.isFetching &&
    !annotationRefreshing &&
    (annotationNotice !== 'conflict' || conflictRefreshed);

  function editDraft(next: AnnotationDraft) {
    if (
      !currentResult() ||
      !writeAllowed ||
      sourceCommand ||
      sourceBusy.current ||
      annotationCommand ||
      annotationBusy.current ||
      !entry ||
      !entryGuard
    )
      return;
    if (!review) setReview({ entry, guard: entryGuard });
    setConfirmation(null);
    setLocalOutcome(null);
    setSavedAnnotation(null);
    setDraft(next);
  }

  function acceptEntry(next: PersonalEntry) {
    queryClient.setQueryData<PrivateEntryReadResult>(queryKey, (previous) =>
      previous?.kind === 'ready' ? { ...previous, entry: next } : previous,
    );
  }

  async function sendAnnotation(command: AnnotationCommand) {
    if (!currentResult() || !writeAllowed || sourceBusy.current || sourceCommand || annotationBusy.current) return;
    const episode = generation.current;
    annotationBusy.current = true;
    setAnnotationCommand(command);
    setAnnotationNotice(null);
    let outcome: PrivateEntryCommandResult;
    try {
      outcome = await transport.annotations({ data: command });
    } catch {
      outcome = { kind: 'uncertain' };
    }
    if (episode === generation.current) annotationBusy.current = false;
    if (!currentResult() || episode !== generation.current) return;
    if (outcome.kind === 'saved') {
      acceptEntry(outcome.entry);
      setDraft(null);
      setReview(null);
      setConfirmation(null);
      setSavedAnnotation(outcome.entry);
      setLocalOutcome(null);
      setAnnotationCommand(null);
      setAnnotationNotice(null);
      return;
    }
    if (outcome.kind === 'conflict') {
      setAnnotationCommand(null);
      setConfirmation(null);
      setAnnotationNotice('conflict');
      setConflictRefreshed(false);
      setAnnotationRefreshing(true);
      try {
        const [fresh, currentEntry] = await Promise.all([query.refetch(), origin.refreshEntry()]);
        if (currentResult() && episode === generation.current)
          setConflictRefreshed(!fresh.isError && fresh.data?.kind === 'ready' && currentEntry);
      } finally {
        if (currentResult() && episode === generation.current) setAnnotationRefreshing(false);
      }
      return;
    }
    if (outcome.kind === 'uncertain') {
      setAnnotationNotice('uncertain');
      return;
    }
    setAnnotationCommand(null);
    if (outcome.kind === 'retired' || outcome.kind === 'signed-out') {
      retired.current = true;
      setPrivateAuthorityRetired(true);
      setRetirementKind(outcome.kind === 'retired' ? 'entry' : 'account');
      queryClient.removeQueries({ queryKey });
      setDraft(null);
      setReview(null);
      setConfirmation(null);
      setDeparture(null);
      setSavedAnnotation(null);
      setSourceEditor(null);
      return;
    }
    setAnnotationNotice(outcome.kind === 'denied' ? 'denied' : 'missing');
  }

  function openAnnotationReview() {
    if (
      !currentResult() ||
      !entry ||
      !entryGuard ||
      !annotationEditable ||
      sourceBusy.current ||
      annotationBusy.current ||
      conflictWaiting ||
      result?.kind !== 'ready' ||
      departure
    )
      return;
    if (issues.note || issues.priority) {
      focusAnnotationEditor(editorRefs, issues.note ? 'note' : 'priority');
      return;
    }
    const baseline = review?.entry ?? entry;
    const guard = review?.guard ?? entryGuard;
    const next = annotationConfirmation(baseline, workingDraft, guard, result);
    if (!next) {
      setLocalOutcome('unchanged');
      setConfirmation(null);
      return;
    }
    setLocalOutcome(null);
    setSavedAnnotation(null);
    setReview({ entry: baseline, guard });
    setConfirmation(next);
  }

  function returnToAnnotation(field: AnnotationField | 'review') {
    if (!currentResult() || annotationCommand || annotationBusy.current) return;
    setConfirmation(null);
    setEditorFocus(field);
  }

  function submitAnnotation() {
    const captured = confirmationRef.current;
    if (
      !currentResult() ||
      !captured ||
      !entry ||
      !entryGuard ||
      !writeAllowed ||
      annotationCommand ||
      sourceCommand ||
      sourceBusy.current ||
      annotationBusy.current ||
      conflictWaiting ||
      result?.kind !== 'ready' ||
      departure ||
      captured.viewer !== viewer ||
      reviewVersion(captured.entry, captured.body.entryGuard) !== reviewVersion(entry, entryGuard) ||
      captured.draft.note !== workingDraft.note ||
      captured.draft.priority !== workingDraft.priority
    )
      return;
    void sendAnnotation({
      subjectId: subject.id,
      viewer: captured.viewer,
      csrfToken: captured.csrfToken,
      credential: captured.credential,
      key: crypto.randomUUID(),
      body: captured.body,
    });
  }

  function askDiscard(trigger: HTMLButtonElement) {
    if (!currentResult() || annotationCommand || annotationBusy.current || !unsentDraft) return;
    departureTrigger.current = trigger;
    setDeparture('discard');
  }

  function stayWithAnnotation() {
    setDeparture(null);
    departureTrigger.current?.focus();
  }

  function discardAnnotation(leave: boolean) {
    if (
      !currentResult() ||
      annotationCommand ||
      annotationBusy.current ||
      (leave && (sourceEditor || sourceCommand || sourceBusy.current))
    )
      return;
    setConfirmation(null);
    setDraft(null);
    setReview(null);
    setAnnotationNotice(null);
    setConflictRefreshed(false);
    setLocalOutcome('discarded');
    setSavedAnnotation(null);
    setDeparture(null);
    if (leave) {
      // The canonical anchor navigates. Retire this visit before any late callback can publish.
      retired.current = true;
      generation.current++;
    } else {
      setEditorFocus('discard');
    }
  }

  function followDiary(event: MouseEvent<HTMLAnchorElement>) {
    if (!currentResult()) {
      event.preventDefault();
      return;
    }
    if (unsentDraft || annotationCommand || annotationBusy.current || sourceEditor || sourceCommand) {
      event.preventDefault();
      departureTrigger.current = event.currentTarget;
      setDeparture('diary');
    }
  }

  function reviewLatest() {
    if (
      !currentResult() ||
      !entry ||
      !entryGuard ||
      !reviewAvailable ||
      annotationCommand ||
      annotationBusy.current ||
      sourceCommand ||
      sourceBusy.current
    )
      return;
    // An unchanged operand stays unchanged even if the latest private note or rank has changed.
    setDraft(renewAnnotationDraft(review?.entry ?? entry, entry, workingDraft, review?.guard ?? entryGuard));
    setReview({ entry, guard: entryGuard });
    setConfirmation(null);
    setEditorFocus('review');
    setAnnotationNotice(null);
    setConflictRefreshed(false);
  }

  function refreshConflict() {
    if (!currentResult() || annotationRefreshing) return;
    setAnnotationRefreshing(true);
    void Promise.all([query.refetch(), origin.refreshEntry()])
      .then(([fresh, currentEntry]) => {
        if (currentResult()) setConflictRefreshed(!fresh.isError && fresh.data?.kind === 'ready' && currentEntry);
      })
      .finally(() => {
        if (currentResult()) setAnnotationRefreshing(false);
      });
  }

  function openSource(observation: PersonalEntryObservation, event: MouseEvent<HTMLButtonElement>) {
    if (!currentResult() || !writeAllowed || sourceCommand || annotationCommand || annotationBusy.current) return;
    sourceOpener.current = event.currentTarget;
    setSourceEditor(observation.provider + '\u0000' + observation.recordId);
    setSourceBaseObservation(observation);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setSourceConflictRevision(null);
  }

  function sourceCommandIsCurrent(command: SourceCorrectionCommand) {
    const latest = current.current;
    return (
      currentResult() &&
      command.subjectId === latest.subjectId &&
      command.viewer === latest.viewer &&
      command.originLifetime === latest.origin.lifetime &&
      latest.entryGuard !== null &&
      JSON.stringify(command.entryGuard) ===
        JSON.stringify({
          incarnationId: latest.entryGuard.incarnationId,
          currentRevision: latest.entryGuard.currentRevision,
        })
    );
  }

  function clearSourceFlow() {
    sourceBusy.current = false;
    setSourceEditor(null);
    setSourceBaseObservation(null);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setSourceConflictRevision(null);
  }

  async function sendSource(command: SourceCorrectionCommand) {
    if (
      !sourceCommandIsCurrent(command) ||
      !writeAllowed ||
      annotationCommand ||
      annotationBusy.current ||
      sourceBusy.current
    )
      return;
    const episode = generation.current;
    sourceBusy.current = true;
    setSourceCommand(command);
    setSourceNotice(null);
    let outcome: SourceCorrectionCommandResult;
    try {
      outcome = await transport.sourceCorrection({
        data: {
          subjectId: command.subjectId,
          viewer: command.viewer,
          csrfToken: command.csrfToken,
          credential: command.credential,
          key: command.key,
          originLifetime: command.originLifetime,
          entryGuard: command.entryGuard,
          body: command.body,
        },
      });
    } catch {
      outcome = { kind: 'uncertain' };
    } finally {
      if (episode === generation.current && sourceCommandIsCurrent(command)) sourceBusy.current = false;
    }
    if (!sourceCommandIsCurrent(command) || episode !== generation.current) return;
    if (outcome.kind === 'saved') {
      acceptEntry(outcome.entry);
      setSourceCommand(null);
      setSourceNotice('saved');
      setSourceSavedBody(command.body);
      setSourceSavedObservation(outcome.observation);
      setSourceConflictRevision(null);
      return;
    }
    if (outcome.kind === 'conflict') {
      setSourceCommand(null);
      setSourceNotice('conflict');
      setSourceConflictRevision(command.body.revision);
      void query.refetch();
      return;
    }
    if (outcome.kind === 'uncertain') {
      setSourceCommand(command);
      setSourceNotice('uncertain');
      return;
    }
    setSourceCommand(null);
    if (outcome.kind === 'retired' || outcome.kind === 'signed-out') {
      retired.current = true;
      setRetirementKind(outcome.kind === 'retired' ? 'entry' : 'account');
      setPrivateAuthorityRetired(true);
      queryClient.removeQueries({ queryKey });
      setDraft(null);
      setReview(null);
      setConfirmation(null);
      setDeparture(null);
      setSavedAnnotation(null);
      clearSourceFlow();
      return;
    }
    if (outcome.kind === 'unavailable') {
      setSourceNotice('unavailable');
      return;
    }
    setSourceNotice(outcome.kind === 'denied' ? 'denied' : outcome.kind === 'missing' ? 'missing' : null);
  }

  function submitSource(body: PersonalEntrySourceCorrection) {
    if (
      !currentResult() ||
      !viewer ||
      !csrfToken ||
      result?.kind !== 'ready' ||
      !entryGuard ||
      !sourceBaseObservation ||
      !writeAllowed ||
      sourceCommand ||
      sourceBusy.current ||
      annotationCommand ||
      annotationBusy.current ||
      body.provider !== sourceBaseObservation.provider ||
      body.recordId !== sourceBaseObservation.recordId ||
      body.revision !== sourceBaseObservation.revision
    )
      return;
    const command: SourceCorrectionCommand = Object.freeze({
      subjectId: subject.id,
      viewer: result.viewer,
      csrfToken: result.csrfToken,
      credential: result.credential,
      key: crypto.randomUUID(),
      originLifetime: origin.lifetime,
      entryGuard: Object.freeze({
        incarnationId: entryGuard.incarnationId,
        currentRevision: entryGuard.currentRevision,
      }),
      body,
    });
    void sendSource(command);
  }

  function reviewLatestSource() {
    if (!currentResult() || !entry || !sourceBaseObservation || !sourceEditor) return;
    const [provider, recordId] = sourceEditor.split('\u0000');
    const latest = entry.sourceObservations.find((item) => item.provider === provider && item.recordId === recordId);
    if (!latest) return;
    setSourceBaseObservation(latest);
    setSourceNotice(null);
    setSourceSavedBody(null);
    setSourceSavedObservation(null);
    setSourceConflictRevision(null);
  }

  function closeSource() {
    if (!currentResult()) return;
    clearSourceFlow();
    if (sourceOpener.current?.isConnected) sourceOpener.current.focus();
    else sourceHeading.current?.focus();
  }

  const displayedSource = entry?.sourceObservations.find(
    (observation) => sourceEditor === observation.provider + '\u0000' + observation.recordId,
  );
  const sourceFactsReady =
    !!entryGuard && !sourceOwnerChanged && !(privateAuthorityRetired && retirementKind === 'entry');

  if ((privateAuthorityRetired && retirementKind !== 'entry') || readExposureChanged || writeExposureChanged) {
    return (
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        {retirementKind === 'exposure' || readExposureChanged || writeExposureChanged
          ? m.library_rich_entry_source_unavailable()
          : m.library_rich_entry_signed_out()}
      </p>
    );
  }
  if (!origin.isCurrent() || retired.current) {
    retired.current = true;
    return (
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        {m.library_rich_entry_source_retired()}
      </p>
    );
  }
  if (session.state === 'signed-out') {
    return <p className="mt-4 text-sm text-muted-foreground">{m.library_rich_entry_signed_out()}</p>;
  }
  if (!enabled) {
    return <p className="mt-4 text-sm text-muted-foreground">{m.library_rich_entry_unavailable()}</p>;
  }
  if (query.isPending) {
    return (
      <section aria-label={m.library_rich_entry_heading()} className="mt-5 rounded-lg border p-4">
        {m.library_rich_entry_loading()}
      </section>
    );
  }
  if (!entry) {
    return (
      <section aria-label={m.library_rich_entry_heading()} className="mt-5 rounded-lg border p-4">
        <p>{m.library_rich_entry_unavailable()}</p>
        <Button
          type="button"
          variant="outline" className='mt-2'
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {m.library_selection_retry()}
        </Button>
      </section>
    );
  }

  return (
    <EntryWorkspace
      subject={subject}
      entry={entry}
      diaryHref={diaryHref}
      onDiaryClick={followDiary}
      annotation={{
        draft: workingDraft,
        issues,
        disabled: !annotationEditable,
        reviewDisabled: conflictWaiting,
        canDiscard: unsentDraft,
        refs: editorRefs,
        confirmation,
        submitted: annotationCommand !== null,
        blocked: !annotationEditable || conflictWaiting,
        savedEntry: savedAnnotation,
        localOutcome,
        pending: annotationCommand !== null,
        uncertain: annotationNotice === 'uncertain',
        denied: annotationNotice === 'denied',
        missing: annotationNotice === 'missing',
        conflict: conflictWaiting,
        refreshing: query.isFetching || annotationRefreshing,
        reviewLatestAvailable: reviewAvailable,
        departure,
        unresolved: annotationCommand !== null || sourceCommand !== null,
        sourceOpen: sourceEditor !== null,
        returnFocus: departureTrigger.current,
        onChange: editDraft,
        onReview: openAnnotationReview,
        onAskDiscard: askDiscard,
        onEdit: returnToAnnotation,
        onSave: submitAnnotation,
        onCloseReview: () => returnToAnnotation('review'),
        onRetry: () => {
          if (annotationCommand) void sendAnnotation(annotationCommand);
        },
        onReviewLatest: reviewLatest,
        onRefreshConflict: refreshConflict,
        onStay: stayWithAnnotation,
        onDepartureDiscard: discardAnnotation,
      }}
      source={{
        factsReady: sourceFactsReady,
        editorKey: sourceEditor,
        baseline: sourceBaseObservation,
        displayed: displayedSource ?? null,
        notice: sourceNotice,
        conflictRevision: sourceConflictRevision,
        pending: sourceCommand !== null,
        savedBody: sourceSavedBody,
        savedObservation: sourceSavedObservation,
        disabled: !writeAllowed || annotationCommand !== null || annotationBusy.current,
        writeAllowed,
        viewer: viewer ?? null,
        originLifetime: origin.lifetime,
        announceConflict: !!displayedSource && sourceNotice === 'conflict',
        headingRef: sourceHeading,
        onOpen: openSource,
        onSubmit: submitSource,
        onRetry: () => {
          if (sourceCommand) void sendSource(sourceCommand);
        },
        onRefresh: () => void query.refetch(),
        onReviewLatest: reviewLatestSource,
        onCancel: closeSource,
        onEdit: () => {
          setSourceNotice(null);
          setSourceSavedBody(null);
          setSourceSavedObservation(null);
        },
      }}
    />
  );
}
