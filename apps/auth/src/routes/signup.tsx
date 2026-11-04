import { createFileRoute, useBlocker, useRouter } from '@tanstack/react-router';
import { AuthButton as Button } from '../button';
import { Field } from '@rezics/ui/shadcn/field';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@rezics/ui/shadcn/alert-dialog';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AuthPage } from '../frame';
import { explainSignIn, normalizeSignupHandle, submitSignup } from '../signup';
import { signIn, signInTarget } from '../sign-in';
import { readRegistrationPage, type RegistrationPage } from '../registration-page';
import { TurnstileWidget, type TurnstileHandle, type TurnstileStatus } from '../turnstile.tsx';
import { ErrorAlert } from '../alert';
import {
  SignupAttemptController,
  signupAttemptHasPrivateInput,
  type SignupAttemptPhase,
  type SignupDraft,
} from '../signup-attempt';
import { SignupCredentials, signupCredentialFieldIds, type SignupCredentialErrors } from '../signup-credentials';

const { handle: handleId, password: passwordId, confirmation: confirmationId } = signupCredentialFieldIds;
const turnstileErrorId = 'signup-turnstile-error';
const uncertainPanelId = 'signup-uncertain-panel';

type SignupJourney = {
  active: boolean;
  sequence: number;
  query: string;
  attempt: SignupAttemptController;
};

type ActiveSignupPhase = Extract<
  SignupAttemptPhase,
  { kind: 'draft' | 'dispatched' | 'uncertain' | 'handle-unavailable' }
>;

const emptyErrors = (): SignupCredentialErrors => ({ handle: '', email: '', password: '', confirmation: '' });

function clearSignupInputs() {
  document.querySelectorAll<HTMLInputElement>('#signup-form input').forEach((input) => {
    input.value = '';
  });
}

// Keep the router adapter with the journey: Stay retains its original attempt and focus.
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

export const Route = createFileRoute('/signup')({
  head: () => ({ meta: [{ title: `${m.auth_signup_heading()} · REZICS` }] }),
  loader: () => readRegistrationPage(),
  component: SignupPage,
});

function SignupPage() {
  const router = useRouter();
  const { history } = router;
  const page = Route.useLoaderData();
  const pageKey =
    page.kind === 'already-signed-in'
      ? `account:${page.viewer.account_id}`
      : page.kind === 'registration'
        ? 'registration'
        : null;
  const sequence = useRef(0);
  const currentJourney = useRef<SignupJourney | null>(null);
  const replaceJourney = useRef<() => void>(() => {});
  const lastAuthority = useRef<string | null>(null);
  const [journey, setJourney] = useState<SignupJourney | null>(null);

  useLayoutEffect(() => {
    const leave = () => {
      const current = currentJourney.current;
      if (current) {
        current.active = false;
        current.attempt.retire();
      }
      currentJourney.current = null;
      clearSignupInputs();
      setJourney(null);
    };
    const replace = () => {
      leave();
      if (history.location.pathname !== '/signup') return;
      const nextSequence = ++sequence.current;
      const next: SignupJourney = {
        active: true,
        sequence: nextSequence,
        query: history.location.search,
        attempt: new SignupAttemptController(nextSequence),
      };
      currentJourney.current = next;
      setJourney(next);
    };
    replaceJourney.current = replace;
    const unsubscribe = history.subscribe(replace);
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        replace();
        void router.invalidate();
      }
    };
    const refresh = () => void router.invalidate();
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);
    window.addEventListener('focus', refresh);
    replace();
    return () => {
      leave();
      replaceJourney.current = () => {};
      unsubscribe();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('focus', refresh);
    };
  }, [history, router]);

  useLayoutEffect(() => {
    if (pageKey === null) return;
    const previous = lastAuthority.current;
    if (previous !== null && previous !== pageKey) replaceJourney.current();
    lastAuthority.current = pageKey;
  }, [pageKey]);

  return journey ? <SignupPageState key={journey.sequence} journey={journey} page={page} router={router} /> : null;
}

