import { useEffect, useRef, type MouseEvent } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../../paraglide/messages.js';
import type { Failure } from './model';

const recoveryControlClassName =
  'h-auto min-h-8 min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere] py-1 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';

export type KeyboardActivation = { generation: number };

/** A deferred result may take focus only while the same keyboard activation still owns it. */
export function useSettlementFocus() {
  const generation = useRef(0);
  const expectedRestore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const invalidate = () => {
      expectedRestore.current = null;
      generation.current += 1;
    };
    const onFocus = (event: FocusEvent) => {
      if (expectedRestore.current && (event.target === expectedRestore.current || event.target === document.body)) {
        expectedRestore.current = null;
        return;
      }
      invalidate();
    };
    document.addEventListener('pointerdown', invalidate, true);
    document.addEventListener('keydown', invalidate, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('pointerdown', invalidate, true);
      document.removeEventListener('keydown', invalidate, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, []);

  function captureActivation(event?: { detail: number }, restoreTo?: HTMLElement | null) {
    expectedRestore.current = restoreTo ?? null;
    return event && event.detail !== 0 ? null : { generation: generation.current };
  }

  function focusResult(
    getTarget: () => HTMLElement | null,
    activation: KeyboardActivation | null,
    isCurrent: () => boolean,
  ) {
    if (!activation) return;
    requestAnimationFrame(() => {
      const target = getTarget();
      if (
        generation.current !== activation.generation ||
        !isCurrent() ||
        !target?.isConnected ||
        target.getClientRects().length === 0
      )
        return;
      target.focus();
    });
  }

  return { captureActivation, focusResult };
}

export function ZoneFeedback({
  failure,
  locale,
  onRetry,
  retryPending = false,
  returnTo = `/${locale}/my/zones`,
}: {
  failure: Failure;
  locale: string;
  onRetry?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
  retryPending?: boolean;
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
    <div role="alert" className="min-w-0 space-y-3 rounded-xl border bg-muted/30 p-3 text-foreground sm:p-4">
      <p className="whitespace-normal text-base leading-relaxed [overflow-wrap:anywhere]">{text({}, options)}</p>
      {failure.kind === 'signed-out' ? (
        <a
          className={cn(buttonVariants({ variant: 'outline' }), recoveryControlClassName)}
          href={`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`}
        >
          {m.zones_owner_sign_in({}, options)}
        </a>
      ) : onRetry ? (
        <Button
          className={recoveryControlClassName}
          type="button"
          variant="outline"
          disabled={retryPending}
          aria-busy={retryPending}
          onClick={onRetry}
        >
          {retryPending ? m.zones_owner_loading({}, options) : m.zones_owner_retry({}, options)}
        </Button>
      ) : failure.kind === 'unavailable' ? (
        <a className={cn(buttonVariants({ variant: 'outline' }), recoveryControlClassName)} href={returnTo}>
          {m.zones_owner_retry({}, options)}
        </a>
      ) : null}
    </div>
  );
}
