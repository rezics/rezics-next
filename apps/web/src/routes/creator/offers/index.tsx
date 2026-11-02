import { createFileRoute, useLocation } from '@tanstack/react-router';
import { readCreatorOffersCurrent } from '../../../checkout/creator-offers';
import { CreatorOffersCurrent } from '../../../checkout/creator-offers-current';
import { creatorOffersSearch } from '../../../checkout/creator-offer-address';
import { CreatorOfferAddressPage } from '../../../checkout/creator-offer-address-page';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/offers/')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorOffersSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => (deps.addressIssue ? null : readCreatorOffersCurrent({ data: deps })),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_offers_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: function PendingOffers() {
    const search = creatorOffersSearch(useLocation({ select: (location) => location.search }));
    return (
      <CreatorOfferAddressPage kind="list" locale={getLocale()} issue={search.addressIssue} requested={search.cursor} />
    );
  },
  component: function CreatorOffersRoute() {
    const { cursor, addressIssue } = Route.useSearch();
    const initial = Route.useLoaderData();
    if (addressIssue || !initial)
      return <CreatorOfferAddressPage kind="list" locale={getLocale()} issue={addressIssue} requested={cursor} />;
    return <CreatorOffersCurrent initial={initial} locale={getLocale()} {...(cursor ? { cursor } : {})} />;
  },
});
