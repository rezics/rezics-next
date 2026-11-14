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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
  type FormEvent,
  type ReactNode,
} from 'react';
import { m } from '../../paraglide/messages.js';
import { useOperation } from '../application';
import { useSession } from '../application';
import type { ProgressSessionView } from '../progress-reads';
import {
  correctOccurrenceJournal,
  readOccurrenceJournal,
  changeOccurrenceLifecycle,
  type JournalReadResult,
  type JournalPatch,
} from './occurrence-server';

import { historyReturn } from './address';
import { PrivateJournalDraftNavigation, usePrivateJournalDraftNavigation } from './draft-navigation';

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

type LifecycleIntent = Readonly<{
  data: Readonly<LifecycleCommand>;
  send: typeof changeOccurrenceLifecycle;
}>;

type PrivateJournal = Extract<JournalReadResult, { kind: 'ready' }>['journal'];
type JournalCustody = {
  command?: JournalCommand;
  basis?: PrivateJournal;
  flight?: object;
  listeners?: Set<() => void>;
  lifecycle?: LifecycleIntent;
  lifecycleFlight?: object;
  lifecycleConflictRevision?: number;
};
// Only the existing progress-reader lifetime can retain a dispatched command through a read replacement.
// Only a dispatched command and its original comparison survive here. Neither authorizes a current read.
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
  const identity = JSON.stringify([
    owner.state,
    owner.subject,
    owner.csrfToken,
    props.session.id,
    props.session.subjectId,
    props.session.versionSubjectId,
    location.search.history,
    read,
    journalRead,
  ]);
  const source = useRef({ lifetime: props.lifetime, identity, generation: 0 });
  if (source.current.lifetime !== props.lifetime || source.current.identity !== identity) {
    const previous = source.current.lifetime && journalCommands.get(source.current.lifetime);
    if (previous) {
      delete previous.lifecycle;
      delete previous.lifecycleConflictRevision;
    }
    source.current = { lifetime: props.lifetime, identity, generation: source.current.generation + 1 };
  }
  if (owner.state !== 'signed-in' || !owner.csrfToken || !read || !journalRead || !props.isCurrent()) {
    const previous = props.lifetime && journalCommands.get(props.lifetime);
    if (previous) {
      delete previous.lifecycle;
      delete previous.lifecycleConflictRevision;
    }
    return <p role="status">{m.library_occurrence_unavailable()}</p>;
  }
  return (
    <PrivateJournalDraftNavigation
      key={JSON.stringify([
        owner.subject,
        owner.csrfToken,
        props.session.id,
        props.session.subjectId,
        props.session.versionSubjectId,
        location.search.history,
        source.current.generation,
      ])}
    >
      <OccurrenceControls {...props} />
    </PrivateJournalDraftNavigation>
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
  useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        (custody.listeners ??= new Set()).add(listener);
        return () => {
          custody.listeners!.delete(listener);
        };
      },
      [custody],
    ),
    () => custody.flight ?? custody.lifecycleFlight,
    () => undefined,
  );
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
  // Reference equality identifies only the selections actually sent. Later edits get new selections.
  const submittedDraft = useRef<JournalDraft | null>(retained ? draft : null);
  const [review, setReview] = useState<JournalCommand | null>(retained);
  const [reviewBasis, setReviewBasis] = useState<PrivateJournal | null>(retained ? (custody.basis ?? null) : null);
  const [editing, setEditing] = useState(Boolean(retained));
  const editButton = useRef<HTMLButtonElement>(null);
  const reflectionField = useRef<HTMLDivElement>(null);
  const returningToRead = useRef(false);
  useEffect(() => {
    if (editing && !retained) reflectionField.current?.querySelector('textarea')?.focus();
    else if (!editing && returningToRead.current) {
      returningToRead.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
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
  const heldLifecycle = custody.lifecycle;
  const retainedLifecycle =
    heldLifecycle &&
    heldLifecycle.data.sessionId === session.id &&
    heldLifecycle.data.viewer === currentViewer &&
    heldLifecycle.data.csrfToken === csrfToken &&
    (heldLifecycle.data.action === 'reopen' ? reopenAllowed : retireAllowed)
      ? heldLifecycle
      : null;
  if (heldLifecycle && !retainedLifecycle) {
    delete custody.lifecycle;
    delete custody.lifecycleConflictRevision;
  }
  const [lifecycleCommand, setLifecycleCommand] = useState<LifecycleIntent | null>(retainedLifecycle);
  // This ref closes the gap between activation and rendering: no second review can replace the first intent.
  const lifecycleChoice = useRef<LifecycleIntent | null>(retainedLifecycle);
  const lifecycleDispatched = lifecycleCommand !== null && custody.lifecycle === lifecycleCommand;
  const lifecyclePending = lifecycleDispatched && !!custody.lifecycleFlight;
  const lifecyclePanel = useRef<HTMLDivElement>(null);
  const lifecycleSubmit = useRef<HTMLButtonElement>(null);
  const lifecycleLauncher = useRef<HTMLButtonElement | null>(null);
  const lifecycleRecovery = useRef<HTMLButtonElement>(null);
  const lifecycleFocus = useRef<{ from: Element | null; to: 'submit' | 'launcher' | 'recovery' } | null>(null);
  const lifecycleReading = useRef(false);
  const [readingLifecycle, setReadingLifecycle] = useState(false);
  const [lifecycleNotice, setLifecycleNotice] = useState<
    'conflict' | 'uncertain' | 'saved' | null
  >(retainedLifecycle ? 'uncertain' : null);
  const [lifecycleConflictRevision, setLifecycleConflictRevision] = useState<number | null>(
    custody.lifecycleConflictRevision ?? null,
  );
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
    setReviewBasis(custody.command ? (custody.basis ?? null) : null);
    setJournalCommand(custody.command ?? null);
    setJournalNotice(custody.command ? 'uncertain' : null);
    setConflictRevision(null);
    setReviewedRevision(null);
  }, [journalUpdateAllowed, reopenAllowed, retireAllowed]);

  const lifecycleAuthority = useRef({ reopenAllowed, retireAllowed, generation: 0 });
  if (
    lifecycleAuthority.current.reopenAllowed !== reopenAllowed ||
    lifecycleAuthority.current.retireAllowed !== retireAllowed
  ) {
    lifecycleAuthority.current = {
      reopenAllowed,
      retireAllowed,
      generation: lifecycleAuthority.current.generation + 1,
    };
    delete custody.lifecycle;
    delete custody.lifecycleConflictRevision;
    lifecycleChoice.current = null;
    lifecycleFocus.current = null;
  }
  useEffect(() => {
    setLifecycleCommand(custody.lifecycle ?? null);
    lifecycleChoice.current = custody.lifecycle ?? null;
    setLifecycleNotice(custody.lifecycle ? 'uncertain' : null);
    setLifecycleConflictRevision(custody.lifecycleConflictRevision ?? null);
  }, [reopenAllowed, retireAllowed]);

  const leaving = useRef(false);
  const departed = useRef(false);
  const [departureIdentity] = useState(() => ({}));
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
    !departed.current &&
    !leaving.current &&
    currentRef.current.enabled &&
    currentRef.current.sessionId === command.sessionId &&
    currentRef.current.viewer === command.viewer &&
    currentRef.current.csrfToken === command.csrfToken &&
    currentRef.current.isCurrent();

  useEffect(() => {
    const request = lifecycleFocus.current;
    lifecycleFocus.current = null;
    if (!request || !enabled || !isCurrent() || departed.current || leaving.current) return;
    const active = document.activeElement;
    if (active !== request.from && (request.from?.isConnected || active !== document.body)) return;
    const target =
      request.to === 'submit'
        ? lifecycleSubmit.current
        : request.to === 'launcher'
          ? lifecycleLauncher.current
          : lifecycleRecovery.current;
    if (target?.isConnected && !target.disabled) target.focus();
  }, [lifecycleCommand, lifecycleNotice, lifecycleConflictRevision, session.revision]);

  usePrivateJournalDraftNavigation({
    identity: departureIdentity,
    isCurrent: () => live.current && !departed.current && !leaving.current && !terminal && enabled && isCurrent(),
    draft,
    command: journalCommand
      ? busy || custody.flight
        ? 'pending'
        : journalNotice === 'acknowledged'
          ? 'acknowledged'
          : 'uncertain'
      : null,
    discard: () => {
      departed.current = true;
      setDraft(emptyJournalDraft());
      setReview(null);
      setReviewBasis(null);
      setRefusedField(null);
      setEditing(false);
    },
  });

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
    if (
      !currentRef.current.journalUpdateAllowed ||
      !stillCurrent(command) ||
      flight.current ||
      custody.flight ||
      custody.lifecycle ||
      custody.lifecycleFlight ||
      lifecycleChoice.current
    )
      return;
    if (custody.command && custody.command !== command) return;
    if (!custody.command) submittedDraft.current = draft;
    custody.command ??= command;
    if (reviewBasis !== null) custody.basis ??= reviewBasis;
    const attempt = {};
    custody.flight = attempt;
    custody.listeners?.forEach((listener) => listener());
    flight.current = true;
    const generation = authority.current.generation;
    setBusy(true);
    setJournalCommand(command);
    setJournalNotice(null);
    const result = await correctOccurrenceJournal({ data: command }).catch(() => ({ kind: 'uncertain' as const }));
    if (custody.flight === attempt) delete custody.flight;
    custody.listeners?.forEach((listener) => listener());
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
      delete custody.basis;
      const submitted = submittedDraft.current!;
      setDraft((current) => ({
        startDate: current.startDate === submitted.startDate ? { kind: 'untouched' } : current.startDate,
        finishDate: current.finishDate === submitted.finishDate ? { kind: 'untouched' } : current.finishDate,
        reflection: current.reflection === submitted.reflection ? { kind: 'untouched' } : current.reflection,
        assessment: current.assessment === submitted.assessment ? { kind: 'untouched' } : current.assessment,
      }));
      submittedDraft.current = null;
      setReview(null);
      setJournalNotice('saved');
      setJournalCommand(null);
      setConflictRevision(null);
      setReviewedRevision(null);
      return;
    }
    if (result.kind === 'conflict') {
      delete custody.command;
      delete custody.basis;
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
    delete custody.basis;
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
      lifecycleChoice.current ||
      custody.lifecycleFlight ||
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
    setReviewBasis(structuredClone(journal));
    setReview(command);
    setJournalNotice(null);
    setRefusedField(null);
  }

  function restoreLifecycleFocus(to: 'launcher' | 'recovery') {
    if (lifecyclePanel.current?.contains(document.activeElement))
      lifecycleFocus.current = { from: document.activeElement, to };
  }

  async function submitLifecycle(intent: LifecycleIntent) {
    const command = intent.data;
    if (
      lifecycleChoice.current !== intent ||
      (custody.lifecycle && custody.lifecycle !== intent) ||
      !(command.action === 'reopen' ? currentRef.current.reopenAllowed : currentRef.current.retireAllowed) ||
      !stillCurrent(command) ||
      flight.current ||
      custody.flight ||
      custody.command ||
      custody.lifecycleFlight
    )
      return;
    // Only dispatch seals the review. Every replay uses this exact data and the sender captured at review.
    custody.lifecycle = intent;
    const attempt = {};
    custody.lifecycleFlight = attempt;
    custody.listeners?.forEach((listener) => listener());
    flight.current = true;
    const generation = lifecycleAuthority.current.generation;
    setBusy(true);
    setLifecycleNotice(null);
    const result = await intent.send({ data: command }).catch(() => ({ kind: 'uncertain' as const }));
    if (custody.lifecycleFlight === attempt) delete custody.lifecycleFlight;
    custody.listeners?.forEach((listener) => listener());
    flight.current = false;
    if (!stillCurrent(command)) return;
    setBusy(false);
    if (generation !== lifecycleAuthority.current.generation || custody.lifecycle !== intent) return;
    if (result.kind === 'uncertain') {
      setLifecycleNotice('uncertain');
      return;
    }
    delete custody.lifecycle;
    lifecycleChoice.current = null;
    setLifecycleCommand(null);
    if (result.kind === 'saved') {
      restoreLifecycleFocus('launcher');
      delete custody.lifecycleConflictRevision;
      setLifecycleConflictRevision(null);
      if (result.session.state === 'retired') {
        leaveRetiredDetail();
        return;
      }
      setLifecycleNotice('saved');
      void router.invalidate();
      return;
    }
    if (result.kind === 'conflict') {
      restoreLifecycleFocus('recovery');
      custody.lifecycleConflictRevision = command.revision;
      setLifecycleConflictRevision(command.revision);
      setLifecycleNotice('conflict');
      void router.invalidate();
      return;
    }
    leaveRetiredDetail();
  }

  function chooseLifecycle(action: 'reopen' | 'retire', launcher: HTMLButtonElement) {
    if (
      !(action === 'reopen' ? reopenAllowed : retireAllowed) ||
      !isCurrent() ||
      !currentViewer ||
      !csrfToken ||
      terminal ||
      departed.current ||
      leaving.current ||
      busy ||
      flight.current ||
      custody.flight ||
      custody.command ||
      custody.lifecycle ||
      custody.lifecycleFlight ||
      lifecycleChoice.current ||
      journalCommand !== null ||
      review !== null ||
      lifecycleConflictRevision !== null
    )
      return;
    const intent: LifecycleIntent = Object.freeze({
      data: Object.freeze({
        action,
        sessionId: session.id,
        viewer: currentViewer,
        csrfToken,
        revision: session.revision,
        key: crypto.randomUUID(),
      }),
      send: changeOccurrenceLifecycle,
    });
    lifecycleLauncher.current = launcher;
    lifecycleFocus.current = { from: document.activeElement, to: 'submit' };
    lifecycleChoice.current = intent;
    setLifecycleCommand(intent);
    setLifecycleNotice(null);
  }

  function cancelLifecycleReview(intent: LifecycleIntent) {
    if (!stillCurrent(intent.data) || custody.lifecycle || lifecycleChoice.current !== intent) return;
    restoreLifecycleFocus('launcher');
    lifecycleChoice.current = null;
    setLifecycleCommand(null);
  }

  async function readLifecycleCurrent() {
    if (!enabled || !isCurrent() || departed.current || leaving.current || lifecycleReading.current) return;
    lifecycleReading.current = true;
    setReadingLifecycle(true);
    try {
      // The selected occurrence's existing read is an observation, never a receipt for the original write.
      await router.invalidate();
    } finally {
      lifecycleReading.current = false;
      if (live.current && !departed.current && !leaving.current) setReadingLifecycle(false);
    }
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

      {journal ? (
        <>
          <JournalSavedReadout journal={journal} observedOnly={journalCommand !== null} />
          {!editing ? (
            <Button
              ref={editButton}
              type="button"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              disabled={!journalUpdateAllowed || (busy && !custody.lifecycle)}
              onClick={() => {
                if (enabled && isCurrent()) setEditing(true);
              }}
            >
              {m.library_journal_edit_entry()}
            </Button>
          ) : null}
        </>
      ) : null}
      {journal && editing ? (
        <form className="min-w-0 space-y-5 rounded-xl border bg-card p-4 sm:p-6" onSubmit={submitJournal} noValidate>
          <h3 className="text-lg font-semibold">{m.library_journal_edit_entry()}</h3>
          <p className="text-sm text-muted-foreground">{m.library_occurrence_date_help()}</p>
          <p className="text-sm text-muted-foreground">{m.library_journal_selection_help()}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {(['reflection', 'startDate', 'finishDate', 'assessment'] as const).map((field) => (
              <div
                key={field}
                ref={field === 'reflection' ? reflectionField : undefined}
                className={field === 'reflection' ? 'min-w-0 md:col-span-2' : 'min-w-0'}
              >
                <JournalFieldEditor
                  field={field}
                  selection={draft[field]}
                  value={working[field]}
                  disabled={!journalUpdateAllowed || (!journalCommand && review !== null)}
                  invalid={!parsedDraft.ok && parsedDraft.field === field}
                  refused={refusedField === field}
                  onChange={(selection) => {
                    if (
                      !enabled ||
                      !isCurrent() ||
                      departed.current ||
                      leaving.current ||
                      !journalUpdateAllowed ||
                      (review && !custody.command)
                    )
                      return;
                    setDraft((current) => ({ ...current, [field]: selection }));
                    // Editing a retained field cannot remove the only current-read/re-review recovery.
                    if (!custody.command)
                      setJournalNotice(
                        conflictRevision !== null && reviewedRevision !== journal.revision ? 'conflict' : null,
                      );
                    setRefusedField(null);
                  }}
                />
              </div>
            ))}
          </div>
          {journalNotice === 'invalid' ? (
            <p role="alert">{m.library_journal_native_refusal({ field: journalFieldLabel(refusedField) })}</p>
          ) : null}
          {review ? (
            <JournalDraftReview
              journal={reviewBasis ?? journal}
              draft={draftFromPatch(review.body)}
              revision={review.body.revision}
            >
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
                lifecycleCommand !== null ||
                !!custody.lifecycleFlight ||
                (conflictRevision !== null && reviewedRevision !== journal.revision)
              }
            >
              {m.library_journal_review()}
            </Button>
          )}
          {!journalCommand ? (
            <div className="flex justify-end border-t pt-3">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                className="min-h-11 w-full sm:w-auto"
                onClick={() => {
                  if (!isCurrent() || custody.command || custody.flight) return;
                  setDraft(emptyJournalDraft());
                  setReview(null);
                  setReviewBasis(null);
                  setRefusedField(null);
                  setConflictRevision(null);
                  setReviewedRevision(null);
                  setJournalNotice(null);
                  returningToRead.current = true;
                  setEditing(false);
                }}
              >
                {m.library_progress_cancel()}
              </Button>
            </div>
          ) : null}
          {journalCommand ? (
            <div className="space-y-2">
              <p role="status">
                {journalNotice === 'acknowledged'
                  ? m.library_occurrence_acknowledged()
                  : m.library_occurrence_uncertain()}
              </p>
              <p className="text-sm text-muted-foreground">{m.library_journal_retry_identity()}</p>
              <p className="text-sm text-muted-foreground">{m.library_journal_separate_draft()}</p>
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
        </form>
      ) : null}

      {reopenAllowed || retireAllowed ? (
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap gap-2">
            {reopenAllowed && (session.state === 'completed' || session.state === 'abandoned') ? (
              <button
                type="button"
                className="min-h-11 whitespace-normal rounded-md border px-3 py-2 [overflow-wrap:anywhere]"
                disabled={
                  lifecycleCommand !== null ||
                  lifecycleConflictRevision !== null ||
                  busy ||
                  !!custody.lifecycleFlight ||
                  journalCommand !== null ||
                  review !== null
                }
                onClick={(event) => chooseLifecycle('reopen', event.currentTarget)}
              >
                {m.library_occurrence_reopen()}
              </button>
            ) : null}
            {retireAllowed ? (
              <button
                type="button"
                className="min-h-11 whitespace-normal rounded-md border px-3 py-2 [overflow-wrap:anywhere]"
                disabled={
                  lifecycleCommand !== null ||
                  lifecycleConflictRevision !== null ||
                  busy ||
                  !!custody.lifecycleFlight ||
                  journalCommand !== null ||
                  review !== null
                }
                onClick={(event) => chooseLifecycle('retire', event.currentTarget)}
              >
                {m.library_occurrence_retire()}
              </button>
            ) : null}
          </div>
          {lifecycleCommand ? (
            <div
              ref={lifecyclePanel}
              className="min-w-0 space-y-3 rounded-md border p-3"
              role="group"
              aria-label={m.library_occurrence_confirm_heading()}
            >
              <p>
                {lifecycleCommand.data.action === 'reopen'
                  ? m.library_occurrence_confirm_reopen()
                  : m.library_occurrence_confirm_retire()}
              </p>
              <p className="text-sm text-muted-foreground">
                {m.library_occurrence_lifecycle_basis({ revision: lifecycleCommand.data.revision })}
              </p>
              {lifecycleDispatched ? (
                <>
                  <p role="status">
                    {lifecyclePending ? m.library_occurrence_lifecycle_pending() : m.library_occurrence_uncertain()}
                  </p>
                  <p>{m.library_occurrence_lifecycle_retry_help()}</p>
                </>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  ref={lifecycleSubmit}
                  type="button"
                  className="min-h-11 whitespace-normal rounded-md bg-primary px-4 py-2 text-primary-foreground [overflow-wrap:anywhere]"
                  disabled={busy || lifecyclePending || !!custody.flight}
                  onClick={() => void submitLifecycle(lifecycleCommand)}
                >
                  {lifecycleDispatched
                    ? m.library_occurrence_lifecycle_retry()
                    : m.library_occurrence_confirm_heading()}
                </button>
                {!lifecycleDispatched ? (
                  <button
                    type="button"
                    className="min-h-11 whitespace-normal rounded-md border px-3 py-2 [overflow-wrap:anywhere]"
                    onClick={() => cancelLifecycleReview(lifecycleCommand)}
                  >
                    {m.library_progress_cancel()}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="min-h-11 whitespace-normal rounded-md border px-3 py-2 [overflow-wrap:anywhere]"
                    disabled={readingLifecycle || lifecyclePending}
                    onClick={() => void readLifecycleCurrent()}
                  >
                    {m.library_occurrence_lifecycle_read_current()}
                  </button>
                )}
              </div>
              {lifecycleDispatched ? <LifecycleObservation session={session} /> : null}
            </div>
          ) : null}
          {lifecycleConflictRevision !== null ? (
            <div
              role="group"
              aria-label={m.library_occurrence_conflict()}
              className="min-w-0 space-y-3 rounded-md border p-3"
            >
              <p role="alert">{m.library_occurrence_conflict()}</p>
              <LifecycleObservation session={session} />
              <button
                ref={lifecycleRecovery}
                type="button"
                className="min-h-11 whitespace-normal rounded-md border px-3 py-2 [overflow-wrap:anywhere]"
                disabled={readingLifecycle || busy}
                onClick={() => {
                  if (!enabled || !isCurrent() || departed.current || leaving.current) return;
                  if (session.revision !== lifecycleConflictRevision) {
                    delete custody.lifecycleConflictRevision;
                    setLifecycleConflictRevision(null);
                    setLifecycleNotice(null);
                  } else void readLifecycleCurrent();
                }}
              >
                {session.revision !== lifecycleConflictRevision
                  ? m.library_occurrence_review_latest()
                  : m.library_occurrence_lifecycle_read_current()}
              </button>
            </div>
          ) : null}
          {lifecycleNotice === 'saved' ? <p role="status">{m.library_occurrence_reopened()}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function LifecycleObservation({ session }: { session: ProgressSessionView }) {
  const state =
    session.state === 'active'
      ? m.library_progress_state_active()
      : session.state === 'completed'
        ? m.library_progress_state_completed()
        : m.library_progress_state_abandoned();
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {m.library_occurrence_lifecycle_observed({ state, revision: session.revision })}
    </p>
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
          placeholder={m.library_journal_reflection_placeholder()}
          disabled={disabled}
          className="min-h-64 resize-y text-base leading-relaxed [overflow-wrap:anywhere]"
          dir="auto"
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
  return (
    <span
      dir="auto"
      className="block max-w-prose whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere] [unicode-bidi:plaintext]"
    >
      {value}
    </span>
  );
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
                    <p className="text-sm text-muted-foreground">{m.library_journal_original_value()}</p>
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
      {children ? (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-card px-4 py-3 sm:flex-row [&_button]:min-h-11 [&_button]:whitespace-normal">
          {children}
        </div>
      ) : null}
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
            <JournalValue value={journal.reflection} />
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{m.library_journal_reported_dates()}</p>
    </section>
  );
}
