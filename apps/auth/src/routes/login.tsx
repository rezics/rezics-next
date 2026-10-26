import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { PasswordInput, PasswordInputGroup, PasswordInputInput, PasswordInputTrigger } from '@rezics/ui/password-input';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { failureMessage, RECOVERY_COMPLETE_NOTICE_KEY } from '../api';
import {
  passkeyAutofillSupported,
  passkeySignInFailure,
  passkeysSupported,
  signInWithPasskey,
  type PasskeySignInResult,
} from '../passkeys';
import { signIn, signInTarget } from '../sign-in';
import { ErrorAlert } from '../alert';

const emailId = 'login-email';
const emailErrorId = 'login-email-error';
const passwordId = 'login-password';
const passwordErrorId = 'login-password-error';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  // Router search serialization turns repeated parameters into a JSON array.
  // Auth needs the original query, including its signature on the sign-up link.
  const query = useRouter().history.location.search;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [recoveryComplete, setRecoveryComplete] = useState(false);
  // Passkey controls appear only after the browser reports WebAuthn, so the server render has none.
  const [passkeySupport, setPasskeySupport] = useState<'none' | 'prompt' | 'autofill'>('none');
  const [passkeyPending, setPasskeyPending] = useState(false);
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [emailError, passwordError, message]);

  useLayoutEffect(() => {
    if (window.sessionStorage.getItem(RECOVERY_COMPLETE_NOTICE_KEY) === '1') {
      window.sessionStorage.removeItem(RECOVERY_COMPLETE_NOTICE_KEY);
      setRecoveryComplete(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!passkeysSupported()) return;
      setPasskeySupport('prompt');
      if ((await passkeyAutofillSupported()) && active) setPasskeySupport('autofill');
    })();
    return () => {
      active = false;
    };
  }, []);

  // The browser offers passkeys in the email field once its autocomplete token is on the page.
  useEffect(() => {
    if (passkeySupport !== 'autofill') return;
    startAutofill();
    return () => WebAuthnAbortService.cancelCeremony();
  }, [passkeySupport]);

  function startAutofill() {
    void signInWithPasskey({ autofill: true }).then(finishPasskey);
  }

  function finishPasskey(result: PasskeySignInResult) {
    if (result.ok) {
      window.location.assign(signInTarget(query, window.location.origin));
      return;
    }
    submitting.current = false;
    setPending(false);
    setPasskeyPending(false);
    if (result.reason === 'cancelled') return;
    setMessage(passkeySignInFailure(result));
  }

  async function submitPasskey() {
    if (submitting.current || pending) return;
    submitting.current = true;
    setPending(true);
    setPasskeyPending(true);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const result = await signInWithPasskey();
    finishPasskey(result);
    // Showing the prompt replaced the autofill ceremony, so offer autofill again if the person backed out.
    if (!result.ok && passkeySupport === 'autofill') startAutofill();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    const invalidPassword = !password;
    setEmailError(invalidEmail ? (email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '');
    setPasswordError(invalidPassword ? m.auth_form_required() : '');
    if (invalidEmail || invalidPassword) {
      if (invalidEmail) emailInput.current?.focus();
      else document.getElementById(passwordId)?.focus();
      return;
    }
    submitting.current = true;
    setPending(true);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const result = await signIn(email, password);
    setPassword('');
    if (result.ok) {
      window.location.assign(signInTarget(query, window.location.origin));
      return;
    }
    submitting.current = false;
    setPending(false);
    setMessage(
      result.reason === 'credentials'
        ? failureMessage(401, 'authentication_denied', null)
        : result.reason === 'rate-limited'
          ? failureMessage(429, 'rate_limited', result.retryAfter)
          : failureMessage(503, 'unavailable', null),
    );
  }

  return (
    <AuthPage heading={m.auth_login_heading()}>
      <form className="auth-login-form" method="post" action="/signin" noValidate onSubmit={submit}>
        <Field required invalid={Boolean(emailError)}>
          <FieldLabel htmlFor={emailId}>{m.auth_login_email()}</FieldLabel>
          <Input
            ref={emailInput}
            id={emailId}
            name="email"
            type="email"
            autoComplete={passkeySupport === 'autofill' ? 'username webauthn' : 'username'}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailError('');
            }}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? emailErrorId : undefined}
            readOnly={pending}
            required
          />
          {emailError ? <FieldError id={emailErrorId}>{emailError}</FieldError> : null}
        </Field>
        <Field required invalid={Boolean(passwordError)}>
          <FieldLabel htmlFor={passwordId}>{m.auth_login_password()}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="current-password"
            required
            readOnly={pending}
            invalid={Boolean(passwordError)}
            translations={{
              visibilityTrigger: (visible) =>
                visible ? m.auth_security_hide_password() : m.auth_security_show_password(),
            }}
          >
            <PasswordInputGroup>
              <PasswordInputInput
                id={passwordId}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setPasswordError('');
                }}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? passwordErrorId : undefined}
              />
              <PasswordInputTrigger />
            </PasswordInputGroup>
          </PasswordInput>
          {passwordError ? <FieldError id={passwordErrorId}>{passwordError}</FieldError> : null}
        </Field>
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
        <Button type="submit" disabled={pending} isLoading={pending && !passkeyPending}>
          {m.auth_login_heading()}
        </Button>
        {passkeySupport === 'none' ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            isLoading={passkeyPending}
            onClick={() => void submitPasskey()}
          >
            <KeyRound aria-hidden="true" />
            {m.auth_login_passkey()}
          </Button>
        )}
      </form>
      {recoveryComplete ? (
        <div className="auth-login-alert" role="status">
          {m.auth_login_recovery_success()}
        </div>
      ) : null}
      <nav className="auth-login-links" aria-label={m.auth_login_help()}>
        <a href="/recovery">{m.auth_login_recovery()}</a>
        <a href={`/signup${query}`}>{m.auth_login_signup()}</a>
      </nav>
    </AuthPage>
  );
}
