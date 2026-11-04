import { createFileRoute, useBlocker, useLocation, useRouter } from '@tanstack/react-router';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { AuthButton as Button } from '../button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FieldError } from '@rezics/ui/shadcn/field';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { passkeysSupported } from '../passkeys';
import { confirmStepUp, confirmStepUpWithPasskey } from '../step-up';
import { useStepUpAdvice, useStepUpReturnReview, type StepUpHistory } from '../step-up-return';
import { StepUpReturnView, StepUpHistoryNotice } from '../step-up-return-view';
import { ErrorAlert } from '../alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';

const emailId = 'step-up-email';
const emailErrorId = 'step-up-email-error';
const passwordId = 'step-up-password';
const passwordErrorId = 'step-up-password-error';

function clearStepUpFields() {
  for (const field of document.querySelectorAll<HTMLInputElement>('#step-up-email, #step-up-password'))
    field.value = '';
}

export const Route = createFileRoute('/step-up')({
  head: () => ({ meta: [{ title: `${m.auth_step_up_heading()} · REZICS` }] }),
  component: StepUpPage,
});

// Browser continuations belong to one mounted request, independently of a dispatched server sign-in.
class ConfirmationJourney {
  active = false;
  completed = false;
  private pending: { kind: 'password' | 'passkey' } | null = null;

  private request: { href: string; query: string; origin: string } | null = null;

  activate() {
    // Capture the browser spelling, preserving repeated/empty signed parameters through router normalization.
    this.request = { href: window.location.href, query: window.location.search, origin: window.location.origin };
    this.completed = false;
    this.active = true;
  }

  isCurrent() {
    return this.active && this.request?.href === window.location.href;
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
      query: this.request!.query,
      origin: this.request!.origin,
      isCurrent,
      finish: (success: boolean) => {
        if (!isCurrent()) return false;
        // Keep a successful confirmation closed until navigation or an explicit new journey.
        if (success) this.completed = true;
        else this.pending = null;
        return true;
      },
    };
  }
}

