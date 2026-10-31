import { createFileRoute } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { authPost, failureMessage, RECOVERY_COMPLETE_NOTICE_KEY } from '../api';
import { ErrorAlert } from '../alert';

const emailId = 'recovery-email';
const emailErrorId = 'recovery-email-error';
const passwordId = 'recovery-password';
const passwordErrorId = 'recovery-password-error';

export const Route = createFileRoute('/recovery')({
  head: () => ({ meta: [{ title: `${m.auth_recovery_heading()} · REZICS` }] }),
  component: RecoveryPage,
});

function RecoveryPage() {
  const [hasFragment, setHasFragment] = useState<boolean | null>(null);
  const [credentials, setCredentials] = useState<{ accountId: string; token: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordFieldError, setPasswordFieldError] = useState('');
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const fragment = window.location.hash;
    if (fragment) {
      const parameters = new URLSearchParams(fragment.slice(1));
      const recovered = { accountId: parameters.get('account_id'), token: parameters.get('token') };
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      if (recovered.accountId && recovered.token) {
        setCredentials({ accountId: recovered.accountId, token: recovered.token });
      } else {
        setMessage(failureMessage(401, 'invalid_recovery', null));
      }
      setHasFragment(true);
    } else {
      setHasFragment(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (emailError) emailInput.current?.focus();
    else if (passwordFieldError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [emailError, passwordFieldError, message]);

  async function submitStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    if (invalidEmail) {
      setNotice('');
      setEmailError(email.trim() ? m.auth_form_email_invalid() : m.auth_form_required());
      return;
    }
    setEmailError('');
    submitting.current = true;
    setPending(true);
    setNotice('');
    setMessage('');
    const result = await authPost('/recovery/start', { email: email.trim() });
    submitting.current = false;
    setPending(false);
    if (result.ok) {
      setNotice(m.auth_recovery_start_success());
      return;
    }
    setMessage(failureMessage(result.status, result.code, result.retryAfter));
  }

  async function submitComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    const passwordLength = Array.from(password).length;
    if (passwordLength < 8 || passwordLength > 128) {
      const error = password ? m.auth_recovery_password_invalid() : m.auth_form_required();
      setPasswordFieldError(error);
      setMessage(error);
      return;
    }
    setPasswordFieldError('');
    if (!credentials?.accountId || !credentials.token) {
      setMessage(failureMessage(401, 'invalid_recovery', null));
      return;
    }
    submitting.current = true;
    setPending(true);
    setMessage('');
    const result = await authPost('/recovery/complete', {
      account_id: credentials.accountId,
      token: credentials.token,
      new_password: password,
    });
    submitting.current = false;
    setPending(false);
    if (result.ok) {
      try {
        window.sessionStorage.setItem(RECOVERY_COMPLETE_NOTICE_KEY, '1');
      } catch {
        // The optional notice must not prevent navigation after native completion.
      }
      window.location.assign('/login');
      return;
    }
    setMessage(failureMessage(result.status, result.code, result.retryAfter));
  }

  if (hasFragment === null) return <AuthPage heading={m.auth_recovery_heading()} />;

  if (hasFragment && !credentials) {
    return (
      <AuthPage heading={m.auth_recovery_heading()}>
        <ErrorAlert tabIndex={-1} ref={alert}>
          {message}
        </ErrorAlert>
        <a href="/recovery">{m.auth_recovery_new_link()}</a>
      </AuthPage>
    );
  }

  if (hasFragment) {
    return (
      <AuthPage heading={m.auth_recovery_heading()}>
        <form
          className="auth-login-form"
          method="post"
          action="/recovery/complete"
          noValidate
          onSubmit={submitComplete}
        >
          <Field data-invalid={Boolean(passwordFieldError)}>
            <FieldLabel htmlFor={passwordId}>{m.auth_recovery_password()}</FieldLabel>
            <PasswordInput
              name="new_password"
              autoComplete="new-password"
              required
              readOnly={pending}
              id={passwordId}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordFieldError('');
                setMessage('');
              }}
              aria-invalid={passwordFieldError ? true : undefined}
              aria-describedby={passwordFieldError ? passwordErrorId : undefined}
            />
            {passwordFieldError ? (
              <FieldError id={passwordErrorId} role={message ? undefined : 'alert'}>
                {passwordFieldError}
              </FieldError>
            ) : null}
          </Field>
          {message ? (
            <ErrorAlert tabIndex={-1} ref={alert}>
              {message}
            </ErrorAlert>
          ) : null}
          {message === failureMessage(401, 'invalid_recovery', null) ? (
            <a href="/recovery">{m.auth_recovery_new_link()}</a>
          ) : null}
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {m.auth_recovery_complete_submit()}
          </Button>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage heading={m.auth_recovery_heading()}>
      <form className="auth-login-form" method="post" action="/recovery/start" noValidate onSubmit={submitStart}>
        <Field data-invalid={Boolean(emailError)}>
          <FieldLabel htmlFor={emailId}>{m.auth_recovery_email()}</FieldLabel>
          <Input
            ref={emailInput}
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
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
        {notice ? (
          <div className="auth-login-alert" role="status">
            {notice}
          </div>
        ) : null}
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            {message}
          </ErrorAlert>
        ) : null}
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {m.auth_recovery_start_submit()}
        </Button>
      </form>
    </AuthPage>
  );
}
