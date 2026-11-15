import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useRef, useState } from 'react';
import { useBuyerCurrentOrigin, type BuyerCurrentOrigin } from './buyer-current-origin';
import { m } from '../paraglide/messages.js';
import type { OfferPageData } from './offer';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';
import { BenefitDetails } from './benefit-details';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { isMoneyUnit } from './money-schema';
import { createOfferRequest, type AcquisitionProblem } from './offer-recovery';
import { OfferPurchaseWorkspace } from './offer-purchase-workspace';

type Phase = 'ready' | 'submitting' | 'retry' | 'terms-changed' | 'unavailable' | 'closed' | 'existing';
type Authority = ReturnType<typeof useBuyerCurrentOrigin>;

export function OfferPage({ offer }: { offer: OfferPageData }) {
  const address = JSON.stringify([offer.id, getLocale()]);
  const authority = useBuyerCurrentOrigin(
    'order.create',
    address,
    address,
    (pathname) => pathname.match(/(?:^|\/)offers\/([^/]+)\/?$/)?.[1] === offer.id,
  );
  return (
    <OfferPurchase key={authority.intent.id} observedOffer={offer} authority={authority} origin={authority.origin} />
  );
}

function OfferPurchase({
  observedOffer,
  authority,
  origin,
}: {
  observedOffer: OfferPageData;
  authority: Authority;
  origin: BuyerCurrentOrigin;
}) {
  const submittedOffer = useRef<OfferPageData | null>(null);
  const pendingOrigin = useRef<BuyerCurrentOrigin | null>(null);
  const submission = useRef<ReturnType<typeof createOfferRequest> | null>(null);
  const offer = submittedOffer.current ?? observedOffer;
  const [submissionPhase, setPhase] = useState<Phase>('ready');
  const phase = submittedOffer.current
    ? submissionPhase === 'submitting' && !pendingOrigin.current?.isCurrent()
      ? 'retry'
      : submissionPhase
    : offer.state === 'delisted'
      ? 'unavailable'
      : 'ready';
  const [existing, setExisting] = useState<AcquisitionProblem | null>(null);
  const [fullTitlesOpen, setFullTitlesOpen] = useState(false);
  const termsKnown =
    isMoneyUnit(offer.moneyUnit) && offer.taxBehavior === 'exclusive' && offer.benefit?.kind === 'mapped';
  const canStart =
    authority.admitted &&
    (authority.state === 'signed-out' ||
      (authority.state === 'signed-in' &&
        Boolean(authority.subject) &&
        (submission.current !== null || Boolean(authority.csrfToken))));

  async function start() {
    if (
      (!origin.isCurrent() && !origin.isPublic()) ||
      !canStart ||
      !termsKnown ||
      (phase !== 'ready' && phase !== 'retry')
    )
      return;
    if (authority.state === 'signed-out') {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (!submission.current) {
      const credential = origin.credential();
      if (!credential || !authority.intent.isObserved()) return;
      // Capture consent, credentials and operands together; a refresh never replaces this intent.
      const owner = authority.intent;
      submittedOffer.current = offer;
      submission.current = createOfferRequest(
        { offerId: offer.id, expectedOfferRevision: offer.revision, idempotencyKey: offer.idempotencyKey },
        async (intent) => {
          if (!owner.isObserved()) throw new Error('Offer acquisition origin retired');
          return fetch('/checkout', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'manual',
            headers: { 'content-type': 'application/json', 'x-csrf-token': credential },
            body: JSON.stringify(intent),
          });
        },
      );
    }
    pendingOrigin.current = origin;
    setPhase('submitting');
    const result = await submission.current(() => origin.isCurrent() && authority.intent.isObserved());
    // Dispatched writes can still commit; only their originating UI may consume the result.
    if (!origin.isCurrent()) return;
    if (!result) {
      setPhase('retry');
      return;
    }
    if (result.kind === 'checkout') {
      window.location.assign(result.url);
      return;
    }
    if (result.kind === 'order') {
      window.location.assign(localizeHref(`/orders/${encodeURIComponent(result.orderId)}`));
      return;
    }
    if (result.kind === 'existing') setExisting(result.problem);
    setPhase(result.kind);
  }

  // A local child render may run before a queued authority replacement commits.
  const currentExisting = phase === 'existing' && origin.isCurrent() ? existing : null;
  const note = currentExisting
    ? currentExisting.code === 'benefit_already_owned'
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
  const buyDisabled = !canStart || !termsKnown || phase !== 'ready';

  return (
    <OfferPurchaseWorkspace
      idempotencyKey={offer.idempotencyKey}
      fullTitlesOpen={fullTitlesOpen}
      onFullTitlesOpenChange={setFullTitlesOpen}
      productIdentity={
        <header className="flex min-w-0 items-start gap-4 sm:gap-6">
          <SubjectCover data={offer.subject} size="sm" priority />
          <div className="min-w-0 space-y-2">
            <PageHeading className="line-clamp-2 break-words text-2xl! text-foreground sm:text-4xl!">
              {offer.subject.subject.title}
            </PageHeading>
            <p className="line-clamp-2 break-words text-base leading-relaxed text-foreground sm:text-lg">
              <span className="font-medium">{m.offer_receives()}: </span>
              {offer.title}
            </p>
          </div>
        </header>
      }
      priceDecision={
        <div className="space-y-5" data-slot="offer-decision">
          <p className="space-y-2">
            <span className="block font-serif text-4xl text-foreground tabular-nums">{offer.price}</span>
            <span className="block text-sm text-muted-foreground">
              {offer.currency.toUpperCase()} ·{' '}
              {offer.taxBehavior === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
            </span>
          </p>
          <div className="space-y-4 border-t pt-4">
            <p className="text-sm text-muted-foreground">{m.offer_terms_revision({ revision: String(offer.revision) })}</p>
            {note && (
              <Alert role="status">
                <AlertDescription className="text-foreground">{note}</AlertDescription>
              </Alert>
            )}
            {currentExisting ? (
              <Button
                variant="outline"
                className="w-full"
                nativeButton={false}
                render={
                  <a
                    onClick={(event) => {
                      if (!origin.isCurrent()) event.preventDefault();
                    }}
                    href={localizeHref(
                      currentExisting.code === 'benefit_already_owned' && currentExisting.entitlementId
                        ? `/entitlements/${encodeURIComponent(currentExisting.entitlementId)}`
                        : `/orders/${encodeURIComponent(currentExisting.orderId!)}`,
                    )}
                  />
                }
              >
                {currentExisting.code === 'benefit_already_owned' && currentExisting.entitlementId
                  ? m.offer_open_entitlement()
                  : m.offer_open_order()}
              </Button>
            ) : phase === 'terms-changed' ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  if (origin.isCurrent()) window.location.reload();
                }}
              >
                {m.offer_review_terms()}
              </Button>
            ) : phase === 'retry' ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={!canStart || !termsKnown}
                onClick={() => void start()}
              >
                {m.offer_retry()}
              </Button>
            ) : phase === 'closed' ? null : (
              <Button
                type="button"
                variant={buyDisabled ? 'outline' : 'default'}
                className="w-full"
                disabled={buyDisabled}
                onClick={() => void start()}
              >
                {m.offer_buy()}
              </Button>
            )}
          </div>
        </div>
      }
      benefitReview={
        offer.benefit ? (
          <BenefitDetails benefit={offer.benefit} creatorName={offer.creatorName} locale={getLocale()} review />
        ) : null
      }
      supportingDetails={
        <div className="space-y-4 text-sm leading-relaxed">
          <p className="break-words">{offer.subject.subject.title}</p>
          <p className="break-words">
            <span className="font-medium">{m.offer_receives()}: </span>
            {offer.title}
          </p>
        </div>
      }
    />
  );
}
