import { createFileRoute } from '@tanstack/react-router';
import { OfferPage } from '../../checkout/offer-page';
import { readOffer } from '../../checkout/offer';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/offers/$id')({
  loader: ({ params }) => readOffer({ data: { id: params.id, locale: getLocale() } }),
  staleTime: 60_000,
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? m.offer_unavailable() }] }),
  component: function OfferRoute() {
    return <OfferPage offer={Route.useLoaderData()} />;
  },
});
