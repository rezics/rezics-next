import { useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedProblem } from '../kernel/platform-closed.ts';
import type { OfferPageData } from './offer';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';
import { BenefitDetails } from './benefit-details';
import { getLocale } from '../paraglide/runtime.js';
import { isMoneyUnit } from './money-schema';

type Phase = 'ready' | 'submitting' | 'retry' | 'terms-changed' | 'unavailable' | 'closed';

export function OfferPage({ offer: observedOffer }: { offer: OfferPageData }) {
  const submittedOffer = useRef<OfferPageData | null>(null);
  const offer = submittedOffer.current ?? observedOffer;
  const { state: session, csrfToken: csrf } = useSession();
  const admitted = useOperation('order.create');
  const [phase, setPhase] = useState<Phase>(offer.state === 'delisted' ? 'unavailable' : 'ready');
  const termsKnown =
    isMoneyUnit(offer.moneyUnit) && offer.taxBehavior === 'exclusive' && offer.benefit?.kind === 'mapped';

  async function start() {
    if (!termsKnown || (phase !== 'ready' && phase !== 'retry')) return;
    if (!csrf) {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    // A loader refresh cannot replace consent while the original creation outcome is uncertain.
    submittedOffer.current ??= offer;
    setPhase('submitting');
    try {
      const response = await fetch('/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          offerId: offer.id,
          expectedOfferRevision: offer.revision,
          idempotencyKey: offer.idempotencyKey,
        }),
      });
      if (response.status === 409) {
        const failure: unknown = await response.json();
        if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'offer_revision_conflict')
          setPhase('terms-changed');
        else if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'offer_unavailable')
          setPhase('unavailable');
        else setPhase('retry');
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
    phase === 'terms-changed'
      ? m.offer_terms_changed()
      : phase === 'unavailable'
        ? m.offer_unavailable()
        : phase === 'retry'
          ? m.offer_retry_note()
          : phase === 'closed'
            ? m.offer_start_closed()
            : null;
  const buyDisabled = !admitted || !termsKnown || phase !== 'ready' || session === 'unknown';

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
            <span className="block text-sm text-muted-foreground">
              {offer.currency.toUpperCase()} ·{' '}
              {offer.taxBehavior === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">
            {m.offer_terms_revision({ revision: String(offer.revision) })}
          </p>
          {note && (
            <Alert role="status">
              <AlertDescription className="text-foreground">{note}</AlertDescription>
            </Alert>
          )}
        </div>
      </header>
      {offer.benefit ? (
        <BenefitDetails benefit={offer.benefit} creatorName={offer.creatorName} locale={getLocale()} review />
      ) : null}
      <div className="pt-2">
        {phase === 'terms-changed' ? (
          <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => window.location.reload()}>
            {m.offer_review_terms()}
          </Button>
        ) : phase === 'retry' ? (
          <Button
            variant="outline"
            size="lg"
            className="w-full disabled:opacity-100 sm:w-auto"
            disabled={!admitted || !termsKnown || session === 'unknown'}
            onClick={() => void start()}
          >
            {m.offer_retry()}
          </Button>
        ) : phase === 'closed' ? null : (
          <Button
            variant={buyDisabled ? 'outline' : 'default'}
            size="lg"
            className="w-full disabled:opacity-100 sm:w-auto"
            disabled={buyDisabled}
            onClick={() => void start()}
          >
            {m.offer_buy()}
          </Button>
        )}
      </div>
    </article>
  );
}
