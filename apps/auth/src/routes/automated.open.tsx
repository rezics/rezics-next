import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@rezics/ui/shadcn/alert-dialog';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { loadManagementSession, managementSessionMatches, type ManagementSession } from '../management-operations';
import {
  managementOperationStepUpUrl,
  pendingManagementOperationMatches,
  pendingManagementOperationStepUpState,
  storePendingManagementOperationStepUp,
} from '../management-operation-step-up';
import {
  isOpeningInput,
  loadOpeningMetadata,
  readOpenedSession,
  sameOpeningPage,
  submitOperatorOpening,
  type OpeningInput,
  type OpeningMetadata,
  type OpeningOutcome,
} from '../operator-session-opening';
import {
  appendOpeningReturnEntry,
  openingMayStillBeRunning,
  type OpeningReturnEntry,
  type OpeningReturnPhase,
} from '../operator-opening-return';
import { OpeningCurrentSessionView, OpeningReturnHistoryView } from '../operator-opening-return-view';

export const Route = createFileRoute('/automated/open')({
  head: () => ({ meta: [{ title: `${m.auth_opening_heading()} · REZICS` }] }),
  component: OperatorSessionOpeningPage,
});
const websiteOrigin = 'https://rezics.com';
function websiteHref(path: '/' | '/accounts') {
  return new URL(`/${getLocale()}${path === '/' ? '/' : path}`, websiteOrigin).toString();
}
function message(kind: string) {
  if (kind === 'step-up') return m.auth_opening_step_up();
  if (kind === 'refused') return m.auth_opening_refused();
  if (kind === 'unknown') return m.auth_opening_unknown();
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  return m.auth_opening_unavailable();
}
export function OperatorSessionOpeningPage() {
  const { history } = useRouter();
  const [page, setPage] = useState<{ key: number; isCurrent: () => boolean } | null>(null);
  const [entries, setEntries] = useState<OpeningReturnEntry[]>([]);
  const retireReview = useRef<(() => void) | null>(null);
  const historyFocus = useRef<HTMLElement | null>(null);
  const bindRetirement = useCallback((retire: (() => void) | null) => {
    retireReview.current = retire;
  }, []);
  const recordHistory = useCallback((phase: OpeningReturnPhase) => {
    setEntries((current) => appendOpeningReturnEntry(current, phase));
  }, []);
  const focusAfterDismissal = useCallback(() => {
    const target =
      document.getElementById('opening-current-state-heading') ??
      document.getElementById('opening-authenticate') ??
      document.getElementById('opening-confirmation') ??
      document.getElementById('opening-safe-exit') ??
      document.getElementById('opening-account-management') ??
      document.getElementById('opening-return-container');
    target?.focus();
  }, []);
  const dismissHistory = useCallback(() => {
    flushSync(() => setEntries([]));
    focusAfterDismissal();
  }, [focusAfterDismissal]);

  useLayoutEffect(() => {
    if (entries.length) historyFocus.current?.focus();
  }, [entries]);

  useLayoutEffect(() => {
    let generation = 0;
    let active = false;
    const leave = () => {
      active = false;
      generation++;
      retireReview.current?.();
      setPage(null);
    };
    const enter = () => {
      retireReview.current?.();
      const key = ++generation;
      active = true;
      setPage({ key, isCurrent: () => active && generation === key });
    };
    const unsubscribe = history.subscribe(({ location }) => {
      if (location.pathname === '/automated/open') enter();
      else leave();
    });
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && window.location.pathname === '/automated/open') enter();
    };
    const pagehide = () => flushSync(leave);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', restore);
    enter();
    return () => {
      active = false;
      generation++;
      unsubscribe();
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', restore);
    };
  }, [history]);
  return (
    <AuthPage heading={m.auth_opening_heading()}>
      <div id="opening-return-container" className="space-y-5" tabIndex={-1}>
        <OpeningReturnHistoryView entries={entries} focusRef={historyFocus} dismiss={dismissHistory} />
        {page ? (
          <OpeningReview
            key={page.key}
            isCurrent={page.isCurrent}
            bindRetirement={bindRetirement}
            recordHistory={recordHistory}
          />
        ) : null}
      </div>
    </AuthPage>
  );
}

