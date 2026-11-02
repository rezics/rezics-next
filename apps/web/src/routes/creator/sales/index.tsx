import { createFileRoute } from '@tanstack/react-router';
import { CreatorSalesAddress } from '../../../checkout/creator-sales-address';
import { CreatorSalesPage } from '../../../checkout/creator-sales-page';
import { CreatorSalesCurrent } from '../../../checkout/creator-sales-current';
import { creatorSalesAddressLoad, creatorSalesSearch, readCreatorSalesCurrent } from '../../../checkout/creator-sales';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/sales/')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorSalesSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => creatorSalesAddressLoad(deps, (data) => readCreatorSalesCurrent({ data })),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_sales_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorSalesPage page={{ kind: 'loading' }} locale={getLocale()} />,
  component: function CreatorSalesRoute() {
    const search = Route.useSearch();
    const initial = Route.useLoaderData();
    const locale = getLocale();
    if ('kind' in search)
      return <CreatorSalesAddress locale={locale} {...(search.cursor === undefined ? {} : { cursor: search.cursor })} />;
    if (!initial) return <CreatorSalesPage page={{ kind: 'unavailable' }} locale={locale} {...search} />;
    return <CreatorSalesCurrent initial={initial} locale={locale} {...search} />;
  },
});
