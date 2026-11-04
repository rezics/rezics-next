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
import { LoginReturnView } from '../login-return-view';
import { type LoginPhase } from '../login-return';
import { loadSignInPageForJourney } from '../signin-page';
import {
  initialLoginChoice,
  loginCanContinue,
  loginReview,
  loginShowsCredentials,
  observedLoginChoice,
  type LoginAccountChoice,
} from '../login-account-choice';
import { LoginAccountChoiceView } from '../login-account-choice-view';
import { selectAccountOperationStepUp } from '../account-operation-step-up';
import { selectOrganizationDeleteStepUp } from '../organization-delete-step-up';

const emailId = 'login-email';
const emailErrorId = 'login-email-error';
const passwordId = 'login-password';
const passwordErrorId = 'login-password-error';

export const Route = createFileRoute('/login')({
  head: () => ({ meta: [{ title: `${m.auth_login_heading()} · REZICS` }] }),
  component: LoginPage,
});

function LoginPage() {
  const { journey, records, dismiss } = useLoginJourney();
  const current = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!journey) current.current?.focus();
  }, [journey]);
  return (
    <AuthPage heading={m.auth_login_heading()}>
      <LoginReturnView
        records={records}
        onDismiss={() => {
          dismiss();
          current.current?.focus();
        }}
      />
      <div ref={current} tabIndex={-1}>
        {journey ? (
          <LoginForm key={journey.key} query={journey.query} attempt={journey.attempt} restored={journey.restored} />
        ) : (
          <p role="status">{m.auth_inventory_loading()}</p>
        )}
      </div>
    </AuthPage>
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

function LoginForm({ query, attempt, restored }: { query: string; attempt: LoginAttempt; restored: boolean }) {
  const { history } = useRouter();
  const released = useRef(false);
  const unfinished = useRef(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [choice, setChoiceState] = useState<LoginAccountChoice>(initialLoginChoice);
  const currentChoice = useRef(choice);
  const [pageRetry, setPageRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [recoveryComplete, setRecoveryComplete] = useState(false);
  // Passkey controls appear only after the browser reports WebAuthn, so the server render has none.
  const [passkeySupport, setPasskeySupport] = useState<'checking' | 'none' | 'prompt' | 'autofill'>('checking');
  const [passkeyPending, setPasskeyPending] = useState(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const focusCredentials = useRef(false);
  const stepUp =
    selectManagementOperationStepUp(query).kind !== 'ordinary' ||
    selectAccountOperationStepUp(query).kind !== 'ordinary' ||
    selectOrganizationDeleteStepUp(query).kind !== 'ordinary';
  const pageData = choice.kind === 'ready' ? choice.page : null;
  const showCredentials = loginShowsCredentials(choice) || (choice.kind === 'ready' && stepUp);
  unfinished.current = !released.current && Boolean(email.trim() || password || pending);

  function setChoice(next: LoginAccountChoice) {
    currentChoice.current = next;
    setChoiceState(next);
  }

  function clearFeedback() {
    setMessage('');
    setEmailError('');
    setPasswordError('');
  }

  function uncertain() {
    setChoice({ kind: 'uncertain', review: { ...loginReview(currentChoice.current), uncertain: true } });
    setPassword('');
    setPending(false);
    setPasskeyPending(false);
    clearFeedback();
  }

  function leave() {
    released.current = true;
    unfinished.current = false;
    attempt.retire();
    setEmail('');
    setPassword('');
    setPending(false);
    setPasskeyPending(false);
    setChoice(initialLoginChoice());
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
    if (focusCredentials.current) {
      focusCredentials.current = false;
      emailInput.current?.focus();
    }
  }, [choice]);

  useEffect(() => {
    const controller = new AbortController();
    const review = loginReview(currentChoice.current);
    void loadSignInPageForJourney(query, window.location.origin, attempt, controller.signal).then((result) => {
      if (!result) return;
      setChoice(observedLoginChoice(result, review, restored || pageRetry > 0, restored && pageRetry === 0));
    });
    return () => {
      controller.abort();
    };
  }, [attempt, pageRetry, query, restored]);

  useLayoutEffect(() => {
    if (choice.kind !== 'ready') return;
    try {
      if (window.sessionStorage.getItem(RECOVERY_COMPLETE_NOTICE_KEY) === '1') {
        window.sessionStorage.removeItem(RECOVERY_COMPLETE_NOTICE_KEY);
        setRecoveryComplete(true);
      }
    } catch {
      // The notice is optional when browser storage is unavailable.
    }
  }, [choice.kind]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!passkeysSupported()) {
        setPasskeySupport('none');
        return;
      }
      setPasskeySupport('prompt');
      if ((await passkeyAutofillSupported()) && active) setPasskeySupport('autofill');
    })();
    return () => {
      active = false;
    };
  }, []);

  // The browser offers passkeys in the email field once its autocomplete token is on the page.
  useEffect(() => {
    if (
      !showCredentials ||
      choice.kind !== 'ready' ||
      choice.uncertain ||
      choice.observation !== 'initial' ||
      !choice.page.methods.passkey ||
      passkeySupport !== 'autofill' ||
      stepUp
    )
      return;
    startAutofill();
  }, [attempt, choice, passkeySupport, query, showCredentials, stepUp]);

  function startAutofill() {
    const selected = currentChoice.current;
    if (
      selected.kind !== 'ready' ||
      selected.uncertain ||
      selected.observation !== 'initial' ||
      !loginShowsCredentials(selected) ||
      !selected.page.methods.passkey ||
      stepUp
    )
      return;
    const completion = attempt.begin('autofill');
    if (!completion) return;
    void signInWithPasskey({
      autofill: true,
      isCurrent: completion.isCurrent,
      onPhase: (phase) => observePasskey(completion, phase),
    }).then((result) => {
      if (completion.finish()) finishPasskey(result, true);
    });
  }

  function observePasskey(
    completion: { isCurrent: () => boolean; observe: (phase: LoginPhase) => void },
    phase: LoginPhase,
  ) {
    if (!completion.isCurrent()) return;
    completion.observe(phase);
    if (phase === 'dispatched') {
      unfinished.current = true;
      setPending(true);
      setPasskeyPending(true);
    }
  }

  function switchAccount() {
    if (currentChoice.current !== choice || choice.kind !== 'ready' || !attempt.choose()) return;
    focusCredentials.current = true;
    setChoice({ ...choice, mode: 'credentials' });
    setEmail('');
    setPassword('');
    clearFeedback();
  }

  function reviewSession() {
    if (currentChoice.current !== choice || choice.kind === 'loading' || !attempt.choose()) return;
    setChoice({ kind: 'loading', review: loginReview(choice) });
    setEmail('');
    setPassword('');
    clearFeedback();
    setPageRetry((value) => value + 1);
  }

  function continueCurrentAccount() {
    if (currentChoice.current !== choice || !loginCanContinue(choice) || stepUp || choice.kind !== 'ready') return;
    if (!attempt.begin('continue')) return;
    complete(choice.page.continuation.href);
  }

  function credentialChoice() {
    const selected = currentChoice.current;
    return selected === choice && selected.kind === 'ready' && (loginShowsCredentials(selected) || stepUp)
      ? selected
      : null;
  }

  function finishPasskey(result: PasskeySignInResult, autofill = false) {
    if (result.ok) {
      complete(signInTarget(query, window.location.origin));
      return;
    }
    setPending(false);
    setPasskeyPending(false);
    if (result.reason === 'cancelled') {
      if (!autofill) setMessage(m.auth_login_prompt_cancelled());
      return;
    }
    if (result.reason === 'unavailable' && ['unknown', 'dispatched'].includes(attempt.snapshot()?.phase ?? '')) {
      uncertain();
      return;
    }
    setMessage(passkeySignInFailure(result));
  }

  async function submitPasskey() {
    const selected = credentialChoice();
    if (!selected || !selected.page.methods.passkey || !['prompt', 'autofill'].includes(passkeySupport)) return;
    const completion = attempt.begin('passkey');
    if (!completion) return;
    setChoice({ ...selected, mode: 'credentials' });
    setPending(true);
    setPasskeyPending(true);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    if (stepUp) {
      completion.observe('dispatched');
      const outcome = await confirmStepUpWithPasskey(query, window.location.origin, completion.isCurrent);
      completion.observe(
        outcome.ok ? 'acknowledged' : outcome.message === m.auth_failure_unavailable() ? 'unknown' : 'refused',
      );
      if (!completion.finish()) return;
      if (outcome.ok) {
        complete(outcome.target);
        return;
      }
      setPending(false);
      setPasskeyPending(false);
      if (outcome.message === m.auth_failure_unavailable()) {
        uncertain();
        return;
      }
      setMessage(outcome.message ?? '');
      return;
    }
    const result = await signInWithPasskey({
      isCurrent: completion.isCurrent,
      onPhase: (phase) => observePasskey(completion, phase),
    });
    if (!completion.finish()) return;
    finishPasskey(result);
    // A deliberate button prompt never restarts conditional mediation when it retires.
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = credentialChoice();
    if (!selected || !selected.page.methods.password) return;
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
    setChoice({ ...selected, mode: 'credentials' });
    setPending(true);
    setPasskeyPending(false);
    setMessage('');
    setEmailError('');
    setPasswordError('');
    if (stepUp) {
      const outcome = await confirmStepUp(email, password, query, window.location.origin, completion.isCurrent);
      completion.observe(
        outcome.ok ? 'acknowledged' : outcome.message === m.auth_failure_unavailable() ? 'unknown' : 'refused',
      );
      if (!completion.finish()) return;
      setPassword('');
      if (outcome.ok) {
        complete(outcome.target);
        return;
      }
      setPending(false);
      if (outcome.message === m.auth_failure_unavailable()) {
        uncertain();
        return;
      }
      setMessage(outcome.message ?? '');
      return;
    }
    const result = await signIn(email, password, completion.observe);
    if (!completion.finish()) return;
    setPassword('');
    if (result.ok) {
      complete(signInTarget(query, window.location.origin));
      return;
    }
    setPending(false);
    if (result.reason === 'unavailable') {
      uncertain();
      return;
    }
    setMessage(
      result.reason === 'credentials'
        ? failureMessage(401, 'authentication_denied', null)
        : result.reason === 'rate-limited'
          ? failureMessage(429, 'rate_limited', result.retryAfter)
          : failureMessage(503, 'unavailable', null),
    );
  }

  return (
    <>
      <LoginDeparture unfinished={unfinished} leave={leave} focus={() => emailInput.current?.focus()} />
      <LoginAccountChoiceView
        choice={choice}
        pending={pending}
        passkeyPending={passkeyPending}
        allowContinue={!stepUp}
        onContinue={continueCurrentAccount}
        onSwitch={switchAccount}
        onReview={reviewSession}
      />
      {pageData && !pageData.methods.passkey ? <p role="status">{m.auth_login_passkey_method_unavailable()}</p> : null}
      {pageData && pageData.methods.passkey && passkeySupport === 'none' ? (
        <p role="status">{m.auth_login_passkey_browser_unsupported()}</p>
      ) : null}
      {showCredentials && pageData ? (
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
              readOnly={pending}
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
          {message ? (
            <ErrorAlert tabIndex={-1} ref={alert}>
              {message}
            </ErrorAlert>
          ) : null}
          <Button type="submit" disabled={pending} aria-busy={pending && !passkeyPending}>
            {m.auth_login_heading()}
          </Button>
          {!pageData.methods.passkey || passkeySupport === 'none' || passkeySupport === 'checking' ? null : (
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
      ) : null}
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
    </>
  );
}
