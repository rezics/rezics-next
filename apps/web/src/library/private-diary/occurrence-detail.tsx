import {
  buildJournalDraftPatch,
  emptyJournalDraft,
  journalDraftText,
  reviewJournalDraft,
  formatJournalDate,
  formatJournalAssessment,
  parseJournalDateText,
  MAX_JOURNAL_REFLECTION_CHARACTERS,
  MAX_JOURNAL_REFLECTION_BYTES,
  type JournalDraft,
  type JournalField,
  type JournalFieldDraft,
  type ProgressSessionJournalPatch,
} from '@rezics/progress';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, useId, type FormEvent, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../../kernel/exposure';
import { useSession } from '../../session/query';
import type { ProgressSessionView } from '../progress-reads';
import {
  correctOccurrenceJournal,
  readOccurrenceJournal,
  changeOccurrenceLifecycle,
  type JournalReadResult,
  type JournalPatch,
} from './occurrence-server';

import { historyReturn } from './address';

type JournalBody = JournalPatch;
type JournalCommand = {
  sessionId: string;
  viewer: string;
  csrfToken: string;
  key: string;
  body: JournalBody;
};
type LifecycleCommand = {
  action: 'reopen' | 'retire';
  sessionId: string;
  viewer: string;
  csrfToken: string;
  key: string;
  revision: number;
};

type PrivateJournal = Extract<JournalReadResult, { kind: 'ready' }>['journal'];
type JournalCustody = { command?: JournalCommand; flight?: object };
// Only the existing progress-reader lifetime can retain a dispatched command through a read replacement.
// This map contains no journal read, reflected draft or independent request identity.
const journalCommands = new WeakMap<object, JournalCustody>();
function journalCustody(lifetime: object | undefined): JournalCustody {
  if (!lifetime) return {};
  let retained = journalCommands.get(lifetime);
  if (!retained) journalCommands.set(lifetime, (retained = {}));
  return retained;
}

function draftFromPatch(patch: ProgressSessionJournalPatch): JournalDraft {
  const draft = { ...emptyJournalDraft() };
  for (const field of ['startDate', 'finishDate', 'reflection', 'assessment'] as const) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    draft[field] =
      value === null
        ? { kind: 'clear' }
        : {
            kind: 'set',
            text:
              field === 'startDate' || field === 'finishDate'
                ? formatJournalDate(patch[field] ?? null)
                : field === 'reflection'
                  ? (patch.reflection ?? '')
                  : formatJournalAssessment(patch.assessment!.units),
          };
  }
  return draft;
}

function freezeJournalCommand(command: JournalCommand): JournalCommand {
  const parsed = buildJournalDraftPatch(command.body.revision, draftFromPatch(command.body));
  if (!parsed.ok) throw new Error('Invalid journal draft');
  const body = structuredClone(parsed.patch);
  for (const field of ['startDate', 'finishDate', 'assessment'] as const)
    if (body[field] && typeof body[field] === 'object') Object.freeze(body[field]);
  return Object.freeze({ ...command, body: Object.freeze(body) });
}

function currentJournal(
  result: JournalReadResult | undefined,
  sessionId: string,
  viewer: string | null,
  csrfToken: string | null,
) {
  return result?.kind === 'ready' &&
    result.journal.sessionId === sessionId &&
    result.viewer === viewer &&
    result.csrfToken === csrfToken
    ? result.journal
    : null;
}

/** Replacement of an owner, credential, source or return visit cannot inherit private commands. */
export function PrivateOccurrenceControls(props: {
  session: ProgressSessionView;
  isCurrent: () => boolean;
  lifetime?: object | undefined;
}) {
  const owner = useSession();
  const location = useLocation();
  const read = useOperation('progress_session.read');
  const journalRead = useOperation('progress_session_journal.read');
  if (owner.state !== 'signed-in' || !owner.csrfToken || !read || !journalRead || !props.isCurrent())
    return <p role="status">{m.library_occurrence_unavailable()}</p>;
  return (
    <OccurrenceControls
      key={JSON.stringify([
        owner.subject,
        owner.csrfToken,
        props.session.id,
        props.session.subjectId,
        props.session.versionSubjectId,
        location.search.history,
      ])}
      {...props}
    />
  );
}

