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
    if (!attempt.available) return;
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
    if (!attempt.available) return;
    const passwordLength = Array.from(password).length;
    if (passwordLength < 8 || passwordLength > 128) {
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
    unresolved.current = true;
    setPending(true);
    setMessage('');
    const result = await authPost('/recovery/complete', {
      account_id: credentials.accountId,
      token: credentials.token,
      new_password: password,
    });
    if (!finish()) return;
    unresolved.current = false;
    unsent.current = false;
    setPending(false);
    if (result.ok) {
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
    setMessage(failureMessage(result.status, result.code, result.retryAfter));
  }

  if (hasFragment === null) return <AuthPage heading={m.auth_recovery_heading()} />;

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
              readOnly={pending}
              id={passwordId}
              value={password}
              onChange={(event) => {
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
          {message === failureMessage(401, 'invalid_recovery', null) ? (
            <a href="/recovery">{m.auth_recovery_new_link()}</a>
          ) : null}
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {m.auth_recovery_complete_submit()}
          </Button>
        </form>
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
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {m.auth_recovery_start_submit()}
        </Button>
      </form>
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
