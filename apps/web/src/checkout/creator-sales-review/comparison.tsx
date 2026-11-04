import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { CreatorSale } from '../creator-sales';
import type { CreatorSaleReading } from '../creator-sale-reading';
import { creatorSaleSettlementLabel } from '../creator-sale-inspection';
import { formatMinorAmount } from '../money';
import { CREATOR_SALE_COMPARISON_LIMIT, recordedUnitRelationship } from './model';

function ComparisonFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function settlementDetail(sale: CreatorSale): string {
  switch (sale.settlement) {
    case 'paid':
      return m.creator_sale_paid_detail();
    case 'pending':
      return m.creator_sale_pending_detail();
    case 'failed':
      return m.creator_sale_failed_detail();
    case 'unknown':
      return m.creator_sale_unknown_detail();
  }
}

type ComparisonReading = Pick<
  CreatorSaleReading,
  'comparisonSales' | 'closeComparison' | 'select' | 'toggleComparison'
>;

function ComparisonSale({ sale, locale, reading }: { sale: CreatorSale; locale: string; reading: ComparisonReading }) {
  const amount = formatMinorAmount(locale, sale.currency, sale.unitAmountMinor, sale.moneyUnit);
  return (
    <article
      className="min-w-0 space-y-4 rounded-lg border bg-card p-4 text-card-foreground"
      aria-labelledby={`comparison-${sale.orderId}`}
    >
      <h3 id={`comparison-${sale.orderId}`} className="whitespace-pre-wrap font-semibold [overflow-wrap:anywhere]">
        {sale.title}
      </h3>
      <dl className="min-w-0 space-y-4">
        <ComparisonFact label={m.creator_sales_reference()}>
          <span className="font-mono text-sm">{sale.orderId}</span>
        </ComparisonFact>
        <ComparisonFact label={m.creator_sale_work_reference()}>
          <span className="font-mono text-sm">{sale.targetSubjectId}</span>
        </ComparisonFact>
        <ComparisonFact label={m.creator_sale_offer_reference()}>
          <span className="font-mono text-sm">{sale.offerId}</span>
        </ComparisonFact>
        <ComparisonFact label={m.order_ordered_at()}>
          <time dateTime={sale.createdAt}>
            {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(
              new Date(sale.createdAt),
            )}
          </time>
          <span className="block font-mono text-sm">{sale.createdAt}</span>
        </ComparisonFact>
        <ComparisonFact label={m.creator_sale_unit_price()}>
          <span className="font-serif text-xl tabular-nums">{amount ?? m.statements_amount_unavailable()}</span>
        </ComparisonFact>
        <ComparisonFact label={m.creator_sale_currency()}>{sale.currency.toUpperCase()}</ComparisonFact>
        <ComparisonFact label={m.creator_sale_raw_amount()}>
          <span className="font-mono">{String(sale.unitAmountMinor)}</span>
        </ComparisonFact>
        <ComparisonFact label={m.creator_sale_tax()}>
          {sale.taxBehavior === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
        </ComparisonFact>
        <ComparisonFact label={m.creator_review_unit_provenance()}>
          {sale.moneyUnit ? (
            <>
              <span>{m.creator_sale_unit_known({ digits: sale.moneyUnit.exponent })}</span>
              <span className="block font-mono text-sm">{sale.moneyUnit.system}</span>
              <span className="block font-mono text-sm">{sale.moneyUnit.factsVersion}</span>
            </>
          ) : (
            m.creator_sale_unit_unknown()
          )}
        </ComparisonFact>
        <ComparisonFact label={m.creator_sale_settlement()}>
          <span className="block font-medium">{creatorSaleSettlementLabel(sale.settlement)}</span>
          <span className="block text-sm text-muted-foreground">{settlementDetail(sale)}</span>
        </ComparisonFact>
      </dl>
      <div className="flex flex-wrap gap-3 border-t pt-4">
        <Button
          variant="outline"
          className="min-h-11 whitespace-normal"
          aria-describedby={`comparison-${sale.orderId}`}
          onClick={(event) => reading.select(sale.orderId, event.currentTarget)}
        >
          {m.creator_sale_inspect()}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11 whitespace-normal"
          aria-describedby={`comparison-${sale.orderId}`}
          onClick={() => reading.toggleComparison(sale.orderId)}
        >
          {m.creator_review_remove()}
        </Button>
      </div>
    </article>
  );
}

/** Relate identity facts only. No monetary arithmetic or implied reconciliation enters the review. */
function ComparisonContext({ sales }: { sales: readonly CreatorSale[] }) {
  const workCount = new Set(sales.map((sale) => sale.targetSubjectId)).size;
  const offerCount = new Set(sales.map((sale) => sale.offerId)).size;
  const titleCount = new Set(sales.map((sale) => sale.title)).size;
  const settlementCount = new Set(sales.map((sale) => sale.settlement)).size;
  return (
    <details className="min-w-0 rounded-lg border p-4">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.creator_review_comparison_context()}</summary>
      <div className="min-w-0 space-y-4 pt-4">
        <p className="text-sm text-muted-foreground">{m.creator_review_comparison_context_hint()}</p>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <ComparisonFact label={m.creator_sale_work_reference()}>
            {workCount === 1 ? m.creator_review_same_work() : m.creator_review_different_works({ count: workCount })}
          </ComparisonFact>
          <ComparisonFact label={m.creator_sale_offer_reference()}>
            {offerCount === 1
              ? m.creator_review_same_offer()
              : m.creator_review_different_offers({ count: offerCount })}
          </ComparisonFact>
          <ComparisonFact label={m.creator_review_captured_title()}>
            {titleCount === 1
              ? m.creator_review_same_title()
              : m.creator_review_different_titles({ count: titleCount })}
          </ComparisonFact>
          <ComparisonFact label={m.creator_sale_settlement()}>
            {settlementCount === 1
              ? m.creator_review_same_settlement()
              : m.creator_review_different_settlements({ count: settlementCount })}
          </ComparisonFact>
        </dl>
        <p className="text-sm text-muted-foreground">{m.creator_review_identity_hint()}</p>
      </div>
    </details>
  );
}

