import { useRouter } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { AuthButton } from './button';
import { AuthPage } from './frame';
import { m } from './paraglide/messages.js';
import type { RouteRetryState } from './route-failure';

type RecoveryKind = 'failure' | 'missing';
type RecoveryState = RouteRetryState | 'interrupted';
type RecoveryAttempt = { kind: RecoveryKind; state: RecoveryState | 'checking' };
type ResetOwner = { reset: (() => void) | undefined };
type RecoveryContextValue = {
  attempt: RecoveryAttempt | null;
  retry(kind: RecoveryKind): void;
  registerReset(owner: ResetOwner): () => void;
  reportRenderFailure(): void;
};
const RecoveryContext = createContext<RecoveryContextValue | null>(null);

export function RouteRecoveryProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState<RecoveryAttempt | null>(null);
  const attemptRef = useRef<RecoveryAttempt | null>(null);
  const resetOwner = useRef<ResetOwner | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const suspended = useRef(false);

  const publish = useCallback((next: RecoveryAttempt | null) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);

  useEffect(() => {
    const retire = () => {
      generation.current += 1;
      inFlight.current = false;
    };
    const unsubscribe = router.history.subscribe(() => {
      retire();
      publish(null);
    });
    const hide = () => {
      // Retire before committing the nonsecret view that the browser may cache.
      suspended.current = true;
      retire();
      const current = attemptRef.current;
      if (current?.state === 'pending' || current?.state === 'checking')
        flushSync(() => publish({ kind: current.kind, state: 'interrupted' }));
    };
    const show = () => {
      // Restoration releases only the local gate. It never starts route work.
      suspended.current = false;
    };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      retire();
      attemptRef.current = null;
      resetOwner.current = null;
      unsubscribe();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [publish, router]);

  const registerReset = useCallback((owner: ResetOwner) => {
    resetOwner.current = owner;
    return () => {
      if (resetOwner.current === owner) resetOwner.current = null;
    };
  }, []);

  const reportRenderFailure = useCallback(() => {
    if (attemptRef.current?.state === 'checking') publish({ kind: attemptRef.current.kind, state: 'failed' });
  }, [publish]);

  // Child error boundaries report first in the same layout commit. A successful
  // current page then takes ownership without a timer or a recovery overlay.
  useLayoutEffect(() => {
    if (attemptRef.current?.state === 'checking') publish(null);
  }, [attempt, publish]);

  const retry = useCallback(
    (kind: RecoveryKind) => {
      if (suspended.current || inFlight.current || attemptRef.current?.state === 'checking') return;
      inFlight.current = true;
      const token = ++generation.current;
      const currentLocationKey = router.state.location.state.__TSR_key;
      const owner = resetOwner.current;
      const matchIds = new Set(router.state.matches.map((match) => match.id));
      const current = () =>
        !suspended.current &&
        generation.current === token &&
        router.state.location.state.__TSR_key === currentLocationKey;
      publish({ kind, state: 'pending' });

      void (async () => {
        try {
          await router.invalidate({ filter: (match) => matchIds.has(match.id) });
          if (!current()) return;
          const failed = kind === 'missing' || router.state.matches.some((match) => match.status !== 'success');
          if (failed) {
            publish({ kind, state: 'failed' });
            return;
          }
          publish({ kind, state: 'checking' });
          if (owner && resetOwner.current === owner) owner.reset?.();
        } catch {
          if (current()) publish({ kind, state: 'failed' });
        } finally {
          if (current()) inFlight.current = false;
        }
      })();
    },
    [publish, router],
  );

  const presenting = attempt && attempt.state !== 'checking' ? { kind: attempt.kind, state: attempt.state } : null;
  return (
    <RecoveryContext.Provider value={{ attempt, retry, registerReset, reportRenderFailure }}>
      <div hidden={!!presenting}>{children}</div>
      {presenting ? (
        <RouteFailureView kind={presenting.kind} state={presenting.state} onRetry={() => retry(presenting.kind)} />
      ) : null}
    </RecoveryContext.Provider>
  );
}

export function RouteFailureError({ reset }: { reset?: () => void }) {
  const recovery = useRecoveryContext();
  const owner = useRef<ResetOwner>({ reset });
  useLayoutEffect(() => {
    owner.current.reset = reset;
  });
  useLayoutEffect(() => recovery.registerReset(owner.current), [recovery.registerReset]);
  useLayoutEffect(() => {
    if (recovery.attempt?.state === 'checking') recovery.reportRenderFailure();
  }, [recovery.attempt?.state, recovery.reportRenderFailure]);
  if (recovery.attempt) return null;
  return <RouteFailureView kind="failure" state="ready" onRetry={() => recovery.retry('failure')} />;
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
  kind: RecoveryKind;
  state: RecoveryState;
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
    state === 'interrupted'
      ? m.auth_route_failure_interrupted()
      : kind === 'missing'
        ? m.auth_route_missing_body()
        : state === 'failed'
          ? m.auth_route_failure_failed_body()
          : m.auth_route_failure_body();

  useEffect(() => {
    const focus = () => {
      if (pending) pendingStatus.current?.focus();
      else heading.current?.focus();
    };
    // pagehide commits the cached view without moving focus; restoration owns it.
    if (state !== 'interrupted') focus();
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) focus();
    };
    window.addEventListener('pageshow', show);
    return () => window.removeEventListener('pageshow', show);
  }, [kind, pending, state]);

  return (
    <AuthPage heading={title} headingRef={heading} headingTabIndex={-1}>
      <section className="auth-route-failure" aria-busy={pending}>
        <p>{body}</p>
        <p>{m.auth_route_failure_read_only()}</p>
        {pending ? (
          <p ref={pendingStatus} tabIndex={-1} role="status">
            {m.auth_route_failure_retrying()}
          </p>
        ) : null}
        {state === 'failed' ? <p>{m.auth_route_failure_retry_failed()}</p> : null}
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
