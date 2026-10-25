import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { signIn, signInTarget } from '../sign-in';

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
  const submitting = useRef(false);
  const alert = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !email.trim() || !password) return;
    submitting.current = true;
    setPending(true);
    setMessage('');
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
        ? m.auth_login_invalid_credentials()
        : result.reason === 'rate-limited'
          ? result.retryAfter === null
            ? m.auth_login_rate_limited()
            : m.auth_login_retry_after({ seconds: result.retryAfter })
          : m.auth_login_unavailable(),
    );
  }

  return (
    <AuthPage heading={m.auth_login_heading()}>
      <form className="auth-login-form" method="post" action="/signin" onSubmit={submit}>
        <Field required>
          <FieldLabel>{m.auth_login_email()}</FieldLabel>
          <Input
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={pending}
            required
          />
        </Field>
        <Field required>
          <FieldLabel>{m.auth_login_password()}</FieldLabel>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
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
        <Button type="submit" disabled={pending || !email.trim() || !password} isLoading={pending}>
          {m.auth_login_heading()}
        </Button>
      </form>
      <nav className="auth-login-links" aria-label={m.auth_login_help()}>
        <a href="/recovery">{m.auth_login_recovery()}</a>
        <a href={`/signup${query}`}>{m.auth_login_signup()}</a>
      </nav>
    </AuthPage>
  );
}
