import { ContentItem } from '@rezics/ui/content-item';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { BuyerOrder, BuyerOrderPage } from './orders';
import { formatMinorAmount } from './money';
import { recordedMoneyUnit, recordedTaxBehavior } from './money-schema';

function price(order: BuyerOrder, locale: string): string {
  return (
    formatMinorAmount(locale, order.currency, order.unitAmountMinor, recordedMoneyUnit(order)) ??
    m.statements_amount_unavailable()
  );
}

function settlementLabel(settlement: BuyerOrder['settlement']): string {
  if (settlement === 'paid') return m.orders_status_paid();
  if (settlement === 'failed') return m.orders_status_failed();
  if (settlement === 'pending') return m.orders_status_pending();
  return m.orders_status_unknown();
}

function entitlementLabel(order: BuyerOrder): string {
  if (order.entitlementId) return m.orders_entitlement_recorded();
  if (order.settlement === 'pending' || order.settlement === 'unknown') return m.orders_entitlement_pending();
  return m.orders_entitlement_none();
}

export function OrdersPage({ page, locale }: { page: BuyerOrderPage; locale: string }) {
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="orders-heading">
      <PageHeading id="orders-heading" className="text-foreground">
        {m.orders_heading()}
      </PageHeading>
      <p>
        <a
          href={`/${locale}/entitlements`}
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
        >
          {m.entitlements_heading()}
        </a>
      </p>
      {page.orders.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6">
          <p className="font-medium">{m.orders_empty()}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.orders_empty_hint()}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-xl border border-border bg-card text-card-foreground">
          {page.orders.map((order) => (
            <ContentItem
              key={order.id}
              title={order.title}
              headingLevel={2}
              href={`/${locale}/orders/${order.id}`}
              data-order-row
              data-order-id={order.id}
              data-settlement={order.settlement}
              data-entitlement={order.entitlementId ?? ''}
              className="min-w-0 p-4 sm:p-5"
              trailing={
                <p className="min-w-0 break-words font-serif text-lg tabular-nums sm:max-w-64">
                  {price(order, locale)}
                  <span className="block font-sans text-sm text-muted-foreground">
                    {order.currency.toUpperCase()} ·{' '}
                    {recordedTaxBehavior(order) === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
                  </span>
                </p>
              }
              metadata={
                <dl className="grid min-w-0 w-full grid-cols-1 gap-x-4 gap-y-1.5 text-sm break-words sm:grid-cols-[auto_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">{m.orders_status_label()}</dt>
                  <dd className="min-w-0 text-card-foreground">{settlementLabel(order.settlement)}</dd>
                  <dt className="text-muted-foreground">{m.orders_entitlement_label()}</dt>
                  <dd className="min-w-0 text-card-foreground">{entitlementLabel(order)}</dd>
                  <dt className="text-muted-foreground">{m.order_ordered_at()}</dt>
                  <dd className="min-w-0 text-card-foreground">
                    <time dateTime={order.createdAt}>
                      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(order.createdAt))}
                    </time>
                  </dd>
                </dl>
              }
            />
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
