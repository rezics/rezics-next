import { createFileRoute } from '@tanstack/react-router';
import { creatorOffersSearch, readCreatorOffersCurrent } from '../../../checkout/creator-offers';
import { CreatorOffersCurrent } from '../../../checkout/creator-offers-current';
import { CreatorOffersPage } from '../../../checkout/creator-offers-page';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/offers/')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorOffersSearch,
  loaderDeps: ({ search }) => creatorOffersSearch(search),
  loader: ({ deps }) => readCreatorOffersCurrent({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_offers_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorOffersPage page={{ kind: 'preparing' }} locale={getLocale()} />,
  component: function CreatorOffersRoute() {
    const { cursor } = Route.useSearch();
    return (
      <CreatorOffersCurrent initial={Route.useLoaderData()} locale={getLocale()} {...(cursor ? { cursor } : {})} />
    );
  },
});
