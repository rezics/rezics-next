import { QueryClientContext } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { AnonymousSessionContext, exposureQuery, sessionQuery, useSession } from '../session/query';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import type { OfferPageData } from './offer';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';
import { BenefitDetails } from './benefit-details';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { isMoneyUnit } from './money-schema';
import { createOfferRequest, type AcquisitionProblem } from './offer-recovery';

type Phase = 'ready' | 'submitting' | 'retry' | 'terms-changed' | 'unavailable' | 'closed' | 'existing';
type Authority = ReturnType<typeof useSession> & { admitted: boolean };
type Origin = { isCurrent: () => boolean; credential: () => string | null };
const subscribe = () => () => {};
const anonymousExposureKey = ['exposure', 'anonymous'] as const;
const offerAddress = (pathname: string) => pathname.match(/(?:^|\/)offers\/([^/]+)\/?$/)?.[1] ?? null;
const identity = (offerId: string, authority: Authority) =>
  JSON.stringify([offerId, authority.state, authority.subject ?? null, authority.admitted, Boolean(authority.csrfToken)]);

export function OfferPage({ offer: observedOffer }: { offer: OfferPageData }) {
  const session = useSession();
  const admitted = useOperation('order.create');
  const client = useContext(QueryClientContext);
  const router = useRouter({ warn: false });
  const anonymous = useContext(AnonymousSessionContext);
  const address = useRef({ router, id: router ? offerAddress(router.state.location.pathname) : observedOffer.id });
  if (address.current.router !== router)
    address.current = { router, id: router ? offerAddress(router.state.location.pathname) : observedOffer.id };
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  function authority(): Authority {
    // Server HTML and standalone previews keep the public terms without inferring a viewer.
    if (!hydrated || !client) return { ...session, admitted };
    const sessionState = client.getQueryState<ReturnType<typeof useSession>>(sessionQuery.queryKey);
    const current = anonymous
      ? { state: 'signed-out' as const, subject: null, csrfToken: null }
      : (sessionState?.status === 'success' ? sessionState.data : undefined) ??
        { state: 'unknown' as const, csrfToken: null };
    const exposure = client.getQueryState<string[]>(
      current.state === 'signed-out' ? anonymousExposureKey : exposureQuery.queryKey,
    );
    return {
      ...current,
      admitted:
        current.state !== 'unknown' &&
        current.state !== 'unavailable' &&
        (!router || address.current.id === observedOffer.id) &&
        operationIsAdmitted('order.create', exposure?.status === 'success' ? exposure.data : undefined),
    };
  }
  const currentAuthority = authority();
  const signature = identity(observedOffer.id, currentAuthority);
  const [scope, setScope] = useState(() => ({
    signature,
    client,
    anonymous,
    generation: 0,
    retired: false,
    mounted: false,
  }));
  let current = scope;
  if (scope.signature !== signature || scope.client !== client || scope.anonymous !== anonymous || scope.retired) {
    // Address and rendered authority replacement retire retained handlers before commit.
    scope.retired = true;
    current = { signature, client, anonymous, generation: scope.generation + 1, retired: false, mounted: false };
    setScope(current);
  }
  function isCurrent() {
    if (current.retired || !current.mounted) return false;
    if (identity(observedOffer.id, authority()) !== current.signature) current.retired = true;
    return !current.retired;
  }
  const [, renderRetired] = useState(0);
  useLayoutEffect(() => {
    current.mounted = true;
    const observe = () => {
      if (!current.retired && !isCurrent()) renderRetired((version) => version + 1);
    };
    // Cache notifications are synchronous: A -> B -> A retires A even if React batches
    // every notification into one render. No session/exposure IO is added here.
    const unsubscribe = client?.getQueryCache().subscribe(({ query }) => {
      if (query.queryKey[0] === 'session' || query.queryKey[0] === 'exposure') observe();
    });
    const navigation = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
      address.current.id = offerAddress(toLocation.pathname);
      observe();
    });
    observe();
    return () => {
      current.mounted = false;
      unsubscribe?.();
      navigation?.();
    };
  }, [current, router]);
  const origin: Origin = {
    isCurrent,
    credential: () => (isCurrent() ? authority().csrfToken : null),
  };
  return (
    <OfferPurchase key={current.generation} observedOffer={observedOffer} authority={currentAuthority} origin={origin} />
  );
}

function OfferPurchase({
  observedOffer,
  authority,
  origin,
}: {
  observedOffer: OfferPageData;
  authority: Authority;
  origin: Origin;
}) {
  const submittedOffer = useRef<OfferPageData | null>(null);
  const submission = useRef<ReturnType<typeof createOfferRequest> | null>(null);
  const offer = submittedOffer.current ?? observedOffer;
  const [submissionPhase, setPhase] = useState<Phase>('ready');
  const phase = submittedOffer.current ? submissionPhase : offer.state === 'delisted' ? 'unavailable' : 'ready';
  const [existing, setExisting] = useState<AcquisitionProblem | null>(null);
  const [fullTitlesOpen, setFullTitlesOpen] = useState(false);
  const termsKnown =
    isMoneyUnit(offer.moneyUnit) && offer.taxBehavior === 'exclusive' && offer.benefit?.kind === 'mapped';
  const canStart =
    authority.admitted &&
    (authority.state === 'signed-out' ||
      (authority.state === 'signed-in' && Boolean(authority.subject) && Boolean(authority.csrfToken)));

  async function start() {
    if (!origin.isCurrent() || !canStart || !termsKnown || (phase !== 'ready' && phase !== 'retry')) return;
    if (authority.state === 'signed-out') {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    // A loader refresh cannot replace consent while the original creation outcome is uncertain.
    submittedOffer.current ??= offer;
    submission.current ??= createOfferRequest(
      { offerId: offer.id, expectedOfferRevision: offer.revision, idempotencyKey: offer.idempotencyKey },
      (intent) => {
        const credential = origin.credential();
        if (!credential) throw new Error('Offer acquisition origin retired');
        return fetch('/checkout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-csrf-token': credential },
          body: JSON.stringify(intent),
        });
      },
    );
    setPhase('submitting');
    const result = await submission.current();
    // Dispatched writes can still commit; only their originating UI may consume the result.
    if (!origin.isCurrent() || !result) return;
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
  const buyDisabled = !canStart || !termsKnown || phase !== 'ready';

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
                onClick={(event) => {
                  if (!origin.isCurrent()) event.preventDefault();
                }}
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
            onClick={() => {
              if (origin.isCurrent()) window.location.reload();
            }}
          >
            {m.offer_review_terms()}
          </Button>
        ) : phase === 'retry' ? (
          <Button
            variant="outline"
            size="lg"
            className="min-h-11 w-full disabled:opacity-100 sm:w-auto"
            disabled={!canStart || !termsKnown}
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
