import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
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
  createAutomatedAttempt,
  discardAutomatedReview,
  loadAutomatedOperator,
  reauthenticateAutomated,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
  submitAutomatedAttempt,
  type AutomatedAttempt,
  type AutomatedOutcome,
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
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  return m.auth_automated_unavailable();
}
export function AutomatedAccountCreatePage({ initial }: { initial?: ManagementSessionResult } = {}) {
  const router = useRouter({ warn: false });
  const [accountId, setAccountId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [handle, setHandle] = useState('');
  const [attempt, setAttempt] = useState<AutomatedAttempt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('');
  const [reauth, setReauth] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState('');
  const lock = useRef(false);
  const lifetime = useRef<object | null>(null);
  const [reload, setReload] = useState(0);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);

  const work = useRef({ accountId, attempt, ready, created, busy, operatorId, handle });
  work.current = { accountId, attempt, ready, created, busy, operatorId, handle };
  const protectedWork = () => {
    const value = work.current;
    return (
      !!lifetime.current &&
      value.ready &&
      !value.created &&
      !!(value.busy || value.attempt || value.operatorId.trim() || value.handle.trim())
    );
  };
  function retire() {
    lifetime.current = null;
    discardAutomatedReview(work.current.attempt);
    work.current.ready = false;
    setReady(false);
    setAttempt(null);
    setConfirmed(false);
    setOperatorId('');
    setHandle('');
    setEmail('');
    setPassword('');
  }
  async function validateCaller() {
    const current = lifetime.current;
    const owner = work.current.accountId;
    if (!current || !owner) return;
    const session = await loadManagementSession();
    if (lifetime.current !== current) return;
    if (
      session.kind === 'signed-out' ||
      (session.kind === 'ready' && (session.accountId !== owner || !session.scopes.includes('account:manage')))
    ) {
      retire();
      setStatus('refused');
    }
  }
  useLayoutEffect(() => {
    const current = {};
    lifetime.current = current;
    lock.current = false;
    setBusy(false);
    setReady(false);
    setStatus('');
    setConfirmed(false);
    setReauth(false);
    setPassword('');
    setCreated('');
    setAccountId('');
    setAttempt(null);
    setOperatorId('');
    setHandle('');
    setEmail('');
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setReload((value) => value + 1);
    };
    window.addEventListener('pagehide', retire);
    window.addEventListener('focus', validateCaller);
    window.addEventListener('pageshow', restore);
    void (initial && reload === 0 ? Promise.resolve(initial) : loadManagementSession()).then((session) => {
      if (lifetime.current !== current) return;
      if (session.kind !== 'ready') {
        setStatus(session.kind);
        return;
      }
      const saved = restoreAutomatedAttempt();
      if (saved === 'invalid' || (saved && saved.accountId !== session.accountId)) {
        setStatus('refused');
        return;
      }
      setAccountId(session.accountId);
      setAttempt(saved);
      setReady(true);
    });
    return () => {
      retire();
      window.removeEventListener('pagehide', retire);
      window.removeEventListener('focus', validateCaller);
      window.removeEventListener('pageshow', restore);
    };
  }, [initial, reload]);
  useEffect(() => {
    if (status) feedback.current?.focus();
  }, [status]);
  useEffect(() => {
    if (attempt) confirmation.current?.focus();
  }, [attempt]);

  // Approval references may change during this command; its parties and business body cannot.
  function currentWork() {
    const current = lifetime.current;
    const binding = () => {
      const saved = restoreAutomatedAttempt();
      return saved && saved !== 'invalid'
        ? JSON.stringify({ ...saved, reference: undefined, submitted: undefined })
        : saved;
    };
    const saved = binding();
    return () => current !== null && lifetime.current === current && binding() === saved;
  }

  async function review(event: FormEvent) {
    event.preventDefault();
    if (!lifetime.current || !ready || lock.current || attempt) return;
    const isCurrent = currentWork();
    const current = lifetime.current;
    const normalized = normalizeSignupHandle(handle);
    if (!normalized) {
      setStatus('refused');
      return;
    }
    lock.current = true;
    setBusy(true);
    setStatus('');
    try {
      const target = await loadAutomatedOperator(accountId, operatorId);
      if (!isCurrent()) return;
      await validateCaller();
      if (!isCurrent()) return;
      if (target.kind !== 'ready') {
        setStatus('unavailable');
        return;
      }
      const next = createAutomatedAttempt(accountId, target.operator, normalized);
      if (!next || !saveAutomatedAttempt(next)) {
        setStatus('unavailable');
        return;
      }
      setAttempt(next);
      setConfirmed(false);
    } finally {
      if (lifetime.current === current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!lifetime.current || lock.current || !attempt || !confirmed) return;
    const isCurrent = currentWork();
    lock.current = true;
    setBusy(true);
    setStatus('');
    setConfirmed(false);
    try {
      const result: AutomatedOutcome = await submitAutomatedAttempt(attempt, isCurrent);
      if (!isCurrent()) return;
      const session = await loadManagementSession();
      if (!isCurrent()) return;
      if (session.kind !== 'ready' || session.accountId !== accountId || !session.scopes.includes('account:manage')) {
        if (session.kind !== 'unavailable') retire();
        setStatus(session.kind === 'unavailable' ? 'unavailable' : 'refused');
        return;
      }
      const saved = restoreAutomatedAttempt();
      if (saved && saved !== 'invalid') setAttempt(saved);
      if (result.kind === 'complete') setCreated(result.accountId);
      else {
        if (result.kind === 'refused') retire();
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
    if (!lifetime.current || lock.current || !attempt) return;
    const isCurrent = currentWork();
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    try {
      const result = await reauthenticateAutomated(accountId, email, password, isCurrent);
      if (!isCurrent()) return;
      await validateCaller();
      if (!isCurrent()) return;
      if (result) {
        if (result.kind === 'refused') retire();
        setStatus(result.kind);
      } else {
        setReauth(false);
        setStatus('step-up');
      }
    } finally {
      if (isCurrent()) {
        setPassword('');
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <AuthPage heading={m.auth_automated_heading()}>
      {router ? <DepartureDecision protectedWork={protectedWork} validate={validateCaller} retire={retire} /> : null}
      <div className="space-y-5" aria-busy={busy}>
        <p>{m.auth_automated_intro()}</p>
        {status ? (
          <ErrorAlert ref={feedback} tabIndex={-1}>
            {notice(status)}
          </ErrorAlert>
        ) : null}
        {!ready ? (
          <div className="space-y-3">
            <p role="status">{status ? notice(status) : m.auth_inventory_loading()}</p>
            {status === 'unavailable' ? (
              <Button type="button" onClick={() => setReload((value) => value + 1)}>
                {m.auth_account_delete_retry()}
              </Button>
            ) : null}
          </div>
        ) : created ? (
          <div role="status" className="space-y-3">
            <p>{m.auth_automated_created({ account: created })}</p>
            <p>{m.auth_automated_result()}</p>
          </div>
        ) : !attempt ? (
          <form onSubmit={(event) => void review(event)} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="automated-operator">{m.auth_automated_operator()}</FieldLabel>
              <Input
                id="automated-operator"
                value={operatorId}
                required
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setOperatorId(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="automated-handle">{m.auth_signup_handle()}</FieldLabel>
              <Input
                id="automated-handle"
                value={handle}
                required
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setHandle(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {m.auth_automated_review()}
            </Button>
          </form>
        ) : (
          <section className="space-y-4" aria-labelledby="automated-confirmation">
            <h2 id="automated-confirmation" ref={confirmation} tabIndex={-1}>
              {m.auth_automated_confirm_heading()}
            </h2>
            <p className="break-all">
              {m.auth_automated_confirm({
                handle: attempt.operation.handle,
                operator: attempt.operator.displayName ?? attempt.operator.handle ?? attempt.operator.id,
                id: attempt.operation.operatorAccountId,
              })}
            </p>
            <p className="break-all">{m.auth_automated_initiator({ account: attempt.accountId })}</p>
            <p>{m.auth_automated_authority()}</p>
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
                    onChange={(event) => setEmail(event.target.value)}
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
                    onChange={(event) => setPassword(event.target.value)}
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
    </AuthPage>
  );
}
