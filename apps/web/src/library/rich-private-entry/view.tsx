import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../../kernel/exposure';
import type { useSession } from '../../session/query';
import { PRIVATE_NOTE_BYTES, annotationWrite, draftOf, type AnnotationDraft } from './contract';
import {
  readPrivateEntryForSubject,
  savePrivateAnnotations,
  savePrivateSourceCorrection,
  type PrivateEntryCommandResult,
  type PrivateEntryReadResult,
  type SourceCorrectionCommandResult,
} from './server';
import type {
  PersonalEntry,
  PersonalEntryGuard,
  PersonalEntryObservation,
  PersonalEntrySourceCorrection,
} from '@rezics/client';
import { SourceCorrectionEditor, type SourceCorrectionNotice } from './source-correction-editor';

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

function privacyText(value: PersonalEntryObservation['privacy']) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'cleared') return m.library_rich_source_cleared();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return value.meaning === 'private' ? m.library_rich_source_private() : m.library_rich_source_visible();
}

function timestampText(value: PersonalEntryObservation['sourceCreated']) {
  if (value.status === 'absent') return m.library_rich_source_not_supplied();
  if (value.status === 'cleared') return m.library_rich_source_cleared();
  if (value.status === 'unknown')
    return value.sourceValue
      ? m.library_rich_source_unknown_value({ value: value.sourceValue })
      : m.library_rich_source_unknown();
  return m.library_rich_source_timestamp({
    value: value.value,
    precision:
      value.precision === 'year'
        ? m.library_rich_entry_precision_year()
        : value.precision === 'month'
          ? m.library_rich_entry_precision_month()
          : value.precision === 'day'
            ? m.library_rich_entry_precision_day()
            : value.precision === 'minute'
              ? m.library_rich_entry_precision_minute()
              : value.precision === 'second'
                ? m.library_rich_entry_precision_second()
                : m.library_rich_entry_precision_fraction(),
    zone:
      value.zone === 'utc'
        ? m.library_rich_entry_zone_utc()
        : value.zone === 'offset'
          ? m.library_rich_entry_zone_offset()
          : m.library_rich_entry_zone_unknown(),
  });
}

