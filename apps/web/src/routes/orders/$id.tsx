import { createFileRoute } from '@tanstack/react-router';
import { OrderPage } from '../../checkout/order-page';
import { readOrder } from '../../checkout/order';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';

function checkoutQuery(value: unknown): 'canceled' | 'success' | undefined {
  if (value === 'canceled') return 'canceled';
  if (value === 'success') return 'success';
  return undefined;
}

export const Route = createFileRoute('/orders/$id')({
  validateSearch: (search: Record<string, unknown>) => {
    const checkout = checkoutQuery(search.checkout);
    return checkout ? { checkout } : {};
  },
  loader: ({ params }) => readOrder({ data: { id: params.id, locale: getLocale() } }),
  staleTime: 60_000,
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.settlement === 'paid' ? m.order_paid() : loaderData ? m.order_pending() : m.not_found_heading(),
      },
    ],
  }),
  component: function OrderRoute() {
    const checkout = Route.useSearch().checkout;
    return checkout ? (
      <OrderPage order={Route.useLoaderData()} checkout={checkout} />
    ) : (
      <OrderPage order={Route.useLoaderData()} />
    );
  },
});
