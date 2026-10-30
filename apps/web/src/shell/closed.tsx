import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed.ts';
import { pageHead, type HeadContext } from './head.ts';
import { ErrorPage, StatusPage } from './shell';
import { useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';

export function closedPageHead(context: HeadContext) {
  return pageHead({ robots: 'noindex' }, context);
}

export function ClosedPage() {
  return <StatusPage heading={m.platform_closed_heading()} message={m.platform_closed_message()} />;
}

export function ClosedErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const router = useRouter();
  const active = useRef(false);
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (active.current) return;
    active.current = true;
    setRetrying(true);
    try {
      // Invalidation reruns the original bounded loader; reset alone only rerenders its failed match.
      await router.invalidate({ sync: true });
      reset?.();
    } catch {
      // The same safe error state remains available for another explicit attempt.
    } finally {
      active.current = false;
      setRetrying(false);
    }
  }
  return isPlatformClosedError(error) ? <ClosedPage /> : <ErrorPage onRetry={retry} retrying={retrying} />;
}
