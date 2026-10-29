import { useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedProblem } from '../kernel/platform-closed.ts';
import type { OfferPageData } from './offer';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';

type Phase = 'ready' | 'submitting' | 'retry' | 'unavailable' | 'closed';

export function OfferPage({ offer }: { offer: OfferPageData }) {
  const { state: session, csrfToken: csrf } = useSession();
  const admitted = useOperation('order.create');
  const [phase, setPhase] = useState<Phase>(offer.state === 'delisted' ? 'unavailable' : 'ready');

  async function start() {
    if (phase === 'unavailable' || phase === 'submitting') return;
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

  const note =
    phase === 'unavailable'
      ? m.offer_unavailable()
      : phase === 'retry'
        ? m.offer_retry_note()
        : phase === 'closed'
          ? m.offer_start_closed()
          : null;

  return (
    <article className="max-w-3xl min-w-0 space-y-8 text-foreground" data-idempotency-key={offer.idempotencyKey}>
      <header className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
        <SubjectCover data={offer.subject} size="md" priority />
        <div className="min-w-0 space-y-4">
          <PageHeading className="break-words text-foreground">{offer.subject.subject.title}</PageHeading>
          <p className="break-words text-base leading-relaxed text-foreground">
            <span className="font-medium">{m.offer_receives()}: </span>
            {offer.title}
          </p>
          <p className="space-y-1">
            <span className="block text-sm font-medium text-muted-foreground">{m.offer_price()}</span>
            <span className="block font-serif text-3xl text-foreground tabular-nums">{offer.price}</span>
          </p>
          {note && (
            <Alert role="status">
              <AlertDescription className="text-foreground">{note}</AlertDescription>
            </Alert>
          )}
        </div>
      </header>
      <div className="pt-2">
        {phase === 'retry' ? (
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            disabled={!admitted || session === 'unknown'}
            onClick={() => void start()}
          >
            {m.offer_retry()}
          </Button>
        ) : phase === 'closed' ? null : (
          <Button
            size="lg"
            className="w-full sm:w-auto"
            disabled={!admitted || phase !== 'ready' || session === 'unknown'}
            onClick={() => void start()}
          >
            {m.offer_buy()}
          </Button>
        )}
      </div>
    </article>
  );
}
