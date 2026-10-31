import { useOperation } from '../kernel/exposure';
import { useSession } from '../session/query';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';
import type { OfferPageData } from './offer';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';
import { BenefitDetails } from './benefit-details';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { isMoneyUnit } from './money-schema';
import { createOfferRequest, type AcquisitionProblem } from './offer-recovery';

type Phase = 'ready' | 'submitting' | 'retry' | 'terms-changed' | 'unavailable' | 'closed' | 'existing';

export function OfferPage({ offer: observedOffer }: { offer: OfferPageData }) {
  const submittedOffer = useRef<OfferPageData | null>(null);
  const submission = useRef<ReturnType<typeof createOfferRequest> | null>(null);
  const offer = submittedOffer.current ?? observedOffer;
  const { state: session, csrfToken: csrf } = useSession();
  const csrfToken = useRef(csrf);
  csrfToken.current = csrf;
  const admitted = useOperation('order.create');
  const [phase, setPhase] = useState<Phase>(offer.state === 'delisted' ? 'unavailable' : 'ready');
  const [existing, setExisting] = useState<AcquisitionProblem | null>(null);
  const [fullTitlesOpen, setFullTitlesOpen] = useState(false);
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
    submission.current ??= createOfferRequest(
      { offerId: offer.id, expectedOfferRevision: offer.revision, idempotencyKey: offer.idempotencyKey },
      (intent) =>
        fetch('/checkout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken.current ?? '' },
          body: JSON.stringify(intent),
        }),
    );
    setPhase('submitting');
    const result = await submission.current();
    if (!result) return;
    if (result.kind === 'checkout') {
      window.location.assign(result.url);
      return;
    }
    if (result.kind === 'existing') setExisting(result.problem);
    setPhase(result.kind);
  }

  const note =
    phase === 'existing' && existing
      ? existing.code === 'benefit_already_owned'
        ? m.offer_already_owned()
        : m.offer_acquisition_pending()
      : phase === 'terms-changed'
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
    <article className="max-w-3xl min-w-0 space-y-6 text-foreground" data-idempotency-key={offer.idempotencyKey}>
      <header className="flex min-w-0 items-start gap-4 sm:gap-6">
        <SubjectCover data={offer.subject} size="sm" priority />
        <div className="min-w-0 space-y-2">
          <PageHeading className="line-clamp-2 break-words text-2xl! text-foreground sm:text-4xl!">
            {offer.subject.subject.title}
          </PageHeading>
          <p className="line-clamp-2 break-words text-sm leading-relaxed text-foreground">
            <span className="font-medium">{m.offer_receives()}: </span>
            {offer.title}
          </p>
        </div>
      </header>
      <section className="space-y-3" aria-label={m.offer_price()} data-slot="offer-decision">
        <p className="space-y-1">
          <span className="block text-sm font-medium text-muted-foreground">{m.offer_price()}</span>
          <span className="block font-serif text-3xl text-foreground tabular-nums">{offer.price}</span>
          <span className="block text-sm text-muted-foreground">
            {offer.currency.toUpperCase()} ·{' '}
            {offer.taxBehavior === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
          </span>
        </p>
        {offer.benefit?.kind === 'mapped' && (
          <div className="space-y-1 text-sm leading-relaxed">
            <p>{m.benefit_acquisition()}</p>
            <p>{m.benefit_fixed_version()}</p>
          </div>
        )}
        <p className="text-sm text-muted-foreground">{m.offer_terms_revision({ revision: String(offer.revision) })}</p>
        {note && (
          <Alert role="status">
            <AlertDescription className="text-foreground">{note}</AlertDescription>
          </Alert>
        )}
        {phase === 'existing' && existing ? (
          <Button
            variant="outline"
            size="lg"
            className="min-h-11 w-full sm:w-auto"
            nativeButton={false}
            render={
              <a
                href={localizeHref(
                  existing.code === 'benefit_already_owned' && existing.entitlementId
                    ? `/entitlements/${encodeURIComponent(existing.entitlementId)}`
                    : `/orders/${encodeURIComponent(existing.orderId!)}`,
                )}
              />
            }
          >
            {existing.code === 'benefit_already_owned' && existing.entitlementId
              ? m.offer_open_entitlement()
              : m.offer_open_order()}
          </Button>
        ) : phase === 'terms-changed' ? (
          <Button
            variant="outline"
            size="lg"
            className="min-h-11 w-full sm:w-auto"
            onClick={() => window.location.reload()}
          >
            {m.offer_review_terms()}
          </Button>
        ) : phase === 'retry' ? (
          <Button
            variant="outline"
            size="lg"
            className="min-h-11 w-full disabled:opacity-100 sm:w-auto"
            disabled={!admitted || !termsKnown || session === 'unknown'}
            onClick={() => void start()}
          >
            {m.offer_retry()}
          </Button>
        ) : phase === 'closed' ? null : (
          <Button
            variant={buyDisabled ? 'outline' : 'default'}
            size="lg"
            className="min-h-11 w-full disabled:opacity-100 sm:w-auto"
            disabled={buyDisabled}
            onClick={() => void start()}
          >
            {m.offer_buy()}
          </Button>
        )}
      </section>
      <details className="min-w-0 space-y-3 text-sm" onToggle={(event) => setFullTitlesOpen(event.currentTarget.open)}>
        <summary className="w-fit cursor-pointer rounded-sm py-3 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
          {m.offer_full_titles()}
        </summary>
        {fullTitlesOpen && (
          <div className="space-y-3">
            <p className="break-words">{offer.subject.subject.title}</p>
            <p className="break-words">
              <span className="font-medium">{m.offer_receives()}: </span>
              {offer.title}
            </p>
          </div>
        )}
      </details>
      {offer.benefit ? (
        <BenefitDetails benefit={offer.benefit} creatorName={offer.creatorName} locale={getLocale()} review />
      ) : null}
    </article>
  );
}