function OpeningDeparture({
  work,
  validate,
  retire,
  focus,
  uncertain,
}: {
  work: () => boolean;
  validate: () => Promise<void>;
  retire: () => void;
  focus: () => void;
  uncertain: () => boolean;
}) {
  const previous = useRef<HTMLElement | null>(null);
  const leaving = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: async ({ next }) => {
      // Replacing this route remains a new journey, as does cached-page return.
      if (next.pathname === '/automated/open' || !work()) return false;
      previous.current = document.activeElement as HTMLElement | null;
      await validate();
      return work();
    },
    enableBeforeUnload: work,
    withResolver: true,
  });
  useLayoutEffect(() => {
    if (blocker.status === 'blocked' && !work()) blocker.proceed();
  });
  const stay = () => {
    leaving.current = false;
    if (blocker.status === 'blocked') blocker.reset();
  };
  return (
    <AlertDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <AlertDialogContent
        finalFocus={() => {
          const target = previous.current;
          if (
            !leaving.current &&
            target?.isConnected &&
            target.matches('input:not(:disabled),button:not(:disabled),[tabindex]')
          )
            target.focus();
          else focus();
          return false;
        }}
      >
        <AlertDialogTitle>{m.auth_opening_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>
          {m.auth_organization_departure_description()}{' '}
          {uncertain() ? m.auth_opening_departure_uncertain() : m.auth_account_operation_leave_notice()}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (blocker.status !== 'blocked') return;
              leaving.current = true;
              retire();
              blocker.proceed();
            }}
          >
            {m.auth_organization_departure_leave()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OpeningReview({
  isCurrent: pageIsCurrent,
  bindRetirement,
  recordHistory,
}: {
  isCurrent: () => boolean;
  bindRetirement: (retire: (() => void) | null) => void;
  recordHistory: (phase: OpeningReturnPhase) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [attempt, setAttempt] = useState<OpeningInput | null>(null);
  const [metadata, setMetadata] = useState<OpeningMetadata | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [outcome, setOutcome] = useState<OpeningOutcome | null>(null);
  const [outcomeSource, setOutcomeSource] = useState<'opening-response' | 'session-readback' | null>(null);
  const live = useRef(true);
  const observationOwner = useRef<AbortController | null>(null);
  const bypassDeparture = useRef(false);
  const authority = useRef<ManagementSession | null>(null);
  const progress = useRef<OpeningReturnPhase | null>(null);
  const isCurrent = () => live.current && pageIsCurrent();
  const lock = useRef(false);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const markProgress = (phase: OpeningReturnPhase) => {
    progress.current = phase;
    if (phase === 'acknowledged' || phase === 'unconfirmed' || phase === 'refused') recordHistory(phase);
  };

  function retireObservation() {
    const owner = observationOwner.current;
    observationOwner.current = null;
    owner?.abort();
  }
  function beginObservation() {
    retireObservation();
    const owner = new AbortController();
    observationOwner.current = owner;
    return owner;
  }
  function observationIsCurrent(owner: AbortController) {
    return isCurrent() && observationOwner.current === owner && !owner.signal.aborted;
  }

  const work = () =>
    isCurrent() &&
    !bypassDeparture.current &&
    (openingMayStillBeRunning(progress.current) ||
      (outcome?.kind !== 'opened' && Boolean(subjectId.trim() || operatorId.trim() || attempt)));
  function retire() {
    if (!live.current) return;
    // Retire callbacks before clearing private review; submitted recovery stays untouched.
    retireObservation();
    live.current = false;
    if (progress.current) recordHistory(progress.current);
    authority.current = null;
    setAccountId('');
    setSubjectId('');
    setOperatorId('');
    setAttempt(null);
    setMetadata(null);
    setConfirmed(false);
    setBusy(false);
    setTerminal(false);
    setOutcome(null);
    setOutcomeSource(null);
    setStatus('refused');
  }
  useLayoutEffect(() => {
    bindRetirement(retire);
    return () => bindRetirement(null);
  });
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      retireObservation();
      live.current = false;
    };
  }, []);
  async function validateCaller() {
    const owner = authority.current;
    const submitted = () => {
      const state = pendingManagementOperationStepUpState();
      return (
        state.kind === 'pending' &&
        state.value.phase === 'submitted' &&
        Boolean(attempt && pendingManagementOperationMatches(state.value, attempt))
      );
    };
    // Issuance replaces the human cookie deliberately. Its recovery is read-only.
    if (!isCurrent() || !owner || submitted()) return;
    const caller = await loadManagementSession();
    if (!isCurrent() || authority.current !== owner || submitted()) return;
    if (caller.kind === 'unavailable') {
      setMetadata(null);
      setConfirmed(false);
      setStatus('unavailable');
    } else if (
      caller.kind === 'signed-out' ||
      (caller.kind === 'ready' &&
        (caller.accountId !== owner.accountId ||
          caller.clientId !== owner.clientId ||
          caller.authnEpoch !== owner.authnEpoch ||
          caller.authTime !== owner.authTime ||
          JSON.stringify(caller.scopes) !== JSON.stringify(owner.scopes) ||
          JSON.stringify(caller.amr) !== JSON.stringify(owner.amr) ||
          (metadata && attempt && !managementSessionMatches(caller, attempt))))
    )
      retire();
  }
  useEffect(() => {
    const validate = () => {
      void validateCaller();
    };
    window.addEventListener('focus', validate);
    return () => window.removeEventListener('focus', validate);
  });

  async function reconcile(saved: OpeningInput, owner: AbortController) {
    const result = await readOpenedSession(saved, owner.signal);
    if (!observationIsCurrent(owner)) return;
    setOutcome(result);
    setOutcomeSource(result.kind === 'opened' ? 'session-readback' : null);
    setStatus(result.kind === 'opened' ? '' : 'unknown');
  }

  // Recovery repeats only reads. A local review keeps its original tuple/key;
  // a submitted continuation always goes through native session readback.
  async function restore(local: OpeningInput | null = null) {
    if (!isCurrent() || lock.current) return;
    const owner = beginObservation();
    lock.current = true;
    setBusy(true);
    setStatus('');
    setMetadata(null);
    setConfirmed(false);
    try {
      const state = pendingManagementOperationStepUpState();
      if (
        state.kind === 'invalid' ||
        (state.kind === 'pending' &&
          ((local && !pendingManagementOperationMatches(state.value, local)) ||
            !isOpeningInput({
              accountId: state.value.accountId,
              operationKey: state.value.operationKey,
              operation: state.value.operation,
            })))
      ) {
        setStatus('refused');
        return;
      }
      const saved =
        state.kind === 'pending'
          ? ({
              accountId: state.value.accountId,
              operationKey: state.value.operationKey,
              operation: state.value.operation,
            } as OpeningInput)
          : local;
      if (saved) {
        setAttempt(saved);
        if (state.kind === 'pending' && state.value.phase === 'submitted') {
          markProgress('unconfirmed');
          setTerminal(true);
          await reconcile(saved, owner);
          return;
        }
        markProgress('review');
        const human = await loadManagementSession();
        if (!observationIsCurrent(owner)) return;
        if (human.kind === 'unavailable') {
          setStatus('unavailable');
          return;
        }
        if (human.kind !== 'ready' || human.accountId !== saved.accountId) {
          retire();
          return;
        }
        authority.current = human;
        setAccountId(human.accountId);
        if ((state.kind === 'pending' && state.value.phase !== 'returned') || !managementSessionMatches(human, saved)) {
          setStatus('step-up');
          return;
        }
        const read = await loadOpeningMetadata(saved, owner.signal);
        if (!observationIsCurrent(owner)) return;
        if (read.kind === 'ready') setMetadata(read.metadata);
        else if (read.kind === 'refused') {
          markProgress('refused');
          retire();
        } else setStatus(read.kind);
        return;
      }
      const human = await loadManagementSession();
      if (!observationIsCurrent(owner)) return;
      if (human.kind === 'ready') {
        authority.current = human;
        setAccountId(human.accountId);
      } else setStatus(human.kind);
    } finally {
      if (observationIsCurrent(owner)) {
        observationOwner.current = null;
        lock.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void restore();
  }, []);
  useEffect(() => {
    if (status) feedback.current?.focus();
  }, [status]);
  useEffect(() => {
    if (metadata) confirmation.current?.focus();
  }, [metadata]);

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || lock.current || attempt || !accountId) return;
    const next: OpeningInput = {
      accountId,
      operationKey: crypto.randomUUID(),
      operation: {
        kind: 'opening',
        operatorAccountId: operatorId,
        subjectAccountId: subjectId,
      },
    };
    if (!isOpeningInput(next)) {
      setStatus('refused');
      return;
    }
    markProgress('review');
    setAttempt(next);
    await restore(next);
  }
  function stepUp(restart = false) {
    if (!isCurrent() || !attempt || lock.current) return;
    // Recovery is a deliberate new opening and always requires a native fresh
    // human login. No consumed approval, cached human proof or metadata survives.
    const next = restart ? { ...attempt, operationKey: crypto.randomUUID() } : attempt;
    retireObservation();
    if (!storePendingManagementOperationStepUp(next)) {
      setStatus('unavailable');
      return;
    }
    markProgress('review');
    bypassDeparture.current = true;
    window.location.assign(managementOperationStepUpUrl('opening'));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isCurrent() || lock.current || !attempt || !metadata || !confirmed || terminal) return;
    const owner = beginObservation();
    markProgress('preflight');
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    setStatus('');
    try {
      const reviewed = metadata;
      const current = await loadOpeningMetadata(attempt, owner.signal);
      if (!observationIsCurrent(owner)) return;
      if (current.kind === 'refused') {
        markProgress('refused');
        retire();
        return;
      }
      if (current.kind !== 'ready') {
        setMetadata(null);
        setStatus(current.kind);
        return;
      }
      if (!sameOpeningPage(reviewed, current.metadata)) {
        markProgress('refused');
        retire();
        return;
      }
      const result = await submitOperatorOpening(attempt, isCurrent, markProgress);
      if (!isCurrent()) return;
      if (result.kind === 'refused') {
        markProgress('refused');
        retire();
        return;
      }
      const state = pendingManagementOperationStepUpState();
      setTerminal(state.kind === 'pending' && state.value.phase === 'submitted');
      setOutcome(result);
      setOutcomeSource(result.kind === 'opened' ? 'opening-response' : null);
      setStatus(result.kind === 'opened' ? '' : result.kind);
    } finally {
      if (observationIsCurrent(owner)) {
        observationOwner.current = null;
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <OpeningDeparture
        work={work}
        validate={validateCaller}
        retire={retire}
        uncertain={() => openingMayStillBeRunning(progress.current)}
        focus={() => {
          const target =
            document.getElementById('opening-return-history') ??
            document.getElementById('opening-current-state-heading') ??
            document.getElementById('opening-authenticate') ??
            confirmation.current ??
            feedback.current ??
            document.getElementById('opening-safe-exit');
          target?.focus();
        }}
      />
      <div className="space-y-5" aria-busy={busy}>
        <p>{m.auth_opening_intro()}</p>
        {status ? (
          <ErrorAlert ref={feedback} tabIndex={-1}>
            {message(status)}
          </ErrorAlert>
        ) : null}
        {status === 'unavailable' && !metadata && !terminal ? (
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" disabled={busy} onClick={() => void restore(attempt)}>
              {m.auth_account_identity_retry()}
            </Button>
            <a id="opening-account-management" className="underline underline-offset-4" href={websiteHref('/accounts')}>
              {m.auth_opening_account_management()}
            </a>
          </div>
        ) : null}
        {!attempt ? (
          <form className="auth-login-form" method="post" action="/automated/open" onSubmit={review}>
            <Field>
              <FieldLabel htmlFor="opening-subject">{m.auth_opening_subject()}</FieldLabel>
              <Input
                id="opening-subject"
                value={subjectId}
                onChange={(event) => setSubjectId(event.target.value)}
                required
                readOnly={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="opening-operator">{m.auth_opening_operator()}</FieldLabel>
              <Input
                id="opening-operator"
                value={operatorId}
                onChange={(event) => setOperatorId(event.target.value)}
                required
                readOnly={busy}
              />
            </Field>
            <Button type="submit" disabled={busy || !accountId}>
              {m.auth_opening_review()}
            </Button>
          </form>
        ) : null}
        {metadata && !terminal ? (
          <form className="auth-login-form" method="post" action="/operator-sessions/open" onSubmit={submit}>
            <h2 id="opening-confirmation" ref={confirmation} tabIndex={-1}>
              {m.auth_opening_confirmation()}
            </h2>
            <section aria-labelledby="opening-consequences">
              <h3 id="opening-consequences">{m.auth_opening_consequences_heading()}</h3>
              <p>{m.auth_opening_consequences()}</p>
            </section>
            <dl>
              <dt>{m.auth_opening_human()}</dt>
              <dd>
                {m.auth_opening_identity_undisclosed()}
                <br />
                <small>
                  {m.auth_opening_account_id()}: <code className="break-all">{metadata.viewer.accountId}</code>
                </small>
              </dd>
              <dt>{m.auth_opening_subject()}</dt>
              <dd>
                {m.auth_opening_identity_undisclosed()}
                <br />
                <small>
                  {m.auth_opening_account_id()}: <code className="break-all">{metadata.subject.id}</code>
                </small>
              </dd>
              <dt>{m.auth_opening_operator()}</dt>
              <dd>
                {m.auth_opening_identity_undisclosed()} ·{' '}
                {metadata.operator.kind === 'organization'
                  ? m.auth_opening_operator_organization()
                  : m.auth_opening_operator_actor()}
                <br />
                <small>
                  {m.auth_opening_account_id()}: <code className="break-all">{metadata.operator.id}</code>
                </small>
              </dd>
            </dl>
            <Field>
              <FieldLabel htmlFor="opening-confirm">
                <input
                  id="opening-confirm"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  required
                  disabled={busy}
                />
                {m.auth_opening_confirm()}
              </FieldLabel>
            </Field>
            <Button type="submit" disabled={busy || !confirmed}>
              {m.auth_opening_submit()}
            </Button>
          </form>
        ) : null}
        {attempt && status === 'step-up' && !terminal ? (
          <Button id="opening-authenticate" disabled={busy} onClick={() => stepUp()}>
            {m.auth_opening_authenticate()}
          </Button>
        ) : null}
        {terminal && attempt ? (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (!isCurrent() || lock.current) return;
                const owner = beginObservation();
                lock.current = true;
                setBusy(true);
                try {
                  await reconcile(attempt, owner);
                } finally {
                  if (observationIsCurrent(owner)) {
                    observationOwner.current = null;
                    lock.current = false;
                    setBusy(false);
                  }
                }
              }}
            >
              {m.auth_opening_readback()}
            </Button>
            <Button id="opening-restart" variant="outline" disabled={busy} onClick={() => stepUp(true)}>
              {m.auth_opening_restart()}
            </Button>
          </>
        ) : null}
        {outcome?.kind === 'opened' && outcomeSource ? (
          <OpeningCurrentSessionView session={outcome.session} source={outcomeSource} continueHref={websiteHref('/')} />
        ) : null}
      </div>
    </>
  );
}
