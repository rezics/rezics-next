import { useLayoutEffect, useRef, useState } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import {
  manageCreatorOffer,
  type CreatorOffer,
  type CreatorOfferGuard,
  type CreatorOfferMutation,
  type CreatorOfferResult,
  type CreatorOffersData,
  type CreatorOffersPageData,
} from './creator-offers';
import { CreatorPriceField, creatorNotice, parsedPrice } from './creator-offer-editor';
import { recordedMoneyUnit, recordedTaxBehavior } from './money-schema';
import { formatMinorAmount } from './money';

function OwnedOfferControls({
  offer,
  data,
  locale,
  guard,
}: {
  offer: CreatorOffer;
  data: CreatorOffersPageData;
  locale: string;
  guard?: CreatorOfferGuard | undefined;
}) {
  // Keep the observed row and original command stable while a write's outcome is uncertain.
  const [observed] = useState(offer);
  const [text, setText] = useState('');
  const [result, setResult] = useState<CreatorOfferResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<CreatorOfferMutation | null>(null);
  const locked = useRef(false);
  const keys = useRef(data.keys[observed.id]);
  const [rule] = useState(() =>
    data.schema?.configuredSaleCurrencies.find((row) => row.currency === observed.currency),
  );
  const currentData = useRef(data);
  currentData.current = data;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = () => mounted.current && (guard ? guard.isCurrent() : currentData.current.selling);
  const csrf = () => (guard ? guard.csrfToken() : currentData.current.csrfToken);
  const uncertain = result?.kind === 'retry';
  const frozen = busy || uncertain || result?.kind === 'saved';
  const editable =
    observed.state === 'active' && data.selling && !!csrf() && !!keys.current && (!guard || guard.isCurrent());
  async function change(operation: 'reprice' | 'delist') {
    const csrfToken = csrf();
    if (!isCurrent() || !csrfToken || locked.current || !editable || result?.kind === 'saved') return;
    if (!pending.current) {
      const key = keys.current?.[operation];
      if (!key) return;
      const amount = parsedPrice(text, rule);
      if (operation === 'reprice' && amount === null) return;
      pending.current =
        operation === 'delist'
          ? { operation, offerId: observed.id, idempotencyKey: key }
          : { operation, offerId: observed.id, idempotencyKey: key, unitAmountMinor: amount! };
    }
    locked.current = true;
    setBusy(true);
    let saved = false;
    try {
      const next = await manageCreatorOffer({ data: pending.current, headers: { 'X-CSRF-Token': csrfToken } });
      if (!isCurrent()) return;
      saved = next.kind === 'saved';
      setResult(next);
      if (next.kind !== 'retry' && next.kind !== 'saved') {
        pending.current = null;
        keys.current = { reprice: crypto.randomUUID(), delist: crypto.randomUUID() };
      }
    } catch {
      if (isCurrent()) setResult({ kind: 'retry' });
    } finally {
      if (isCurrent()) {
        locked.current = saved;
        setBusy(false);
      }
    }
  }
  return (
    <div className="space-y-4">
      {observed.state === 'active' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void change('reprice');
          }}
          className="space-y-4"
        >
          <CreatorPriceField
            rule={rule}
            text={text}
            onChange={setText}
            locale={locale}
            disabled={!editable || frozen}
          />
          <p className="text-sm leading-relaxed text-muted-foreground">{m.creator_revision_meaning()}</p>
          {!rule && (
            <p className="text-sm" role="status">
              {m.creator_price_unavailable()}
            </p>
          )}
          {uncertain ? (
            <Button
              type="button"
              onClick={() => {
                if (pending.current?.operation !== 'create') void change(pending.current?.operation ?? 'reprice');
              }}
              disabled={busy || !editable}
              className="min-h-11"
            >
              {m.creator_retry()}
            </Button>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                type="submit"
                disabled={!editable || frozen || parsedPrice(text, rule) === null}
                className="min-h-11"
              >
                {m.creator_reprice()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!editable || frozen}
                className="min-h-11"
                onClick={() => void change('delist')}
              >
                {m.creator_delist()}
              </Button>
            </div>
          )}
        </form>
      )}
      {result && <p role={result.kind === 'saved' ? 'status' : 'alert'}>{creatorNotice(result.kind)}</p>}
    </div>
  );
}

