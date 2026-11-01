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
  return (
    <ZoneFeedback
      locale={getLocale()}
      failure={{ kind: 'unavailable' }}
      onRetry={() => {
        if (lifetime.isCurrent(capture)) void router.invalidate();
      }}
    />
  );
}
