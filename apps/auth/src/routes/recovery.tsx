import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { authPost, failureMessage, RECOVERY_COMPLETE_NOTICE_KEY } from '../api';
import { ErrorAlert } from '../alert';
import { RecoveryAttempt, useRecoveryAttempt } from '../recovery-attempt';
import { definitiveRecoveryRefusal, recoveryFailure, recoverySubmission, type RecoverySubmission } from '../recovery';
import { useRecoveryPage } from '../recovery-page';

const emailId = 'recovery-email';
const emailErrorId = 'recovery-email-error';
const passwordId = 'recovery-password';
const passwordErrorId = 'recovery-password-error';

export const Route = createFileRoute('/recovery')({
  head: () => ({ meta: [{ title: `${m.auth_recovery_heading()} · REZICS` }] }),
  component: RecoveryPage,
});

function RecoveryPage() {
  const journey = useRecoveryAttempt();
  return journey ? (
    <RecoveryForm key={journey.key} attempt={journey.attempt} />
  ) : (
    <AuthPage heading={m.auth_recovery_heading()} />
  );
}

function RecoveryForm({ attempt }: { attempt: RecoveryAttempt }) {
  const router = useRouter();
  const [hasFragment, setHasFragment] = useState<boolean | null>(null);
  const advice = useRecoveryPage(hasFragment === null ? null : hasFragment ? 'complete' : 'start');
  const page = advice.state.kind === 'ready' ? advice.state.page : null;
  const [credentials, setCredentials] = useState<{ accountId: string; token: string } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordFieldError, setPasswordFieldError] = useState('');
  const unsent = useRef(false);
  const unresolved = useRef(false);
  const submission = useRef<RecoverySubmission | null>(null);
  const [unknown, setUnknown] = useState(false);
  const retiring = useRef(false);
  const initialized = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const shouldWarn = useCallback(() => !retiring.current && (unsent.current || unresolved.current), []);
  const clearSecrets = useCallback(() => {
    retiring.current = true;
    attempt.retire();
    unsent.current = false;
    unresolved.current = false;
    submission.current = null;
    setUnknown(false);
    setCredentials(null);
    setEmail('');
    setPassword('');
    setEmailError('');
    setPasswordFieldError('');
    setMessage('');
    setNotice('');
    setPending(false);
  }, [attempt]);

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
      const href = link.getAttribute('href')!;
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

  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fragment = window.location.hash;
    if (fragment) {
      const parameters = new URLSearchParams(fragment.slice(1));
      const recovered = { accountId: parameters.get('account_id'), token: parameters.get('token') };
      attempt.removeFragment();
      if (recovered.accountId && recovered.token) {
        setCredentials({ accountId: recovered.accountId, token: recovered.token });
      } else {
        setMessage(failureMessage(401, 'invalid_recovery', null));
      }
      setHasFragment(true);
    } else {
      setHasFragment(false);
    }
  }, [attempt]);

  useLayoutEffect(() => {
    if (emailError) emailInput.current?.focus();
    else if (passwordFieldError) document.getElementById(passwordId)?.focus();
    else if (message) alert.current?.focus();
  }, [emailError, passwordFieldError, message]);

  async function submitStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attempt.available || !page?.actions.start || !page.methods.email) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    if (invalidEmail) {
      setNotice('');
      setEmailError(email.trim() ? m.auth_form_email_invalid() : m.auth_form_required());
      return;
    }
    setEmailError('');
    const finish = attempt.begin();
    if (!finish) return;
    unresolved.current = true;
    setPending(true);
    setNotice('');
    setMessage('');
    const result = await authPost('/recovery/start', { email: email.trim() });
    if (!finish()) return;
    unresolved.current = false;
    unsent.current = false;
    setPending(false);
    if (result.ok) {
      setNotice(m.auth_recovery_start_success());
      return;
    }
    setMessage(failureMessage(result.status, result.code, result.retryAfter));
  }

  async function submitComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!attempt.available || !page?.actions.complete || !page.methods.password) return;
    const passwordLength = password.length;
    if (!submission.current && (passwordLength < page.requirements.password_min_length || passwordLength > page.requirements.password_max_length)) {
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
    const finish = attempt.begin();
    if (!finish) return;
    const original = submission.current ?? recoverySubmission(credentials.accountId, credentials.token, password);
    submission.current = original;
    unresolved.current = true;
    setPending(true);
    setMessage('');
    const result = await authPost('/recovery/complete', original);
    if (!finish()) return;
    unsent.current = false;
    setPending(false);
    if (result.ok) {
      unresolved.current = false;
      submission.current = null;
      setUnknown(false);
      retiring.current = true;
      attempt.retire();
      setPassword('');
      setCredentials(null);
      try {
        window.sessionStorage.setItem(RECOVERY_COMPLETE_NOTICE_KEY, '1');
      } catch {
        // The optional notice must not prevent navigation after native completion.
      }
      window.location.assign('/login');
      return;
    }
    // A later refusal cannot resolve an earlier unknown effect. Keep the exact
    // submission until acknowledged success or local retirement, with no replay
    // except the person's explicit retry.
    if (unknown || !definitiveRecoveryRefusal(result)) {
      setUnknown(true);
      setMessage(m.auth_recovery_unknown());
    } else {
      unresolved.current = false;
      submission.current = null;
      setMessage(recoveryFailure(result));
    }
  }

  if (hasFragment === null) return <AuthPage heading={m.auth_recovery_heading()} />;

  const readAdvice = advice.state.kind === 'loading' ? <p role="status">{m.auth_inventory_loading()}</p>
    : advice.state.kind === 'unavailable' ? <>
      <ErrorAlert>{m.auth_failure_unavailable()}</ErrorAlert>
      <Button type="button" onClick={advice.retry}>{m.auth_login_retry()}</Button>
    </> : null;

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
        {readAdvice}
        <p>{m.auth_recovery_consequences()}</p>
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
              readOnly={pending || unknown}
              id={passwordId}
              value={password}
              onChange={(event) => {
                if (unknown) return;
                const value = event.target.value;
                unsent.current = value.length > 0;
                setPassword(value);
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
          {unknown || message === failureMessage(401, 'invalid_recovery', null) ? (
            <a href="/recovery">{m.auth_recovery_new_link()}</a>
          ) : null}
          <Button type="submit" disabled={pending || !page?.actions.complete || !page.methods.password} aria-busy={pending}>
            {unknown ? m.auth_recovery_retry_exact() : m.auth_recovery_complete_submit()}
          </Button>
        </form>
        <a href="/login">{m.auth_login_heading()}</a>
        <RecoveryDeparture
          shouldWarn={shouldWarn}
          leave={clearSecrets}
          focus={() => document.getElementById(passwordId)?.focus()}
        />
      </AuthPage>
    );
  }

  return (
    <AuthPage heading={m.auth_recovery_heading()}>
      {readAdvice}
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
              const value = event.target.value;
              unsent.current = Boolean(value.trim());
              setEmail(value);
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
        <Button type="submit" disabled={pending || !page?.actions.start || !page.methods.email} aria-busy={pending}>
          {m.auth_recovery_start_submit()}
        </Button>
      </form>
      <a href="/login">{m.auth_login_heading()}</a>
      <RecoveryDeparture shouldWarn={shouldWarn} leave={clearSecrets} focus={() => emailInput.current?.focus()} />
    </AuthPage>
  );
}

function RecoveryDeparture({
  shouldWarn,
  leave,
  focus,
}: {
  shouldWarn: () => boolean;
  leave: () => void;
  focus: () => void;
}) {
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => shouldWarn() && next.pathname !== '/recovery',
    enableBeforeUnload: false,
    withResolver: true,
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
        <AlertDialogTitle>{m.auth_recovery_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>{m.auth_recovery_departure_description()}</AlertDialogDescription>
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
