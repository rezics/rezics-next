import { createFileRoute, useLocation } from '@tanstack/react-router';
import { CreatorOfferEditorCurrent } from '../../../checkout/creator-offers-current';
import {
  CreatorOfferOriginAddressPanel,
  CreatorOfferOriginScope,
} from '../../../checkout/creator-offer-editor';
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
  loaderDeps: ({ search }) => ({
    ...(search.contentEditionId ? { contentEditionId: search.contentEditionId } : {}),
    ...(search.addressIssue ? { addressIssue: search.addressIssue } : {}),
  }),
  loader: ({ deps }) => (deps.addressIssue ? null : readCreatorOfferEditorCurrent({ data: deps })),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_new_offer(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: function PendingEdition() {
    const search = creatorEditionSearch(useLocation({ select: (location) => location.search }));
    return (
      <CreatorOfferOriginScope token={search.editionOrigin} editionId={search.contentEditionId}>
        <CreatorOfferAddressPage
          kind="editor"
          locale={getLocale()}
          issue={search.addressIssue}
          requested={search.contentEditionId}
        />
        <CreatorOfferOriginAddressPanel />
      </CreatorOfferOriginScope>
    );
  },
  component: function CreatorOfferEditorRoute() {
    const { contentEditionId, addressIssue, editionOrigin } = Route.useSearch();
    const initial = Route.useLoaderData();
    if (addressIssue || !initial)
      return (
        <CreatorOfferOriginScope token={editionOrigin} editionId={contentEditionId}>
          <CreatorOfferAddressPage
            kind="editor"
            locale={getLocale()}
            issue={addressIssue}
            requested={contentEditionId}
          />
          <CreatorOfferOriginAddressPanel />
        </CreatorOfferOriginScope>
      );
    return (
      <CreatorOfferOriginScope token={editionOrigin} editionId={contentEditionId}>
        <CreatorOfferEditorCurrent initial={initial} locale={getLocale()} contentEditionId={contentEditionId} />
      </CreatorOfferOriginScope>
    );
  },
});
