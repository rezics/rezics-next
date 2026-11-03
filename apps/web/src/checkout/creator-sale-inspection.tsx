import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { CreatorSale } from './creator-sales';
import { creatorSaleDestinations } from './creator-sale-destinations';
import { CreatorSaleReturn } from './creator-sale-return';
import { formatMinorAmount } from './money';

export function creatorSaleSettlementLabel(settlement: CreatorSale['settlement']): string {
  if (settlement === 'paid') return m.creator_sales_paid();
  if (settlement === 'pending') return m.creator_sales_pending();
  if (settlement === 'failed') return m.creator_sales_failed();
  return m.creator_sales_unknown();
}

function settlementMeaning(settlement: CreatorSale['settlement']): string {
  if (settlement === 'paid') return m.creator_sale_paid_detail();
  if (settlement === 'pending') return m.creator_sale_pending_detail();
  if (settlement === 'failed') return m.creator_sale_failed_detail();
  return m.creator_sale_unknown_detail();
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

type Props = { sale: CreatorSale; locale: string; close: () => void; isCurrent: () => boolean };

/** One supplied historical observation. Opening, copying and link preparation perform no reads. */
export function CreatorSaleInspection({ sale, locale, close, isCurrent }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const live = useRef({ isCurrent, mounted: true, attempt: 0 });
  live.current.isCurrent = isCurrent;
  const [copy, setCopy] = useState<'idle' | 'pending' | 'copied' | 'failed'>('idle');
  useLayoutEffect(() => {
    live.current.mounted = true;
    heading.current?.focus();
    return () => {
      live.current.mounted = false;
      live.current.attempt++;
    };
  }, []);
  const destinations = creatorSaleDestinations(sale, locale);
  const amount = formatMinorAmount(locale, sale.currency, sale.unitAmountMinor, sale.moneyUnit);
  const copyReference = async () => {
    if (!live.current.isCurrent()) return;
    const attempt = ++live.current.attempt;
    const current = () =>
      live.current.mounted && live.current.isCurrent() && live.current.attempt === attempt;
    setCopy('pending');
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // The copied text identifies this as a sale reference, never a receipt or buyer-order link.
      await navigator.clipboard.writeText(`${m.creator_sales_reference()}: ${sale.orderId}`);
      if (current()) setCopy('copied');
    } catch {
      if (current()) setCopy('failed');
    }
  };
  return (
    <section
      id="creator-sale-inspection"
      aria-labelledby="creator-sale-inspection-heading"
      className="min-w-0 space-y-6 rounded-xl border bg-card p-4 text-card-foreground sm:p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="space-y-2">
        <h2 id="creator-sale-inspection-heading" ref={heading} tabIndex={-1} className="text-xl font-semibold">
          {m.creator_sale_inspection()}
        </h2>
        <p className="whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">{sale.title}</p>
      </div>
      <section className="space-y-3" aria-labelledby="creator-sale-terms">
        <h3 id="creator-sale-terms" className="font-medium">{m.creator_sale_terms()}</h3>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Fact label={m.creator_sale_unit_price()}>
            <span className="font-serif text-xl tabular-nums">{amount ?? m.statements_amount_unavailable()}</span>
          </Fact>
          <Fact label={m.creator_sale_currency()}>{sale.currency.toUpperCase()}</Fact>
          <Fact label={m.creator_sale_raw_amount()}><span className="font-mono">{String(sale.unitAmountMinor)}</span></Fact>
          <Fact label={m.creator_sale_tax()}>
            {sale.taxBehavior === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
          </Fact>
        </dl>
        <p className="text-sm text-muted-foreground">
          {sale.moneyUnit
            ? m.creator_sale_unit_known({ digits: sale.moneyUnit.exponent })
            : m.creator_sale_unit_unknown()}
        </p>
      </section>
      <section className="space-y-3 border-t pt-4" aria-labelledby="creator-sale-settlement">
        <h3 id="creator-sale-settlement" className="font-medium">{m.creator_sale_settlement()}</h3>
        <p>{creatorSaleSettlementLabel(sale.settlement)}</p>
        <p className="text-sm text-muted-foreground">{settlementMeaning(sale.settlement)}</p>
        <p className="text-sm text-muted-foreground">{m.creator_sale_statements_hint()}</p>
      </section>
      <section className="space-y-3 border-t pt-4" aria-labelledby="creator-sale-identities">
        <h3 id="creator-sale-identities" className="font-medium">{m.creator_sale_identities()}</h3>
        <dl className="space-y-4">
          <Fact label={m.order_ordered_at()}>
            <time dateTime={sale.createdAt}>
              {new Intl.DateTimeFormat(locale, {
                dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC',
              }).format(new Date(sale.createdAt))}
            </time>
            <span className="block font-mono text-sm">{sale.createdAt}</span>
          </Fact>
          <Fact label={m.creator_sales_reference()}><span className="font-mono">{sale.orderId}</span></Fact>
          <Fact label={m.creator_sale_offer_reference()}><span className="font-mono">{sale.offerId}</span></Fact>
          <Fact label={m.creator_sale_work_reference()}><span className="font-mono">{sale.targetSubjectId}</span></Fact>
        </dl>
        <Button variant="outline" className="min-h-11 whitespace-normal" disabled={copy === 'pending'} onClick={copyReference}>
          {copy === 'pending' ? m.creator_sale_copying() : m.creator_sale_copy()}
        </Button>
        <p role="status" className="text-sm">
          {copy === 'copied' ? m.creator_sale_copied() : copy === 'failed' ? m.creator_sale_copy_failed() : ''}
        </p>
        <p className="text-sm text-muted-foreground">{m.creator_sale_reference_hint()}</p>
      </section>
      <nav aria-label={m.creator_sale_destinations()} className="space-y-3 border-t pt-4">
        <p className="text-sm text-muted-foreground">{m.creator_sale_destination_hint()}</p>
        <div className="flex flex-wrap gap-3">
          {([
            [destinations.offer, m.creator_sale_open_offer()],
            [destinations.work, m.creator_sale_open_work()],
          ] as const).map(([href, label]) => href ? (
            <Button key={label} variant="outline" className="min-h-11 whitespace-normal" nativeButton={false}
              render={<a href={href} onClick={(event) => { if (!isCurrent()) event.preventDefault(); }} />}>
              {label}
            </Button>
          ) : (
            <p key={label} className="text-sm">{label}: {m.creator_sale_destination_unavailable()}</p>
          ))}
        </div>
      </nav>
      <CreatorSaleReturn close={close} />
    </section>
  );
}
