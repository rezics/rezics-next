import { createFileRoute } from '@tanstack/react-router';
import { creatorOffersSearch, readCreatorOffers } from '../../../checkout/creator-offers';
import { CreatorOffersPage } from '../../../checkout/creator-offers-page';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
import { useOperation } from '../../../kernel/exposure';

export const Route = createFileRoute('/creator/offers/')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorOffersSearch,
  loaderDeps: ({ search }) => creatorOffersSearch(search),
  loader: ({ deps }) => readCreatorOffers({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_offers_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorOffersPage page={{ kind: 'preparing' }} locale={getLocale()} />,
  component: function CreatorOffersRoute() {
    const offerPageAvailable = useOperation('offer.get');
    const { cursor } = Route.useSearch();
    return (
      <CreatorOffersPage
        page={Route.useLoaderData()}
        locale={getLocale()}
        offerPageAvailable={offerPageAvailable}
        {...(cursor ? { cursor } : {})}
      />
    );
  },
});
