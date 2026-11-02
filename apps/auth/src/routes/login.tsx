import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@rezics/ui/shadcn/alert-dialog';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { PasswordInput } from '../password-input';
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
import { selectManagementOperationStepUp } from '../management-operation-step-up';
import { confirmStepUp, confirmStepUpWithPasskey } from '../step-up';
import { LoginAttempt, useLoginJourney } from '../login-attempt';

const emailId = 'login-email';
const emailErrorId = 'login-email-error';
const passwordId = 'login-password';
const passwordErrorId = 'login-password-error';

export const Route = createFileRoute('/login')({
  head: () => ({ meta: [{ title: `${m.auth_login_heading()} · REZICS` }] }),
  component: LoginPage,
});

function LoginPage() {
  const journey = useLoginJourney();
  return journey ? (
    <LoginForm key={journey.key} query={journey.query} attempt={journey.attempt} />
  ) : (
    <AuthPage heading={m.auth_login_heading()} />
  );
}

// Keep navigation ownership local to this form; credentials never enter the blocker or its copy.
function LoginDeparture({
  unfinished,
  leave,
  focus,
}: {
  unfinished: { current: boolean };
  leave: () => void;
  focus: () => void;
}) {
  const callbacks = useRef({ leave, focus });
  callbacks.current = { leave, focus };
  const returnFocus = useRef<HTMLElement | null>(null);
  const shouldWarn = useCallback(() => unfinished.current, [unfinished]);
  const blocker = useBlocker({
    shouldBlockFn: useCallback(
      ({ next }: { next: { pathname: string } }) => {
        // A replacement authentication request revokes the previous request before any async continuation.
        if (next.pathname === '/login') {
          callbacks.current.leave();
          return false;
        }
        if (!unfinished.current) return false;
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return true;
      },
      [unfinished],
    ),
    enableBeforeUnload: shouldWarn,
    withResolver: true,
  });
  const resolver = useRef(blocker);
  resolver.current = blocker;
  useLayoutEffect(
    () => () => {
      if (resolver.current.status === 'blocked') resolver.current.reset();
    },
    [],
  );
  useLayoutEffect(() => {
    // A completed sign-in owns its validated destination, even while a departure choice is open.
    if (blocker.status === 'blocked' && !unfinished.current) blocker.reset();
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
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
          else callbacks.current.focus();
          return false;
        }}
      >
        <AlertDialogTitle>{m.auth_login_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>{m.auth_login_departure_description()}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (blocker.status !== 'blocked') return;
              callbacks.current.leave();
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

function LoginForm({ query, attempt }: { query: string; attempt: LoginAttempt }) {
  const { history } = useRouter();
  const released = useRef(false);
  const unfinished = useRef(false);
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
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  unfinished.current = !released.current && Boolean(email.trim() || password || pending);

  function leave() {
    released.current = true;
    unfinished.current = false;
    attempt.retire();
    setEmail('');
    setPassword('');
    setPending(false);
    setPasskeyPending(false);
  }

  function complete(target: string) {
    leave();
    window.location.assign(target);
  }

  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    // Push the original href so repeated, empty and signed query parameters keep their exact encoding.
    history.push(event.currentTarget.getAttribute('href')!);
  }

  useLayoutEffect(() => {
    if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [emailError, passwordError, message]);

  useLayoutEffect(() => {
    try {
      if (window.sessionStorage.getItem(RECOVERY_COMPLETE_NOTICE_KEY) === '1') {
        window.sessionStorage.removeItem(RECOVERY_COMPLETE_NOTICE_KEY);
        setRecoveryComplete(true);
      }
    } catch {
      // The notice is optional when browser storage is unavailable.
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
    if (passkeySupport !== 'autofill' || selectManagementOperationStepUp(query).kind !== 'ordinary') return;
    startAutofill();
  }, [passkeySupport, query, attempt]);

  function startAutofill() {
    const completion = attempt.begin('autofill');
    if (!completion) return;
    void signInWithPasskey({ autofill: true, isCurrent: completion.isCurrent }).then((result) => {
      if (completion.finish()) finishPasskey(result);
    });
  }

  function finishPasskey(result: PasskeySignInResult) {
    if (result.ok) {
      complete(signInTarget(query, window.location.origin));
      return;
    }
    setPending(false);
    setPasskeyPending(false);
    if (result.reason === 'cancelled') return;
    setMessage(passkeySignInFailure(result));
  }

  async function submitPasskey() {
    const completion = attempt.begin('passkey');
    if (!completion) return;
    setPending(true);
    setPasskeyPending(true);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    if (selectManagementOperationStepUp(query).kind !== 'ordinary') {
      const outcome = await confirmStepUpWithPasskey(query, window.location.origin, completion.isCurrent);
      if (!completion.finish()) return;
      if (outcome.ok) {
        complete(outcome.target);
        return;
      }
      setPending(false);
      setPasskeyPending(false);
      setMessage(outcome.message ?? '');
      return;
    }
    const result = await signInWithPasskey({ isCurrent: completion.isCurrent });
    if (!completion.finish()) return;
    finishPasskey(result);
    // Showing the prompt replaced the autofill ceremony, so offer autofill again if the person backed out.
    if (!result.ok && passkeySupport === 'autofill') startAutofill();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending && !passkeyPending) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    const invalidPassword = !password;
    setEmailError(invalidEmail ? (email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '');
    setPasswordError(invalidPassword ? m.auth_form_required() : '');
    if (invalidEmail || invalidPassword) {
      if (invalidEmail) emailInput.current?.focus();
      else document.getElementById(passwordId)?.focus();
      return;
    }
    const completion = attempt.begin('password');
    if (!completion) return;
    setPending(true);
    setPasskeyPending(false);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    if (selectManagementOperationStepUp(query).kind !== 'ordinary') {
      const outcome = await confirmStepUp(email, password, query, window.location.origin, completion.isCurrent);
      if (!completion.finish()) return;
      setPassword('');
      if (outcome.ok) {
        complete(outcome.target);
        return;
      }
      setPending(false);
      setMessage(outcome.message ?? '');
      return;
    }
    const result = await signIn(email, password);
    if (!completion.finish()) return;
    setPassword('');
    if (result.ok) {
      complete(signInTarget(query, window.location.origin));
      return;
    }
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
      <LoginDeparture unfinished={unfinished} leave={leave} focus={() => emailInput.current?.focus()} />
      <form className="auth-login-form" method="post" action="/signin" noValidate onSubmit={submit}>
        <Field data-invalid={Boolean(emailError)}>
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
          {m.auth_login_heading()}
        </Button>
        {passkeySupport === 'none' ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            aria-busy={passkeyPending}
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
        <a href="/recovery" onClick={navigate}>
          {m.auth_login_recovery()}
        </a>
        <a href={`/signup${query}`} onClick={navigate}>
          {m.auth_login_signup()}
        </a>
      </nav>
    </AuthPage>
  );
}
