import { createFileRoute } from '@tanstack/react-router';
import { CreatorSalesAddress } from '../../../checkout/creator-sales-address';
import { CreatorSalesPage } from '../../../checkout/creator-sales-page';
import { CreatorSalesCurrent } from '../../../checkout/creator-sales-current';
import { creatorSalesAddressLoad, creatorSalesSearch, readCreatorSalesCurrent } from '../../../checkout/creator-sales';
import { requirePrivatePageAccess } from '../../../session/guard';
import { isSessionUnavailablePage, loadPrivatePage, SessionUnavailablePrompt } from '../../../session/private-page';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/sales/')({
  beforeLoad: async (context) => ({ sessionAccess: await requirePrivatePageAccess(context) }),
  validateSearch: creatorSalesSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    loadPrivatePage(context.sessionAccess, () =>
      creatorSalesAddressLoad(deps, (data) => readCreatorSalesCurrent({ data })),
    ),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_sales_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorSalesPage page={{ kind: 'loading' }} locale={getLocale()} />,
  component: function CreatorSalesRoute() {
    const search = Route.useSearch();
    const initial = Route.useLoaderData();
    const locale = getLocale();
    if (isSessionUnavailablePage(initial)) return <SessionUnavailablePrompt signInHref={initial.signInHref} />;
    if ('kind' in search)
      return (
        <CreatorSalesAddress locale={locale} {...(search.cursor === undefined ? {} : { cursor: search.cursor })} />
      );
    if (!initial) return <CreatorSalesPage page={{ kind: 'unavailable' }} locale={locale} {...search} />;
    return <CreatorSalesCurrent initial={initial} locale={locale} {...search} />;
  },
});