export function CreatorSalesComparison({ reading, locale }: { reading: ComparisonReading; locale: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);
  const relationship = recordedUnitRelationship(reading.comparisonSales);
  const meaning =
    relationship === 'unknown'
      ? m.creator_review_comparison_unknown()
      : relationship === 'different-currencies'
        ? m.creator_review_comparison_currencies()
        : relationship === 'different-units'
          ? m.creator_review_comparison_units()
          : m.creator_review_comparison_same_unit();
  return (
    <section
      id="creator-sales-comparison"
      aria-labelledby="creator-sales-comparison-heading"
      className="min-w-0 space-y-5 rounded-xl border p-4 sm:p-5"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          reading.closeComparison();
        }
      }}
    >
      <h2 id="creator-sales-comparison-heading" ref={heading} tabIndex={-1} className="text-lg font-semibold">
        {m.creator_review_comparison_heading()}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{m.creator_review_comparison_hint()}</p>
      <p role="status" className="text-sm">
        {meaning}
      </p>
      <ComparisonContext sales={reading.comparisonSales} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-3">
        {reading.comparisonSales.map((sale) => (
          <ComparisonSale key={sale.orderId} sale={sale} locale={locale} reading={reading} />
        ))}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">{m.creator_sale_statements_hint()}</p>
      <Button variant="outline" className="min-h-11 whitespace-normal" onClick={reading.closeComparison}>
        {m.creator_review_close_comparison()}
      </Button>
    </section>
  );
}

export function CreatorSalesComparisonSelection({
  reading,
  visibleIds,
}: {
  reading: CreatorSaleReading;
  visibleIds: ReadonlySet<string>;
}) {
  const openButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !reading.comparisonOpen && reading.sourceIsCurrent()) {
      if (openButton.current && !openButton.current.disabled) openButton.current.focus();
      else document.getElementById('creator-sales-selection-heading')?.focus();
    }
    wasOpen.current = reading.comparisonOpen;
  }, [reading.comparisonOpen]);
  const hidden = reading.comparisonIds.filter((id) => !visibleIds.has(id)).length;
  return (
    <section
      aria-labelledby="creator-sales-selection-heading"
      className="min-w-0 space-y-3 rounded-xl border p-4 sm:p-5"
    >
      <h2 id="creator-sales-selection-heading" tabIndex={-1} className="font-semibold">
        {m.creator_review_selection_heading()}
      </h2>
      <p id="creator-sales-comparison-bound" className="text-sm text-muted-foreground">
        {m.creator_review_selection_bound({ limit: CREATOR_SALE_COMPARISON_LIMIT })}
      </p>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
        {m.creator_review_selected_count({ count: reading.comparisonIds.length, limit: CREATOR_SALE_COMPARISON_LIMIT })}
        {hidden > 0 && <span className="block">{m.creator_review_hidden_selection({ count: hidden })}</span>}
      </p>
      {reading.comparisonSales.length > 0 && (
        <ul className="space-y-2">
          {reading.comparisonSales.map((sale) => (
            <li key={sale.orderId} className="min-w-0 space-y-1 text-sm">
              <span className="block whitespace-pre-wrap [overflow-wrap:anywhere]">{sale.title}</span>
              <span className="block select-text font-mono [overflow-wrap:anywhere]">{sale.orderId}</span>
              <Button
                variant="ghost"
                className="min-h-11"
                onClick={() => reading.toggleComparison(sale.orderId)}
                aria-label={`${m.creator_review_remove()}: ${sale.orderId}`}
              >
                {m.creator_review_remove()}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          ref={openButton}
          variant="outline"
          className="min-h-11 whitespace-normal"
          disabled={reading.comparisonIds.length < 2}
          aria-expanded={reading.comparisonOpen}
          aria-controls={reading.comparisonOpen ? 'creator-sales-comparison' : undefined}
          onClick={reading.openComparison}
        >
          {m.creator_review_compare()}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11 whitespace-normal"
          disabled={reading.comparisonIds.length === 0}
          onClick={reading.clearComparison}
        >
          {m.creator_review_clear_selection()}
        </Button>
      </div>
    </section>
  );
}
