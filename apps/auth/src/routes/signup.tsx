import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Button } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AuthPage } from '../frame';
import { createSignupKey, explainSignIn, submitSignup } from '../signup';
import { signInTarget } from '../sign-in';
import { readTurnstileConfig } from '../turnstile.ts';
import { TurnstileWidget, type TurnstileHandle } from '../turnstile.tsx';

const handleId = 'signup-handle';
const handleErrorId = 'signup-handle-error';
const emailId = 'signup-email';
const passwordId = 'signup-password';
const passwordErrorId = 'signup-password-error';

export const Route = createFileRoute('/signup')({
  loader: () => readTurnstileConfig(),
  component: SignupPage,
});

function SignupPage() {
  const { siteKey, scriptUrl } = Route.useLoaderData();
  const query = useRouter().history.location.search;
  const key = useRef(createSignupKey());
  const turnstile = useRef<TurnstileHandle>(null);
  const alert = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [handleError, setHandleError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);

  useLayoutEffect(() => {
    if (handleError) document.getElementById(handleId)?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [handleError, passwordError, message]);

  function clearErrors() {
    setHandleError('');
    setPasswordError('');
    setMessage('');
    setConflict(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending || !handle.trim() || !email.trim() || !password || !token) return;
    clearErrors();
    submitting.current = true;
    setPending(true);
    const submission = await submitSignup({
      key: key.current,
      handle,
      email,
      password,
      turnstile_token: token,
    });
    if (submission.ok) {
      if (submission.signIn.ok) {
        window.location.assign(signInTarget(query, window.location.origin));
        return;
      }
      submitting.current = false;
      setPending(false);
      setMessage(explainSignIn(submission.signIn));
      return;
    }
    submitting.current = false;
    setPending(false);
    if (submission.failure.field === 'password') {
      setPasswordError(submission.failure.message);
      document.getElementById(passwordId)?.focus();
      return;
    }
    setToken(null);
    turnstile.current?.reset();
    if (submission.failure.field === 'handle') {
      setHandleError(submission.failure.message);
      document.getElementById(handleId)?.focus();
      return;
    }
    setConflict(submission.failure.conflict);
    setMessage(submission.failure.message);
  }

  const blocked = pending || !handle.trim() || !email.trim() || !password || !token;

  return (
    <AuthPage heading={m.auth_signup_heading()}>
      <form className="auth-login-form" method="post" action="/signup" noValidate onSubmit={submit}>
        <Field>
          <FieldLabel htmlFor={handleId}>{m.auth_signup_handle()}</FieldLabel>
          <Input
            id={handleId}
            name="handle"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            aria-invalid={handleError ? true : undefined}
            aria-describedby={handleError ? handleErrorId : undefined}
            readOnly={pending}
            required
          />
          {handleError ? (
            <p id={handleErrorId} className="auth-login-alert" role="alert">
              {handleError}
            </p>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={emailId}>{m.auth_signup_email()}</FieldLabel>
          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            readOnly={pending}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={passwordId}>{m.auth_signup_password()}</FieldLabel>
          <Input
            id={passwordId}
            name="password"
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? passwordErrorId : undefined}
            readOnly={pending}
            required
          />
          <button type="button" className="auth-signup-toggle" onClick={() => setVisible((value) => !value)}>
            {visible ? m.auth_signup_hide_password() : m.auth_signup_show_password()}
          </button>
          {passwordError ? (
            <p id={passwordErrorId} className="auth-login-alert" role="alert">
              {passwordError}
            </p>
          ) : null}
        </Field>
        <TurnstileWidget
          ref={turnstile}
          siteKey={siteKey}
          scriptUrl={scriptUrl}
          language={getLocale()}
          onToken={setToken}
        />
        {message ? (
          <div className="auth-login-alert" role="alert" tabIndex={-1} ref={alert}>
            <p>{message}</p>
            {conflict ? (
              <nav className="auth-signup-links" aria-label={m.auth_signup_conflict()}>
                <a href={`/login${query}`}>{m.auth_signup_sign_in()}</a>
                <a href={`/recovery${query}`}>{m.auth_signup_recovery()}</a>
              </nav>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" disabled={blocked} isLoading={pending}>
          {m.auth_signup_heading()}
        </Button>
      </form>
      <nav className="auth-login-links" aria-label={m.auth_signup_sign_in()}>
        <a href={`/login${query}`}>{m.auth_signup_sign_in()}</a>
      </nav>
    </AuthPage>
  );
}
