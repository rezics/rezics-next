import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { loadManagementSession, type ManagementSessionResult } from '../management-operations';
import { normalizeSignupHandle } from '../signup';
import {
  dismissAutomatedCreationReturnHistory,
  emptyAutomatedCreationReturnHistory,
  observeAutomatedCreationContinuation,
  recordAutomatedCreationReturnFact,
  type AutomatedCreationReturnHistory,
  type AutomatedCreationReturnFact,
} from '../automated-creation-return';
import { AutomatedCreationReturnView } from '../automated-creation-return-view';
import {
  createAutomatedAttempt,
  discardAutomatedReview,
  automatedId,
  loadAutomatedCreationPage,
  reauthenticateAutomated,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
  submitAutomatedAttempt,
  type AutomatedAttempt,
  type AutomatedCreationPage,
} from '../automated-account-create';

export const Route = createFileRoute('/automated/new')({
  head: () => ({ meta: [{ title: `${m.auth_automated_heading()} · REZICS` }] }),
  component: AutomatedAccountCreatePage,
});

// This adapter belongs to this creation page; standalone page fixtures need no router.
function DepartureDecision({
  protectedWork,
  validate,
  retire,
}: {
  protectedWork: () => boolean;
  validate: () => Promise<void>;
  retire: () => void;
}) {
  const blocker = useBlocker({
    shouldBlockFn: async () => {
      await validate();
      return protectedWork();
    },
    enableBeforeUnload: protectedWork,
    withResolver: true,
  });
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (blocker.status !== 'blocked') return;
    if (!protectedWork()) {
      blocker.proceed();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog.current!;
    modal.showModal();
    stay.current?.focus();
    return () => {
      modal.close();
      previous?.focus();
    };
  }, [blocker.status, protectedWork]);
  return blocker.status === 'blocked' ? (
    <dialog
      ref={dialog}
      aria-labelledby="automated-departure-title"
      onCancel={(event) => {
        event.preventDefault();
        blocker.reset();
      }}
    >
      <h2 id="automated-departure-title">{m.auth_automated_departure()}</h2>
      <p>{m.auth_account_operation_leave_notice()}</p>
      <div className="flex gap-3">
        <Button ref={stay} type="button" onClick={() => blocker.reset()}>
          {m.auth_automated_stay()}
        </Button>
        <Button
          type="button"
          onClick={() => {
            retire();
            blocker.proceed();
          }}
        >
          {m.auth_automated_leave()}
        </Button>
      </div>
    </dialog>
  ) : null;
}

