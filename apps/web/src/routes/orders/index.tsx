import { orderHistoryAddress, orderHistorySearch } from '../../checkout/order-history-address';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute } from '@tanstack/react-router';
import { OrdersCurrent } from '../../checkout/orders-current';
import { readBuyerOrdersCurrent } from '../../checkout/orders';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

export const Route = createFileRoute('/orders/')({
  beforeLoad: requireSignedIn,
  validateSearch: orderHistorySearch,
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => {
    const address = orderHistoryAddress(deps.cursor);
    if (address.kind === 'malformed') return null;
    return readBuyerOrdersCurrent({
      data: { ...(address.cursor ? { cursor: address.cursor } : {}), locale: getLocale() },
    });
  },
  head: ({ match }) =>
    pageHead({ title: m.orders_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: OrdersRoute,
});

function OrdersRoute() {
  return <OrdersCurrent initial={Route.useLoaderData()} search={Route.useSearch()} locale={getLocale()} />;
}
