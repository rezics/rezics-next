import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { OfferPage } from '../../checkout/offer-page';
import { readOffer } from '../../checkout/offer';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/offers/$id')({
  loader: ({ params }) => readOffer({ data: { id: params.id, locale: getLocale() } }),
  // Sign-in, viewer replacement and return-to-offer must re-admit current terms before checkout.
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  head: ({ loaderData, match }) =>
    pageHead(
      { title: loaderData?.title ?? m.offer_unavailable(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: function OfferRoute() {
    const offer = Route.useLoaderData();
    return <OfferPage key={offer.id} offer={offer} />;
  },
});
