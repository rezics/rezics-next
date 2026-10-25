import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { authPost, failureMessage, RECOVERY_COMPLETE_NOTICE_KEY } from '../api';

export const Route = createFileRoute('/recovery')({
  component: RecoveryPage,
});

function RecoveryPage() {
  const [hasFragment, setHasFragment] = useState<boolean | null>(null);
  const [credentials, setCredentials] = useState<{ accountId: string | null; token: string | null } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const fragment = window.location.hash;
    if (fragment) {
      const parameters = new URLSearchParams(fragment.slice(1));
      const recovered = { accountId: parameters.get('account_id'), token: parameters.get('token') };
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      setCredentials(recovered);
      setHasFragment(true);
    } else {
      setHasFragment(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  async function submitStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    if (!emailInput.current?.checkValidity()) {
      setNotice('');
      setMessage(failureMessage(400, 'invalid_request', null));
      return;
    }
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
      setMessage(failureMessage(400, 'invalid_password', null));
      return;
    }
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
      window.sessionStorage.setItem(RECOVERY_COMPLETE_NOTICE_KEY, '1');
      window.location.assign('/login');
      return;
    }
    setMessage(failureMessage(result.status, result.code, result.retryAfter));
  }

  if (hasFragment === null) return <AuthPage heading={m.auth_recovery_heading()} />;

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
          <Field required>
            <FieldLabel>{m.auth_recovery_password()}</FieldLabel>
            <Input
              name="new_password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              readOnly={pending}
              required
            />
          </Field>
          {message ? (
            <div className="auth-login-alert" role="alert" tabIndex={-1} ref={alert}>
              {message}
            </div>
          ) : null}
          {message === failureMessage(401, 'invalid_recovery', null) ? (
            <a href="/recovery">{m.auth_recovery_new_link()}</a>
          ) : null}
          <Button type="submit" disabled={pending || !password} isLoading={pending}>
            {m.auth_recovery_complete_submit()}
          </Button>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage heading={m.auth_recovery_heading()}>
      <form className="auth-login-form" method="post" action="/recovery/start" noValidate onSubmit={submitStart}>
        <Field required>
          <FieldLabel>{m.auth_recovery_email()}</FieldLabel>
          <Input
            ref={emailInput}
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={pending}
            required
          />
        </Field>
        {notice ? (
          <div className="auth-login-alert" role="status">
            {notice}
          </div>
        ) : null}
        {message ? (
          <div className="auth-login-alert" role="alert" tabIndex={-1} ref={alert}>
            {message}
          </div>
        ) : null}
        <Button type="submit" disabled={pending || !email.trim()} isLoading={pending}>
          {m.auth_recovery_start_submit()}
        </Button>
      </form>
    </AuthPage>
  );
}
