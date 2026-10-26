import { Button } from '@rezics/ui/button';
import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedProblem } from '../kernel/platform-closed.ts';
import type { OfferPageData } from './offer';
import { PageHeading } from '../shell/page-heading';

type Phase = 'ready' | 'submitting' | 'retry' | 'unavailable' | 'closed';

export function OfferPage({ offer }: { offer: OfferPageData }) {
  const [phase, setPhase] = useState<Phase>(offer.state === 'delisted' ? 'unavailable' : 'ready');

  async function start() {
    if (phase === 'unavailable' || phase === 'submitting') return;
    const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (!csrf) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    setPhase('submitting');
    try {
      const response = await fetch('/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ offerId: offer.id, idempotencyKey: offer.idempotencyKey }),
      });
      if (response.status === 409) {
        setPhase('unavailable');
        return;
      }
      if (!response.ok) {
        if (
          response.status === 403 &&
          isPlatformClosedProblem(
            response.status,
            await response
              .clone()
              .json()
              .catch(() => undefined),
          )
        ) {
          setPhase('closed');
          return;
        }
        setPhase('retry');
        return;
      }
      const body = (await response.json()) as { checkoutUrl?: unknown };
      if (typeof body.checkoutUrl === 'string' && body.checkoutUrl) {
        window.location.assign(body.checkoutUrl);
        return;
      }
      setPhase('retry');
    } catch {
      setPhase('retry');
    }
  }

  return (
    <article className="max-w-xl min-w-0 space-y-8 text-foreground" data-idempotency-key={offer.idempotencyKey}>
      <header className="space-y-4">
        <PageHeading className="text-foreground">{offer.title}</PageHeading>
        <p className="space-y-1">
          <span className="block text-sm font-medium text-muted-foreground">{m.offer_price()}</span>
          <span className="block font-serif text-3xl text-foreground tabular-nums">{offer.price}</span>
        </p>
      </header>
      {phase === 'unavailable' && (
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-foreground" role="status">
          {m.offer_unavailable()}
        </p>
      )}
      {phase === 'retry' && (
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-foreground" role="status">
          {m.offer_retry_note()}
        </p>
      )}
      {phase === 'closed' && (
        <p className="rounded-xl border border-border bg-muted px-4 py-3 text-foreground" role="status">
          {m.offer_start_closed()}
        </p>
      )}
      <div>
        {phase === 'retry' ? (
          <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => void start()}>
            {m.offer_retry()}
          </Button>
        ) : phase === 'closed' ? null : (
          <Button size="lg" className="w-full sm:w-auto" disabled={phase !== 'ready'} onClick={() => void start()}>
            {m.offer_buy()}
          </Button>
        )}
      </div>
    </article>
  );
}
