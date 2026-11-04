import { useRouter } from '@tanstack/react-router';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AuthButton } from './button';
import { AuthPage } from './frame';
import { m } from './paraglide/messages.js';
import type { RouteRetryState } from './route-failure';

type RecoveryKind = 'failure' | 'missing';
type RecoveryPhase = RouteRetryState | 'checking';
type RecoveryAttempt = { kind: RecoveryKind; state: RecoveryPhase };
type RecoveryContextValue = {
  attempt: RecoveryAttempt | null;
  retry(kind: RecoveryKind, reset?: () => void): void;
  reportRenderFailure(): void;
};
const RecoveryContext = createContext<RecoveryContextValue | null>(null);

export function RouteRecoveryProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState<RecoveryAttempt | null>(null);
  const attemptRef = useRef<RecoveryAttempt | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);

  const publish = useCallback((next: RecoveryAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);

  useEffect(() => {
    const unsubscribe = router.history.subscribe(() => {
      generation.current += 1;
      inFlight.current = false;
      publish(null);
    });
    return () => {
      generation.current += 1;
      inFlight.current = false;
      attemptRef.current = null;
      unsubscribe();
    };
  }, [publish, router]);

  const reportRenderFailure = useCallback(() => {
    if (attemptRef.current?.state === 'checking') publish({ kind: attemptRef.current.kind, state: 'failed' });
  }, [publish]);

  const retry = useCallback(
    (kind: RecoveryKind, reset?: () => void) => {
      if (inFlight.current || attemptRef.current?.state === 'pending' || attemptRef.current?.state === 'checking')
        return;
      inFlight.current = true;
      const token = ++generation.current;
      const currentLocationKey = router.state.location.state.__TSR_key;
      const current = () =>
        generation.current === token && router.state.location.state.__TSR_key === currentLocationKey;
      publish({ kind, state: 'pending' });

      void (async () => {
        try {
          await router.invalidate();
          if (!current()) return;
          const failed =
            kind === 'missing' ||
            router.state.matches.some((match) => match.status === 'error' || match.status === 'notFound');
          if (failed) {
            publish({ kind, state: 'failed' });
            return;
          }
          publish({ kind, state: 'checking' });
          reset?.();
          setTimeout(() => {
            if (current() && attemptRef.current?.state === 'checking') publish(null);
          }, 0);
        } catch {
          if (current()) publish({ kind, state: 'failed' });
        } finally {
          if (current()) inFlight.current = false;
        }
      })();
    },
    [publish, router],
  );

  const value = { attempt, retry, reportRenderFailure };
  const overlayState = attempt?.state === 'checking' ? 'pending' : attempt?.state;
  return (
    <RecoveryContext.Provider value={value}>
      {children}
      {attempt && overlayState ? (
        <RouteFailureView kind={attempt.kind} state={overlayState} onRetry={() => retry(attempt.kind)} />
      ) : null}
    </RecoveryContext.Provider>
  );
}

export function RouteFailureError({ reset }: { reset?: () => void }) {
  const recovery = useRecoveryContext();
  useEffect(() => {
    if (recovery.attempt?.state === 'checking') recovery.reportRenderFailure();
  }, [recovery.attempt?.state, recovery.reportRenderFailure]);
  if (recovery.attempt) return null;
  return <RouteFailureView kind="failure" state="ready" onRetry={() => recovery.retry('failure', reset)} />;
}

export function RouteMissing() {
  const recovery = useRecoveryContext();
  if (recovery.attempt) return null;
  return <RouteFailureView kind="missing" state="ready" onRetry={() => recovery.retry('missing')} />;
}

export function RouteFailureView({
  kind,
  state,
  onRetry,
}: {
  kind: 'failure' | 'missing';
  state: RouteRetryState;
  onRetry(): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingStatus = useRef<HTMLParagraphElement>(null);
  const pending = state === 'pending';
  const title =
    kind === 'missing'
      ? m.auth_route_missing_title()
      : state === 'failed'
        ? m.auth_route_failure_failed_title()
        : m.auth_route_failure_title();
  const body =
    kind === 'missing'
      ? m.auth_route_missing_body()
      : state === 'failed'
        ? m.auth_route_failure_failed_body()
        : m.auth_route_failure_body();

  useEffect(() => {
    if (pending) pendingStatus.current?.focus();
    else heading.current?.focus();
  }, [kind, pending, state]);

  return (
    <AuthPage heading={title} headingRef={heading} headingTabIndex={-1}>
      <section className="auth-route-failure" aria-busy={pending}>
        <p role={pending ? 'status' : 'alert'}>{body}</p>
        {pending ? (
          <p ref={pendingStatus} tabIndex={-1} role="status">
            {m.auth_route_failure_retrying()}
          </p>
        ) : null}
        {state === 'failed' ? <p role="status">{m.auth_route_failure_retry_failed()}</p> : null}
        <AuthButton type="button" variant="outline" disabled={pending} aria-busy={pending} onClick={onRetry}>
          {pending ? m.auth_route_failure_retrying() : m.auth_route_failure_retry()}
        </AuthButton>
        <nav aria-label={m.auth_route_failure_safe_navigation()}>
          <a href="/login">{m.auth_route_failure_exit_login()}</a>
          <a href="/security">{m.auth_route_failure_exit_security()}</a>
        </nav>
      </section>
    </AuthPage>
  );
}

function useRecoveryContext(): RecoveryContextValue {
  const value = useContext(RecoveryContext);
  if (!value) throw new Error('Auth route recovery requires its root provider.');
  return value;
}