function notice(kind: string): string {
  if (kind === 'step-up') return m.auth_automated_step_up();
  if (kind === 'refused') return m.auth_automated_refused();
  if (kind === 'unknown') return m.auth_automated_unknown();
  if (kind === 'blocked') return m.auth_automated_history_blocked();
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  return m.auth_automated_unavailable();
}
type Draft = Readonly<{ accountId: string; operatorId: string; handle: string }>;
type Session = Extract<ManagementSessionResult, { kind: 'ready' }>;
function sameCaller(left: Session, right: Session) {
  return (
    left.accountId === right.accountId &&
    left.clientId === right.clientId &&
    left.authTime === right.authTime &&
    left.authnEpoch === right.authnEpoch &&
    JSON.stringify(left.scopes) === JSON.stringify(right.scopes) &&
    JSON.stringify(left.amr) === JSON.stringify(right.amr)
  );
}
function possiblySent(attempt: AutomatedAttempt | null | 'invalid' | undefined): boolean {
  return !!attempt && attempt !== 'invalid' && (!!attempt.submitted || !!attempt.reference);
}
export function AutomatedAccountCreatePage({ initial }: { initial?: ManagementSessionResult } = {}) {
  const router = useRouter({ warn: false });
  const [accountId, setAccountId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [handle, setHandle] = useState('');
  const [page, setPage] = useState<AutomatedCreationPage | null>(null);
  const [attempt, setAttempt] = useState<AutomatedAttempt | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [retired, setRetired] = useState(false);
  const [status, setStatus] = useState('');
  const [errors, setErrors] = useState({ operator: false, handle: false });
  const [reauth, setReauth] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState('');
  const [history, setHistory] = useState<AutomatedCreationReturnHistory>(emptyAutomatedCreationReturnHistory);
  const [historyDismissed, setHistoryDismissed] = useState(false);
  const [historyFocusRequest, setHistoryFocusRequest] = useState(0);
  const lock = useRef(false);
  const caller = useRef<Session | null>(null);
  const lifetime = useRef<object | null>(null);
  const historyRef = useRef(history);
  const acknowledgedSeen = useRef(false);
  const uncertaintySeen = useRef(false);
  const unresolvedUnknown = useRef(false);
  const focusAfterRead = useRef(false);
  const [reload, setReload] = useState(0);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const work = useRef({ accountId, attempt, draft, page, ready, created, busy, operatorId, handle, email, password });
  work.current = { accountId, attempt, draft, page, ready, created, busy, operatorId, handle, email, password };
  function updateHistory(next: AutomatedCreationReturnHistory) {
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    setHistoryDismissed(false);
    setHistoryFocusRequest((value) => value + 1);
  }
  function noteFact(fact: AutomatedCreationReturnFact) {
    if (fact === 'unknown') unresolvedUnknown.current = true;
    if (fact === 'acknowledged') acknowledgedSeen.current = true;
    updateHistory(recordAutomatedCreationReturnFact(historyRef.current, fact));
  }
  function noteStoredContinuation(saved: AutomatedAttempt | null | 'invalid' | undefined) {
    if (!possiblySent(saved) || uncertaintySeen.current) return;
    uncertaintySeen.current = true;
    const next = observeAutomatedCreationContinuation(historyRef.current, true);
    if (next.includes('unknown')) unresolvedUnknown.current = true;
    updateHistory(next);
  }
  function dismissHistory() {
    const next = dismissAutomatedCreationReturnHistory(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    setHistoryDismissed(true);
    setHistoryFocusRequest((value) => value + 1);
    if (status === 'unknown') setStatus('');
  }
  const protectedWork = () => {
    const value = work.current;
    return (
      !!lifetime.current &&
      value.ready &&
      !value.created &&
      !!(value.busy || value.attempt || value.operatorId.trim() || value.handle.trim())
    );
  };
  function retire(cached = false, synchronous = true) {
    const previous = work.current;
    lifetime.current = null;
    caller.current = null;
    lock.current = false;
    const saved = restoreAutomatedAttempt();
    discardAutomatedReview(previous.attempt);
    const clear = () => {
      const previousHistory = historyRef.current;
      if (possiblySent(previous.attempt) || possiblySent(saved))
        noteStoredContinuation(possiblySent(saved) ? saved : previous.attempt);
      else if (previous.attempt || previous.draft || previous.operatorId.trim() || previous.handle.trim())
        noteFact('interrupted');
      if (cached && historyRef.current === previousHistory && (historyRef.current.length > 0 || historyDismissed))
        setHistoryFocusRequest((value) => value + 1);
      work.current = {
        accountId: '',
        attempt: null,
        draft: null,
        page: null,
        ready: false,
        created: '',
        busy: false,
        operatorId: '',
        handle: '',
        email: '',
        password: '',
      };
      setAccountId('');
      setOperatorId('');
      setHandle('');
      setPage(null);
      setAttempt(null);
      setDraft(null);
      setConfirmed(false);
      setBusy(false);
      setReady(false);
      setStatus('');
      setErrors({ operator: false, handle: false });
      setReauth(false);
      setEmail('');
      setPassword('');
      setCreated('');
      setRetired(cached);
    };
    if (synchronous) flushSync(clear);
    else clear();
  }
  const retireForDeparture = () => retire(true, true);
  function revoked(kind: string) {
    retire(false, true);
    setStatus(kind);
  }
  async function validateCaller() {
    const current = lifetime.current;
    if (!current || !caller.current) return;
    const session = await loadManagementSession();
    if (lifetime.current !== current) return;
    if (session.kind !== 'ready' || !sameCaller(caller.current, session))
      revoked(
        session.kind === 'signed-out' ? 'signed-out' : session.kind === 'unavailable' ? 'unavailable' : 'refused',
      );
  }
  async function blockFreshCreation(session: Session, current: object, status: 'blocked' | 'refused') {
    const read = await loadAutomatedCreationPage(session.accountId, null);
    if (lifetime.current !== current) return;
    if (read.kind !== 'ready' || read.page.readiness === 'refused') {
      revoked(read.kind === 'ready' ? 'refused' : read.kind);
      return;
    }
    await validateCaller();
    if (lifetime.current !== current) return;
    retire(false, true);
    setStatus(status);
  }
  useLayoutEffect(() => {
    const current = {};
    focusAfterRead.current = reload > 0;
    lifetime.current = current;
    caller.current = null;
    lock.current = false;
    setBusy(false);
    setReady(false);
    setRetired(false);
    setStatus('');
    setConfirmed(false);
    setReauth(false);
    setPage(null);
    setDraft(null);
    setErrors({ operator: false, handle: false });
    setPassword('');
    setCreated('');
    setAccountId('');
    setAttempt(null);
    setOperatorId('');
    setHandle('');
    setEmail('');
    const onPageHide = () => retire(true, true);
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setReload((value) => value + 1);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('focus', validateCaller);
    window.addEventListener('pageshow', restore);
    void (async () => {
      const saved = restoreAutomatedAttempt();
      noteStoredContinuation(saved);
      const session = initial && reload === 0 ? initial : await loadManagementSession();
      if (lifetime.current !== current) return;
      if (session.kind !== 'ready') {
        setStatus(session.kind);
        return;
      }
      const currentSaved = restoreAutomatedAttempt();
      caller.current = session;
      setAccountId(session.accountId);
      if (
        currentSaved === 'invalid' ||
        (currentSaved && currentSaved.accountId !== session.accountId) ||
        JSON.stringify(currentSaved) !== JSON.stringify(saved)
      ) {
        await blockFreshCreation(session, current, unresolvedUnknown.current ? 'blocked' : 'refused');
        return;
      }
      // Every visit, including restoration, starts with native page advice. It has no command effect.
      const read = await loadAutomatedCreationPage(session.accountId, currentSaved?.operator.id ?? null);
      if (lifetime.current !== current) return;
      if (JSON.stringify(restoreAutomatedAttempt()) !== JSON.stringify(currentSaved)) {
        revoked('refused');
        return;
      }
      if (read.kind !== 'ready') {
        revoked(read.kind);
        return;
      }
      if (read.page.readiness === 'refused') {
        revoked('refused');
        return;
      }
      await validateCaller();
      if (lifetime.current !== current) return;
      if (unresolvedUnknown.current && !currentSaved) {
        retire(false, true);
        setStatus('blocked');
        return;
      }
      setPage(read.page);
      setAttempt(currentSaved);
      setReauth(!!currentSaved && read.page.readiness === 'authentication-needed');
      setStatus(
        read.page.readiness === 'authentication-needed'
          ? 'step-up'
          : currentSaved?.submitted && (unresolvedUnknown.current || !acknowledgedSeen.current)
            ? 'unknown'
            : '',
      );
      setReady(true);
    })();
    return () => {
      retire(false, false);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('focus', validateCaller);
      window.removeEventListener('pageshow', restore);
    };
  }, [initial, reload]);
  useLayoutEffect(() => {
    if (status) feedback.current?.focus();
  }, [status]);
  useLayoutEffect(() => {
    if (attempt || draft) confirmation.current?.focus();
  }, [attempt, draft]);
  useLayoutEffect(() => {
    if (!ready || !focusAfterRead.current) return;
    focusAfterRead.current = false;
    if (!attempt && !draft) document.getElementById('automated-operator')?.focus();
  }, [attempt, draft, ready]);

  // Approval references may change; the exact parties, key and business body cannot.
  function currentWork() {
    const current = lifetime.current;
    const binding = () => {
      const saved = restoreAutomatedAttempt();
      return saved && saved !== 'invalid'
        ? JSON.stringify({ ...saved, reference: undefined, submitted: undefined })
        : saved;
    };
    const saved = binding();
    return () => {
      if (current === null || lifetime.current !== current) return false;
      if (binding() !== saved) {
        revoked('refused');
        return false;
      }
      return true;
    };
  }
  async function observe(selection: Draft, isCurrent: () => boolean) {
    const read = await loadAutomatedCreationPage(selection.accountId, selection.operatorId);
    if (!isCurrent()) return;
    await validateCaller();
    if (!isCurrent()) return;
    if (read.kind !== 'ready') {
      revoked(read.kind);
      return;
    }
    setPage(read.page);
    setConfirmed(false);
    if (read.page.readiness === 'authentication-needed') {
      setDraft(Object.freeze(selection));
      setReauth(true);
      setStatus('step-up');
      return;
    }
    if (read.page.readiness !== 'review' || !read.page.operator) {
      revoked('refused');
      return;
    }
    const next = attempt ?? createAutomatedAttempt(selection.accountId, read.page.operator, selection.handle);
    if (!next || !saveAutomatedAttempt(next)) {
      setStatus('unavailable');
      return;
    }
    setAttempt(next);
    setDraft(null);
    setReauth(false);
    setStatus(next.submitted ? 'unknown' : '');
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    if (!lifetime.current || !ready || lock.current || attempt || draft) return;
    const normalized = normalizeSignupHandle(handle);
    const invalid = { operator: !automatedId(operatorId.trim()), handle: !normalized };
    setErrors(invalid);
    if (invalid.operator || invalid.handle) {
      document.getElementById(invalid.operator ? 'automated-operator' : 'automated-handle')?.focus();
      return;
    }
    const selection = Object.freeze({ accountId, operatorId: operatorId.trim(), handle: normalized! });
    work.current = { ...work.current, operatorId: selection.operatorId, handle: selection.handle };
    setOperatorId(selection.operatorId);
    setHandle(selection.handle);
    // Ordinary sessions can authenticate before any privileged selected-operator read.
    if (page?.readiness === 'authentication-needed') {
      setDraft(selection);
      setReauth(true);
      setStatus('step-up');
      return;
    }
    const isCurrent = currentWork();
    const current = lifetime.current;
    lock.current = true;
    setBusy(true);
    setStatus('');
    try {
      await observe(selection, isCurrent);
    } finally {
      if (lifetime.current === current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!lifetime.current || lock.current || !attempt || !confirmed || reauth || page?.readiness !== 'review') return;
    const isCurrent = currentWork();
    lock.current = true;
    setBusy(true);
    setStatus('');
    setConfirmed(false);
    try {
      await validateCaller();
      if (!isCurrent()) return;
      const result = await submitAutomatedAttempt(attempt, isCurrent);
      if (result.kind === 'complete') {
        uncertaintySeen.current = true;
        noteFact('acknowledged');
      } else {
        noteStoredContinuation(restoreAutomatedAttempt());
        if (result.kind === 'unknown') {
          uncertaintySeen.current = true;
          noteFact('unknown');
        }
      }
      if (!isCurrent()) return;
      await validateCaller();
      if (!isCurrent()) return;
      const saved = restoreAutomatedAttempt();
      if (saved && saved !== 'invalid') setAttempt(saved);
      if (result.kind === 'complete') setCreated(result.accountId);
      else if (result.kind === 'refused') revoked('refused');
      else {
        setStatus(result.kind);
        setReauth(result.kind === 'step-up');
      }
    } finally {
      if (isCurrent()) {
        lock.current = false;
        setBusy(false);
        setPassword('');
      }
    }
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    const selection = attempt
      ? {
          accountId: attempt.accountId,
          operatorId: attempt.operation.operatorAccountId,
          handle: attempt.operation.handle,
        }
      : draft;
    if (!lifetime.current || lock.current || !selection) return;
    const isCurrent = currentWork();
    const current = lifetime.current;
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    setStatus('');
    const secret = password;
    work.current = { ...work.current, email: '', password: '' };
    setPassword('');
    setEmail('');
    try {
      const result = await reauthenticateAutomated(selection.accountId, email, secret, isCurrent);
      if (!isCurrent()) return;
      if (result) {
        if (result.kind === 'refused') revoked('refused');
        else setStatus(result.kind);
        return;
      }
      const session = await loadManagementSession();
      if (!isCurrent()) return;
      if (session.kind !== 'ready' || session.accountId !== selection.accountId) {
        revoked('refused');
        return;
      }
      // This explicit authentication alone may replace the admitted session binding.
      caller.current = session;
      await observe(selection, isCurrent);
    } finally {
      if (lifetime.current === current) {
        lock.current = false;
        setBusy(false);
        setPassword('');
      }
    }
  }
  const selection = attempt
    ? {
        accountId: attempt.accountId,
        operatorId: attempt.operation.operatorAccountId,
        handle: attempt.operation.handle,
      }
    : draft;
  return (
    <AuthPage heading={m.auth_automated_heading()}>
      {router && !retired ? (
        <DepartureDecision protectedWork={protectedWork} validate={validateCaller} retire={retireForDeparture} />
      ) : null}
      {retired ? (
        <div className="space-y-5">
          <AutomatedCreationReturnView
            history={history}
            dismissed={historyDismissed}
            focusRequest={historyFocusRequest}
            onDismiss={dismissHistory}
          />
          <div className="flex flex-wrap gap-4">
            <a href="/security">{m.auth_security_heading()}</a>
            <a href="/">{m.auth_home_heading()}</a>
          </div>
        </div>
      ) : (
        <div className="space-y-5" aria-busy={busy}>
          <p>{m.auth_automated_intro()}</p>
          <AutomatedCreationReturnView
            history={history}
            dismissed={historyDismissed}
            focusRequest={historyFocusRequest}
            onDismiss={dismissHistory}
          />
          {busy ? (
            <p role="status" aria-live="polite">
              {m.auth_automated_pending()}
            </p>
          ) : null}
          {status ? (
            <ErrorAlert ref={feedback} tabIndex={-1}>
              {notice(status)}
            </ErrorAlert>
          ) : null}
          {!ready ? (
            <div className="space-y-3">
              {!status ? <p role="status">{m.auth_inventory_loading()}</p> : null}
              {status === 'signed-out' ? <a href="/login">{m.auth_security_sign_in()}</a> : null}
              {status ? (
                <Button
                  type="button"
                  onClick={() => {
                    setRetired(false);
                    setReload((value) => value + 1);
                  }}
                >
                  {m.auth_account_delete_retry()}
                </Button>
              ) : null}
              <div className="flex flex-wrap gap-4">
                <a href="/security">{m.auth_security_heading()}</a>
                <a href="/">{m.auth_home_heading()}</a>
              </div>
            </div>
          ) : created ? (
            <div role="status" className="space-y-3">
              <p className="break-all">{m.auth_automated_created({ account: created })}</p>
              <p>{m.auth_automated_result()}</p>
              <a href="/security">{m.auth_security_heading()}</a>
              <a href="/">{m.auth_home_heading()}</a>
            </div>
          ) : !selection ? (
            <form noValidate onSubmit={(event) => void review(event)} className="space-y-4">
              <Field data-invalid={errors.operator || undefined}>
                <FieldLabel htmlFor="automated-operator">{m.auth_automated_operator()}</FieldLabel>
                <Input
                  id="automated-operator"
                  value={operatorId}
                  required
                  disabled={busy}
                  autoComplete="off"
                  aria-invalid={errors.operator}
                  aria-describedby={errors.operator ? 'automated-operator-error' : undefined}
                  onChange={(event) => {
                    work.current = { ...work.current, operatorId: event.target.value };
                    setOperatorId(event.target.value);
                    setErrors((value) => ({ ...value, operator: false }));
                  }}
                />
                {errors.operator ? <p id="automated-operator-error">{m.auth_automated_operator_invalid()}</p> : null}
              </Field>
              <Field data-invalid={errors.handle || undefined}>
                <FieldLabel htmlFor="automated-handle">{m.auth_signup_handle()}</FieldLabel>
                <Input
                  id="automated-handle"
                  value={handle}
                  required
                  disabled={busy}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={errors.handle}
                  aria-describedby={`automated-handle-help${errors.handle ? ' automated-handle-error' : ''}`}
                  onChange={(event) => {
                    work.current = { ...work.current, handle: event.target.value };
                    setHandle(event.target.value);
                    setErrors((value) => ({ ...value, handle: false }));
                  }}
                />
                <p id="automated-handle-help">
                  {m.auth_signup_handle_requirement({
                    minimum: page!.handleRules.minLength,
                    maximum: page!.handleRules.maxLength,
                  })}
                </p>
                {errors.handle ? <p id="automated-handle-error">{m.auth_signup_handle_invalid()}</p> : null}
              </Field>
              <Button type="submit" disabled={busy}>
                {page?.action === 'authenticate' ? m.auth_members_reauthenticate() : m.auth_automated_review()}
              </Button>
            </form>
          ) : (
            <section className="space-y-4" aria-labelledby="automated-confirmation">
              <h2 id="automated-confirmation" ref={confirmation} tabIndex={-1}>
                {m.auth_automated_confirm_heading()}
              </h2>
              <p className="break-all">
                {m.auth_automated_confirm({
                  handle: selection.handle,
                  operator:
                    page?.operator?.displayName?.trim() ||
                    page?.operator?.handle?.trim() ||
                    m.auth_automated_operator_unlabelled(),
                  id: selection.operatorId,
                })}
              </p>
              <p className="break-all">{m.auth_automated_initiator({ account: selection.accountId })}</p>
              <p>{m.auth_automated_authority()}</p>
              <p>{m.auth_automated_responsibility()}</p>
              {reauth ? (
                <form onSubmit={(event) => void authenticate(event)} className="space-y-4">
                  <Field>
                    <FieldLabel htmlFor="automated-email">{m.auth_login_email()}</FieldLabel>
                    <Input
                      id="automated-email"
                      type="email"
                      autoComplete="username"
                      required
                      disabled={busy}
                      value={email}
                      onChange={(event) => {
                        work.current = { ...work.current, email: event.target.value };
                        setEmail(event.target.value);
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="automated-password">{m.auth_login_password()}</FieldLabel>
                    <PasswordInput
                      id="automated-password"
                      autoComplete="current-password"
                      required
                      disabled={busy}
                      value={password}
                      onChange={(event) => {
                        work.current = { ...work.current, password: event.target.value };
                        setPassword(event.target.value);
                      }}
                    />
                  </Field>
                  <Button type="submit" disabled={busy}>
                    {m.auth_members_reauthenticate()}
                  </Button>
                </form>
              ) : (
                <form onSubmit={(event) => void submit(event)} className="space-y-4">
                  <label className="flex items-start gap-3">
                    <input
                      id="automated-confirm"
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    {m.auth_automated_confirm_check()}
                  </label>
                  <Button type="submit" disabled={busy || !confirmed} aria-busy={busy}>
                    {m.auth_automated_submit()}
                  </Button>
                </form>
              )}
            </section>
          )}
        </div>
      )}
    </AuthPage>
  );
}