function SignupPageState({
  journey,
  page,
  router,
}: {
  journey: SignupJourney;
  page: RegistrationPage;
  router: ReturnType<typeof useRouter>;
}) {
  const controller = journey.attempt;
  const [phase, setPhase] = useState(controller.phase);
  const returnFocus = useRef<HTMLElement | null>(null);
  const { history } = router;

  useLayoutEffect(() => controller.subscribe(setPhase), [controller]);

  useLayoutEffect(() => {
    if (phase.kind === 'refused') document.getElementById('signup-refusal')?.focus();
  }, [phase.kind]);

  const shouldWarn = useCallback(() => {
    const warn = journey.active && signupAttemptHasPrivateInput(controller.phase);
    if (warn && !document.activeElement?.closest('[role="alertdialog"]'))
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return warn;
  }, [controller, journey]);

  const leave = useCallback(() => {
    journey.active = false;
    controller.retire();
    clearSignupInputs();
  }, [controller, journey]);

  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!shouldWarn()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [shouldWarn]);

  const departure = (
    <SignupDeparture
      shouldWarn={shouldWarn}
      leave={leave}
      focus={() => {
        const previous = returnFocus.current;
        if (previous?.isConnected && previous !== document.body) previous.focus();
        else (document.getElementById(handleId) ?? document.getElementById(uncertainPanelId))?.focus();
      }}
    />
  );

  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.push(event.currentTarget.getAttribute('href')!);
  }

  if (page.kind === 'already-signed-in') {
    return (
      <AuthPage heading={m.auth_signup_heading()}>
        {departure}
        <div className="auth-login-form">
          <p role="status">{m.auth_signup_already_signed_in()}</p>
          <nav className="auth-login-links" aria-label={m.auth_signup_continue()}>
            <a href={signInTarget(journey.query)}>{m.auth_signup_continue()}</a>
            <a href={`/login${journey.query}`} onClick={follow}>
              {m.auth_signup_sign_in()}
            </a>
          </nav>
        </div>
      </AuthPage>
    );
  }

  if (isCompletionPhase(phase)) {
    return (
      <AuthPage heading={m.auth_signup_heading()}>
        {departure}
        <SignupCompletion phase={phase} query={journey.query} follow={follow} />
      </AuthPage>
    );
  }

  if (phase.kind === 'refused') {
    return (
      <AuthPage heading={m.auth_signup_heading()}>
        {departure}
        <SignupRefusal message={phase.message} query={journey.query} follow={follow} />
      </AuthPage>
    );
  }

  if (page.kind === 'unavailable') {
    return (
      <AuthPage heading={m.auth_signup_heading()}>
        {departure}
        <div className="auth-login-form">
          {phase.kind === 'uncertain' ? (
            <SignupUncertainty phase={phase} query={journey.query} follow={follow} unavailable />
          ) : phase.kind === 'dispatched' ? (
            <ErrorAlert>
              <p role="status">{m.auth_signup_creating()}</p>
              <p>{m.auth_signup_page_unavailable()}</p>
              <SignupAuthLinks query={journey.query} follow={follow} />
            </ErrorAlert>
          ) : (
            <ErrorAlert>
              <p>
                {page.reason === 'verification' ? m.auth_signup_turnstile_failed() : m.auth_signup_page_unavailable()}
              </p>
            </ErrorAlert>
          )}
          <Button type="button" onClick={() => void router.invalidate()}>
            {m.auth_signup_retry()}
          </Button>
          {phase.kind !== 'uncertain' && phase.kind !== 'dispatched' ? (
            <SignupAuthLinks query={journey.query} follow={follow} />
          ) : null}
        </div>
      </AuthPage>
    );
  }

  if (phase.kind === 'retired') return null;
  return (
    <AuthPage heading={m.auth_signup_heading()}>
      {departure}
      <SignupForm journey={journey} registration={page} phase={phase as ActiveSignupPhase} />
    </AuthPage>
  );
}

