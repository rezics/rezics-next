import { useRouter } from '@tanstack/react-router';
import { getLocale } from '../../../paraglide/runtime.js';
import { m } from '../../../paraglide/messages.js';
import { ZoneFeedback } from './feedback';

export function ZonesPending() {
  return <p role="status">{m.zones_owner_loading()}</p>;
}

export function ZonesRouteError() {
  const router = useRouter();
  return (
    <ZoneFeedback locale={getLocale()} failure={{ kind: 'unavailable' }} onRetry={() => void router.invalidate()} />
  );
}
