import { createFileRoute, useRouter } from '@tanstack/react-router';
import { CreatorSalesAddress } from '../../../checkout/creator-sales-address';
import { CreatorSalesPage } from '../../../checkout/creator-sales-page';
import {
  CreatorSalesCurrent,
  creatorSalesLocationKey,
  navigateCreatorSales,
} from '../../../checkout/creator-sales-current';
import { creatorSalesAddressLoad, creatorSalesSearch, readCreatorSalesCurrent } from '../../../checkout/creator-sales';
import { requirePrivatePageAccess } from '../../../session/guard';
import { loadPrivatePage } from '../../../session/private-page';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';

export const Route = createFileRoute('/creator/sales/')({
  beforeLoad: async (context) => ({ sessionAccess: await requirePrivatePageAccess(context) }),
  validateSearch: creatorSalesSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => ({
    loadId: crypto.randomUUID(),
    initial: await loadPrivatePage(context.sessionAccess, () =>
      creatorSalesAddressLoad(deps, (data) => readCreatorSalesCurrent({ data })),
    ),
  }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.creator_sales_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <CreatorSalesPage page={{ kind: 'loading' }} locale={getLocale()} />,
  component: function CreatorSalesRoute() {
    const router = useRouter();
    const search = Route.useSearch();
    const { initial, loadId } = Route.useLoaderData();
    const locale = getLocale();
    if ('kind' in search)
      return (
        <CreatorSalesAddress locale={locale} {...(search.cursor === undefined ? {} : { cursor: search.cursor })} />
      );
    if (!initial) return <CreatorSalesPage page={{ kind: 'unavailable' }} locale={locale} {...search} />;
    return (
      <CreatorSalesCurrent
        initial={initial}
        loadId={loadId}
        locationKey={creatorSalesLocationKey(router.state.location)}
        locale={locale}
        {...search}
        navigate={(href, started) => navigateCreatorSales(router, href, started)}
      />
    );
  },
});
