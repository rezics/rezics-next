import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { BuyerOrder, BuyerOrderPage } from './orders';

function price(order: BuyerOrder, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: order.currency.toUpperCase() });
  const digits = formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(order.unitAmountMinor / 10 ** digits);
}

function settlementLabel(settlement: BuyerOrder['settlement']): string {
  if (settlement === 'paid') return m.orders_status_paid();
  if (settlement === 'failed') return m.orders_status_failed();
  if (settlement === 'pending') return m.orders_status_pending();
  return m.orders_status_unknown();
}

function entitlementLabel(order: BuyerOrder): string {
  if (order.entitlementId) return m.orders_entitlement_active();
  if (order.settlement === 'pending' || order.settlement === 'unknown') return m.orders_entitlement_pending();
  return m.orders_entitlement_none();
}

export function OrdersPage({ page, locale }: { page: BuyerOrderPage; locale: string }) {
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="orders-heading">
      <PageHeading id="orders-heading" className="text-foreground">
        {m.orders_heading()}
      </PageHeading>
      {page.orders.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6">
          <p className="font-medium">{m.orders_empty()}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.orders_empty_hint()}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-xl border border-border bg-card text-card-foreground">
          {page.orders.map((order) => (
            <li
              key={order.id}
              data-order-row
              data-order-id={order.id}
              data-settlement={order.settlement}
              data-entitlement={order.entitlementId ?? ''}
              className="min-w-0 p-4 sm:p-5"
            >
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <a
                  href={`/${locale}/orders/${order.id}`}
                  className="min-w-0 break-words font-medium text-primary underline underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                >
                  {order.title}
                </a>
                <p className="shrink-0 font-serif text-lg tabular-nums">{price(order, locale)}</p>
              </div>
              <dl className="mt-3 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">{m.orders_status_label()}</dt>
                <dd>{settlementLabel(order.settlement)}</dd>
                <dt className="text-muted-foreground">{m.orders_entitlement_label()}</dt>
                <dd>{entitlementLabel(order)}</dd>
                <dt className="text-muted-foreground">{m.order_ordered_at()}</dt>
                <dd>
                  <time dateTime={order.createdAt}>
                    {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(order.createdAt))}
                  </time>
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {page.next ? (
        <nav aria-label={m.orders_pagination()}>
          <a
            href={`/${locale}/orders?cursor=${encodeURIComponent(page.next)}`}
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.orders_next()}
          </a>
        </nav>
      ) : null}
    </section>
  );
}