function validDraft(draft: AnnotationDraft) {
  const bytes = new TextEncoder().encode(draft.note).byteLength;
  if (bytes > PRIVATE_NOTE_BYTES) return false;
  if (!draft.priority.trim()) return true;
  return /^[0-9]{1,3}$/.test(draft.priority) && Number(draft.priority) >= 1 && Number(draft.priority) <= 100;
}

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
const reviewVersion = (entry: PersonalEntry, guard: PersonalEntryGuard | null) =>
  JSON.stringify([entry.annotationRevision, guard?.incarnationId, guard?.currentRevision]);
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
  const client = useQueryClient();
  const receiver = useMemo(() => crypto.randomUUID(), [client]);
  return (
    <PrivateEntryReview
      key={JSON.stringify([
        props.subject.id,
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
  const currentResult = () =>
    mounted.current && !retired.current && current.current.enabled && current.current.origin.isCurrent();
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
  const sourceOwnerKey = JSON.stringify([
    subject.id,
    viewer,
    origin.lifetime,
    entryGuard,
  ]);
  useEffect(() => {
    mounted.current = true;
    const stop = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed' && JSON.stringify(event.query.queryKey) === JSON.stringify(queryKey)) {
        retired.current = true;
        generation.current++;
        setPrivateAuthorityRetired(true);
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
    setPrivateAuthorityRetired(true);
    setRetirementKind('entry');
    void query.refetch().then((fresh) => {
      const latest = current.current;
      if (
        latest.origin.isCurrent() &&
        JSON.stringify([latest.subjectId, latest.viewer, latest.origin.lifetime, latest.entryGuard]) === sourceOwnerKey &&
        !fresh.isError &&
        fresh.data?.kind === 'ready'
      ) {
        setPrivateAuthorityRetired(false);
        setRetirementKind(null);
      }
    });
  }, [sourceOwnerKey]);

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
  const write = entry ? annotationWrite(review?.entry ?? entry, workingDraft, review?.guard ?? entryGuard) : null;
  const staleReview = !!(
    entry &&
    review &&
    reviewVersion(review.entry, review.guard) !== reviewVersion(entry, entryGuard)
  );
  const conflictWaiting = annotationNotice === 'conflict' || staleReview;
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
    annotationBusy.current = false;
    if (!currentResult() || episode !== generation.current) return;
    if (outcome.kind === 'saved') {
      acceptEntry(outcome.entry);
      setDraft(null);
      setReview(null);
      setAnnotationCommand(null);
      setAnnotationNotice(null);
      return;
    }
    if (outcome.kind === 'conflict') {
      setAnnotationCommand(null);
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
      setSourceEditor(null);
      return;
    }
    setAnnotationNotice(outcome.kind === 'denied' ? 'denied' : 'missing');
  }

  function submitAnnotation(event: FormEvent) {
    event.preventDefault();
    if (
      !currentResult() ||
      !entry ||
      !write ||
      !validDraft(workingDraft) ||
      !writeAllowed ||
      annotationCommand ||
      sourceCommand ||
      sourceBusy.current ||
      annotationBusy.current ||
      conflictWaiting ||
      result?.kind !== 'ready'
    )
      return;
    void sendAnnotation({
      subjectId: subject.id,
      viewer: result.viewer,
      csrfToken: result.csrfToken,
      credential: result.credential,
      key: crypto.randomUUID(),
      body: write,
    });
  }

  function reviewLatest() {
    if (!currentResult() || !entry || !entryGuard || !reviewAvailable) return;
    // An unchanged operand stays unchanged even if the latest private note or rank has changed.
    setDraft({
      note: write?.note.op === 'unchanged' ? (entry.note ?? '') : workingDraft.note,
      priority: write?.priority.op === 'unchanged' ? draftOf(entry).priority : workingDraft.priority,
    });
    setReview({ entry, guard: entryGuard });
    setAnnotationNotice(null);
    setConflictRefreshed(false);
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
      sourceBusy.current = false;
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
    sourceOpener.current?.focus();
  }

  const displayedSource = entry?.sourceObservations.find(
    (observation) => sourceEditor === observation.provider + '\u0000' + observation.recordId,
  );
  const sourceFactsReady =
    !!entryGuard && !sourceOwnerChanged && !(privateAuthorityRetired && retirementKind === 'entry');

  if (
    (privateAuthorityRetired && retirementKind !== 'entry') ||
    readExposureChanged ||
    writeExposureChanged
  ) {
    return (
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        {retirementKind === 'exposure' || readExposureChanged || writeExposureChanged
            ? m.library_rich_entry_source_unavailable()
            : m.library_rich_entry_signed_out()}
      </p>
    );
  }
  if (!origin.isCurrent()) {
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
        <button
          type="button"
          className="mt-2 min-h-11 rounded-md border px-3"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {m.library_selection_retry()}
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="rich-private-entry-heading" className="mt-5 space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="rich-private-entry-heading" className="text-lg font-semibold">
            {m.library_rich_entry_heading()}
          </h2>
          <p className="text-sm font-medium">{subject.label}</p>
          <p className="text-sm text-muted-foreground">{m.library_rich_entry_private_help()}</p>
        </div>
        <a
          className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm"
          href={'/library/history?returnTo=' + encodeURIComponent(returnTo)}
        >
          {m.library_rich_entry_diary_link()}
        </a>
      </div>

      <form className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)]" onSubmit={submitAnnotation}>
        <div className="space-y-2">
          <label htmlFor={'private-note-' + subject.id} className="block text-sm font-medium">
            {m.library_rich_entry_note()}
          </label>
          <textarea
            id={'private-note-' + subject.id}
            className="min-h-28 w-full rounded-md border bg-background p-3"
            value={workingDraft.note}
            maxLength={PRIVATE_NOTE_BYTES}
            readOnly={!writeAllowed || !entryGuard || annotationCommand !== null || sourceCommand !== null}
            onChange={(event) => editDraft({ ...workingDraft, note: event.currentTarget.value })}
          />
          <p className="text-sm text-muted-foreground">
            {m.library_rich_entry_note_bytes({ count: new TextEncoder().encode(workingDraft.note).byteLength })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              disabled={!writeAllowed || !entryGuard || annotationCommand !== null || sourceCommand !== null}
              onClick={() => editDraft({ ...workingDraft, note: '' })}
            >
              {m.library_rich_entry_clear_note()}
            </button>
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor={'private-priority-' + subject.id} className="block text-sm font-medium">
            {m.library_rich_entry_priority()}
          </label>
          <input
            id={'private-priority-' + subject.id}
            className="min-h-11 w-full rounded-md border bg-background px-3"
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            value={workingDraft.priority}
            readOnly={!writeAllowed || !entryGuard || annotationCommand !== null || sourceCommand !== null}
            onChange={(event) => editDraft({ ...workingDraft, priority: event.currentTarget.value })}
          />
          <p className="text-sm text-muted-foreground">
            {entry.priority === null
              ? m.library_rich_entry_unranked()
              : m.library_rich_entry_priority_value({ value: entry.priority })}
          </p>
          <button
            type="button"
            className="min-h-11 rounded-md border px-3"
            disabled={!writeAllowed || !entryGuard || annotationCommand !== null || sourceCommand !== null}
            onClick={() => editDraft({ ...workingDraft, priority: '' })}
          >
            {m.library_rich_entry_clear_priority()}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          <button
            type="submit"
            className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
            disabled={
              !writeAllowed ||
              !write ||
              !validDraft(workingDraft) ||
              annotationCommand !== null ||
              conflictWaiting ||
              !entryGuard ||
              sourceCommand !== null
            }
          >
            {m.library_rich_entry_save()}
          </button>
          {annotationCommand && annotationNotice === 'uncertain' ? (
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              onClick={() => void sendAnnotation(annotationCommand)}
            >
              {m.library_rich_entry_retry()}
            </button>
          ) : null}
          {annotationNotice === 'uncertain' ? (
            <p role="status" aria-live="polite">
              {m.library_rich_entry_uncertain()}
            </p>
          ) : null}
          {annotationNotice === 'denied' ? <p role="status">{m.library_rich_entry_denied()}</p> : null}
          {annotationNotice === 'missing' ? <p role="status">{m.library_rich_entry_missing()}</p> : null}
        </div>
      </form>

      {conflictWaiting ? (
        <div
          role="group"
          aria-label={m.library_rich_entry_conflict()}
          className="space-y-2 rounded-md border border-amber-600 p-3"
        >
          <p>{m.library_rich_entry_conflict()}</p>
          <dl className="grid gap-2 break-words sm:grid-cols-2">
            <div>
              <dt>{m.library_rich_entry_note()}</dt>
              <dd className="whitespace-pre-wrap">{entry.note ?? ''}</dd>
            </div>
            <div>
              <dt>{m.library_rich_entry_priority()}</dt>
              <dd>
                {entry.priority === null
                  ? m.library_rich_entry_unranked()
                  : m.library_rich_entry_priority_value({ value: entry.priority })}
              </dd>
            </div>
          </dl>
          {query.isFetching || annotationRefreshing ? (
            <p>{m.library_rich_entry_refreshing()}</p>
          ) : reviewAvailable ? (
            <button type="button" className="min-h-11 rounded-md border px-3" onClick={reviewLatest}>
              {m.library_rich_entry_review_latest()}
            </button>
          ) : (
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              onClick={() => {
                if (!currentResult()) return;
                setAnnotationRefreshing(true);
                void Promise.all([query.refetch(), origin.refreshEntry()])
                  .then(([fresh, currentEntry]) => {
                    if (currentResult())
                      setConflictRefreshed(!fresh.isError && fresh.data?.kind === 'ready' && currentEntry);
                  })
                  .finally(() => {
                    if (currentResult()) setAnnotationRefreshing(false);
                  });
              }}
            >
              {m.library_selection_retry()}
            </button>
          )}
        </div>
      ) : null}

      <div className="space-y-3 border-t pt-4">
        <div>
          <h3 className="font-semibold">{m.library_rich_entry_sources()}</h3>
          <p className="text-sm text-muted-foreground">{m.library_rich_entry_sources_help()}</p>
          <p className="text-sm text-muted-foreground">{m.library_rich_entry_timestamp_is_source_evidence()}</p>
        </div>
        {!sourceFactsReady ? (
          <p role="status">{m.library_rich_entry_source_retired()}</p>
        ) : entry.sourceObservations.length === 0 ? (
          <p>{m.library_rich_entry_no_sources()}</p>
        ) : (
          <ul className="grid gap-3">
            {entry.sourceObservations.map((observation) => {
              const open = sourceEditor === observation.provider + '\u0000' + observation.recordId;
              return (
                <li key={observation.provider + ':' + observation.recordId} className="rounded-md border p-3">
                  <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-sm font-medium">{m.library_rich_entry_provider()}</dt>
                      <dd>{observation.provider}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium">{m.library_rich_entry_record()}</dt>
                      <dd className="break-all">{observation.recordId}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium">{m.library_rich_entry_privacy()}</dt>
                      <dd>{privacyText(observation.privacy)}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium">{m.library_rich_entry_source_created()}</dt>
                      <dd className="break-words">{timestampText(observation.sourceCreated)}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium">{m.library_rich_entry_source_updated()}</dt>
                      <dd className="break-words">{timestampText(observation.sourceUpdated)}</dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium">{m.library_rich_entry_native_recorded()}</dt>
                      <dd>{observation.recordedAt}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="mt-3 min-h-11 rounded-md border px-3"
                    disabled={!writeAllowed || annotationCommand !== null || sourceCommand !== null}
                    onClick={(event) => openSource(observation, event)}
                  >
                    {m.library_rich_entry_edit_source_facts()}
                  </button>
                  {open && sourceBaseObservation ? (
                    <SourceCorrectionEditor
                      key={`${subject.id}:${viewer}:${origin.lifetime}:${observation.provider}:${observation.recordId}`}
                      baseline={sourceBaseObservation}
                      current={displayedSource}
                      notice={sourceNotice}
                      conflictRevision={sourceConflictRevision}
                      pending={sourceCommand !== null}
                      savedBody={sourceSavedBody}
                      savedObservation={sourceSavedObservation}
                      disabled={!writeAllowed || annotationCommand !== null || annotationBusy.current}
                      onSubmit={submitSource}
                      onRetry={() => sourceCommand && void sendSource(sourceCommand)}
                      onRefresh={() => void query.refetch()}
                      onReviewLatest={reviewLatestSource}
                      onCancel={closeSource}
                      onEdit={() => {
                        setSourceNotice(null);
                        setSourceSavedBody(null);
                        setSourceSavedObservation(null);
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {sourceFactsReady && sourceEditor && sourceBaseObservation && !displayedSource ? (
          <SourceCorrectionEditor
            key={`${subject.id}:${viewer}:${origin.lifetime}:${sourceBaseObservation.provider}:${sourceBaseObservation.recordId}`}
            baseline={sourceBaseObservation}
            current={null}
            notice={sourceNotice}
            conflictRevision={sourceConflictRevision}
            pending={sourceCommand !== null}
            savedBody={sourceSavedBody}
            savedObservation={sourceSavedObservation}
            disabled={!writeAllowed || annotationCommand !== null || annotationBusy.current}
            onSubmit={submitSource}
            onRetry={() => sourceCommand && void sendSource(sourceCommand)}
            onRefresh={() => void query.refetch()}
            onReviewLatest={reviewLatestSource}
            onCancel={closeSource}
            onEdit={() => {
              setSourceNotice(null);
              setSourceSavedBody(null);
              setSourceSavedObservation(null);
            }}
          />
        ) : null}
      </div>

      <div className="border-t pt-4">
        <h3 className="font-semibold">{m.library_rich_entry_state_history()}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{m.library_rich_entry_state_history_unavailable()}</p>
      </div>

      <span className="sr-only" aria-live="polite">
        {displayedSource && sourceNotice === 'conflict' ? m.library_rich_entry_source_conflict() : ''}
      </span>
    </section>
  );
}
