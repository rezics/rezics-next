import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorOffersData } from './creator-offers';
import { formatMinorAmount } from './money';

export function creatorOffersHref(locale: string, cursor?: string): string {
  return `/${locale}/creator/offers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function CreatorOffersPage({
  page,
  locale,
  cursor,
  offerPageAvailable = true,
}: {
  page: CreatorOffersData;
  locale: string;
  cursor?: string;
  offerPageAvailable?: boolean;
}) {
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
            : m.creator_offers_unavailable();
  const restart = page.kind === 'stale' || page.kind === 'error';
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="creator-offers-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading id="creator-offers-heading">{m.creator_offers_heading()}</PageHeading>
        {page.kind !== 'preparing' && (
          <Button variant="outline" className="min-h-11" nativeButton={false} render={<a href={href} />}>
            {m.creator_offers_refresh()}
          </Button>
        )}
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_offers_intro()}</p>
      {page.kind !== 'ready' ? (
        <div
          className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground"
          role={page.kind === 'preparing' ? 'status' : 'alert'}
        >
          <p>{notice}</p>
          {page.kind !== 'preparing' && (
            <Button
              variant="outline"
              className="min-h-11"
              nativeButton={false}
              render={<a href={restart ? creatorOffersHref(locale) : href} />}
            >
              {restart ? m.creator_offers_restart() : m.creator_offers_retry()}
            </Button>
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
                <ListRow key={offer.id} data-offer-state={offer.state} className="min-w-0 space-y-2 p-3">
                  {offer.state === 'active' && offerPageAvailable && (
                    <ListRowLink href={`/${locale}/offers/${offer.id}`}>{offer.title}</ListRowLink>
                  )}
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <h2 className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{offer.title}</h2>
                    <p className="shrink-0 font-serif text-lg tabular-nums">
                      {formatMinorAmount(locale, offer.currency, offer.unitAmountMinor) ??
                        m.creator_offers_amount_unavailable()}{' '}
                      <span className="text-sm">{offer.currency.toUpperCase()}</span>
                    </p>
                  </div>
                  <p className="text-sm font-medium">
                    {offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted()}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {offer.contentEdition === null ? m.creator_offers_unknown() : m.creator_offers_captured()}
                  </p>
                </ListRow>
              ))}
            </ul>
          )}
          <nav aria-label={m.creator_offers_pagination()} className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<a href={creatorOffersHref(locale)} />}
              >
                {m.creator_offers_restart()}
              </Button>
            )}
            {page.next && (
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<a href={creatorOffersHref(locale, page.next)} />}
              >
                {m.creator_offers_next()}
              </Button>
            )}
          </nav>
        </>
      )}
    </section>
  );
}
