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
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { PasswordInput } from '../password-input';
import { m } from '../paraglide/messages.js';
import { AuthPage } from '../frame';
import { failureMessage, RECOVERY_COMPLETE_NOTICE_KEY } from '../api';
import { ErrorAlert } from '../alert';
import { RecoveryAttempt, useRecoveryAttempt } from '../recovery-attempt';
import {
  completeRecovery,
  definitiveRecoveryRefusal,
  recoveryFailure,
  recoverySubmission,
  startRecovery,
  type RecoverySubmission,
} from '../recovery';
import { useRecoveryPage } from '../recovery-page';
import { hasRecoveryHistory, unresolvedRecoveryHistory } from '../recovery-return';
import { RecoveryHistory, RecoveryReturnView } from '../recovery-return-view';

const emailId = 'recovery-email';
const emailErrorId = 'recovery-email-error';
const passwordId = 'recovery-password';
const passwordErrorId = 'recovery-password-error';
type RecoveryControlEvent = ReactMouseEvent<HTMLElement>;
type AdviceControl = 'retry' | 'fresh' | 'fresh-link';

// One mounted control owns one orientation. Observation never creates intent.
function useRecoveryFocus() {
  const intent = useRef<{ trigger: HTMLElement; destination: 'form' | 'return' } | null>(null);
  const cancel = useCallback(() => {
    intent.current = null;
  }, []);
  const claim = (event: RecoveryControlEvent, destination: 'form' | 'return') => {
    cancel();
    if (event.detail === 0 && document.activeElement === event.currentTarget)
      intent.current = { trigger: event.currentTarget, destination };
  };
  const settle = (target: (destination: 'form' | 'return') => HTMLElement | null) => {
    const owned = intent.current;
    cancel();
    if (!owned) return;
    // A completed transition may have just removed its trigger. A connected
    // trigger must still hold focus; detached controls never own another reader.
    if (
      document.activeElement !== owned.trigger &&
      (owned.trigger.isConnected || document.activeElement !== document.body)
    ) return;
    target(owned.destination)?.focus();
  };
  useLayoutEffect(() => {
    const moved = (event: FocusEvent) => {
      if (intent.current && event.target !== intent.current.trigger) cancel();
    };
    const blurred = (event: FocusEvent) => {
      if (event.target === intent.current?.trigger) cancel();
    };
    const acted = (event: MouseEvent | KeyboardEvent) => {
      if (!intent.current) return;
      const sameControl = event.target instanceof Node && intent.current.trigger.contains(event.target);
      if (
        !sameControl || event.type === 'click' ||
        ('key' in event && (event.key === 'Enter' || event.key === ' '))
      ) cancel();
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('focusout', blurred, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('mousedown', cancel, true);
    document.addEventListener('touchstart', cancel, true);
    document.addEventListener('click', acted, true);
    document.addEventListener('keydown', acted, true);
    document.addEventListener('visibilitychange', cancel);
    window.addEventListener('focus', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('pagehide', cancel);
    return () => {
      cancel();
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('focusout', blurred, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('mousedown', cancel, true);
      document.removeEventListener('touchstart', cancel, true);
      document.removeEventListener('click', acted, true);
      document.removeEventListener('keydown', acted, true);
      document.removeEventListener('visibilitychange', cancel);
      window.removeEventListener('focus', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pagehide', cancel);
    };
  }, [cancel]);
  return { claim, settle, cancel };
}

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
  const [fresh, setFresh] = useState(false);
  const historical = !hasFragment && hasRecoveryHistory(attempt.returned);
  const advice = useRecoveryPage(
    hasFragment === null
      ? null
      : hasFragment || (historical && !fresh && attempt.returned.complete)
        ? 'complete'
        : 'start',
  );
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
  const [confirmResend, setConfirmResend] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const readStatus = useRef<HTMLDivElement>(null);
  const focusIntent = useRecoveryFocus();
  const [adviceControl, setAdviceControl] = useState<AdviceControl | null>(null);
  const retiring = useRef(false);
  const initialized = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const shouldWarn = useCallback(
    () => !retiring.current && (unsent.current || unresolved.current || unresolvedRecoveryHistory(attempt.returned)),
    [attempt],
  );
  const retryAdvice = (event: RecoveryControlEvent) => {
    if (advice.state.kind === 'loading') return;
    focusIntent.claim(event, historical && !fresh ? 'return' : 'form');
    setAdviceControl('retry');
    advice.retry();
  };
  const startFresh = (event: RecoveryControlEvent) => {
    if (!page || !attempt.available) return;
    focusIntent.claim(event, 'form');
    setAdviceControl('fresh');
    setFresh(true);
  };
  const clearSecrets = useCallback(() => {
    retiring.current = true;
    focusIntent.cancel();
    for (const input of form.current?.querySelectorAll('input') ?? []) {
      input.value = '';
      input.defaultValue = '';
    }
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
  }, [attempt, focusIntent.cancel]);

  useLayoutEffect(
    () => () => {
      // Clear detached input nodes too, before a document can enter the browser cache.
      for (const input of form.current?.querySelectorAll('input') ?? []) {
        input.value = '';
        input.defaultValue = '';
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (advice.state.kind === 'loading' || !adviceControl) return;
    setAdviceControl(null);
    if (adviceControl === 'fresh-link') setMessage('');
    focusIntent.settle((destination) => {
      if (destination === 'return') return document.getElementById('recovery-return-heading');
      if (!page) return readStatus.current;
      if (hasFragment && !credentials) return alert.current;
      return emailInput.current ?? document.getElementById(passwordId);
    });
  }, [advice.state, adviceControl, fresh]);

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
    focusIntent.cancel();
    if (!attempt.available || !page?.actions.start || !page.methods.email) return;
    const invalidEmail = !email.trim() || Boolean(emailInput.current?.validity.typeMismatch);
    if (invalidEmail) {
      setNotice('');
      setEmailError(email.trim() ? m.auth_form_email_invalid() : m.auth_form_required());
      return;
    }
    setEmailError('');
    if (unknown && !confirmResend) return;
    const finish = attempt.begin();
    if (!finish) return;
    const settle = attempt.outcomes.dispatch('start');
    unresolved.current = true;
    setPending(true);
    setNotice('');
    setMessage('');
    const result = await startRecovery({ email: email.trim() });
    if (!finish()) return;
    settle(result);
    // An unavailable acknowledgement may still have sent mail. A later refusal
    // is about the new request, and cannot settle the earlier unknown send.
    const uncertain = unknown || (!result.ok && !definitiveRecoveryRefusal(result));
    unresolved.current = uncertain;
    setUnknown(uncertain);
    setConfirmResend(false);
    unsent.current = false;
    setPending(false);
    if (result.ok) {
      setNotice(m.auth_recovery_start_success());
      if (uncertain) setMessage(m.auth_recovery_start_unknown());
      return;
    }
    setMessage(uncertain ? m.auth_recovery_start_unknown() : recoveryFailure(result, 'start'));
  }

  async function submitComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    focusIntent.cancel();
    if (!attempt.available || !page?.actions.complete || !page.methods.password) return;
    const passwordLength = password.length;
    if (
      !submission.current &&
      (passwordLength < page.requirements.password_min_length || passwordLength > page.requirements.password_max_length)
    ) {
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
    const settle = attempt.outcomes.dispatch('complete', submission.current !== null);
    submission.current = original;
    unresolved.current = true;
    setPending(true);
    setMessage('');
    const result = await completeRecovery(original);
    if (!finish()) return;
    settle(result);
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

  const reading = advice.state.kind === 'loading';
  const readAdvice = (
    <>
      {reading ? <p role="status">{m.auth_recovery_advice_loading()}</p> : null}
      {advice.state.kind === 'unavailable' ? <ErrorAlert>{m.auth_failure_unavailable()}</ErrorAlert> : null}
      {advice.state.kind === 'unavailable' || (reading && adviceControl === 'retry') ? (
        <Button type="button" aria-disabled={reading} aria-busy={reading} onClick={retryAdvice}>
          {m.auth_login_retry()}
        </Button>
      ) : null}
    </>
  );

  if (historical && (!fresh || (reading && adviceControl === 'fresh'))) {
    return (
      <AuthPage heading={m.auth_recovery_heading()}>
        <RecoveryReturnView
          summary={attempt.returned}
          status={advice.state.kind}
          retry={retryAdvice}
          retrying={reading && adviceControl === 'retry'}
          freshPending={reading && adviceControl === 'fresh'}
          fresh={startFresh}
        />
        <RecoveryDeparture
          shouldWarn={shouldWarn}
          leave={clearSecrets}
          focus={() => document.getElementById('recovery-return-heading')?.focus()}
        />
      </AuthPage>
    );
  }

  if ((page && hasFragment && !credentials) || (reading && adviceControl === 'fresh-link')) {
    return (
      <AuthPage heading={m.auth_recovery_heading()}>
        <ErrorAlert tabIndex={-1} ref={alert}>
          {message}
        </ErrorAlert>
        {readAdvice}
        <a
          href="/recovery"
          aria-disabled={reading}
          aria-busy={reading}
          onClick={(event) => {
            event.preventDefault();
            if (reading) return;
            focusIntent.claim(event, 'form');
            setAdviceControl('fresh-link');
            setHasFragment(false);
            setFresh(true);
          }}
        >
          {m.auth_recovery_new_link()}
        </a>
      </AuthPage>
    );
  }

  if (!page) {
    return (
      <AuthPage heading={m.auth_recovery_heading()}>
        <div ref={readStatus} tabIndex={-1}>
          {readAdvice}
        </div>
        {hasRecoveryHistory(attempt.returned) ? <RecoveryHistory summary={attempt.returned} /> : null}
        <a href="/login">{m.auth_login_heading()}</a>
        <RecoveryDeparture shouldWarn={shouldWarn} leave={clearSecrets} focus={() => readStatus.current?.focus()} />
      </AuthPage>
    );
  }

  if (hasFragment) {
    return (
      <AuthPage heading={m.auth_recovery_heading()}>
        {readAdvice}
        <p>{m.auth_recovery_consequences()}</p>
        <form
          ref={form}
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
          <Button
            type="submit"
            disabled={pending || !page?.actions.complete || !page.methods.password}
            aria-busy={pending}
          >
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
      {historical ? <RecoveryHistory summary={attempt.returned} /> : null}
      <form
        ref={form}
        className="auth-login-form"
        method="post"
        action="/recovery/start"
        noValidate
        onSubmit={submitStart}
      >
        <Field data-invalid={Boolean(emailError)}>
          <FieldLabel htmlFor={emailId}>{m.auth_recovery_email()}</FieldLabel>
          <Input
            ref={emailInput}
            id={emailId}
            name="email"
            type="email"
            maxLength={page?.requirements.email_max_length}
            autoComplete="email"
            value={email}
            onChange={(event) => {
              const value = event.target.value;
              unsent.current = Boolean(value.trim());
              setEmail(value);
              setEmailError('');
              setConfirmResend(false);
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
        {unknown && !confirmResend ? (
          <Button
            type="button"
            disabled={pending || !page.actions.start || !page.methods.email}
            onClick={(event) => {
              if (!attempt.available) return;
              setConfirmResend(true);
              retryAdvice(event);
            }}
          >
            {m.auth_recovery_new_link()}
          </Button>
        ) : (
          <>
            {confirmResend ? <p>{m.auth_recovery_resend_confirmation()}</p> : null}
            <Button type="submit" disabled={pending || !page.actions.start || !page.methods.email} aria-busy={pending}>
              {confirmResend ? m.auth_recovery_resend_submit() : m.auth_recovery_start_submit()}
            </Button>
          </>
        )}
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