function isCompletionPhase(
  phase: SignupAttemptPhase,
): phase is Extract<SignupAttemptPhase, { kind: 'created' | 'signing-in' | 'sign-in-failed' | 'signed-in' }> {
  return (
    phase.kind === 'created' ||
    phase.kind === 'signing-in' ||
    phase.kind === 'sign-in-failed' ||
    phase.kind === 'signed-in'
  );
}

function SignupAuthLinks({ query, follow }: { query: string; follow: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <nav className="auth-signup-links" aria-label={m.auth_signup_sign_in()}>
      <a href={`/login${query}`} onClick={follow}>
        {m.auth_signup_sign_in()}
      </a>
      <a href={`/recovery${query}`} onClick={follow}>
        {m.auth_signup_recovery()}
      </a>
    </nav>
  );
}

function SignupCompletion({
  phase,
  query,
  follow,
}: {
  phase: Extract<SignupAttemptPhase, { kind: 'created' | 'signing-in' | 'sign-in-failed' | 'signed-in' }>;
  query: string;
  follow: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="auth-login-form" aria-busy={phase.kind === 'signing-in'}>
      <p role="status">{phase.kind === 'signing-in' ? m.auth_signup_signing_in() : m.auth_signup_created()}</p>
      {phase.kind === 'sign-in-failed' ? (
        <ErrorAlert tabIndex={-1}>
          <p>{phase.message}</p>
        </ErrorAlert>
      ) : null}
      <SignupAuthLinks query={query} follow={follow} />
    </div>
  );
}

function SignupRefusal({
  message,
  query,
  follow,
}: {
  message: string;
  query: string;
  follow: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="auth-login-form">
      <div tabIndex={-1} id="signup-refusal">
        <ErrorAlert>
          <p>{message}</p>
          <SignupAuthLinks query={query} follow={follow} />
        </ErrorAlert>
      </div>
    </div>
  );
}

