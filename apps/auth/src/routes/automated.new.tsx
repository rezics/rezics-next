import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { AuthButton as Button } from '../button';
import { AuthPage } from '../frame';
import { ErrorAlert } from '../alert';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { loadManagementSession } from '../management-operations';
import { normalizeSignupHandle } from '../signup';
import {
  createAutomatedAttempt,
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

function notice(kind: string): string {
  if (kind === 'step-up') return m.auth_automated_step_up();
  if (kind === 'refused') return m.auth_automated_refused();
  if (kind === 'unknown') return m.auth_automated_unknown();
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  return m.auth_automated_unavailable();
}
export function AutomatedAccountCreatePage() {
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
  const feedback = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    void loadManagementSession().then((session) => {
      if (!active) return;
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
      active = false;
    };
  }, []);
  useEffect(() => {
    if (status) feedback.current?.focus();
  }, [status]);
  useEffect(() => {
    if (attempt) confirmation.current?.focus();
  }, [attempt]);

  async function review(event: FormEvent) {
    event.preventDefault();
    if (lock.current || attempt) return;
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
      lock.current = false;
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !attempt || !confirmed) return;
    lock.current = true;
    setBusy(true);
    setStatus('');
    setConfirmed(false);
    try {
      const result: AutomatedOutcome = await submitAutomatedAttempt(attempt);
      const saved = restoreAutomatedAttempt();
      if (saved && saved !== 'invalid') setAttempt(saved);
      if (result.kind === 'complete') setCreated(result.accountId);
      else {
        setStatus(result.kind);
        setReauth(result.kind === 'step-up');
      }
    } finally {
      lock.current = false;
      setBusy(false);
      setPassword('');
    }
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !attempt) return;
    lock.current = true;
    setBusy(true);
    setConfirmed(false);
    try {
      const result = await reauthenticateAutomated(accountId, email, password);
      if (result) setStatus(result.kind);
      else {
        setReauth(false);
        setStatus('step-up');
      }
    } finally {
      setPassword('');
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <AuthPage heading={m.auth_automated_heading()}>
      <div className="space-y-5" aria-busy={busy}>
        <p>{m.auth_automated_intro()}</p>
        {status ? (
          <ErrorAlert ref={feedback} tabIndex={-1}>
            {notice(status)}
          </ErrorAlert>
        ) : null}
        {!ready ? (
          <p role="status">{status ? notice(status) : m.auth_inventory_loading()}</p>
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
