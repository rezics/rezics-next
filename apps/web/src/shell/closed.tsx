import { useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { pageHead, type HeadContext } from './head.ts';
import { routeRetry } from './error-state';
import { RouteState } from './route-state';
import { browserObservation } from '../session/observation';
import { sessionQuery } from '../session/query';
import { isDependencyUnavailableError, isSessionUnavailableError } from '../session/unavailable';
import { DependencyUnavailablePage } from './dependency-recovery/page';
import { recoveryOwnerIsCurrent, type RecoveryOwner } from './dependency-recovery/retry-owner';

export function closedPageHead(context: HeadContext) {
  return pageHead({ robots: 'noindex' }, context);
}

export function ClosedPage() {
  return <RouteState kind="closed" />;
}

/** The error boundary keeps its original loader and never retains a failed loader's payload. */
export function ClosedErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter();
  const active = useRef(false);
  const mounted = useRef(true);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const policy = useMemo(() => routeRetry(error), [error]);
  const [releasedFor, setReleasedFor] = useState<unknown>();
  const waiting = policy.delay > 0 && releasedFor !== error;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!policy.allowed || policy.delay <= 0 || policy.deferred) return;
    setReleasedFor(undefined);
    // One bounded wake-up enables an explicit action; it never makes a request.
    const timer = setTimeout(() => setReleasedFor(error), policy.delay * 1000);
    return () => clearTimeout(timer);
  }, [error, policy]);

  const client = router.options.context.queryClient;
  const observation = browserObservation(client);
  async function retry() {
    if (active.current || !policy.allowed || waiting || policy.deferred) return;
    active.current = true;
    let owner: RecoveryOwner = { visit: router.state.location.state.key, reader: observation.getSnapshot() };
    const currentVisit = () => mounted.current && router.state.location.state.key === owner.visit;
    const current = () =>
      recoveryOwnerIsCurrent(
        owner,
        { visit: router.state.location.state.key, reader: observation.getSnapshot() },
        mounted.current,
      );
    const hadPageFocus = Boolean(
      document.querySelector<HTMLElement>('[data-route-state]')?.contains(document.activeElement),
    );
    setRetrying(true);
    setRetryFailed(false);
    try {
      if (isSessionUnavailableError(error)) {
        await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
        if (!currentVisit()) return;
        // This explicit retry adopts the newly read session incarnation before the private loader runs.
        owner = { visit: owner.visit, reader: observation.getSnapshot() };
      }
      // Invalidation reruns the original bounded loader; reset alone only rerenders its failed match.
      await router.invalidate({ sync: true });
      if (!current()) return;
      if (router.state.matches.some((match) => match.status === 'error' || match.status === 'notFound'))
        setRetryFailed(true);
      else {
        reset?.();
        if (hadPageFocus) document.getElementById('main-content')?.focus({ preventScroll: true });
      }
    } catch {
      if (current()) setRetryFailed(true);
    } finally {
      active.current = false;
      if (mounted.current) setRetrying(false);
    }
  }
  if (isPlatformClosedError(error)) return <ClosedPage />;
  const recovery = !policy.allowed
    ? m.route_retry_unavailable()
    : policy.deferred
      ? m.route_retry_later()
      : waiting
        ? m.route_retry_after({ seconds: policy.delay })
        : undefined;
  const retryProps = {
    onRetry: policy.allowed && !policy.deferred ? retry : undefined,
    retrying,
    retryDisabled: waiting,
    retryFailed,
    ...(recovery ? { recovery } : {}),
  };
  return isDependencyUnavailableError(error) ? (
    <DependencyUnavailablePage {...retryProps} />
  ) : (
    <RouteState kind="error" {...retryProps} />
  );
}