function SignupUncertainty({
  phase,
  query,
  follow,
  unavailable = false,
  onRetry,
  retryDisabled = false,
}: {
  phase: Extract<SignupAttemptPhase, { kind: 'uncertain' }>;
  query: string;
  follow: (event: MouseEvent<HTMLAnchorElement>) => void;
  unavailable?: boolean;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  return (
    <div id={uncertainPanelId}>
      <ErrorAlert tabIndex={-1}>
        <h2>{m.auth_signup_uncertain_title()}</h2>
        <p>{m.auth_signup_uncertain_body()}</p>
        <dl>
          <div>
            <dt>{m.auth_signup_handle()}</dt>
            <dd>{phase.attempt.handle}</dd>
          </div>
          <div>
            <dt>{m.auth_signup_email()}</dt>
            <dd>{phase.attempt.email}</dd>
          </div>
        </dl>
        {phase.verificationFailed ? (
          <p>{m.auth_signup_retry_verification_failed()}</p>
        ) : phase.failure.kind === 'conflict' || phase.failure.kind === 'handle-unavailable' ? (
          <p>{m.auth_signup_retry_refused()}</p>
        ) : (
          <p>{phase.failure.message}</p>
        )}
        {unavailable ? <p>{m.auth_signup_page_unavailable()}</p> : null}
        {onRetry ? (
          <Button type="button" disabled={retryDisabled} onClick={onRetry}>
            {m.auth_signup_retry_original()}
          </Button>
        ) : null}
        <SignupAuthLinks query={query} follow={follow} />
      </ErrorAlert>
    </div>
  );
}

function SignupForm({
  journey,
  registration,
  phase,
}: {
  journey: SignupJourney;
  registration: Extract<RegistrationPage, { kind: 'registration' }>;
  phase: ActiveSignupPhase;
}) {
  const router = useRouter();
  const { history } = router;
  const { siteKey, scriptUrl, requirements } = registration;
  const { query, attempt: controller } = journey;
  const turnstile = useRef<TurnstileHandle>(null);
  // Keep this journey's challenge/token generation when shell presentation changes.
  const challengeLanguage = useRef(getLocale()).current;
  const alert = useRef<HTMLDivElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [challengeStatus, setChallengeStatus] = useState<TurnstileStatus>('loading');
  const [errors, setErrors] = useState<SignupCredentialErrors>(emptyErrors);
  const [turnstileError, setTurnstileError] = useState('');
  const [retryClock, setRetryClock] = useState(Date.now());

  const values: SignupDraft | null =
    phase.kind === 'draft'
      ? phase.values
      : phase.kind === 'handle-unavailable'
        ? phase.values
        : phase.kind === 'dispatched'
          ? phase.values
          : null;
  const readOnly = phase.kind === 'dispatched';
  const handleCorrectionReady =
    phase.kind === 'handle-unavailable' &&
    normalizeSignupHandle(phase.values.handle) !== null &&
    normalizeSignupHandle(phase.values.handle) !== phase.attempt.handle;
  const retryAt = phase.kind === 'uncertain' ? phase.retryAt : null;
  const retryWait = retryAt !== null && retryClock < retryAt;

  useEffect(() => {
    if (retryAt === null || retryAt <= Date.now()) return;
    const delay = retryAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setRetryClock(Date.now()), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [retryAt, retryClock]);

  useLayoutEffect(() => {
    if (errors.handle) document.getElementById(handleId)?.focus();
    else if (errors.email) emailInput.current?.focus();
    else if (errors.password) document.getElementById(passwordId)?.focus();
    else if (errors.confirmation) document.getElementById(confirmationId)?.focus();
    else if (turnstileError) document.getElementById('signup-turnstile')?.focus();
    else if (phase.kind === 'uncertain') alert.current?.focus();
  }, [errors, phase, turnstileError]);

  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.push(event.currentTarget.getAttribute('href')!);
  }

  function clearErrors() {
    setErrors(emptyErrors());
    setTurnstileError('');
  }

  function change(field: keyof SignupDraft, value: string) {
    controller.updateDraft(field, value);
    setErrors((current) => ({ ...current, [field]: '' }));
  }

  async function sendAttempt(retrying: boolean, event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!journey.active || submitting.current) return;
    const current = controller.phase;
    if (retrying && current.kind !== 'uncertain') return;
    if (!retrying && current.kind !== 'draft') return;

    if (!retrying) {
      if (current.kind !== 'draft') return;
      clearErrors();
      const draft = current.values;
      const invalidHandle =
        normalizeSignupHandle(draft.handle) === null ||
        draft.handle.length < requirements.handle.minLength ||
        draft.handle.length > requirements.handle.maxLength;
      const invalidEmail =
        !draft.email.trim() ||
        draft.email.length > requirements.email.maxLength ||
        Boolean(emailInput.current?.validity.typeMismatch);
      const invalidPassword =
        draft.password.length < requirements.password.minLength ||
        draft.password.length > requirements.password.maxLength;
      const invalidConfirmation = Boolean(draft.password && draft.confirmation !== draft.password);
      setErrors({
        handle: invalidHandle ? (draft.handle ? m.auth_signup_handle_invalid() : m.auth_form_required()) : '',
        email: invalidEmail ? (draft.email.trim() ? m.auth_form_email_invalid() : m.auth_form_required()) : '',
        password: invalidPassword
          ? draft.password
            ? m.auth_signup_password_invalid({
                minimum: String(requirements.password.minLength),
                maximum: String(requirements.password.maxLength),
              })
            : m.auth_form_required()
          : '',
        confirmation: invalidConfirmation ? m.auth_signup_password_mismatch() : '',
      });
      if (invalidHandle || invalidEmail || invalidPassword || invalidConfirmation) return;
    }

    const token = turnstile.current?.getToken();
    if (!token) {
      setTurnstileError(m.auth_signup_turnstile_required());
      return;
    }
    const dispatch = controller.dispatch(token);
    if (!dispatch) return;
    submitting.current = true;
    setTurnstileError('');
    const result = await submitSignup(dispatch.body, requirements.password);
    if (!journey.active) return;
    const resolution = controller.resolve(dispatch.attempt, result);

    if (resolution.kind === 'created') {
      controller.beginSignIn();
      const signInResult = await signIn(resolution.credentials.email, resolution.credentials.password);
      if (!journey.active) return;
      submitting.current = false;
      if (signInResult.ok) {
        controller.finishSignIn(true);
        window.location.assign(signInTarget(query, window.location.origin));
        return;
      }
      controller.finishSignIn(false, explainSignIn(signInResult));
      return;
    }

    submitting.current = false;
    if (resolution.kind === 'ignored') return;
    turnstile.current?.reset();
    if (resolution.kind === 'request-rejected') {
      setTurnstileError(m.auth_signup_verification_failed());
    } else if (resolution.kind === 'handle-unavailable') {
      setErrors((currentErrors) => ({ ...currentErrors, handle: resolution.failure.message }));
    }
  }

  function useCorrectedHandle() {
    clearErrors();
    if (!controller.useDifferentHandle()) return;
    turnstile.current?.reset();
    document.getElementById(handleId)?.focus();
  }

  const draftForm = phase.kind === 'draft' || phase.kind === 'handle-unavailable' || phase.kind === 'dispatched';
  return (
    <>
      <form
        id="signup-form"
        className="auth-login-form"
        method="post"
        action="/signup"
        noValidate
        onSubmit={(event) => void sendAttempt(false, event)}
      >
        {draftForm && values ? (
          <SignupCredentials
            values={values}
            requirements={requirements}
            errors={errors}
            readOnly={readOnly}
            emailRef={emailInput}
            onChange={change}
          />
        ) : null}
        {phase.kind === 'handle-unavailable' ? (
          <ErrorAlert>
            <p>{phase.message}</p>
            <p>{m.auth_signup_handle_correction_body()}</p>
            <Button type="button" disabled={!handleCorrectionReady} onClick={useCorrectedHandle}>
              {m.auth_signup_handle_correction_action()}
            </Button>
          </ErrorAlert>
        ) : null}
        {phase.kind === 'uncertain' ? (
          <div ref={alert} tabIndex={-1}>
            <SignupUncertainty
              phase={phase}
              query={query}
              follow={follow}
              onRetry={() => void sendAttempt(true)}
              retryDisabled={retryWait}
            />
          </div>
        ) : null}
        <Field data-invalid={Boolean(turnstileError) || challengeStatus === 'failed'}>
          <div id="signup-turnstile" tabIndex={-1} aria-describedby={turnstileError ? turnstileErrorId : undefined}>
            <TurnstileWidget
              ref={turnstile}
              siteKey={siteKey}
              scriptUrl={scriptUrl}
              language={challengeLanguage}
              onStatus={setChallengeStatus}
              onToken={(value) => {
                if (value) setTurnstileError('');
              }}
            />
          </div>
          <p className="text-sm text-muted-foreground">{m.auth_signup_turnstile_required()}</p>
          {challengeStatus === 'loading' ? <p role="status">{m.auth_signup_turnstile_loading()}</p> : null}
          {challengeStatus === 'failed' ? (
            <div>
              <ErrorAlert>
                <p>{m.auth_signup_turnstile_failed()}</p>
              </ErrorAlert>
              <Button
                type="button"
                disabled={readOnly}
                onClick={() => {
                  setTurnstileError('');
                  turnstile.current?.retry();
                }}
              >
                {m.auth_signup_turnstile_retry()}
              </Button>
            </div>
          ) : null}
          {turnstileError ? (
            <p id={turnstileErrorId} role="alert">
              {turnstileError}
            </p>
          ) : null}
        </Field>
        {phase.kind === 'dispatched' ? (
          <p role="status" aria-busy="true">
            {m.auth_signup_creating()}
          </p>
        ) : phase.kind === 'draft' ? (
          <Button type="submit" aria-busy={false}>
            {m.auth_signup_heading()}
          </Button>
        ) : null}
      </form>
      {phase.kind === 'draft' || phase.kind === 'handle-unavailable' ? (
        <nav className="auth-login-links" aria-label={m.auth_signup_sign_in()}>
          <a href={`/login${query}`} onClick={follow}>
            {m.auth_signup_sign_in()}
          </a>
        </nav>
      ) : null}
    </>
  );
}