function StepUpPage() {
  const href = useLocation({ select: (location) => location.href });
  const [generation, setGeneration] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [history, setHistory] = useState<StepUpHistory | null>(null);
  const historyRef = useRef<StepUpHistory | null>(null);
  const unresolvedRef = useRef(false);
  const [freshHref, setFreshHref] = useState<string | null>(href);
  const clearForm = useRef<() => void>(() => {});
  const remember = useCallback((next: StepUpHistory, unresolvedBefore = unresolvedRef.current) => {
    if (next === 'unknown') unresolvedRef.current = true;
    else if (next === 'refused' || next === 'acknowledged') unresolvedRef.current = unresolvedBefore;
    const value = unresolvedRef.current ? 'unknown' : next;
    historyRef.current = value;
    setHistory(value);
  }, []);
  const registerClear = useCallback((clear: () => void) => {
    clearForm.current = clear;
  }, []);
  const journey = useMemo(() => new ConfirmationJourney(), [href, generation]);
  useLayoutEffect(() => {
    journey.activate();
    const hide = () => {
      journey.retire();
      clearForm.current();
      clearStepUpFields();
      setFreshHref(null);
      setSuspended(true);
    };
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      journey.retire();
      setGeneration((value) => value + 1);
      setFreshHref(null);
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
    <StepUpForm
      key={`${href}:${generation}`}
      journey={journey}
      href={href}
      history={history}
      fresh={freshHref === href}
      remember={remember}
      startFresh={() => setFreshHref(href)}
      registerClear={registerClear}
    />
  );
}

function StepUpForm({
  journey,
  href,
  history,
  fresh,
  remember,
  startFresh,
  registerClear,
}: {
  journey: ConfirmationJourney;
  href: string;
  history: StepUpHistory | null;
  fresh: boolean;
  remember: (phase: StepUpHistory, unresolvedBefore?: boolean) => void;
  startFresh: () => void;
  registerClear: (clear: () => void) => void;
}) {
  const advice = useStepUpAdvice();
  const page = advice.state.kind === 'ready' ? advice.state.page : null;
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
  const emailValue = useRef('');
  const passwordValue = useRef('');
  const confirming = useRef(false);
  const returnStatus = useRef<HTMLParagraphElement>(null);
  const router = useRouter({ warn: false });
  const isCurrent = useCallback(() => journey.isCurrent(), [journey]);
  const query = useMemo(() => window.location.search, [href]);
  const origin = useMemo(() => window.location.origin, [href]);
  const returning = history !== null && !fresh;
  const returnReview = useStepUpReturnReview(query, origin, returning, advice.state, isCurrent);
  const [continuing, setContinuing] = useState(false);
  const continuingRef = useRef(false);
  const [reviewRequiresFreshRead, setReviewRequiresFreshRead] = useState(false);
  const shouldWarn = useCallback(
    () =>
      journey.isCurrent() &&
      !journey.completed &&
      (history === 'unknown' || Boolean(emailValue.current.trim() || passwordValue.current || confirming.current)),
    [history, journey],
  );
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => shouldWarn() && next.pathname !== '/step-up',
    enableBeforeUnload: false,
    withResolver: true,
  });
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  const clearSecrets = useCallback(() => {
    emailValue.current = '';
    passwordValue.current = '';
    setEmail('');
    setPassword('');
    confirming.current = false;
    clearStepUpFields();
  }, []);
  useLayoutEffect(() => {
    registerClear(clearSecrets);
    return () => registerClear(() => {});
  }, [clearSecrets, registerClear]);

  useLayoutEffect(() => {
    if (advice.state.kind !== 'ready') {
      clearSecrets();
      setEmailError('');
      setPasswordError('');
    }
  }, [advice.state, clearSecrets]);

  useLayoutEffect(() => {
    if (blocker.status === 'blocked' && !shouldWarn()) {
      if (journey.completed) blocker.reset();
      else blocker.proceed();
    }
  });

  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const follow = (event: MouseEvent) => {
      if (
        !shouldWarn() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(link instanceof HTMLElement) ||
        link.hasAttribute('download') ||
        (link.getAttribute('target') && link.getAttribute('target') !== '_self')
      )
        return;
      const href = link.getAttribute('href');
      if (!href) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin || href.startsWith('#')) return;
      event.preventDefault();
      void router.navigate({ href: `${url.pathname}${url.search}${url.hash}` });
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', follow);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', follow);
    };
  }, [router, shouldWarn]);

  const stay = () => {
    if (blocker.status === 'blocked') blocker.reset();
  };
  const leave = () => {
    clearSecrets();
    journey.retire();
    if (blocker.status === 'blocked') blocker.proceed();
  };
  const focusForm = () => {
    if (returning) {
      returnStatus.current?.focus();
      return;
    }
    if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else emailInput.current?.focus();
  };

  useLayoutEffect(() => {
    if (returning) {
      if (['unavailable', 'changed', 'account-changed'].includes(returnReview.state.kind)) alert.current?.focus();
      else returnStatus.current?.focus();
    } else if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [advice.state, emailError, message, passwordError, returnReview.state, returning]);

  useEffect(() => setPasskeys(passkeysSupported()), []);

  const observerForAttempt = () => {
    const unresolvedBefore = history === 'unknown';
    return {
      onDispatch: () => remember('unknown', unresolvedBefore),
      onAcknowledged: () => remember('acknowledged', unresolvedBefore),
      onRefused: () => remember('refused', unresolvedBefore),
    };
  };

  async function continueFromReview() {
    if (continuingRef.current || returnReview.state.kind !== 'continue' || !journey.isCurrent()) return;
    continuingRef.current = true;
    setReviewRequiresFreshRead(true);
    setContinuing(true);
    const result = await returnReview.recheck();
    if (!journey.isCurrent()) return;
    continuingRef.current = false;
    setContinuing(false);
    if (result?.kind !== 'continue') return;
    if (blockerRef.current.status === 'blocked') blockerRef.current.reset();
    journey.completed = true;
    journey.retire();
    window.location.assign(result.target);
  }

  async function submitPasskey() {
    if (!page?.actions.authenticate || !page.methods.passkey || !passkeys) return;
    const completion = journey.begin('passkey');
    if (!completion) return;
    const observer = observerForAttempt();
    remember('unsent', history === 'unknown');
    setPending(true);
    setPasskeyPending(true);
    confirming.current = true;
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const outcome = await confirmStepUpWithPasskey(completion.query, completion.origin, completion.isCurrent, observer);
    if (!completion.finish(outcome.ok)) return;
    if (outcome.ok) {
      if (blockerRef.current.status === 'blocked') blockerRef.current.reset();
      window.location.assign(outcome.target);
      return;
    }
    confirming.current = false;
    advice.retry();
    setPending(false);
    setPasskeyPending(false);
    if (outcome.message) setMessage(outcome.message);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!page?.actions.authenticate || !page.methods.password) return;
    if (pending && !passkeyPending) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    const invalidPassword = !password;
    setEmailError(invalidEmail ? (email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '');
    setPasswordError(invalidPassword ? m.auth_form_required() : '');
    if (invalidEmail || invalidPassword) return;
    const completion = journey.begin('password');
    if (!completion) return;
    const observer = observerForAttempt();
    remember('unsent', history === 'unknown');
    setPending(true);
    setPasskeyPending(false);
    confirming.current = true;
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const outcome = await confirmStepUp(
      email,
      password,
      completion.query,
      completion.origin,
      completion.isCurrent,
      observer,
    );
    if (!completion.finish(outcome.ok)) return;
    passwordValue.current = '';
    setPassword('');
    if (outcome.ok) {
      if (blockerRef.current.status === 'blocked') blockerRef.current.reset();
      window.location.assign(outcome.target);
      return;
    }
    confirming.current = false;
    advice.retry();
    setPending(false);
    setMessage(outcome.message ?? '');
  }

  return (
    <AuthPage heading={m.auth_step_up_heading()}>
      <>
        {returning ? (
          <StepUpReturnView
            history={history!}
            review={returnReview.state}
            canAuthenticate={Boolean(
              !reviewRequiresFreshRead &&
              !continuing &&
              returnReview.state.kind !== 'checking' &&
              returnReview.state.kind !== 'unavailable' &&
              page?.actions.authenticate &&
              (page.methods.password || (passkeys && page.methods.passkey)),
            )}
            continuing={continuing}
            statusRef={returnStatus}
            alertRef={alert}
            onRetry={() => {
              setReviewRequiresFreshRead(false);
              advice.retry();
            }}
            onContinue={() => void continueFromReview()}
            onAuthenticate={startFresh}
          />
        ) : (
          <>
            {history ? <StepUpHistoryNotice history={history} /> : null}
            {advice.state.kind === 'loading' ? <p role="status">{m.auth_inventory_loading()}</p> : null}
            {advice.state.kind === 'unavailable' ? (
              <>
                <ErrorAlert>{m.auth_failure_unavailable()}</ErrorAlert>
                <Button type="button" onClick={advice.retry}>
                  {m.auth_login_retry()}
                </Button>
              </>
            ) : null}
            {page?.viewer.kind === 'signed-in' ? (
              <p>{m.auth_login_current_account({ account: page.viewer.email ?? page.viewer.account_id })}</p>
            ) : null}
            <form className="auth-login-form" method="post" action="/signin" noValidate onSubmit={submit}>
              <p>{m.auth_step_up_explanation()}</p>
              {page?.continuation === 'authenticate-before-review' ? <p>{m.auth_step_up_review_required()}</p> : null}
              <Field data-invalid={Boolean(emailError)}>
                <FieldLabel htmlFor={emailId}>{m.auth_login_email()}</FieldLabel>
                <Input
                  ref={emailInput}
                  id={emailId}
                  name="email"
                  type="email"
                  maxLength={page?.requirements.email_max_length}
                  autoComplete="username"
                  value={email}
                  onChange={(event) => {
                    emailValue.current = event.target.value;
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
                    passwordValue.current = event.target.value;
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
              <Button
                type="submit"
                disabled={(pending && !passkeyPending) || !page?.actions.authenticate || !page.methods.password}
                aria-busy={pending && !passkeyPending}
              >
                {m.auth_step_up_heading()}
              </Button>
              {passkeys && page?.methods.passkey && page.actions.authenticate ? (
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
          </>
        )}
        <AlertDialog
          open={blocker.status === 'blocked'}
          onOpenChange={(open) => {
            if (!open) stay();
          }}
        >
          <AlertDialogContent
            finalFocus={() => {
              focusForm();
              return false;
            }}
          >
            <AlertDialogTitle>{m.auth_step_up_departure_heading()}</AlertDialogTitle>
            <AlertDialogDescription>{m.auth_step_up_departure_description()}</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel data-stay onClick={stay}>
                {m.auth_organization_departure_stay()}
              </AlertDialogCancel>
              <AlertDialogAction data-leave onClick={leave}>
                {m.auth_organization_departure_leave()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    </AuthPage>
  );
}
