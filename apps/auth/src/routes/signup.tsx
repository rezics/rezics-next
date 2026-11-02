import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@rezics/ui/shadcn/alert-dialog';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AuthPage } from '../frame';
import { createSignupKey, explainSignIn, normalizeSignupHandle, submitSignup } from '../signup';
import { signIn, signInTarget } from '../sign-in';
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

type SignupJourney = { active: boolean; sequence: number; query: string };

// Keep the router adapter with the form: Stay never replaces its journey or submission key.
function SignupDeparture({
  shouldWarn,
  leave,
  focus,
}: {
  shouldWarn: () => boolean;
  leave: () => void;
  focus: () => void;
}) {
  const blocker = useBlocker({ shouldBlockFn: shouldWarn, enableBeforeUnload: false, withResolver: true });
  useLayoutEffect(() => {
    // Creation finishes this draft even if the subsequent sign-in fails.
    if (blocker.status === 'blocked' && !shouldWarn()) blocker.proceed();
  });
  const stay = () => {
    if (blocker.status === 'blocked') blocker.reset();
  };
  return (
    <AlertDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <AlertDialogContent
        finalFocus={() => {
          focus();
          return false;
        }}
      >
        <AlertDialogTitle>{m.auth_signup_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>{m.auth_signup_departure_description()}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (blocker.status !== 'blocked') return;
              leave();
              blocker.proceed();
            }}
          >
            {m.auth_organization_departure_leave()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SignupPage() {
  const { history } = useRouter();
  const sequence = useRef(0);
  const [journey, setJourney] = useState<SignupJourney | null>(null);
  useLayoutEffect(() => {
    let current: SignupJourney | null = null;
    const leave = () => {
      // This fences browser continuations; a dispatched server write may still complete.
      if (current) current.active = false;
      current = null;
      setJourney(null);
    };
    const replace = () => {
      leave();
      if (history.location.pathname !== '/signup') return;
      current = { active: true, sequence: ++sequence.current, query: history.location.search };
      setJourney(current);
    };
    const unsubscribe = history.subscribe(replace);
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) replace();
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);
    replace();
    return () => {
      if (current) current.active = false;
      unsubscribe();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
    };
  }, [history]);
  return journey ? <SignupForm key={journey.sequence} journey={journey} /> : null;
}

function SignupForm({ journey }: { journey: SignupJourney }) {
  const { history } = useRouter();
  const { siteKey, scriptUrl } = Route.useLoaderData();
  const { query } = journey;
  const key = useRef(createSignupKey());
  const turnstile = useRef<TurnstileHandle>(null);
  const alert = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challengeStatus, setChallengeStatus] = useState<TurnstileStatus>('loading');
  const [created, setCreated] = useState(false);
  const [pending, setPending] = useState(false);
  const [handleError, setHandleError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [turnstileError, setTurnstileError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const protectedDraft = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  protectedDraft.current = !created && Boolean(handle.trim() || email.trim() || password || pending);
  const shouldWarn = useCallback(() => {
    const warn = journey.active && protectedDraft.current;
    if (warn && !document.activeElement?.closest('[role="alertdialog"]'))
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return warn;
  }, [journey]);
  const retire = useCallback(() => {
    // Only browser continuations are retired; a dispatched creation can still finish on the server.
    journey.active = false;
    protectedDraft.current = false;
    form.current?.querySelectorAll('input').forEach((input) => {
      input.value = '';
    });
  }, [journey]);
  const leave = () => {
    retire();
    setHandle('');
    setEmail('');
    setPassword('');
  };
  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('pagehide', leave);
    return () => {
      retire();
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('pagehide', leave);
    };
  }, [retire, shouldWarn]);
  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.push(event.currentTarget.getAttribute('href')!);
  }

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
    if (!journey.active || created || submitting.current || pending) return;
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
    if (!journey.active) return;
    if (submission.ok) {
      protectedDraft.current = false;
      setCreated(true);
      setPassword('');
      // Creation is final for this journey. A login failure only offers existing login/recovery routes.
      const result = await signIn(email, password);
      if (!journey.active) return;
      if (result.ok) {
        window.location.assign(signInTarget(query, window.location.origin));
        return;
      }
      submitting.current = false;
      setPending(false);
      setMessage(explainSignIn(result));
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
      <SignupDeparture
        shouldWarn={shouldWarn}
        leave={leave}
        focus={() => {
          const previous = returnFocus.current;
          if (previous?.isConnected && previous !== document.body) previous.focus();
          else document.getElementById(handleId)?.focus();
        }}
      />
      {created ? (
        <div className="auth-login-form" aria-busy={pending}>
          <p role="status">{m.auth_signup_created()}</p>
          {message ? (
            <ErrorAlert tabIndex={-1} ref={alert}>
              <p>{message}</p>
            </ErrorAlert>
          ) : null}
          <nav className="auth-signup-links" aria-label={m.auth_signup_sign_in()}>
            <a href={`/login${query}`} onClick={follow}>
              {m.auth_signup_sign_in()}
            </a>
            <a href={`/recovery${query}`} onClick={follow}>
              {m.auth_signup_recovery()}
            </a>
          </nav>
        </div>
      ) : (
        <form ref={form} className="auth-login-form" method="post" action="/signup" noValidate onSubmit={submit}>
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
                  <a href={`/login${query}`} onClick={follow}>
                    {m.auth_signup_sign_in()}
                  </a>
                  <a href={`/recovery${query}`} onClick={follow}>
                    {m.auth_signup_recovery()}
                  </a>
                </nav>
              ) : null}
            </ErrorAlert>
          ) : null}
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {m.auth_signup_heading()}
          </Button>
        </form>
      )}
      {!created ? (
        <nav className="auth-login-links" aria-label={m.auth_signup_sign_in()}>
          <a href={`/login${query}`} onClick={follow}>
            {m.auth_signup_sign_in()}
          </a>
        </nav>
      ) : null}
    </AuthPage>
  );
}
