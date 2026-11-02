import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CreatorOfferEditorCurrent } from '../../../checkout/creator-offers-current';
import { readCreatorOfferEditorCurrent } from '../../../checkout/creator-offers';
import { creatorEditionSearch } from '../../../checkout/creator-offer-address';
import { CreatorOfferAddressPage } from '../../../checkout/creator-offer-address-page';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/offers/new')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorEditionSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => (deps.addressIssue ? null : readCreatorOfferEditorCurrent({ data: deps })),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_new_offer(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: function PendingEdition() {
    const search = creatorEditionSearch(useLocation({ select: (location) => location.search }));
    return (
      <CreatorOfferAddressPage
        kind="editor"
        locale={getLocale()}
        issue={search.addressIssue}
        requested={search.contentEditionId}
      />
    );
  },
  component: function CreatorOfferEditorRoute() {
    const { contentEditionId, addressIssue } = Route.useSearch();
    const initial = Route.useLoaderData();
    if (addressIssue || !initial)
      return (
        <CreatorOfferAddressPage kind="editor" locale={getLocale()} issue={addressIssue} requested={contentEditionId} />
      );
    return <CreatorOfferEditorCurrent initial={initial} locale={getLocale()} contentEditionId={contentEditionId} />;
  },
});
