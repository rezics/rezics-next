import { useRef, useState } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { ZoneFeedback } from './feedback';
import { useOwnerLifetime } from '../editor/owner-lifetime';

export function ZonesPending() {
  return <p role="status">{m.zones_owner_loading()}</p>;
}

export function ZonesRouteError() {
  const router = useRouter();
  const location = useLocation();
  const { lifetime, snapshot } = useOwnerLifetime(`${getLocale()}:${location.href}`);
  const capture = snapshot.capture;
  const [retryPending, setRetryPending] = useState(false);
  const retrying = useRef(false);
  // Invalidating the active location reloads its authorized loader without changing the requested URL.
  async function retry() {
    if (retrying.current || !lifetime.isCurrent(capture)) return;
    retrying.current = true;
    setRetryPending(true);
    try {
      await router.invalidate();
    } catch {
      // The route feedback remains visible when a retry cannot complete.
    } finally {
      retrying.current = false;
      setRetryPending(false);
    }
  }
  return (
    <ZoneFeedback
      locale={getLocale()}
      failure={{ kind: 'unavailable' }}
      returnTo={location.href}
      retryPending={retryPending}
      onRetry={() => void retry()}
    />
  );
}
