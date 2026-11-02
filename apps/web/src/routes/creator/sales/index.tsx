import { createFileRoute } from '@tanstack/react-router';
import { CreatorSalesPage } from '../../../checkout/creator-sales-page';
import { CreatorSalesCurrent } from '../../../checkout/creator-sales-current';
import { creatorSalesSearch, readCreatorSalesCurrent } from '../../../checkout/creator-sales';
import { requireSignedIn } from '../../../session/guard';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/sales/')({
  beforeLoad: requireSignedIn,
  validateSearch: creatorSalesSearch,
  loaderDeps: ({ search }) => creatorSalesSearch(search),
  loader: ({ deps }) => readCreatorSalesCurrent({ data: deps }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_sales_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorSalesPage page={{ kind: 'loading' }} locale={getLocale()} />,
  component: function CreatorSalesRoute() {
    const search = creatorSalesSearch(Route.useSearch());
    return <CreatorSalesCurrent initial={Route.useLoaderData()} locale={getLocale()} {...search} />;
  },
});
