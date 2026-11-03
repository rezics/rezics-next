import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../../kernel/exposure';
import type { useSession } from '../../session/query';
import { PRIVATE_NOTE_BYTES, annotationWrite, draftOf, type AnnotationDraft } from './contract';
import {
  readPrivateEntryForSubject,
  savePrivateAnnotations,
  savePrivateSourcePrivacy,
  type PrivateEntryCommandResult,
  type PrivateEntryReadResult,
  type SourcePrivacyCommandResult,
} from './server';
import type { PersonalEntry, PersonalEntryObservation, PersonalEntryPrivacyValue } from '@rezics/client';

type ReaderSession = ReturnType<typeof useSession>;

type AnnotationCommand = {
  subjectId: string;
  viewer: string;
  csrfToken: string;
  key: string;
  body: NonNullable<ReturnType<typeof annotationWrite>>;
};

type PrivacyCommand = {
  subjectId: string;
  viewer: string;
  csrfToken: string;
  key: string;
  provider: string;
  recordId: string;
  revision: number;
  privacy: { op: 'clear' | 'unchanged' } | { op: 'set'; value: PersonalEntryPrivacyValue };
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
    precision: value.precision,
    zone: value.zone,
  });
}

function validDraft(draft: AnnotationDraft) {
  const bytes = new TextEncoder().encode(draft.note).byteLength;
  if (bytes > PRIVATE_NOTE_BYTES) return false;
  if (!draft.priority.trim()) return true;
  return /^[0-9]{1,3}$/.test(draft.priority) && Number(draft.priority) >= 1 && Number(draft.priority) <= 100;
}

