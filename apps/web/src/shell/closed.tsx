import { useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { pageHead, type HeadContext } from './head.ts';
import { routeRetry } from './error-state';
import { RouteState } from './route-state';
import { normalizeSessionObservation, sessionQueryKey } from '../session/browser-state';

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

  function owner() {
    const client = router.options.context.queryClient;
    const session = normalizeSessionObservation(client.getQueryData(sessionQueryKey));
    return { state: session.state, subject: session.subject, token: session.csrfToken };
  }
  async function retry() {
    if (active.current || !policy.allowed || waiting || policy.deferred) return;
    active.current = true;
    const visit = router.state.location.state.key;
    const reader = owner();
    const current = () => {
      const next = owner();
      return (
        mounted.current &&
        router.state.location.state.key === visit &&
        reader.state === next.state &&
        reader.subject === next.subject &&
        reader.token === next.token
      );
    };
    setRetrying(true);
    setRetryFailed(false);
    try {
      // Invalidation reruns the original bounded loader; reset alone only rerenders its failed match.
      await router.invalidate({ sync: true });
      if (!current()) return;
      if (router.state.matches.some((match) => match.status === 'error' || match.status === 'notFound'))
        setRetryFailed(true);
      else reset?.();
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
  return (
    <RouteState
      kind="error"
      onRetry={policy.allowed && !policy.deferred ? retry : undefined}
      retrying={retrying}
      retryDisabled={waiting}
      retryFailed={retryFailed}
      recovery={recovery}
    />
  );
}
