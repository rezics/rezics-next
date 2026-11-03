import { ListRow } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorSalesData } from './creator-sales';
import { formatMinorAmount } from './money';
import { CreatorSaleInspection, creatorSaleSettlementLabel } from './creator-sale-inspection';
import { useCreatorSaleReading } from './creator-sale-reading';

export function creatorSalesHref(locale: string, cursor?: string): string {
  return `/${locale}/creator/sales${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function CreatorSalesPage({
  page,
  locale,
  cursor,
  source,
  isCurrent,
}: {
  page: CreatorSalesData;
  locale: string;
  cursor?: string;
  source?: object | undefined;
  isCurrent?: (() => boolean) | undefined;
}) {
  const reading = useCreatorSaleReading(page, locale, cursor, source, isCurrent);
  const href = creatorSalesHref(locale, cursor);
  const notice =
    page.kind === 'denied'
      ? m.creator_sales_denied()
      : page.kind === 'stale'
        ? m.creator_sales_stale()
        : page.kind === 'error'
          ? m.creator_sales_error()
          : page.kind === 'loading'
            ? m.creator_sales_loading()
            : m.creator_sales_unavailable();
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="creator-sales-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading id="creator-sales-heading">{m.creator_sales_heading()}</PageHeading>
        {page.kind !== 'loading' && (
          <Button variant="outline" className="min-h-11" nativeButton={false} render={<a href={href} />}>
            {m.statements_refresh()}
          </Button>
        )}
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_sales_intro()}</p>
      <nav aria-label={m.creator_sales_navigation()} className="flex flex-wrap gap-x-6 gap-y-2">
        <a
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          href={`/${locale}/creator/statements`}
        >
          {m.statements_heading()}
        </a>
        <a
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          href={`/${locale}/creator/offers`}
        >
          {m.creator_offers_heading()}
        </a>
      </nav>
      <p className="max-w-prose text-sm text-muted-foreground">{m.creator_sale_statements_hint()}</p>
      {page.kind !== 'ready' ? (
        <div
          className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground"
          role={page.kind === 'loading' ? 'status' : 'alert'}
        >
          <p>{notice}</p>
          {page.kind !== 'loading' && (
            <Button
              variant="outline"
              className="min-h-11"
              nativeButton={false}
              render={<a href={page.kind === 'stale' || page.kind === 'error' ? creatorSalesHref(locale) : href} />}
            >
              {page.kind === 'stale' || page.kind === 'error' ? m.creator_sales_restart() : m.statements_retry()}
            </Button>
          )}
        </div>
      ) : (
        <>
          {page.projectionState === 'preparing' && (
            <div className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground" role="status">
              <p>{m.creator_sales_preparing()}</p>
              <a
                className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
                href={creatorSalesHref(locale)}
              >
                {m.statements_refresh()}
              </a>
            </div>
          )}
          {page.sales.length === 0 ? (
            page.projectionState === 'ready' && (
              <div className="space-y-2 rounded-xl border bg-card p-5 text-card-foreground" role="status">
                <p className="font-medium">
                  {cursor || page.next ? m.creator_sales_page_empty() : m.creator_sales_empty()}
                </p>
                <p className="text-sm text-muted-foreground">{m.creator_sales_empty_hint()}</p>
              </div>
            )
          ) : (
            <ul className="space-y-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-5">
              {page.sales.map((sale) => (
                <ListRow key={sale.orderId} data-settlement={sale.settlement} className="min-w-0 space-y-3 p-3">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <h2
                      id={`sale-title-${sale.orderId}`}
                      className="line-clamp-3 min-w-0 break-words font-medium [overflow-wrap:anywhere]"
                    >
                      {sale.title}
                    </h2>
                    <p className="shrink-0 font-serif text-lg tabular-nums">
                      {formatMinorAmount(locale, sale.currency, sale.unitAmountMinor, sale.moneyUnit) ??
                        m.statements_amount_unavailable()}{' '}
                      <span className="text-sm">{sale.currency.toUpperCase()}</span>
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {sale.taxBehavior === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
                  </p>
                  <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">{m.orders_status_label()}</dt>
                    <dd>{creatorSaleSettlementLabel(sale.settlement)}</dd>
                    <dt className="text-muted-foreground">{m.order_ordered_at()}</dt>
                    <dd>
                      <time dateTime={sale.createdAt}>
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium',
                          timeStyle: 'medium',
                          timeZone: 'UTC',
                        }).format(new Date(sale.createdAt))}
                      </time>
                    </dd>
                    <dt className="text-muted-foreground">{m.creator_sales_reference()}</dt>
                    <dd className="min-w-0 truncate font-mono">{sale.orderId}</dd>
                  </dl>
                  <Button
                    variant="outline"
                    className="min-h-11 whitespace-normal"
                    aria-describedby={`sale-title-${sale.orderId}`}
                    aria-expanded={reading.selectedId === sale.orderId}
                    aria-controls={reading.selectedId === sale.orderId ? 'creator-sale-inspection' : undefined}
                    onClick={(event) => reading.select(sale.orderId, event.currentTarget)}
                  >
                    {m.creator_sale_inspect()}
                  </Button>
                </ListRow>
              ))}
            </ul>
          )}
          {reading.sale && (
            <CreatorSaleInspection
              key={reading.selectedId}
              sale={reading.sale}
              locale={locale}
              close={reading.close}
              isCurrent={reading.isCurrent}
            />
          )}
          <nav aria-label={m.creator_sales_pagination()} className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<a href={creatorSalesHref(locale)} />}
              >
                {m.creator_sales_restart()}
              </Button>
            )}
            {page.next && (
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<a href={creatorSalesHref(locale, page.next)} />}
              >
                {m.creator_sales_next()}
              </Button>
            )}
          </nav>
        </>
      )}
    </section>
  );
}