export function RichPrivateEntry({
  subject,
  session,
  admitted,
  returnTo,
}: {
  subject: { id: string; label: string };
  session: ReaderSession;
  admitted: boolean;
  returnTo: string;
}) {
  const readAllowed = useOperation('library_entry.get');
  const writeAllowed = useOperation('library_entry.put');
  const queryClient = useQueryClient();
  const viewer = session.state === 'signed-in' ? session.subject : null;
  const csrfToken = session.state === 'signed-in' ? session.csrfToken : null;
  const enabled = readAllowed && admitted && viewer !== null && csrfToken !== null;
  const queryKey = useMemo(
    () => ['library', 'rich-private-entry', subject.id, viewer, csrfToken] as const,
    [subject.id, viewer, csrfToken],
  );
  const query = useQuery<PrivateEntryReadResult>({
    queryKey,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: () => readPrivateEntryForSubject({ data: { subjectId: subject.id } }),
  });
  const result = query.data;
  const ready =
    result?.kind === 'ready' &&
    result.entry.subjectId === subject.id &&
    result.viewer === viewer &&
    result.csrfToken === csrfToken;
  const [acceptedEntry, setAcceptedEntry] = useState<{
    subjectId: string;
    viewer: string;
    csrfToken: string;
    entry: PersonalEntry;
  } | null>(null);
  const entry = ready
    ? acceptedEntry?.subjectId === subject.id &&
      acceptedEntry.viewer === viewer &&
      acceptedEntry.csrfToken === csrfToken
      ? acceptedEntry.entry
      : result.entry
    : null;
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [annotationCommand, setAnnotationCommand] = useState<AnnotationCommand | null>(null);
  const [annotationNotice, setAnnotationNotice] = useState<'conflict' | 'uncertain' | 'denied' | 'missing' | null>(
    null,
  );
  const [annotationConflictRevision, setAnnotationConflictRevision] = useState<number | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [sourceEditor, setSourceEditor] = useState<string | null>(null);
  const [sourceChoice, setSourceChoice] = useState('keep');
  const [sourceReviewed, setSourceReviewed] = useState(false);
  const [sourceCommand, setSourceCommand] = useState<PrivacyCommand | null>(null);
  const [sourceNotice, setSourceNotice] = useState<'conflict' | 'uncertain' | 'denied' | 'missing' | null>(null);
  const [sourceConflictRevision, setSourceConflictRevision] = useState<number | null>(null);
  const [privateAuthorityRetired, setPrivateAuthorityRetired] = useState(false);
  const mounted = useRef(true);
  const current = useRef({ subjectId: subject.id, viewer, csrfToken });
  current.current = { subjectId: subject.id, viewer, csrfToken };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const currentResult = () =>
    mounted.current &&
    current.current.subjectId === subject.id &&
    current.current.viewer === viewer &&
    current.current.csrfToken === csrfToken;

  const workingDraft = draft ?? (entry ? draftOf(entry) : { note: '', priority: '' });
  const write = entry ? annotationWrite(entry, workingDraft) : null;
  const conflictWaiting = annotationNotice === 'conflict';

  async function sendAnnotation(command: AnnotationCommand) {
    if (!currentResult() || !writeAllowed) return;
    setAnnotationNotice(null);
    const outcome: PrivateEntryCommandResult = await savePrivateAnnotations({ data: command });
    if (!currentResult()) return;
    if (outcome.kind === 'saved') {
      setAcceptedEntry({
        subjectId: subject.id,
        viewer: command.viewer,
        csrfToken: command.csrfToken,
        entry: outcome.entry,
      });
      setDraft(null);
      setAnnotationCommand(null);
      setAnnotationNotice(null);
      setAnnotationConflictRevision(null);
      setReviewedRevision(null);
      return;
    }
    if (outcome.kind === 'conflict') {
      setAcceptedEntry(null);
      setAnnotationCommand(null);
      setAnnotationNotice('conflict');
      setAnnotationConflictRevision(command.body.revision);
      setReviewedRevision(null);
      void query.refetch();
      return;
    }
    if (outcome.kind === 'uncertain') {
      setAnnotationCommand(command);
      setAnnotationNotice('uncertain');
      return;
    }
    setAnnotationCommand(null);
    if (outcome.kind === 'retired') {
      setPrivateAuthorityRetired(true);
      queryClient.removeQueries({ queryKey });
      setDraft(null);
      setSourceEditor(null);
      return;
    }
    setAnnotationNotice(outcome.kind === 'denied' ? 'denied' : outcome.kind === 'missing' ? 'missing' : null);
  }

  function submitAnnotation(event: FormEvent) {
    event.preventDefault();
    if (!entry || !write || !validDraft(workingDraft) || !writeAllowed || annotationCommand) return;
    if (conflictWaiting && reviewedRevision !== entry.annotationRevision) return;
    const command: AnnotationCommand = {
      subjectId: subject.id,
      viewer: viewer!,
      csrfToken: csrfToken!,
      key: crypto.randomUUID(),
      body: { ...write, revision: entry.annotationRevision },
    };
    void sendAnnotation(command);
  }

  function openSource(observation: PersonalEntryObservation) {
    setSourceEditor(observation.provider + '\u0000' + observation.recordId);
    setSourceChoice('keep');
    setSourceReviewed(false);
    setSourceCommand(null);
    setSourceNotice(null);
    setSourceConflictRevision(null);
  }

  async function sendSource(command: PrivacyCommand) {
    if (!currentResult() || !writeAllowed) return;
    setSourceNotice(null);
    const outcome: SourcePrivacyCommandResult = await savePrivateSourcePrivacy({ data: command });
    if (!currentResult()) return;
    if (outcome.kind === 'saved') {
      setAcceptedEntry({
        subjectId: subject.id,
        viewer: command.viewer,
        csrfToken: command.csrfToken,
        entry: outcome.entry,
      });
      setSourceCommand(null);
      setSourceEditor(null);
      setSourceReviewed(false);
      setSourceNotice(null);
      setSourceConflictRevision(null);
      return;
    }
    if (outcome.kind === 'conflict') {
      setAcceptedEntry(null);
      setSourceCommand(null);
      setSourceNotice('conflict');
      setSourceConflictRevision(command.revision);
      setSourceReviewed(false);
      void query.refetch();
      return;
    }
    if (outcome.kind === 'uncertain') {
      setSourceCommand(command);
      setSourceNotice('uncertain');
      return;
    }
    setSourceCommand(null);
    if (outcome.kind === 'retired') {
      setPrivateAuthorityRetired(true);
      queryClient.removeQueries({ queryKey });
      setDraft(null);
      setSourceEditor(null);
      return;
    }
    setSourceNotice(outcome.kind === 'denied' ? 'denied' : outcome.kind === 'missing' ? 'missing' : null);
  }

  function submitSource(event: FormEvent, observation: PersonalEntryObservation) {
    event.preventDefault();
    if (!viewer || !csrfToken || !sourceReviewed || !writeAllowed || sourceCommand || sourceChoice === 'keep') return;
    const privacy =
      sourceChoice === 'cleared'
        ? { op: 'clear' as const }
        : sourceChoice === 'private'
          ? { op: 'set' as const, value: { status: 'known' as const, meaning: 'private' as const } }
          : sourceChoice === 'visible'
            ? { op: 'set' as const, value: { status: 'known' as const, meaning: 'source_visible' as const } }
            : sourceChoice === 'absent'
              ? { op: 'set' as const, value: { status: 'absent' as const } }
              : { op: 'set' as const, value: { status: 'unknown' as const } };
    const command: PrivacyCommand = {
      subjectId: subject.id,
      viewer,
      csrfToken,
      key: crypto.randomUUID(),
      provider: observation.provider,
      recordId: observation.recordId,
      revision: observation.revision,
      privacy,
    };
    void sendSource(command);
  }

  const displayedSource = entry?.sourceObservations.find(
    (observation) => sourceEditor === observation.provider + '\u0000' + observation.recordId,
  );

  if (privateAuthorityRetired) {
    return (
      <p role="status" className="mt-4 text-sm text-muted-foreground">
        {m.library_rich_entry_signed_out()}
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
            disabled={!writeAllowed || annotationCommand !== null}
            onChange={(event) => setDraft({ ...workingDraft, note: event.currentTarget.value })}
          />
          <p className="text-sm text-muted-foreground">
            {m.library_rich_entry_note_bytes({ count: new TextEncoder().encode(workingDraft.note).byteLength })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              disabled={!writeAllowed || annotationCommand !== null}
              onClick={() => setDraft({ ...workingDraft, note: '' })}
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
            disabled={!writeAllowed || annotationCommand !== null}
            onChange={(event) => setDraft({ ...workingDraft, priority: event.currentTarget.value })}
          />
          <p className="text-sm text-muted-foreground">
            {entry.priority === null
              ? m.library_rich_entry_unranked()
              : m.library_rich_entry_priority_value({ value: entry.priority })}
          </p>
          <button
            type="button"
            className="min-h-11 rounded-md border px-3"
            disabled={!writeAllowed || annotationCommand !== null}
            onClick={() => setDraft({ ...workingDraft, priority: '' })}
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
              (conflictWaiting && reviewedRevision !== entry.annotationRevision)
            }
          >
            {m.library_rich_entry_save()}
          </button>
          {annotationCommand ? (
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
          {query.isFetching ? (
            <p>{m.library_rich_entry_refreshing()}</p>
          ) : entry.annotationRevision !== annotationConflictRevision ? (
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              onClick={() => {
                setReviewedRevision(entry.annotationRevision);
                setAnnotationNotice(null);
                setAnnotationConflictRevision(null);
              }}
            >
              {m.library_rich_entry_review_latest()}
            </button>
          ) : (
            <button type="button" className="min-h-11 rounded-md border px-3" onClick={() => void query.refetch()}>
              {m.library_selection_retry()}
            </button>
          )}
        </div>
      ) : null}

      <div className="space-y-3 border-t pt-4">
        <div>
          <h3 className="font-semibold">{m.library_rich_entry_sources()}</h3>
          <p className="text-sm text-muted-foreground">{m.library_rich_entry_sources_help()}</p>
        </div>
        {entry.sourceObservations.length === 0 ? (
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
                    onClick={() => openSource(observation)}
                  >
                    {m.library_rich_entry_edit_privacy()}
                  </button>
                  {open ? (
                    <form
                      className="mt-3 space-y-3 border-t pt-3"
                      onSubmit={(event) => submitSource(event, observation)}
                    >
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium">{m.library_rich_entry_privacy()}</span>
                        <select
                          className="min-h-11 w-full rounded-md border bg-background px-3"
                          value={sourceChoice}
                          disabled={sourceCommand !== null}
                          onChange={(event) => {
                            setSourceChoice(event.currentTarget.value);
                            setSourceReviewed(false);
                          }}
                        >
                          <option value="keep">{m.library_rich_entry_keep_privacy()}</option>
                          <option value="private">{m.library_rich_source_private()}</option>
                          <option value="visible">{m.library_rich_source_visible()}</option>
                          <option value="unknown">{m.library_rich_source_unknown()}</option>
                          <option value="absent">{m.library_rich_source_not_supplied()}</option>
                          <option value="cleared">{m.library_rich_source_cleared()}</option>
                        </select>
                      </label>
                      <label className="flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={sourceReviewed}
                          onChange={(event) => setSourceReviewed(event.currentTarget.checked)}
                        />
                        <span>{m.library_rich_entry_confirm_source()}</span>
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="submit"
                          className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
                          disabled={
                            !sourceReviewed || !writeAllowed || sourceCommand !== null || sourceChoice === 'keep'
                          }
                        >
                          {m.library_rich_entry_save_privacy()}
                        </button>
                        <button
                          type="button"
                          className="min-h-11 rounded-md border px-3"
                          onClick={() => setSourceEditor(null)}
                        >
                          {m.library_rich_entry_cancel()}
                        </button>
                        {sourceCommand ? (
                          <button
                            type="button"
                            className="min-h-11 rounded-md border px-3"
                            onClick={() => void sendSource(sourceCommand)}
                          >
                            {m.library_rich_entry_retry()}
                          </button>
                        ) : null}
                      </div>
                      {sourceNotice === 'uncertain' ? <p role="status">{m.library_rich_entry_uncertain()}</p> : null}
                      {sourceNotice === 'denied' ? <p role="status">{m.library_rich_entry_denied()}</p> : null}
                      {sourceNotice === 'missing' ? <p role="status">{m.library_rich_entry_missing()}</p> : null}
                      {sourceNotice === 'conflict' ? (
                        <div className="space-y-2" role="status">
                          <p>{m.library_rich_entry_source_conflict()}</p>
                          {query.isFetching ? (
                            <p>{m.library_rich_entry_refreshing()}</p>
                          ) : displayedSource && displayedSource.revision !== sourceConflictRevision ? (
                            <button
                              type="button"
                              className="min-h-11 rounded-md border px-3"
                              onClick={() => {
                                setSourceConflictRevision(null);
                                setSourceNotice(null);
                                setSourceReviewed(false);
                              }}
                            >
                              {m.library_rich_entry_review_latest()}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="min-h-11 rounded-md border px-3"
                              onClick={() => void query.refetch()}
                            >
                              {m.library_selection_retry()}
                            </button>
                          )}
                        </div>
                      ) : null}
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
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
