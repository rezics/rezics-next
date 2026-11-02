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
  const journey = useMemo(() => new ConfirmationJourney(), [href, generation]);
  useLayoutEffect(() => {
    journey.activate();
    const hide = () => {
      journey.retire();
      setSuspended(true);
    };
    const show = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      journey.retire();
      setGeneration((value) => value + 1);
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
    <StepUpForm key={`${href}:${generation}`} journey={journey} />
  );
}

function StepUpForm({ journey }: { journey: ConfirmationJourney }) {
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
  const router = useRouter({ warn: false });
  const shouldWarn = useCallback(
    () =>
      journey.isCurrent() &&
      !journey.completed &&
      Boolean(emailValue.current.trim() || passwordValue.current || confirming.current),
    [journey],
  );
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => shouldWarn() && next.pathname !== '/step-up',
    enableBeforeUnload: false,
    withResolver: true,
  });

  useLayoutEffect(() => {
    if (blocker.status === 'blocked' && !shouldWarn()) blocker.proceed();
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
    journey.retire();
    if (blocker.status === 'blocked') blocker.proceed();
  };
  const focusForm = () => {
    if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else emailInput.current?.focus();
  };

  useLayoutEffect(() => {
    if (emailError) emailInput.current?.focus();
    else if (passwordError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [emailError, passwordError, message]);

  useEffect(() => setPasskeys(passkeysSupported()), []);

  async function submitPasskey() {
    const completion = journey.begin('passkey');
    if (!completion) return;
    setPending(true);
    setPasskeyPending(true);
    confirming.current = true;
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const outcome = await confirmStepUpWithPasskey(completion.query, completion.origin, completion.isCurrent);
    if (!completion.finish(outcome.ok)) return;
    if (outcome.ok) {
      if (blocker.status === 'blocked') blocker.reset();
      window.location.assign(outcome.target);
      return;
    }
    confirming.current = false;
    setPending(false);
    setPasskeyPending(false);
    if (outcome.message) setMessage(outcome.message);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending && !passkeyPending) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    const invalidPassword = !password;
    setEmailError(invalidEmail ? (email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '');
    setPasswordError(invalidPassword ? m.auth_form_required() : '');
    if (invalidEmail || invalidPassword) return;
    const completion = journey.begin('password');
    if (!completion) return;
    setPending(true);
    setPasskeyPending(false);
    confirming.current = true;
    setMessage('');
    setEmailError('');
    setPasswordError('');
    const outcome = await confirmStepUp(email, password, completion.query, completion.origin, completion.isCurrent);
    if (!completion.finish(outcome.ok)) return;
    passwordValue.current = '';
    setPassword('');
    if (outcome.ok) {
      if (blocker.status === 'blocked') blocker.reset();
      window.location.assign(outcome.target);
      return;
    }
    confirming.current = false;
    setPending(false);
    setMessage(outcome.message ?? '');
  }

  return (
    <AuthPage heading={m.auth_step_up_heading()}>
      <>
        <form className="auth-login-form" method="post" action="/signin" noValidate onSubmit={submit}>
          <p>{m.auth_step_up_explanation()}</p>
          <Field data-invalid={Boolean(emailError)}>
            <FieldLabel htmlFor={emailId}>{m.auth_login_email()}</FieldLabel>
            <Input
              ref={emailInput}
              id={emailId}
              name="email"
              type="email"
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
          <Button type="submit" disabled={pending && !passkeyPending} aria-busy={pending && !passkeyPending}>
            {m.auth_step_up_heading()}
          </Button>
          {passkeys ? (
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
              <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
              <AlertDialogAction onClick={leave}>{m.auth_organization_departure_leave()}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    </AuthPage>
  );
}