function OccurrenceControls({
  session,
  isCurrent,
  lifetime,
}: {
  session: ProgressSessionView;
  isCurrent: () => boolean;
  lifetime?: object | undefined;
}) {
  const router = useRouter();
  const location = useLocation();
  const returnSearch = historyReturn(location.search.history);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const flight = useRef(false);
  const [custody] = useState(() => journalCustody(lifetime));
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const readAllowed = useOperation('progress_session.read');
  const journalReadAllowed = useOperation('progress_session_journal.read');
  const journalUpdateAllowed = useOperation('progress_session_journal.update');
  const reopenAllowed = useOperation('progress_session.reopen');
  const retireAllowed = useOperation('progress_session.retire');
  const sessionState = useSession();
  const currentViewer = sessionState.state === 'signed-in' ? (sessionState.subject ?? null) : null;
  const csrfToken = sessionState.state === 'signed-in' ? (sessionState.csrfToken ?? null) : null;
  const enabled = readAllowed && journalReadAllowed && currentViewer !== null && csrfToken !== null && isCurrent();
  const queryKey = useMemo(
    () => ['private-occurrence-journal', currentViewer, csrfToken, session.id] as const,
    [currentViewer, csrfToken, session.id],
  );
  const query = useQuery<JournalReadResult>({
    queryKey,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await readOccurrenceJournal({ data: { sessionId: session.id } });
      signal.throwIfAborted();
      return result;
    },
  });
  const [acceptedJournal, setAcceptedJournal] = useState<{
    sessionId: string;
    viewer: string;
    csrfToken: string;
    journal: PrivateJournal;
  } | null>(null);
  const journal =
    acceptedJournal?.sessionId === session.id &&
    acceptedJournal.viewer === currentViewer &&
    acceptedJournal.csrfToken === csrfToken
      ? acceptedJournal.journal
      : currentJournal(query.data, session.id, currentViewer, csrfToken);
  const retainedCommand = custody.command;
  const retained =
    retainedCommand &&
    retainedCommand.sessionId === session.id &&
    retainedCommand.viewer === currentViewer &&
    retainedCommand.csrfToken === csrfToken
      ? retainedCommand
      : null;
  const [draft, setDraft] = useState<JournalDraft>(() =>
    retained ? draftFromPatch(retained.body) : emptyJournalDraft(),
  );
  const [review, setReview] = useState<JournalCommand | null>(retained);
  const working = journal
    ? {
        startDate: journalDraftText(journal, draft, 'startDate'),
        finishDate: journalDraftText(journal, draft, 'finishDate'),
        reflection: journalDraftText(journal, draft, 'reflection'),
        assessment: journalDraftText(journal, draft, 'assessment'),
      }
    : { startDate: '', finishDate: '', reflection: '', assessment: '' };
  const parsedDraft = buildJournalDraftPatch(journal?.revision ?? 0, draft);
  const body = parsedDraft.ok && parsedDraft.changedFields.length ? parsedDraft.patch : null;
  const [journalCommand, setJournalCommand] = useState<JournalCommand | null>(retained);
  const [journalNotice, setJournalNotice] = useState<
    'conflict' | 'uncertain' | 'acknowledged' | 'missing' | 'retired' | 'saved' | 'invalid' | null
  >(retained ? 'uncertain' : null);
  const [refusedField, setRefusedField] = useState<string | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [lifecycleCommand, setLifecycleCommand] = useState<LifecycleCommand | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<
    'conflict' | 'uncertain' | 'missing' | 'retired' | 'saved' | null
  >(null);
  const [lifecycleConflictRevision, setLifecycleConflictRevision] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<'reopen' | 'retire' | null>(null);
  const [terminal, setTerminal] = useState(false);
  const authority = useRef({ journalUpdateAllowed, reopenAllowed, retireAllowed, generation: 0 });
  if (
    authority.current.journalUpdateAllowed !== journalUpdateAllowed ||
    authority.current.reopenAllowed !== reopenAllowed ||
    authority.current.retireAllowed !== retireAllowed
  )
    authority.current = {
      journalUpdateAllowed,
      reopenAllowed,
      retireAllowed,
      generation: authority.current.generation + 1,
    };
  useEffect(() => {
    // Admission replacement can retire rendering, but cannot settle a dispatched command.
    setReview(custody.command ?? null);
    setJournalCommand(custody.command ?? null);
    setJournalNotice(custody.command ? 'uncertain' : null);
    setConflictRevision(null);
    setReviewedRevision(null);
    setLifecycleCommand(null);
    setLifecycleNotice(null);
    setLifecycleConflictRevision(null);
    setConfirmAction(null);
  }, [journalUpdateAllowed, reopenAllowed, retireAllowed]);

  const leaving = useRef(false);
  const currentRef = useRef({
    sessionId: session.id,
    viewer: currentViewer,
    csrfToken,
    isCurrent,
    enabled,
    journalUpdateAllowed,
    reopenAllowed,
    retireAllowed,
  });
  currentRef.current = {
    sessionId: session.id,
    viewer: currentViewer,
    csrfToken,
    isCurrent,
    enabled,
    journalUpdateAllowed,
    reopenAllowed,
    retireAllowed,
  };

  const stillCurrent = (command: { sessionId: string; viewer: string; csrfToken: string }) =>
    live.current &&
    currentRef.current.enabled &&
    currentRef.current.sessionId === command.sessionId &&
    currentRef.current.viewer === command.viewer &&
    currentRef.current.csrfToken === command.csrfToken &&
    currentRef.current.isCurrent();

  const leaveRetiredDetail = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setTerminal(true);
    queryClient.removeQueries({ queryKey });
    void router.navigate({ to: '/library/history', search: returnSearch ?? {} });
  }, [queryClient, queryKey, router, location.search.history]);

  useEffect(() => {
    if (query.data?.kind === 'missing' || query.data?.kind === 'retired') leaveRetiredDetail();
  }, [leaveRetiredDetail, query.data?.kind]);

  async function sendJournal(command: JournalCommand) {
    if (!currentRef.current.journalUpdateAllowed || !stillCurrent(command) || flight.current || custody.flight) return;
    if (custody.command && custody.command !== command) return;
    custody.command ??= command;
    const attempt = {};
    custody.flight = attempt;
    flight.current = true;
    const generation = authority.current.generation;
    setBusy(true);
    setJournalCommand(command);
    setJournalNotice(null);
    const result = await correctOccurrenceJournal({ data: command }).catch(() => ({ kind: 'uncertain' as const }));
    if (custody.flight === attempt) delete custody.flight;
    flight.current = false;
    if (!stillCurrent(command)) return;
    setBusy(false);
    if (generation !== authority.current.generation) return;
    if (!currentRef.current.journalUpdateAllowed) {
      setJournalCommand(null);
      setJournalNotice(null);
      return;
    }
    if (result.kind === 'saved') {
      setAcceptedJournal({
        sessionId: command.sessionId,
        viewer: command.viewer,
        csrfToken: command.csrfToken,
        journal: result.journal,
      });
      delete custody.command;
      setDraft(emptyJournalDraft());
      setReview(null);
      setJournalNotice('saved');
      setJournalCommand(null);
      setConflictRevision(null);
      setReviewedRevision(null);
      return;
    }
    if (result.kind === 'conflict') {
      delete custody.command;
      setReview(null);
      setAcceptedJournal(null);
      setJournalCommand(null);
      setConflictRevision(command.body.revision);
      setReviewedRevision(null);
      setJournalNotice('conflict');
      return;
    }
    if (result.kind === 'uncertain' || result.kind === 'acknowledged') {
      setJournalCommand(command);
      setJournalNotice(result.kind);
      return;
    }
    delete custody.command;
    setJournalCommand(null);
    setReview(null);
    if (result.kind === 'invalid') {
      setRefusedField(result.field);
      setJournalNotice('invalid');
      return;
    }
    setJournalNotice(result.kind);
    if (result.kind === 'missing' || result.kind === 'retired') {
      leaveRetiredDetail();
    }
  }

  function submitJournal(event: FormEvent) {
    event.preventDefault();
    if (
      !journal ||
      !body ||
      !journalUpdateAllowed ||
      journalCommand ||
      busy ||
      terminal ||
      !currentViewer ||
      !csrfToken
    )
      return;
    if (conflictRevision !== null && reviewedRevision !== journal.revision) return;
    const command = freezeJournalCommand({
      sessionId: session.id,
      viewer: currentViewer,
      csrfToken,
      key: crypto.randomUUID(),
      body: { ...body, revision: conflictRevision === null ? journal.revision : reviewedRevision! },
    });
    setReview(command);
    setJournalNotice(null);
    setRefusedField(null);
  }

  async function submitLifecycle(command: LifecycleCommand) {
    if (
      !(command.action === 'reopen' ? currentRef.current.reopenAllowed : currentRef.current.retireAllowed) ||
      !stillCurrent(command) ||
      flight.current
    )
      return;
    flight.current = true;
    const generation = authority.current.generation;
    setBusy(true);
    setLifecycleNotice(null);
    const result = await changeOccurrenceLifecycle({ data: command }).catch(() => ({ kind: 'uncertain' as const }));
    flight.current = false;
    if (!stillCurrent(command)) return;
    setBusy(false);
    if (generation !== authority.current.generation) return;
    if (!(command.action === 'reopen' ? currentRef.current.reopenAllowed : currentRef.current.retireAllowed)) {
      setLifecycleCommand(null);
      setLifecycleNotice(null);
      return;
    }
    if (result.kind === 'saved') {
      setLifecycleCommand(null);
      setConfirmAction(null);
      setLifecycleConflictRevision(null);
      if (result.session.state === 'retired') {
        leaveRetiredDetail();
      }
      setLifecycleNotice('saved');
      void router.invalidate();
      return;
    }
    if (result.kind === 'conflict') {
      setLifecycleCommand(null);
      setConfirmAction(null);
      setLifecycleConflictRevision(command.revision);
      setLifecycleNotice('conflict');
      void router.invalidate();
      return;
    }
    if (result.kind === 'uncertain') {
      setLifecycleCommand(command);
      setLifecycleNotice('uncertain');
      return;
    }
    setLifecycleCommand(null);
    setLifecycleNotice(result.kind);
    if (result.kind === 'missing' || result.kind === 'retired') {
      leaveRetiredDetail();
    }
  }

  function chooseLifecycle(action: 'reopen' | 'retire') {
    if (
      !(action === 'reopen' ? reopenAllowed : retireAllowed) ||
      !isCurrent() ||
      !currentViewer ||
      !csrfToken ||
      terminal ||
      busy ||
      journalCommand !== null ||
      review !== null ||
      lifecycleConflictRevision !== null
    )
      return;
    setConfirmAction(action);
    setLifecycleCommand({
      action,
      sessionId: session.id,
      viewer: currentViewer,
      csrfToken,
      revision: session.revision,
      key: crypto.randomUUID(),
    });
  }

  if (terminal || query.data?.kind === 'missing' || query.data?.kind === 'retired') {
    return (
      <section className="space-y-2 border-t pt-4" aria-live="polite">
        <h2 className="font-semibold">{m.library_occurrence_heading()}</h2>
        <p>{m.library_occurrence_retired()}</p>
        <Link
          className="inline-flex min-h-11 items-center rounded-md border px-3"
          to="/library/history"
          search={returnSearch ?? {}}
        >
          {m.library_diary_return()}
        </Link>
      </section>
    );
  }

  return (
    <section className="space-y-4 border-t pt-4">
      <div>
        <h2 className="text-lg font-semibold">{m.library_occurrence_heading()}</h2>
        <p className="text-sm text-muted-foreground">{m.library_occurrence_private_help()}</p>
      </div>

      {returnSearch ? (
        <Link
          className="inline-flex min-h-11 items-center rounded-md border px-3"
          to="/library/history"
          search={returnSearch}
        >
          {m.library_diary_heading()}
        </Link>
      ) : null}
      {query.isPending ? <p role="status">{m.library_occurrence_loading()}</p> : null}
      {query.data?.kind === 'unavailable' ? (
        <div className="space-y-2">
          <p role="status">{m.library_occurrence_unavailable()}</p>
          <button type="button" className="min-h-11 rounded-md border px-3" onClick={() => void query.refetch()}>
            {m.library_selection_retry()}
          </button>
        </div>
      ) : null}

      {journal ? <JournalSavedReadout journal={journal} observedOnly={journalCommand !== null} /> : null}
      {journal ? (
        <form className="space-y-4" onSubmit={submitJournal} noValidate>
          <p className="text-sm text-muted-foreground">{m.library_occurrence_date_help()}</p>
          <p className="text-sm text-muted-foreground">{m.library_journal_selection_help()}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {(['startDate', 'finishDate', 'assessment', 'reflection'] as const).map((field) => (
              <JournalFieldEditor
                key={field}
                field={field}
                selection={draft[field]}
                value={working[field]}
                disabled={!journalUpdateAllowed || journalCommand !== null || busy || review !== null}
                invalid={!parsedDraft.ok && parsedDraft.field === field}
                refused={refusedField === field}
                onChange={(selection) => {
                  if (!enabled || !isCurrent() || !journalUpdateAllowed || custody.command || custody.flight || review)
                    return;
                  setDraft((current) => ({ ...current, [field]: selection }));
                  // Editing a retained field cannot remove the only current-read/re-review recovery.
                  setJournalNotice(
                    conflictRevision !== null && reviewedRevision !== journal.revision ? 'conflict' : null,
                  );
                  setRefusedField(null);
                }}
              />
            ))}
          </div>
          {journalNotice === 'invalid' ? (
            <p role="alert">{m.library_journal_native_refusal({ field: journalFieldLabel(refusedField) })}</p>
          ) : null}
          {review ? (
            <JournalDraftReview journal={journal} draft={draftFromPatch(review.body)} revision={review.body.revision}>
              <Button
                type="button"
                disabled={busy || !journalUpdateAllowed || !!custody.flight}
                onClick={() => void sendJournal(review)}
              >
                {journalCommand ? m.library_rich_entry_retry() : m.library_occurrence_save()}
              </Button>
              {!journalCommand ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (isCurrent() && !custody.command) setReview(null);
                  }}
                >
                  {m.library_journal_correct_draft()}
                </Button>
              ) : null}
            </JournalDraftReview>
          ) : (
            <Button
              type="submit"
              disabled={
                !journalUpdateAllowed ||
                busy ||
                !body ||
                journalCommand !== null ||
                (conflictRevision !== null && reviewedRevision !== journal.revision)
              }
            >
              {m.library_journal_review()}
            </Button>
          )}
          {journalCommand ? (
            <div className="space-y-2">
              <p role="status">
                {journalNotice === 'acknowledged'
                  ? m.library_occurrence_acknowledged()
                  : m.library_occurrence_uncertain()}
              </p>
              <p className="text-sm text-muted-foreground">{m.library_journal_retry_identity()}</p>
              <Button
                type="button"
                variant="outline"
                disabled={busy || query.isFetching}
                onClick={() => {
                  if (isCurrent()) void query.refetch();
                }}
              >
                {m.library_occurrence_read_current()}
              </Button>
              {query.data?.kind === 'ready' ? (
                <p role="status">
                  {m.library_occurrence_observed({
                    revision: query.data.journal.revision,
                    assessment:
                      query.data.journal.assessment.units === null
                        ? '—'
                        : formatJournalAssessment(query.data.journal.assessment.units),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          {journalNotice === 'saved' ? <p role="status">{m.library_journal_saved()}</p> : null}
          {journalNotice === 'conflict' ? (
            <div className="space-y-3 rounded-md border p-3">
              <p role="alert">{m.library_occurrence_conflict()}</p>
              <p>{m.library_journal_draft_retained()}</p>
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetching || busy}
                onClick={() => {
                  if (isCurrent()) void query.refetch();
                }}
              >
                {m.library_occurrence_read_current()}
              </Button>
              {journal.revision !== conflictRevision ? (
                <>
                  <JournalDraftReview journal={journal} draft={draft} revision={journal.revision} />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (!isCurrent() || custody.command || custody.flight) return;
                      setReviewedRevision(journal.revision);
                      setJournalNotice(null);
                      setReview(null);
                    }}
                  >
                    {m.library_occurrence_review_latest()}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          {lifecycleConflictRevision !== null ? (
            <div role="group" aria-label={m.library_occurrence_conflict()} className="space-y-2">
              <p>{m.library_occurrence_conflict()}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!isCurrent()) return;
                  if (session.revision !== lifecycleConflictRevision) {
                    setLifecycleConflictRevision(null);
                    setLifecycleNotice(null);
                  } else void router.invalidate();
                }}
              >
                {session.revision !== lifecycleConflictRevision
                  ? m.library_occurrence_review_latest()
                  : m.library_occurrence_read_current()}
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}

      {reopenAllowed || retireAllowed ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {reopenAllowed && (session.state === 'completed' || session.state === 'abandoned') ? (
              <button
                type="button"
                className="min-h-11 rounded-md border px-3"
                disabled={lifecycleConflictRevision !== null || busy || journalCommand !== null || review !== null}
                onClick={() => chooseLifecycle('reopen')}
              >
                {m.library_occurrence_reopen()}
              </button>
            ) : null}
            {retireAllowed ? (
              <button
                type="button"
                className="min-h-11 rounded-md border px-3"
                disabled={lifecycleConflictRevision !== null || busy || journalCommand !== null || review !== null}
                onClick={() => chooseLifecycle('retire')}
              >
                {m.library_occurrence_retire()}
              </button>
            ) : null}
          </div>
          {confirmAction ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label={m.library_occurrence_confirm_heading()}>
              <p className="w-full">
                {confirmAction === 'reopen'
                  ? m.library_occurrence_confirm_reopen()
                  : m.library_occurrence_confirm_retire()}
              </p>
              <button
                type="button"
                className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground"
                disabled={busy}
                onClick={() => lifecycleCommand && void submitLifecycle(lifecycleCommand)}
              >
                {m.library_occurrence_confirm_heading()}
              </button>
              <button
                type="button"
                className="min-h-11 rounded-md border px-3"
                onClick={() => {
                  setConfirmAction(null);
                  setLifecycleCommand(null);
                }}
              >
                {m.library_progress_cancel()}
              </button>
            </div>
          ) : null}
          {lifecycleCommand && lifecycleNotice === 'uncertain' ? (
            <button
              type="button"
              className="min-h-11 rounded-md border px-3"
              disabled={busy}
              onClick={() => void submitLifecycle(lifecycleCommand)}
            >
              {m.library_rich_entry_retry()}
            </button>
          ) : null}
          {lifecycleNotice === 'uncertain' ? <p role="status">{m.library_occurrence_uncertain()}</p> : null}
          {lifecycleNotice === 'saved' ? <p role="status">{m.library_occurrence_reopened()}</p> : null}
          {lifecycleNotice === 'missing' || lifecycleNotice === 'retired' ? (
            <p role="status">{m.library_occurrence_retired()}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function journalFieldLabel(field: string | null): string {
  if (field === 'startDate') return m.library_occurrence_start_date();
  if (field === 'finishDate') return m.library_occurrence_finish_date();
  if (field === 'reflection') return m.library_occurrence_reflection();
  if (field === 'assessment') return m.library_occurrence_assessment();
  return m.library_occurrence_heading();
}

function journalSelectionLabel(selection: JournalFieldDraft): string {
  if (selection.kind === 'untouched') return m.library_journal_untouched();
  if (selection.kind === 'clear') return m.library_journal_clear_selected();
  return m.library_journal_value_selected();
}

/** Selection status stays next to the control, including when Clear and an empty text look alike. */
function JournalFieldEditor({
  field,
  selection,
  value,
  disabled,
  invalid,
  refused,
  onChange,
}: {
  field: JournalField;
  selection: JournalFieldDraft;
  value: string;
  disabled: boolean;
  invalid: boolean;
  refused: boolean;
  onChange: (selection: JournalFieldDraft) => void;
}) {
  const id = useId();
  const error = `${id}-error`;
  const help = `${id}-help`;
  const status = `${id}-selection`;
  const date = field === 'startDate' || field === 'finishDate';
  const description =
    field === 'reflection'
      ? m.library_journal_reflection_limit({
          characters: MAX_JOURNAL_REFLECTION_CHARACTERS,
          bytes: MAX_JOURNAL_REFLECTION_BYTES,
        })
      : field === 'assessment'
        ? m.library_occurrence_assessment_help()
        : m.library_occurrence_date_help();
  const characters = field === 'reflection' ? Array.from(value).length : 0;
  const bytes = field === 'reflection' ? new TextEncoder().encode(value).byteLength : 0;
  const clearLabel = date
    ? m.library_occurrence_clear_date()
    : field === 'reflection'
      ? m.library_occurrence_clear_reflection()
      : m.library_occurrence_clear_assessment();
  return (
    <div className={field === 'reflection' ? 'space-y-2 md:col-span-2' : 'space-y-2'}>
      <label htmlFor={id} className="block text-sm font-medium">
        {journalFieldLabel(field)}
      </label>
      <p id={help} className="text-sm text-muted-foreground">
        {description}
      </p>
      {field === 'reflection' ? (
        <Textarea
          id={id}
          value={value}
          disabled={disabled}
          className="min-h-28"
          aria-invalid={invalid || refused}
          aria-describedby={`${help} ${status}${invalid || refused ? ` ${error}` : ''}`}
          onChange={(event) => onChange({ kind: 'set', text: event.currentTarget.value })}
        />
      ) : (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          inputMode={date ? 'text' : 'decimal'}
          aria-invalid={invalid || refused}
          aria-describedby={`${help} ${status}${invalid || refused ? ` ${error}` : ''}`}
          onChange={(event) => onChange({ kind: 'set', text: event.currentTarget.value })}
        />
      )}
      <p id={status} className="text-sm font-medium" data-journal-selection={selection.kind}>
        {journalSelectionLabel(selection)}
      </p>
      {field === 'reflection' ? (
        <p className="text-sm text-muted-foreground">{m.library_journal_reflection_count({ characters, bytes })}</p>
      ) : selection.kind === 'set' && date && parseJournalDateText(value) !== null ? (
        <p className="text-sm text-muted-foreground">
          {value.length === 4
            ? m.library_journal_precision_year()
            : value.length === 7
              ? m.library_journal_precision_month()
              : m.library_journal_precision_day()}
        </p>
      ) : null}
      {invalid || refused ? (
        <p id={error} role="alert" className="text-sm text-destructive">
          {refused
            ? m.library_journal_native_refusal({ field: journalFieldLabel(field) })
            : date
              ? m.library_occurrence_date_invalid()
              : field === 'assessment'
                ? m.library_occurrence_assessment_help()
                : m.library_journal_reflection_limit({
                    characters: MAX_JOURNAL_REFLECTION_CHARACTERS,
                    bytes: MAX_JOURNAL_REFLECTION_BYTES,
                  })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || selection.kind === 'clear'}
          onClick={() => onChange({ kind: 'clear' })}
        >
          {clearLabel}
        </Button>
        {selection.kind !== 'untouched' ? (
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange({ kind: 'untouched' })}>
            {m.library_journal_preserve_field()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function JournalValue({ value }: { value: string | null }) {
  if (value === null) return <span className="text-muted-foreground">{m.library_journal_no_value()}</span>;
  if (value === '') return <span className="text-muted-foreground">{m.library_journal_empty_text()}</span>;
  return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</span>;
}

/** Review shows every preserved field as well as the deliberately addressed changes. */
function JournalDraftReview({
  journal,
  draft,
  revision,
  children,
}: {
  journal: PrivateJournal;
  draft: JournalDraft;
  revision: number;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label={m.library_journal_review()}>
      <h3 className="font-semibold">{m.library_journal_review()}</h3>
      <p className="text-sm text-muted-foreground">{m.library_journal_review_basis({ revision })}</p>
      <p className="text-sm text-muted-foreground">{m.library_occurrence_private_help()}</p>
      <dl className="space-y-4">
        {reviewJournalDraft(journal, draft).map((field) => (
          <div key={field.field} className="space-y-2 border-b pb-3 last:border-0">
            <dt className="font-medium">{journalFieldLabel(field.field)}</dt>
            <dd className="space-y-2">
              <p className="text-sm font-medium">{journalSelectionLabel(draft[field.field])}</p>
              {field.kind !== 'untouched' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-muted-foreground">{m.library_journal_current_value()}</p>
                    <JournalValue value={field.before} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-muted-foreground">{m.library_journal_after_save()}</p>
                    <JournalValue value={field.after} />
                  </div>
                </div>
              ) : (
                <JournalValue value={field.before} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </section>
  );
}

/** Current read values are rendered independently of the captured write and its receipt. */
function JournalSavedReadout({ journal, observedOnly }: { journal: PrivateJournal; observedOnly: boolean }) {
  const datePrecision = (date: PrivateJournal['startDate']) =>
    date === null
      ? null
      : date.day !== undefined
        ? m.library_journal_precision_day()
        : date.month !== undefined
          ? m.library_journal_precision_month()
          : m.library_journal_precision_year();
  return (
    <section className="space-y-4 rounded-lg border p-4" aria-label={m.library_journal_current_value()}>
      <div className="space-y-1">
        <h3 className="font-medium">{m.library_journal_current_value()}</h3>
        <p className="text-sm text-muted-foreground">
          {m.library_journal_current_revision({ revision: journal.revision })}
        </p>
        {observedOnly ? (
          <p role="status" className="text-sm">
            {m.library_journal_observation_only()}
          </p>
        ) : null}
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        {(['startDate', 'finishDate'] as const).map((field) => (
          <div key={field} className="space-y-1">
            <dt className="text-sm text-muted-foreground">{journalFieldLabel(field)}</dt>
            <dd className="space-y-1">
              <JournalValue value={journal[field] === null ? null : formatJournalDate(journal[field])} />
              {journal[field] !== null ? (
                <p className="text-sm text-muted-foreground">{datePrecision(journal[field])}</p>
              ) : null}
            </dd>
          </div>
        ))}
        <div className="space-y-1">
          <dt className="text-sm text-muted-foreground">{m.library_occurrence_assessment()}</dt>
          <dd>
            <JournalValue
              value={journal.assessment.units === null ? null : formatJournalAssessment(journal.assessment.units)}
            />
          </dd>
          <dd className="text-sm text-muted-foreground">{m.library_occurrence_assessment_help()}</dd>
        </div>
        <div className="min-w-0 space-y-1 sm:col-span-2">
          <dt className="text-sm text-muted-foreground">{m.library_occurrence_reflection()}</dt>
          <dd>
            {journal.reflection !== null && journal.reflection.length > 160 ? (
              <details className="space-y-2">
                <summary className="min-h-10 cursor-pointer content-center">
                  {m.library_journal_show_reflection()}
                </summary>
                <JournalValue value={journal.reflection} />
              </details>
            ) : (
              <JournalValue value={journal.reflection} />
            )}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{m.library_journal_reported_dates()}</p>
    </section>
  );
}
