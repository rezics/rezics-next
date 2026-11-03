import { Link, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../../kernel/exposure';
import { useSession } from '../../session/query';
import type { ProgressSessionView } from '../progress-reads';
import {
  correctOccurrenceJournal,
  readOccurrenceJournal,
  changeOccurrenceLifecycle,
  type JournalReadResult,
} from './occurrence-server';

type DateShape = { year: number; month?: number; day?: number };
type JournalDraft = { startDate: string; finishDate: string; reflection: string };
type JournalBody = {
  revision: number;
  startDate?: DateShape | null;
  finishDate?: DateShape | null;
  reflection?: string | null;
};
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

function dateText(value: DateShape | null): string {
  if (!value) return '';
  const year = String(value.year).padStart(4, '0');
  if (value.month === undefined) return year;
  const month = String(value.month).padStart(2, '0');
  return value.day === undefined ? year + '-' + month : year + '-' + month + '-' + String(value.day).padStart(2, '0');
}

function parseDate(value: string): DateShape | null | 'invalid' {
  if (value === '') return null;
  const match = /^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?$/.exec(value);
  if (!match) return 'invalid';
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (year < 1 || (month !== undefined && (month < 1 || month > 12))) return 'invalid';
  if (day !== undefined) {
    if (month === undefined) return 'invalid';
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    if (day < 1 || day > days) return 'invalid';
  }
  return {
    year,
    ...(month === undefined ? {} : { month }),
    ...(day === undefined ? {} : { day }),
  };
}

type PrivateJournal = Extract<JournalReadResult, { kind: 'ready' }>['journal'];

function journalDraft(journal: PrivateJournal): JournalDraft {
  return {
    startDate: dateText(journal.startDate),
    finishDate: dateText(journal.finishDate),
    reflection: journal.reflection ?? '',
  };
}

function changedJournalBody(revision: number, current: JournalDraft, draft: JournalDraft): JournalBody | null {
  const body: JournalBody = { revision };
  let changed = false;
  if (current.startDate !== draft.startDate) {
    const date = parseDate(draft.startDate);
    if (date === 'invalid') return null;
    body.startDate = date;
    changed = true;
  }
  if (current.finishDate !== draft.finishDate) {
    const date = parseDate(draft.finishDate);
    if (date === 'invalid') return null;
    body.finishDate = date;
    changed = true;
  }
  if (current.reflection !== draft.reflection) {
    body.reflection = draft.reflection === '' ? null : draft.reflection;
    changed = true;
  }
  return changed ? body : null;
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

export function PrivateOccurrenceControls({
  session,
  isCurrent,
}: {
  session: ProgressSessionView;
  isCurrent: () => boolean;
}) {
  const router = useRouter();
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
  const [draft, setDraft] = useState<JournalDraft | null>(null);
  const working = draft ?? (journal ? journalDraft(journal) : { startDate: '', finishDate: '', reflection: '' });
  const body = journal ? changedJournalBody(journal.revision, journalDraft(journal), working) : null;
  const [journalCommand, setJournalCommand] = useState<JournalCommand | null>(null);
  const [journalNotice, setJournalNotice] = useState<'conflict' | 'uncertain' | 'missing' | 'retired' | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const [lifecycleCommand, setLifecycleCommand] = useState<LifecycleCommand | null>(null);
  const [lifecycleNotice, setLifecycleNotice] = useState<
    'conflict' | 'uncertain' | 'missing' | 'retired' | 'saved' | null
  >(null);
  const [lifecycleConflictRevision, setLifecycleConflictRevision] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<'reopen' | 'retire' | null>(null);
  const [terminal, setTerminal] = useState(false);
  const leaving = useRef(false);
  const currentRef = useRef({ sessionId: session.id, viewer: currentViewer, csrfToken, isCurrent });
  currentRef.current = { sessionId: session.id, viewer: currentViewer, csrfToken, isCurrent };

  const stillCurrent = (command: { sessionId: string; viewer: string; csrfToken: string }) =>
    currentRef.current.sessionId === command.sessionId &&
    currentRef.current.viewer === command.viewer &&
    currentRef.current.csrfToken === command.csrfToken &&
    currentRef.current.isCurrent();

  const leaveRetiredDetail = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setTerminal(true);
    queryClient.removeQueries({ queryKey });
    void router.navigate({ to: '/library/history' });
  }, [queryClient, queryKey, router]);

  useEffect(() => {
    if (query.data?.kind === 'missing' || query.data?.kind === 'retired') leaveRetiredDetail();
  }, [leaveRetiredDetail, query.data?.kind]);

  async function sendJournal(command: JournalCommand) {
    if (!journalUpdateAllowed || !stillCurrent(command)) return;
    setJournalNotice(null);
    const result = await correctOccurrenceJournal({ data: command });
    if (!stillCurrent(command)) return;
    if (result.kind === 'saved') {
      setAcceptedJournal({
        sessionId: command.sessionId,
        viewer: command.viewer,
        csrfToken: command.csrfToken,
        journal: result.journal,
      });
      setDraft(null);
      setJournalCommand(null);
      setConflictRevision(null);
      setReviewedRevision(null);
      return;
    }
    if (result.kind === 'conflict') {
      setAcceptedJournal(null);
      setJournalCommand(null);
      setConflictRevision(command.body.revision);
      setReviewedRevision(null);
      setJournalNotice('conflict');
      void query.refetch();
      return;
    }
    if (result.kind === 'uncertain') {
      setJournalCommand(command);
      setJournalNotice('uncertain');
      return;
    }
    setJournalCommand(null);
    setJournalNotice(result.kind);
    if (result.kind === 'missing' || result.kind === 'retired') {
      leaveRetiredDetail();
    }
  }

  function submitJournal(event: FormEvent) {
    event.preventDefault();
    if (!journal || !body || !journalUpdateAllowed || journalCommand || terminal || !currentViewer || !csrfToken)
      return;
    if (conflictRevision !== null && reviewedRevision !== journal.revision) return;
    const command: JournalCommand = {
      sessionId: session.id,
      viewer: currentViewer,
      csrfToken,
      key: crypto.randomUUID(),
      body: { ...body, revision: conflictRevision === null ? journal.revision : reviewedRevision! },
    };
    void sendJournal(command);
  }

  async function submitLifecycle(command: LifecycleCommand) {
    if (!(command.action === 'reopen' ? reopenAllowed : retireAllowed) || !stillCurrent(command)) return;
    setLifecycleNotice(null);
    const result = await changeOccurrenceLifecycle({ data: command });
    if (!stillCurrent(command)) return;
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
        <Link className="inline-flex min-h-11 items-center rounded-md border px-3" to="/library/history">
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

      {query.isPending ? <p role="status">{m.library_occurrence_loading()}</p> : null}
      {query.data?.kind === 'unavailable' ? (
        <div className="space-y-2">
          <p role="status">{m.library_occurrence_unavailable()}</p>
          <button type="button" className="min-h-11 rounded-md border px-3" onClick={() => void query.refetch()}>
            {m.library_selection_retry()}
          </button>
        </div>
      ) : null}

      {journal ? (
        <form className="space-y-4" onSubmit={submitJournal}>
          <p id="library-occurrence-date-help" className="text-sm text-muted-foreground">
            {m.library_occurrence_date_help()}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{m.library_occurrence_start_date()}</span>
              <input
                className="min-h-11 w-full rounded-md border bg-background px-3"
                inputMode="numeric"
                aria-describedby="library-occurrence-date-help"
                value={working.startDate}
                disabled={!journalUpdateAllowed || journalCommand !== null}
                onChange={(event) => setDraft({ ...working, startDate: event.currentTarget.value })}
              />
              <button
                type="button"
                className="mt-2 min-h-11 rounded-md border px-3"
                disabled={!journalUpdateAllowed || journalCommand !== null}
                onClick={() => setDraft({ ...working, startDate: '' })}
              >
                {m.library_occurrence_clear_date()}
              </button>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{m.library_occurrence_finish_date()}</span>
              <input
                className="min-h-11 w-full rounded-md border bg-background px-3"
                inputMode="numeric"
                aria-describedby="library-occurrence-date-help"
                value={working.finishDate}
                disabled={!journalUpdateAllowed || journalCommand !== null}
                onChange={(event) => setDraft({ ...working, finishDate: event.currentTarget.value })}
              />
              <button
                type="button"
                className="mt-2 min-h-11 rounded-md border px-3"
                disabled={!journalUpdateAllowed || journalCommand !== null}
                onClick={() => setDraft({ ...working, finishDate: '' })}
              >
                {m.library_occurrence_clear_date()}
              </button>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{m.library_occurrence_reflection()}</span>
            <textarea
              className="min-h-28 w-full rounded-md border bg-background p-3"
              value={working.reflection}
              disabled={!journalUpdateAllowed || journalCommand !== null}
              onChange={(event) => setDraft({ ...working, reflection: event.currentTarget.value })}
            />
            <button
              type="button"
              className="mt-2 min-h-11 rounded-md border px-3"
              disabled={!journalUpdateAllowed || journalCommand !== null}
              onClick={() => setDraft({ ...working, reflection: '' })}
            >
              {m.library_occurrence_clear_reflection()}
            </button>
          </label>
          {body === null &&
          ((working.startDate !== dateText(journal.startDate) && parseDate(working.startDate) === 'invalid') ||
            (working.finishDate !== dateText(journal.finishDate) && parseDate(working.finishDate) === 'invalid')) ? (
            <p role="alert">{m.library_occurrence_date_invalid()}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="min-h-11 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50"
              disabled={
                !journalUpdateAllowed ||
                !body ||
                journalCommand !== null ||
                (conflictRevision !== null && reviewedRevision !== journal.revision)
              }
            >
              {m.library_occurrence_save()}
            </button>
            {journalCommand ? (
              <button
                type="button"
                className="min-h-11 rounded-md border px-3"
                onClick={() => void sendJournal(journalCommand)}
              >
                {m.library_rich_entry_retry()}
              </button>
            ) : null}
          </div>
          {journalNotice === 'uncertain' ? <p role="status">{m.library_occurrence_uncertain()}</p> : null}
          {journalNotice === 'conflict' ? (
            <div className="rounded-md border p-3">
              <p>{m.library_occurrence_conflict()}</p>
              {journal.revision !== conflictRevision ? (
                <button
                  type="button"
                  className="mt-2 min-h-11 rounded-md border px-3"
                  onClick={() => {
                    setReviewedRevision(journal.revision);
                    setConflictRevision(journal.revision);
                    setJournalNotice(null);
                  }}
                >
                  {m.library_occurrence_review_latest()}
                </button>
              ) : (
                <button
                  type="button"
                  className="mt-2 min-h-11 rounded-md border px-3"
                  onClick={() => void query.refetch()}
                >
                  {m.library_selection_retry()}
                </button>
              )}
            </div>
          ) : null}
          {lifecycleConflictRevision !== null ? (
            <div
              role="group"
              aria-label={m.library_occurrence_conflict()}
              className="flex flex-wrap items-center gap-2"
            >
              <p>{m.library_occurrence_conflict()}</p>
              {session.revision !== lifecycleConflictRevision ? (
                <button
                  type="button"
                  className="min-h-11 rounded-md border px-3"
                  onClick={() => {
                    setLifecycleConflictRevision(null);
                    setLifecycleNotice(null);
                  }}
                >
                  {m.library_occurrence_review_latest()}
                </button>
              ) : (
                <button
                  type="button"
                  className="min-h-11 rounded-md border px-3"
                  onClick={() => void router.invalidate()}
                >
                  {m.library_selection_retry()}
                </button>
              )}
            </div>
          ) : null}
          {journalNotice === 'missing' || journalNotice === 'retired' ? (
            <p role="status">{m.library_occurrence_retired()}</p>
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
                disabled={lifecycleConflictRevision !== null}
                onClick={() => chooseLifecycle('reopen')}
              >
                {m.library_occurrence_reopen()}
              </button>
            ) : null}
            {retireAllowed ? (
              <button
                type="button"
                className="min-h-11 rounded-md border px-3"
                disabled={lifecycleConflictRevision !== null}
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
