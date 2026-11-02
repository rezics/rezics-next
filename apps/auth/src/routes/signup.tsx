import { createFileRoute, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AuthPage } from '../frame';
import { createSignupKey, explainSignIn, normalizeSignupHandle, submitSignup } from '../signup';
import { signInTarget } from '../sign-in';
import { readTurnstileConfig } from '../turnstile.ts';
import { TurnstileWidget, type TurnstileHandle, type TurnstileStatus } from '../turnstile.tsx';
import { ErrorAlert } from '../alert';

const handleId = 'signup-handle';
const handleErrorId = 'signup-handle-error';
const emailId = 'signup-email';
const emailErrorId = 'signup-email-error';
const passwordId = 'signup-password';
const passwordErrorId = 'signup-password-error';
const turnstileErrorId = 'signup-turnstile-error';

export const Route = createFileRoute('/signup')({
  head: () => ({ meta: [{ title: `${m.auth_signup_heading()} · REZICS` }] }),
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
  const [challengeStatus, setChallengeStatus] = useState<TurnstileStatus>('loading');
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [handleError, setHandleError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [turnstileError, setTurnstileError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (handleError) document.getElementById(handleId)?.focus();
    else if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
    else if (turnstileError) document.getElementById('signup-turnstile')?.focus();
  }, [handleError, emailError, passwordError, message, turnstileError]);

  function clearErrors() {
    setHandleError('');
    setEmailError('');
    setPasswordError('');
    setTurnstileError('');
    setMessage('');
    setConflict(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    clearErrors();
    const invalidHandle = normalizeSignupHandle(handle) === null;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    const passwordLength = Array.from(password).length;
    const invalidPassword = passwordLength < 8 || passwordLength > 128;
    setHandleError(invalidHandle ? (handle ? m.auth_signup_handle_invalid() : m.auth_form_required()) : '');
    setEmailError(invalidEmail ? (email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '');
    setPasswordError(invalidPassword ? (password ? m.auth_signup_password_invalid() : m.auth_form_required()) : '');
    if (invalidHandle || invalidEmail || invalidPassword) return;
    const challenge = turnstile.current;
    const token = challenge?.getToken();
    if (!token) {
      setTurnstileError(m.auth_signup_turnstile_required());
      return;
    }
    submitting.current = true;
    setPending(true);
    const submission = await submitSignup({
      key: key.current,
      handle,
      email,
      password,
      turnstile_token: token,
    });
    if (!mounted.current) return;
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
    challenge?.reset();
    if (submission.failure.field === 'handle') {
      setHandleError(submission.failure.message);
      document.getElementById(handleId)?.focus();
      return;
    }
    setConflict(submission.failure.conflict);
    setMessage(submission.failure.message);
  }

  return (
    <AuthPage heading={m.auth_signup_heading()}>
      <form className="auth-login-form" method="post" action="/signup" noValidate onSubmit={submit}>
        <Field data-invalid={Boolean(handleError)}>
          <FieldLabel htmlFor={handleId}>{m.auth_signup_handle()}</FieldLabel>
          <Input
            id={handleId}
            name="handle"
            value={handle}
            onChange={(event) => {
              setHandle(event.target.value);
              setHandleError('');
            }}
            aria-invalid={handleError ? true : undefined}
            aria-describedby={handleError ? handleErrorId : undefined}
            readOnly={pending}
            required
          />
          {handleError ? <FieldError id={handleErrorId}>{handleError}</FieldError> : null}
        </Field>
        <Field data-invalid={Boolean(emailError)}>
          <FieldLabel htmlFor={emailId}>{m.auth_signup_email()}</FieldLabel>
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
        <Field data-invalid={Boolean(passwordError)}>
          <FieldLabel htmlFor={passwordId}>{m.auth_signup_password()}</FieldLabel>
          <PasswordInput
            name="password"
            autoComplete="new-password"
            required
            readOnly={pending}
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
        <Field data-invalid={Boolean(turnstileError) || challengeStatus === 'failed'}>
          <div id="signup-turnstile" tabIndex={-1} aria-describedby={turnstileError ? turnstileErrorId : undefined}>
            <TurnstileWidget
              ref={turnstile}
              siteKey={siteKey}
              scriptUrl={scriptUrl}
              language={getLocale()}
              onStatus={setChallengeStatus}
              onToken={(value) => {
                if (value) setTurnstileError('');
              }}
            />
          </div>
          {challengeStatus === 'loading' ? <p role="status">{m.auth_signup_turnstile_loading()}</p> : null}
          {challengeStatus === 'failed' ? (
            <div>
              <FieldError role="alert">{m.auth_signup_turnstile_failed()}</FieldError>
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  setTurnstileError('');
                  turnstile.current?.retry();
                }}
              >
                {m.auth_signup_turnstile_retry()}
              </Button>
            </div>
          ) : null}
          {turnstileError ? <FieldError id={turnstileErrorId}>{turnstileError}</FieldError> : null}
        </Field>
        {message ? (
          <ErrorAlert tabIndex={-1} ref={alert}>
            <p>{message}</p>
            {conflict ? (
              <nav className="auth-signup-links" aria-label={m.auth_signup_conflict()}>
                <a href={`/login${query}`}>{m.auth_signup_sign_in()}</a>
                <a href={`/recovery${query}`}>{m.auth_signup_recovery()}</a>
              </nav>
            ) : null}
          </ErrorAlert>
        ) : null}
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {m.auth_signup_heading()}
        </Button>
      </form>
      <nav className="auth-login-links" aria-label={m.auth_signup_sign_in()}>
        <a href={`/login${query}`}>{m.auth_signup_sign_in()}</a>
      </nav>
    </AuthPage>
  );
}
