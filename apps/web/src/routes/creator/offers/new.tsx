import { createFileRoute } from '@tanstack/react-router';
import { CreatorOfferEditorCurrent } from '../../../checkout/creator-offers-current';
import { creatorEditionSearch, readCreatorOfferEditorCurrent } from '../../../checkout/creator-offers';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/offers/new')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorEditionSearch,
  loaderDeps: ({ search }) => creatorEditionSearch(search),
  loader: ({ deps }) => readCreatorOfferEditorCurrent({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_new_offer(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function CreatorOfferEditorRoute() {
    const { contentEditionId } = Route.useSearch();
    return (
      <CreatorOfferEditorCurrent
        initial={Route.useLoaderData()}
        locale={getLocale()}
        contentEditionId={contentEditionId}
      />
    );
  },
});
