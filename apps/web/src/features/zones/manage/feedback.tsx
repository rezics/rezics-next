import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { Failure } from './model';

export function ZoneFeedback({
  failure,
  locale,
  onRetry,
  returnTo = `/${locale}/my/zones`,
}: {
  failure: Failure;
  locale: string;
  onRetry?: (() => void) | undefined;
  returnTo?: string;
}) {
  const options = { locale: locale as never };
  const text = {
    'signed-out': m.zones_owner_signed_out,
    denied: m.zones_owner_denied,
    closed: m.zones_owner_closed,
    actor: m.zones_owner_actor,
    missing: m.zones_owner_missing,
    invalid: m.zones_owner_invalid,
    conflict: m.zones_owner_conflict,
    stale: m.zones_owner_stale,
    unavailable: m.zones_owner_unavailable,
  }[failure.kind];
  return (
    <div role="alert" className="space-y-3">
      <p>{text({}, options)}</p>
      {failure.kind === 'signed-out' ? (
        <a className="underline" href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}>
          {m.zones_owner_sign_in({}, options)}
        </a>
      ) : onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          {m.zones_owner_retry({}, options)}
        </Button>
      ) : failure.kind === 'unavailable' ? (
        <a className="underline" href={returnTo}>
          {m.zones_owner_retry({}, options)}
        </a>
      ) : null}
    </div>
  );
}
