import { createFileRoute } from '@tanstack/react-router';
import { CreatorOfferEditor } from '../../../checkout/creator-offer-editor';
import { creatorEditionSearch, readCreatorOfferEditor } from '../../../checkout/creator-offers';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/offers/new')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorEditionSearch,
  loaderDeps: ({ search }) => creatorEditionSearch(search),
  loader: ({ deps }) => readCreatorOfferEditor({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_new_offer(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function CreatorOfferEditorRoute() {
    return <CreatorOfferEditor data={Route.useLoaderData()} locale={getLocale()} />;
  },
});
