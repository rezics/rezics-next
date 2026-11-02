import { createFileRoute, useLocation } from '@tanstack/react-router';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { AuthButton as Button } from '../button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { KeyRound } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FieldError } from '@rezics/ui/shadcn/field';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { passkeysSupported } from '../passkeys';
import { confirmStepUp, confirmStepUpWithPasskey } from '../step-up';
import { ErrorAlert } from '../alert';

const emailId = 'step-up-email';
const emailErrorId = 'step-up-email-error';
const passwordId = 'step-up-password';
const passwordErrorId = 'step-up-password-error';

export const Route = createFileRoute('/step-up')({
  head: () => ({ meta: [{ title: `${m.auth_step_up_heading()} · REZICS` }] }),
  component: StepUpPage,
});

// Browser continuations belong to one mounted request, independently of a dispatched server sign-in.
class ConfirmationJourney {
  active = false;
  private pending: { kind: 'password' | 'passkey' } | null = null;

  constructor(readonly href: string) {}

  private isCurrent() {
    return this.active && this.href === window.location.pathname + window.location.search + window.location.hash;
  }

  private cancel() {
    const previous = this.pending;
    this.pending = null;
    if (previous?.kind === 'passkey') WebAuthnAbortService.cancelCeremony();
  }

  retire() {
    this.active = false;
    this.cancel();
  }

  begin(kind: 'password' | 'passkey') {
    if (!this.isCurrent() || (this.pending && (this.pending.kind === 'password' || kind === 'passkey'))) return null;
    this.cancel();
    const pending = { kind };
    this.pending = pending;
    const isCurrent = () => this.isCurrent() && this.pending === pending;
    return {
      isCurrent,
      finish: (success: boolean) => {
        if (!isCurrent()) return false;
        // Keep a successful confirmation closed until navigation or an explicit new journey.
        if (!success) this.pending = null;
        return true;
      },
    };
  }
}

function StepUpPage() {
  const href = useLocation({ select: (location) => location.href });
  const [generation, setGeneration] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const journey = useMemo(() => new ConfirmationJourney(href), [href, generation]);
  useLayoutEffect(() => {
    journey.active = true;
    const hide = () => {
      journey.retire();
      setSuspended(true);
    };
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      journey.retire();
      setGeneration((value) => value + 1);
      setSuspended(false);
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      journey.retire();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [journey]);
  return suspended ? (
    <AuthPage heading={m.auth_step_up_heading()} />
  ) : (
    <StepUpForm key={`${href}:${generation}`} journey={journey} query={new URL(href, 'https://auth.invalid').search} />
  );
}

function StepUpForm({ journey, query }: { journey: ConfirmationJourney; query: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  // Passkey controls appear only after the browser reports WebAuthn, so the server render has none.
  const [passkeys, setPasskeys] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [emailError, passwordError, message]);

  useEffect(() => setPasskeys(passkeysSupported()), []);

  async function submitPasskey() {
    const completion = journey.begin('passkey');
    if (!completion) return;
    setPending(true);
    setPasskeyPending(true);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const outcome = await confirmStepUpWithPasskey(query, window.location.origin, completion.isCurrent);
    if (!completion.finish(outcome.ok)) return;
    if (outcome.ok) {
      window.location.assign(outcome.target);
      return;
    }
    setPending(false);
    setPasskeyPending(false);
    if (outcome.message) setMessage(outcome.message);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending && !passkeyPending) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    const invalidPassword = !password;
    setEmailError(invalidEmail ? (email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '');
    setPasswordError(invalidPassword ? m.auth_form_required() : '');
    if (invalidEmail || invalidPassword) return;
    const completion = journey.begin('password');
    if (!completion) return;
    setPending(true);
    setPasskeyPending(false);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const outcome = await confirmStepUp(email, password, query, window.location.origin, completion.isCurrent);
    if (!completion.finish(outcome.ok)) return;
    setPassword('');
    if (outcome.ok) {
      window.location.assign(outcome.target);
      return;
    }
    setPending(false);
    setMessage(outcome.message ?? '');
  }

  return (
    <AuthPage heading={m.auth_step_up_heading()}>
      <form className="auth-login-form" method="post" action="/signin" noValidate onSubmit={submit}>
        <p>{m.auth_step_up_explanation()}</p>
        <Field data-invalid={Boolean(emailError)}>
          <FieldLabel htmlFor={emailId}>{m.auth_login_email()}</FieldLabel>
          <Input
            ref={emailInput}
            id={emailId}
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError('');
            }}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? emailErrorId : undefined}
            readOnly={pending && !passkeyPending}
            required
          />
          {emailError ? <FieldError id={emailErrorId}>{emailError}</FieldError> : null}
        </Field>
        <Field data-invalid={Boolean(passwordError)}>
          <FieldLabel htmlFor={passwordId}>{m.auth_login_password()}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            required
            readOnly={pending && !passkeyPending}
            id={passwordId}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordError('');
            }}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? passwordErrorId : undefined}
          />
          {passwordError ? <FieldError id={passwordErrorId}>{passwordError}</FieldError> : null}
        </Field>
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
        <Button type="submit" disabled={pending && !passkeyPending} aria-busy={pending && !passkeyPending}>
          {m.auth_step_up_heading()}
        </Button>
        {passkeys ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            aria-busy={passkeyPending}
            onClick={() => void submitPasskey()}
          >
            <KeyRound aria-hidden="true" />
            {m.auth_step_up_passkey()}
          </Button>
        ) : null}
      </form>
    </AuthPage>
  );
}