export function creatorOffersHref(locale: string, cursor?: string): string {
  return `/${locale}/creator/offers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function CreatorOffersPage({
  page: suppliedPage,
  data,
  locale,
  cursor,
  offerPageAvailable = true,
  guard,
}: {
  page?: CreatorOffersData;
  data?: CreatorOffersPageData;
  locale: string;
  cursor?: string;
  offerPageAvailable?: boolean;
  guard?: CreatorOfferGuard | undefined;
}) {
  const page = data?.page ?? suppliedPage ?? { kind: 'unavailable' as const };
  const href = creatorOffersHref(locale, cursor);
  const notice =
    page.kind === 'denied'
      ? m.creator_offers_denied()
      : page.kind === 'stale'
        ? m.creator_offers_stale()
        : page.kind === 'error'
          ? m.creator_offers_error()
          : page.kind === 'preparing'
            ? m.creator_offers_preparing()
            : page.kind === 'closed' || page.kind === 'rejected'
              ? creatorNotice(page.kind)
              : m.creator_offers_unavailable();
  const restart = page.kind === 'stale' || page.kind === 'error';
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="creator-offers-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading id="creator-offers-heading">{m.creator_offers_heading()}</PageHeading>
        {page.kind !== 'preparing' && (
          <a href={href} className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}>
            {m.creator_offers_refresh()}
          </a>
        )}
      </div>
      {data && (
        <a
          href={`/${locale}/creator/offers/new`}
          className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
        >
          {m.creator_new_offer()}
        </a>
      )}
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_offers_intro()}</p>
      {page.kind !== 'ready' ? (
        <div
          className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground"
          role={page.kind === 'preparing' ? 'status' : 'alert'}
        >
          <p>{notice}</p>
          {page.kind !== 'preparing' && (
            <a
              href={restart ? creatorOffersHref(locale) : href}
              className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
            >
              {restart ? m.creator_offers_restart() : m.creator_offers_retry()}
            </a>
          )}
        </div>
      ) : (
        <>
          {page.offers.length === 0 ? (
            <div role="status" className="space-y-2 rounded-xl border bg-card p-5 text-card-foreground">
              <p className="font-medium">{cursor ? m.creator_offers_page_empty() : m.creator_offers_empty()}</p>
              <p className="text-sm text-muted-foreground">{m.creator_offers_empty_hint()}</p>
            </div>
          ) : (
            <ul className="space-y-3 rounded-xl border bg-card p-3 text-card-foreground sm:p-5">
              {page.offers.map((offer) => (
                <ContentItem
                  key={offer.id}
                  data-offer-state={offer.state}
                  title={offer.title}
                  headingLevel={2}
                  {...(offer.state === 'active' && offerPageAvailable ? { href: `/${locale}/offers/${offer.id}` } : {})}
                  className="p-3 [&_h2]:break-words [&_h2]:[overflow-wrap:anywhere]"
                  metadata={
                    <div className="min-w-0 space-y-2">
                      <p className="font-serif text-lg tabular-nums">
                        {formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, recordedMoneyUnit(offer)) ??
                          m.creator_offers_amount_unavailable()}{' '}
                        <span className="text-sm">{offer.currency.toUpperCase()}</span>
                      </p>
                      <p>
                        {recordedTaxBehavior(offer) === 'exclusive'
                          ? m.commerce_before_tax()
                          : m.commerce_tax_unknown()}
                      </p>
                      <p className="leading-relaxed">
                        {offer.contentEdition === null ? m.creator_offers_unknown() : m.creator_offers_captured()}
                      </p>
                    </div>
                  }
                  state={
                    <p className="text-sm font-medium">
                      {offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted()}
                    </p>
                  }
                  actions={
                    <details className="min-w-0 max-w-sm">
                      <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        {m.commerce_full_title()}
                      </summary>
                      <p className="break-words py-2 text-sm [overflow-wrap:anywhere]">{offer.title}</p>
                    </details>
                  }
                  trailing={
                    data && (
                      <div className="w-full min-w-0 max-w-sm">
                        <OwnedOfferControls offer={offer} data={data} locale={locale} guard={guard} />
                      </div>
                    )
                  }
                />
              ))}
            </ul>
          )}
          <nav aria-label={m.creator_offers_pagination()} className="flex flex-wrap gap-3">
            {cursor && (
              <a
                href={creatorOffersHref(locale)}
                className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
              >
                {m.creator_offers_restart()}
              </a>
            )}
            {page.next && (
              <a
                href={creatorOffersHref(locale, page.next)}
                className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
              >
                {m.creator_offers_next()}
              </a>
            )}
          </nav>
        </>
      )}
    </section>
  );
}
