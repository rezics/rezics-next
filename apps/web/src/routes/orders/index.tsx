import { purchaseHistorySearch } from '../../checkout/purchase-return';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { OrdersCurrent } from '../../checkout/orders-current';
import { readBuyerOrdersCurrent } from '../../checkout/orders';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

function validCursor(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096) throw notFound();
  return value;
}

function validateOrdersSearch(search: Record<string, unknown>) {
  const cursor = validCursor(search.cursor);
  return { ...purchaseHistorySearch(search), ...(cursor ? { cursor } : {}) };
}

export const Route = createFileRoute('/orders/')({
  beforeLoad: requireSignedIn,
  validateSearch: validateOrdersSearch,
  loaderDeps: ({ search }) => {
    const cursor = validCursor(search.cursor);
    return cursor ? { cursor } : {};
  },
  loader: ({ deps }) => readBuyerOrdersCurrent({ data: { ...deps, locale: getLocale() } }),
  head: ({ match }) =>
    pageHead({ title: m.orders_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: OrdersRoute,
});

function OrdersRoute() {
  return <OrdersCurrent initial={Route.useLoaderData()} search={Route.useSearch()} locale={getLocale()} />;
}
