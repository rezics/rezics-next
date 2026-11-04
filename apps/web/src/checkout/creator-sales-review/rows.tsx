import { ListRow } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { CreatorSale } from '../creator-sales';
import type { CreatorSaleReading } from '../creator-sale-reading';
import { creatorSaleSettlementLabel } from '../creator-sale-inspection';
import { formatMinorAmount } from '../money';
import { CREATOR_SALE_COMPARISON_LIMIT } from './model';

type Props = {
  sales: readonly CreatorSale[];
  locale: string;
  reading: CreatorSaleReading;
};

export function CreatorSalesReviewRows({ sales, locale, reading }: Props) {
  const full = reading.comparisonIds.length >= CREATOR_SALE_COMPARISON_LIMIT;
  return (
    <ul
      aria-label={m.creator_review_rows()}
      className="space-y-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-5"
    >
      {sales.map((sale) => {
        const selected = reading.comparisonIds.includes(sale.orderId);
        return (
          <ListRow key={sale.orderId} data-settlement={sale.settlement} className="min-w-0 space-y-3 p-3">
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <h3
                id={`sale-title-${sale.orderId}`}
                className="line-clamp-3 min-w-0 break-words font-medium [overflow-wrap:anywhere]"
              >
                {sale.title}
              </h3>
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
              <dd className="min-w-0 select-text font-mono [overflow-wrap:anywhere]">{sale.orderId}</dd>
              <dt className="text-muted-foreground">{m.creator_sale_offer_reference()}</dt>
              <dd className="min-w-0 select-text font-mono [overflow-wrap:anywhere]">{sale.offerId}</dd>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={!reading.sourceIsCurrent()}
                variant="outline"
                className="min-h-11 whitespace-normal"
                id={`inspect-sale-${sale.orderId}`}
                aria-describedby={`sale-title-${sale.orderId}`}
                aria-expanded={reading.selectedId === sale.orderId}
                aria-controls={reading.selectedId === sale.orderId ? 'creator-sale-inspection' : undefined}
                onClick={(event) => reading.select(sale.orderId, event.currentTarget)}
              >
                {m.creator_sale_inspect()}
              </Button>
              <label className="inline-flex min-h-11 min-w-0 cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-5 shrink-0 accent-primary"
                  checked={selected}
                  disabled={!reading.sourceIsCurrent() || (!selected && full)}
                  onChange={() => reading.toggleComparison(sale.orderId)}
                  aria-describedby={`sale-title-${sale.orderId} creator-sales-comparison-bound`}
                />
                <span>{m.creator_review_select()}</span>
                <span className="sr-only">
                  {m.creator_sales_reference()}: {sale.orderId}
                </span>
              </label>
            </div>
            {reading.selectedId === sale.orderId && (
              <p className="text-sm text-muted-foreground">{m.creator_review_inspection_below()}</p>
            )}
          </ListRow>
        );
      })}
    </ul>
  );
}
